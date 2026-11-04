// T4F-B — authoritative state-transport server (sibling to persist-server).
// Node builtins ONLY — no framework.
//
// ONE authoritative runtime (the keeper-console dashboard page) POSTs
// versioned snapshots here; the landscape and portrait renderer pages read
// them via snapshot fetch + sequenced SSE. Read-only for renderers: this
// server exposes NO mutation endpoints (no command ingestion, no vote
// control, no announcement sending, no OAuth). It stores NO credentials,
// stream keys, or platform payloads — snapshots are pre-scrubbed by the
// authority (see src/shared/snapshot.ts).
//
//   node server/state-server.mjs [port]   (default 3003)
//   Vite proxies /api/state -> this server during `npm run dev`.
//
// Endpoints:
//   POST /api/state/publish   {protocol:1, snapshot} -> {ok, seq}
//       T4F-C1 AUTHORITY-ONLY: requires `Authorization: Bearer <token>`
//       (401 otherwise; constant-time compare). Validates size (<=512KB),
//       rejects stale worldRev with 409 (authority bug guard). Assigns a
//       monotonic seq, appends to the bounded replay buffer (50), and
//       broadcasts to SSE subscribers (bounded per-subscriber backlog;
//       slow subscribers get a recovery signal and are dropped, never
//       allowed to block the authority).
//   GET  /api/state/snapshot  -> {seq, snapshot} | 404 {error:no-snapshot}
//   GET  /api/state/stream?since=N&format=landscape|portrait  (SSE)
//       Replays buffered snapshots with seq > since (in order); sends
//       `recovery` when since predates the buffer (client must refetch
//       /snapshot); then streams live `state` events + `heartbeat`s + `:ping`.
//   GET  /api/state/status    -> {protocol, seq, worldRev, snapshotAt,
//       subscribers:{total, byFormat}, uptimeSec, bufferSize} (dashboard).
//
// Prototype limits (documented, not silent):
// - localhost dev only: no auth on /publish. Any local page can publish;
//   in production this endpoint needs an authority credential. The server
//   never accepts client-supplied WorldState as anything but a display
//   snapshot — it runs no simulation and influences no game state.
// - in-memory only: restart wipes seq/buffer/snapshot. Renderers show the
//   safe disconnected state until the authority republishes.

import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bearerToken, resolveAuthorityToken, tokensEqual } from "./authority-token.mjs";

const port = Number(process.argv[2] ?? 3003);
const startedAt = Date.now();
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR ?? join(root, "data");

// T4F-C1: the publish route is authority-only. The token is provisioned
// out-of-band (AUTHORITY_TOKEN env or data/authority-token.json); it never
// appears in responses, snapshots, SSE, or logs.
const { token: authorityTokenBoot, generated: tokenGenerated } = await resolveAuthorityToken(dataDir);
void authorityTokenBoot;

// Keep these in sync with src/shared/transport-core.ts (single source of
// truth lives there for TS; this file is standalone .mjs by design).
const PROTOCOL = 1;
const PUBLISH_MAX_BYTES = 512 * 1024;
const REPLAY_BUFFER_MAX = 50;
const SUBSCRIBER_BACKLOG_MAX = 50;
const HEARTBEAT_MS = 15_000;

/** @type {Array<{seq:number, snapshot:any}>} bounded replay buffer, oldest-first */
const buffer = [];
/** @type {{seq:number, snapshot:any} | null} latest authoritative snapshot */
let latest = null;
let seqCounter = 0;
/** @type {Set<{res:any, format:string, backlog:number, alive:boolean}>} */
const subs = new Set();

function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let tooLong = false;
    req.on("data", (chunk) => {
      if (tooLong) return;
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > limit) {
        tooLong = true;
        reject(Object.assign(new Error("too-long"), { code: "too-long" }));
      }
    });
    req.on("end", () => (tooLong ? null : resolve(raw)));
    req.on("error", reject);
  });
}

function snapshotShapeOk(s) {
  if (!s || typeof s !== "object") return false;
  if (s.v !== PROTOCOL) return false;
  if (!Number.isInteger(s.worldRev) || s.worldRev < 1) return false;
  if (typeof s.sessionId !== "string" || s.sessionId.length === 0) return false;
  if (typeof s.streamNumber !== "number" || !Number.isFinite(s.streamNumber)) return false;
  if (!s.world || typeof s.world !== "object") return false;
  if (!s.vote || typeof s.vote !== "object") return false;
  if (!Array.isArray(s.storyLog) || !Array.isArray(s.feed) || !Array.isArray(s.recent)) return false;
  if (!Array.isArray(s.viewerFeed)) return false;
  return true;
}

function sseWrite(sub, chunk) {
  if (!sub.alive) return false;
  if (sub.backlog >= SUBSCRIBER_BACKLOG_MAX) {
    // Slow renderer: tell it to recover from a fresh snapshot, then drop
    // it. The authority is never blocked by a slow reader.
    try {
      sub.res.write(`event: recovery\ndata: {"seq":${seqCounter}}\n\n`);
    } catch { /* dropping anyway */ }
    dropSub(sub);
    return false;
  }
  try {
    sub.res.write(chunk);
    sub.backlog += 1;
    // Node flushes async; treat the write as drained on next tick.
    // Backlog accounting stays conservative (recovery on genuine stall).
    setImmediate(() => {
      sub.backlog = Math.max(0, sub.backlog - 1);
    });
    return true;
  } catch {
    dropSub(sub);
    return false;
  }
}

function dropSub(sub) {
  if (!sub.alive) return;
  sub.alive = false;
  subs.delete(sub);
  try {
    sub.res.end();
  } catch { /* already gone */ }
}

function broadcast(entry) {
  const chunk = `event: state\ndata: ${JSON.stringify({ seq: entry.seq, snapshot: entry.snapshot })}\n\n`;
  for (const sub of [...subs]) sseWrite(sub, chunk);
}

const server = createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/api/state/publish" && req.method === "POST") {
    let raw;
    try {
      raw = await readBody(req, PUBLISH_MAX_BYTES);
    } catch (err) {
      if (err?.code === "too-long") {
        sendJson(res, 413, { error: "too-long" });
        return;
      }
      sendJson(res, 400, { error: "unreadable-body" });
      return;
    }
    // Authority boundary: header credential only (never query — URLs leak
    // into logs). The token is re-resolved per request so operator rotation
    // (new file value) takes effect without restarting this process; env
    // provisioning short-circuits with no filesystem touch. Constant-time
    // compare; no hint about what failed.
    const { token: liveToken } = await resolveAuthorityToken(dataDir);
    if (!tokensEqual(bearerToken(req), liveToken)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: "invalid-json" });
      return;
    }
    if (!body || body.protocol !== PROTOCOL) {
      sendJson(res, 400, { error: "bad-protocol" });
      return;
    }
    if (!snapshotShapeOk(body.snapshot)) {
      sendJson(res, 400, { error: "bad-snapshot" });
      return;
    }
    if (latest && body.snapshot.worldRev < latest.snapshot.worldRev) {
      // Stale publish (authority bug or replayed request): never rewind.
      sendJson(res, 409, { error: "stale-revision", seq: seqCounter });
      return;
    }
    seqCounter += 1;
    const entry = { seq: seqCounter, snapshot: body.snapshot };
    latest = entry;
    buffer.push(entry);
    while (buffer.length > REPLAY_BUFFER_MAX) buffer.shift();
    broadcast(entry);
    sendJson(res, 200, { ok: true, seq: entry.seq });
    return;
  }

  if (url.pathname === "/api/state/snapshot" && req.method === "GET") {
    if (!latest) {
      sendJson(res, 404, { error: "no-snapshot", protocol: PROTOCOL });
      return;
    }
    sendJson(res, 200, { seq: latest.seq, snapshot: latest.snapshot });
    return;
  }

  if (url.pathname === "/api/state/status" && req.method === "GET") {
    const byFormat = {};
    for (const sub of subs) {
      const f = sub.format || "unknown";
      byFormat[f] = (byFormat[f] ?? 0) + 1;
    }
    sendJson(res, 200, {
      protocol: PROTOCOL,
      seq: seqCounter,
      worldRev: latest?.snapshot.worldRev ?? null,
      snapshotAt: latest?.snapshot.atIso ?? null,
      subscribers: { total: subs.size, byFormat },
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      bufferSize: buffer.length,
    });
    return;
  }

  if (url.pathname === "/api/state/stream" && req.method === "GET") {
    const sinceRaw = url.searchParams.get("since");
    const since = sinceRaw === null || sinceRaw === "" ? null : Number(sinceRaw);
    const sinceOk = since === null || (Number.isInteger(since) && since >= 0);
    if (!sinceOk) {
      sendJson(res, 400, { error: "bad-since" });
      return;
    }
    const formatRaw = (url.searchParams.get("format") ?? "unknown").toLowerCase();
    const format = formatRaw === "landscape" || formatRaw === "portrait" ? formatRaw : "unknown";
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`:connected protocol=${PROTOCOL}\n\n`);
    const sub = { res, format, backlog: 0, alive: true };
    subs.add(sub);
    // Resume: replay what the buffer still holds past `since`. Anything
    // older already turned over → recovery (client refetches /snapshot).
    if (since !== null && latest && since < latest.seq) {
      const oldest = buffer.length > 0 ? buffer[0].seq : latest.seq;
      // Needed seqs are since+1..latest; retained are oldest..latest.
      // Missing iff since+1 <= oldest-1 (since=0 with oldest=1 replays all).
      if (buffer.length === 0 || since < oldest - 1) {
        // `since` predates the retained window (or buffer empty): recover.
        try {
          res.write(`event: recovery\ndata: {"seq":${seqCounter}}\n\n`);
        } catch { /* closing anyway */ }
      } else {
        for (const entry of buffer) {
          if (entry.seq > since) {
            const ok = sseWrite(sub, `event: state\ndata: ${JSON.stringify({ seq: entry.seq, snapshot: entry.snapshot })}\n\n`);
            if (!ok) break;
          }
        }
      }
    }
    const heartbeat = setInterval(() => {
      if (!sub.alive) {
        clearInterval(heartbeat);
        return;
      }
      try {
        res.write(`:ping ${Date.now()}\n\n`);
        res.write(`event: heartbeat\ndata: {"seq":${seqCounter},"t":${Date.now()}}\n\n`);
      } catch {
        clearInterval(heartbeat);
        dropSub(sub);
      }
    }, HEARTBEAT_MS);
    const cleanup = () => {
      clearInterval(heartbeat);
      dropSub(sub);
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    return;
  }

  res.writeHead(404).end("not-found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[tidebound] state-transport server on http://127.0.0.1:${port}`);
  console.log(`[tidebound] publish route: authority-token ${tokenGenerated ? "generated" : "loaded"} (never printed)`);
});
