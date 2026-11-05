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
// Endpoints (implemented in ./state-transport.mjs — shared verbatim with the
// authority's single-port embedded mode; D1-D):
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
//
// D1-D: this standalone listener is the LOCAL-DEV topology. The Render
// single-port topology mounts the same transport module inside the
// authority (STATE_TRANSPORT=embedded) — one public listener, no second
// service, no reverse proxy. See docs/render-hosting.md.

import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bearerToken, resolveAuthorityToken, tokensEqual } from "./authority-token.mjs";
import { createStateTransport } from "./state-transport.mjs";

const port = Number(process.argv[2] ?? 3003);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR ?? join(root, "data");

// T4F-C1: the publish route is authority-only. The token is provisioned
// out-of-band (AUTHORITY_TOKEN env or data/authority-token.json); it never
// appears in responses, snapshots, SSE, or logs.
const { token: authorityTokenBoot, generated: tokenGenerated } = await resolveAuthorityToken(dataDir);
void authorityTokenBoot;

// The token is re-resolved per request so operator rotation (new file value)
// takes effect without restarting this process; env provisioning
// short-circuits with no filesystem touch. Constant-time compare; no hint
// about what failed. (Kept here — not inside the shared module — so the
// static security audit can verify the boundary at this call site.)
async function isAuthorized(req) {
  const { token: liveToken } = await resolveAuthorityToken(dataDir);
  return tokensEqual(bearerToken(req), liveToken);
}

const transport = createStateTransport({ isAuthorized });

const server = createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (await transport.handleRequest(req, res, url)) return;
  res.writeHead(404).end("not-found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[tidebound] state-transport server on http://127.0.0.1:${port}`);
  console.log(`[tidebound] publish route: authority-token ${tokenGenerated ? "generated" : "loaded"} (never printed)`);
});
