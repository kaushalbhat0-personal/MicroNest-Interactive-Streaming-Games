// Local sidecar: YouTube adapter HTTP surface (NO secrets leave this process).
//   GET  /api/youtube/status          connection state + diagnostics
//   GET  /api/youtube/auth-url        Google consent URL (creator opens it)
//   GET  /api/youtube/oauth-callback  loopback receiver (?code=... / ?error=...)
//   POST /api/youtube/connect         discover active broadcast + start polling
//   POST /api/youtube/disconnect      stop polling
//   POST /api/youtube/logout          forget tokens
//   GET  /api/youtube/stream          SSE: canonical events (replay via Last-Event-ID)
//   POST /api/youtube/inject          DEV-ONLY: push a raw YT-shaped message through
//                                      the mapper (manual testing without a live stream)
//   POST /api/youtube/send            T3: post one announcement to the live chat
//                                      (validated text + safe event id; typed errors)
// Run: node server/youtube-server.mjs [port]   (default 3002)
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { YT, loadClientConfig } from "./youtube/config.mjs";
import { YouTubeAdapter } from "./youtube/adapter.mjs";
import { mapYouTubeMessage } from "./youtube/mapper.mjs";

const port = Number(process.argv[2] ?? 3002);
const redirectUri = `http://127.0.0.1:${port}/api/youtube/oauth-callback`;
const tokenPath = YT.tokenPath;

// Bounded SSE replay buffer. SSE `id` == canonical eventId, so engine dedup
// makes any replay overlap safe. Browser persists its last id in localStorage.
const buffer = [];
function pushToBuffer(events) {
  for (const ev of events) {
    if (buffer.some((b) => b.eventId === ev.eventId)) continue;
    buffer.push(ev);
  }
  while (buffer.length > YT.sseBufferSize) buffer.shift();
}
const sseClients = new Set();

function broadcast(events) {
  pushToBuffer(events);
  const payload = events.map((ev) => `id: ${ev.eventId}\nevent: canonical\ndata: ${JSON.stringify(ev)}\n\n`).join("");
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      /* drop dead clients lazily on close */
    }
  }
}

const client = await loadClientConfig();
await mkdir(YT.profileDir, { recursive: true }); // secrets dir exists before tokens are written
const adapter = new YouTubeAdapter({
  client,
  redirectUri,
  cursorPath: YT.cursorPath,
  fetchImpl: fetch,
  onEvents: (events) => broadcast(events),
  onStatus: () => {},
});
await adapter.init(tokenPath);

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, last-event-id");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/youtube/status" && req.method === "GET") {
    json(res, 200, adapter.getState());
    return;
  }
  if (url.pathname === "/api/youtube/auth-url" && req.method === "GET") {
    const u = adapter.authUrl();
    if (!u) {
      json(res, 500, { error: "oauth-not-configured" });
      return;
    }
    json(res, 200, { url: u });
    return;
  }
  if (url.pathname === "/api/youtube/oauth-callback" && req.method === "GET") {
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    if (err) {
      res.writeHead(200, { "content-type": "text/html" }).end(
        `<h1>Authorization declined (${escapeHtml(err)}).</h1><p>Close this tab and return to the console.</p>`,
      );
      return;
    }
    if (!code) {
      res.writeHead(400, { "content-type": "text/html" }).end("<h1>Missing code.</h1>");
      return;
    }
    try {
      await adapter.handleCallback(code);
      res.writeHead(200, { "content-type": "text/html" }).end(
        "<h1>Emberkeep connected to YouTube.</h1><p>Close this tab and return to the console.</p>",
      );
    } catch (e) {
      res.writeHead(500, { "content-type": "text/html" }).end(
        `<h1>Auth failed.</h1><p>${escapeHtml(String(e?.message ?? e))}</p>`,
      );
    }
    return;
  }
  if (url.pathname === "/api/youtube/connect" && req.method === "POST") {
    try {
      json(res, 200, await adapter.connect());
    } catch (e) {
      json(res, 500, { error: String(e?.message ?? e) });
    }
    return;
  }
  if (url.pathname === "/api/youtube/disconnect" && req.method === "POST") {
    adapter.disconnect();
    json(res, 200, adapter.getState());
    return;
  }
  if (url.pathname === "/api/youtube/logout" && req.method === "POST") {
    await adapter.logout();
    json(res, 200, adapter.getState());
    return;
  }
  if (url.pathname === "/api/youtube/stream" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("retry: 5000\n\n");
    // Replay anything the client hasn't seen. EventSource auto-sends
    // Last-Event-ID on reconnect; ?lastId= covers a full page reload.
    const lastId = req.headers["last-event-id"] ?? url.searchParams.get("lastId");
    const idx = lastId ? buffer.findIndex((b) => b.eventId === lastId) : -1;
    const missed = idx >= 0 ? buffer.slice(idx + 1) : [...buffer];
    if (missed.length > 0) {
      res.write(
        missed.map((ev) => `id: ${ev.eventId}\nevent: canonical\ndata: ${JSON.stringify(ev)}\n\n`).join(""),
      );
    }
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* closed */
      }
    }, 25000);
    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }
  if (url.pathname === "/api/youtube/inject" && req.method === "POST") {
    // DEV-ONLY manual test hook: maps a raw YouTube-shaped message and
    // broadcasts it exactly like a live event. Never touches secrets.
    if (process.env.YT_ALLOW_INJECT === "0") {
      json(res, 403, { error: "inject-disabled" });
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const mapped = mapYouTubeMessage(JSON.parse(raw));
      if (mapped.event) {
        broadcast([mapped.event]);
        json(res, 200, { outcome: mapped.outcome, eventId: mapped.event.eventId });
      } else {
        json(res, 200, { outcome: mapped.outcome, reason: mapped.reason });
      }
    } catch {
      json(res, 400, { error: "invalid-json" });
    }
    return;
  }
  if (url.pathname === "/api/youtube/send" && req.method === "POST") {
    // T3 outbound announcement. Browser submits text + a safe event id;
    // tokens stay in this process. Bounded body; typed errors only.
    let raw = "";
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4096) {
          json(res, 413, { ok: false, error: "too-long" });
          return;
        }
      }
    } catch {
      json(res, 400, { ok: false, error: "invalid-json" });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      json(res, 400, { ok: false, error: "invalid-json" });
      return;
    }
    const text = parsed?.text;
    const eventId = parsed?.eventId;
    if (typeof text !== "string" || typeof eventId !== "string") {
      json(res, 400, { ok: false, error: "invalid-text" });
      return;
    }
    try {
      const out = await adapter.sendChatMessage({ text, eventId });
      if (out.ok) {
        json(res, 200, { ok: true, duplicate: !!out.duplicate, messageId: out.messageId ?? null });
        return;
      }
      const statusByError = {
        "invalid-text": 400,
        "too-long": 400,
        "invalid-event": 400,
        "auth-required": 401,
        "insufficient-scope": 403,
        "no-live-chat": 409,
        "rate-limited": 429,
        "quota-exceeded": 429,
        uncertain: 504,
        "api-error": 502,
      };
      json(res, statusByError[out.error] ?? 500, { ok: false, error: out.error });
    } catch {
      json(res, 500, { ok: false, error: "api-error" });
    }
    return;
  }
  json(res, 404, { error: "not-found" });
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

server.listen(port, "127.0.0.1", () => {
  console.log(`[emberkeep] youtube sidecar on http://127.0.0.1:${port}`);
  console.log(`[emberkeep] callback URL: ${redirectUri}`);
});
