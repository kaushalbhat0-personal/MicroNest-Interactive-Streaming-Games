// T4F-C2.7-D1-D — state-transport module (no listener, no CORS, no env).
//
// Extracted verbatim from server/state-server.mjs (T4F-B) so ONE implementation
// serves both topologies with identical protocol behavior:
// - standalone: state-server.mjs wraps it (local-dev two-process workflow);
// - single-port: authority-server.ts mounts it (Render one-listener service).
//
// The authority stays the SOLE game owner: this module holds no WorldState,
// runs no simulation, and accepts no client-supplied world as anything but a
// display snapshot. Sequence numbers, the bounded replay buffer (50),
// per-subscriber backlog (50), heartbeat (15s), stale-revision guard,
// reconnect/recovery semantics, and read-only renderer access are unchanged.
// Snapshots are pre-scrubbed by the authority; no credentials, stream keys,
// or platform payloads ever pass through here.
//
// The host owns: the HTTP listener, CORS headers (applied BEFORE delegating
// here — including on the SSE upgrade path), and publish authorization
// (injected `isAuthorized`; the embedded authority path uses its in-process
// bearer, the standalone path re-resolves per request exactly as before).

// Keep in sync with src/shared/transport-core.ts (single source of truth
// lives there for TS; this file is standalone .mjs by design).
export const TRANSPORT_PROTOCOL = 1;
export const PUBLISH_MAX_BYTES = 512 * 1024;
export const REPLAY_BUFFER_MAX = 50;
export const SUBSCRIBER_BACKLOG_MAX = 50;
export const HEARTBEAT_MS = 15_000;

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

export function snapshotShapeOk(s) {
  if (!s || typeof s !== "object") return false;
  if (s.v !== TRANSPORT_PROTOCOL) return false;
  if (!Number.isInteger(s.worldRev) || s.worldRev < 1) return false;
  if (typeof s.sessionId !== "string" || s.sessionId.length === 0) return false;
  if (typeof s.streamNumber !== "number" || !Number.isFinite(s.streamNumber)) return false;
  if (!s.world || typeof s.world !== "object") return false;
  if (!s.vote || typeof s.vote !== "object") return false;
  if (!Array.isArray(s.storyLog) || !Array.isArray(s.feed) || !Array.isArray(s.recent)) return false;
  if (!Array.isArray(s.viewerFeed)) return false;
  return true;
}

/**
 * @param opts.isAuthorized(req) -> boolean|Promise<boolean>. Publish-only gate
 *   (header bearer, constant-time compare — implemented by the host).
 * @param opts.now clock for tests (default Date.now).
 */
export function createStateTransport(opts = {}) {
  const isAuthorized = typeof opts.isAuthorized === "function" ? opts.isAuthorized : () => false;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const startedAt = now();
  /** @type {Array<{seq:number, snapshot:any}>} bounded replay buffer, oldest-first */
  const buffer = [];
  /** @type {{seq:number, snapshot:any} | null} latest authoritative snapshot */
  let latest = null;
  let seqCounter = 0;
  /** @type {Set<{res:any, format:string, backlog:number, alive:boolean}>} */
  const subs = new Set();
  /** @type {Set<ReturnType<typeof setInterval>>} heartbeat registry (drained by close()) */
  const heartbeats = new Set();

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

  /** Shared ingest path (HTTP publish and in-process publishLocal). */
  function ingest(protocol, snapshot) {
    if (protocol !== TRANSPORT_PROTOCOL) return { ok: false, reason: "bad-protocol" };
    if (!snapshotShapeOk(snapshot)) return { ok: false, reason: "bad-snapshot" };
    if (latest && snapshot.worldRev < latest.snapshot.worldRev) {
      // Stale publish (authority bug or replayed request): never rewind.
      return { ok: false, reason: "stale-revision", seq: seqCounter };
    }
    seqCounter += 1;
    const entry = { seq: seqCounter, snapshot };
    latest = entry;
    buffer.push(entry);
    while (buffer.length > REPLAY_BUFFER_MAX) buffer.shift();
    broadcast(entry);
    return { ok: true, seq: entry.seq };
  }

  /**
   * In-process publish for the single-port authority (the caller IS the
   * authority — no bearer needed; the HTTP route below still requires it).
   */
  function publishLocal(snapshot) {
    return ingest(TRANSPORT_PROTOCOL, snapshot);
  }

  function statusPayload() {
    const byFormat = {};
    for (const sub of subs) {
      const f = sub.format || "unknown";
      byFormat[f] = (byFormat[f] ?? 0) + 1;
    }
    return {
      protocol: TRANSPORT_PROTOCOL,
      seq: seqCounter,
      worldRev: latest?.snapshot.worldRev ?? null,
      snapshotAt: latest?.snapshot.atIso ?? null,
      subscribers: { total: subs.size, byFormat },
      uptimeSec: Math.floor((now() - startedAt) / 1000),
      bufferSize: buffer.length,
    };
  }

  /**
   * Handle one request. Returns true when the path belongs to the state
   * transport (response completed here), false otherwise (host continues).
   * The host MUST apply CORS (and preflight) before delegating.
   */
  async function handleRequest(req, res, url) {
    const pathname = url.pathname;

    if (pathname === "/api/state/publish" && req.method === "POST") {
      let raw;
      try {
        raw = await readBody(req, PUBLISH_MAX_BYTES);
      } catch (err) {
        if (err?.code === "too-long") {
          sendJson(res, 413, { error: "too-long" });
          return true;
        }
        sendJson(res, 400, { error: "unreadable-body" });
        return true;
      }
      // Authority boundary: header credential only (never query — URLs leak
      // into logs). Constant-time compare; no hint about what failed.
      let authed = false;
      try {
        authed = await isAuthorized(req);
      } catch {
        authed = false;
      }
      if (!authed) {
        sendJson(res, 401, { error: "unauthorized" });
        return true;
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: "invalid-json" });
        return true;
      }
      if (!body || typeof body !== "object") {
        sendJson(res, 400, { error: "bad-protocol" });
        return true;
      }
      const out = ingest(body.protocol, body.snapshot);
      if (!out.ok) {
        if (out.reason === "stale-revision") {
          sendJson(res, 409, { error: "stale-revision", seq: out.seq });
          return true;
        }
        sendJson(res, 400, { error: out.reason });
        return true;
      }
      sendJson(res, 200, { ok: true, seq: out.seq });
      return true;
    }

    if (pathname === "/api/state/snapshot" && req.method === "GET") {
      if (!latest) {
        sendJson(res, 404, { error: "no-snapshot", protocol: TRANSPORT_PROTOCOL });
        return true;
      }
      sendJson(res, 200, { seq: latest.seq, snapshot: latest.snapshot });
      return true;
    }

    if (pathname === "/api/state/status" && req.method === "GET") {
      sendJson(res, 200, statusPayload());
      return true;
    }

    if (pathname === "/api/state/stream" && req.method === "GET") {
      const sinceRaw = url.searchParams.get("since");
      const since = sinceRaw === null || sinceRaw === "" ? null : Number(sinceRaw);
      const sinceOk = since === null || (Number.isInteger(since) && since >= 0);
      if (!sinceOk) {
        sendJson(res, 400, { error: "bad-since" });
        return true;
      }
      const formatRaw = (url.searchParams.get("format") ?? "unknown").toLowerCase();
      const format = formatRaw === "landscape" || formatRaw === "portrait" ? formatRaw : "unknown";
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`:connected protocol=${TRANSPORT_PROTOCOL}\n\n`);
      const sub = { res, format, backlog: 0, alive: true };
      subs.add(sub);
      // Resume: replay what the buffer still holds past `since`. Anything
      // older already turned over → recovery (client must refetch /snapshot).
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
          heartbeats.delete(heartbeat);
          return;
        }
        try {
          res.write(`:ping ${now()}\n\n`);
          res.write(`event: heartbeat\ndata: {"seq":${seqCounter},"t":${now()}}\n\n`);
        } catch {
          clearInterval(heartbeat);
          heartbeats.delete(heartbeat);
          dropSub(sub);
        }
      }, HEARTBEAT_MS);
      heartbeats.add(heartbeat);
      const cleanup = () => {
        clearInterval(heartbeat);
        heartbeats.delete(heartbeat);
        dropSub(sub);
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
      return true;
    }

    if (pathname === "/api/state/publish" || pathname === "/api/state/snapshot" || pathname === "/api/state/status" || pathname === "/api/state/stream") {
      sendJson(res, 404, { error: "not-found" });
      return true;
    }
    return false;
  }

  /** Graceful drain: end every SSE stream + clear heartbeats (shutdown order). */
  function close() {
    for (const hb of [...heartbeats]) {
      try {
        clearInterval(hb);
      } catch {
        /* drain best-effort */
      }
    }
    heartbeats.clear();
    for (const sub of [...subs]) dropSub(sub);
  }

  return {
    handleRequest,
    publishLocal,
    getSeq: () => seqCounter,
    getStatus: () => statusPayload(),
    subscriberCount: () => subs.size,
    close,
  };
}
