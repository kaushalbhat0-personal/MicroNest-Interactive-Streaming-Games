# Render Hosting Contract — Tidebound (T4F-C2.7-D1-D)

One Render web service (authority + embedded state transport + YouTube
ingestion/announcements + OAuth + persistence). Vercel hosts the dashboard
and overlays. Neon hosts PostgreSQL. OBS loads Vercel overlays. The local PC
is dev/build only.

> PLACEHOLDERS — no production domain exists yet. `vercel.json` points at
> `https://tidebound-api.example.com` and `GOOGLE_REDIRECT_URI` shows
> `https://tidebound-api.example.com/api/youtube/oauth-callback`. Replace
> both with the real Render service URL when it exists (same value in both
> places). Never commit real secret values.

## 1. Locally verified behavior

- Single-port composition: `STATE_TRANSPORT=embedded` serves authority
  control (`/api/authority/*`), OAuth start/callback/status, state snapshot
  (`/api/state/snapshot`), status, and SSE stream (`/api/state/stream`,
  replay/recovery/heartbeat unchanged) from ONE listener. External mode
  (`STATE_TRANSPORT` unset) preserves the historical two-process dev
  topology bit-for-bit (authority `:3004` + standalone state server `:3003`).
- SnapshotV1 contract, seq/replay/recovery, renderer read-only access,
  bearer auth, T3 command semantics, OAuth scopes, event identity: unchanged
  (full Vitest suite green, T3/T4F regressions green).
- Health: `GET /api/healthz` → `{ok:true}` (liveness). `GET /api/readyz` →
  200 ready (running/paused, incl. degraded with explicit
  `persistence:{backend,from,degraded:true}`) or 503 not-ready. No tokens,
  URLs, or paths in either payload.
- CORS allowlist: dev defaults to Vite origins; unknown origins get 403
  (preflight and actual); requests without Origin proceed (health checks).
- Listener validation: dev binds `127.0.0.1`; production requires
  `HOST=0.0.0.0` + Render-injected `PORT` (missing/invalid fails boot).
- Production startup rejects file persistence (`production-requires-postgres`)
  and requires `STATE_TRANSPORT=embedded`; postgres mode requires
  `AUTHORITY_TOKEN` env (never generated, never in DB).
- Production bundle: `npm run build` emits `dist-server/authority-server.mjs`
  (esbuild, ships with Vite — no new dependency); `npm start` runs it on
  plain `node` (no dev-only `tsx` at runtime). Verified boot + snapshot/SSE
  from the bundle locally.
- Graceful shutdown order: loops/ingestion → persist flush → SSE/heartbeat
  drain → socket drain → listener close → pg pool end → lock release.
- Dashboard inbound HTTP polling (1 s panel + 2 s transport/snapshot polls)
  is the intended Free-tier activity source. No keep-alive subsystem added.

## 2. Configuration prepared but NOT externally verified

- `vercel.json` rewrite `/api/:path*` → Render `/api/:path*`
  (`https://tidebound-api.onrender.com`). Same-origin browser calls, no
  frontend change, secrets stay in the Authorization header (forwarded by
  the rewrite). Method, body, query string, and error statuses pass through.
- `CORS_ORIGINS` (comma-separated explicit origins — must contain the exact
  Vercel production origin, e.g. `https://<app>.vercel.app`, plus any custom
  domain). Production boots fail without it. Required even though mutations
  go through the rewrite: the proxied `Origin` header is still checked by
  the authority, and direct state transport (below) needs it too.
- `CORS_ORIGINS` (comma-separated explicit origins, e.g.
  `https://tidebound-dash.example.com`). Production boots fail without it.
- Render env names: `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT` (injected),
  `PERSISTENCE_BACKEND=postgres`, `DATABASE_URL` (Neon **pooled** TLS URL),
  `AUTHORITY_TOKEN` (shared with state transport embedded — same process),
  `STATE_TRANSPORT=embedded`, `CORS_ORIGINS`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
  `GOOGLE_TOKEN_ENCRYPTION_KEY`, `DASHBOARD_URL`. Which service needs each:
  ALL on the single Render service; Vercel needs no secrets (static +
  rewrite), optionally `VITE_STATE_BASE_URL` (public backend origin, see
  "Vercel frontend" below).
- Neon pooled TLS: `pg` pool max 3, statement timeout 5 s, full-chain TLS
  (`rejectUnauthorized:true`) for non-loopback hosts.
- Migration: `ensureMigrated` runs `001_init.sql` at boot (idempotent);
  version mismatch fails boot. Single replica required (file lock +
  in-process single-flight do not span instances).
- Ephemeral filesystem: only the lock file + file-mode saves touch disk;
  postgres mode treats disk as scratch (world/credentials/cursors in Neon).
- SSE/cold-start: EventSource auto-reconnects; `since` replays the retained
  50-event window, older cursors get `recovery` → snapshot refetch; dashboard
  polling wakes a sleeping service; DB outage can never fresh-genesis
  (fail boot / degraded-continue per `server/persistence/storage.mjs`).
- OAuth redirect: Google Cloud console must list the Render
  `/api/youtube/oauth-callback` URL (`GOOGLE_REDIRECT_URI`).

## 3. Vercel frontend (D1-F2)

Static Vite hosting; the browser is a control client + read-only renderer.
Dashboard mutations stay on same-origin relative `/api/*` through the
`vercel.json` rewrite. Snapshot/SSE state transport may bypass the rewrite:

- Vercel settings — framework: Vite; build: `tsc --noEmit && vite build`
  (server bundle intentionally excluded — Render-only); output: `dist`;
  Node: 22.x (`engines`); install: default (`npm install`, devDeps
  included — do NOT set `NODE_ENV=production` in Vercel env or the build
  loses devDependencies exactly like the Render TS2688 failure).
- Optional `VITE_STATE_BASE_URL=https://tidebound-api.onrender.com`:
  snapshot + SSE resolve directly against Render, avoiding the external
  rewrite's ~120 s proxy lifetime on long-lived event streams. Unset →
  historical relative `/api/state/*` (local dev, rewrite deployments).
  Public origin only — never tokens, secrets, or database URLs (boundary
  tests enforce this). Trailing slashes normalized; invalid values fall
  back to relative. Wired through both entry paths (`src/main.ts` preview,
  `src/renderer/renderer.ts` overlays) via the existing
  `snapshotUrl`/`streamUrl` overrides; reconnect cursors, `since`/`format`
  params, backoff, and snapshot recovery unchanged.
- OAuth start MUST be direct-to-Render (D2.6, production `correlation-missing`
  root cause): the dashboard POSTs the start form to the absolute
  `{VITE_STATE_BASE_URL}/api/authority/youtube/oauth/start` built by
  `resolveOAuthStartUrl()` — never the relative Vercel route. The authority
  answers with `Set-Cookie: __Host-yt-oauth-corr`, and a `__Host-` cookie is
  owned by the request host: a Vercel-proxied start would store it on the
  Vercel hostname, which the Render callback
  (`/api/youtube/oauth-callback`) can never receive. The helper requires an
  HTTPS origin root (no path/query/fragment/userinfo); a missing or invalid
  origin fails visibly ("oauth start unavailable") instead of silently using
  the proxy. The bearer travels only in the POST body field, never the URL;
  POST method, `_blank` target, and all server-side correlation/callback
  validation are unchanged. In production `VITE_STATE_BASE_URL` is therefore
  effectively required for YouTube authorization (optional only for state
  transport).
- Render `CORS_ORIGINS` MUST contain the exact Vercel production origin
  (and any custom domain) — direct EventSource responses carry no
  credentials but browsers still enforce ACAO; unknown origins get 403 and
  overlays/snapshots fail closed. `DASHBOARD_URL` must be the Vercel URL
  (post-OAuth return link). `GOOGLE_REDIRECT_URI` stays the Render
  `/api/youtube/oauth-callback` URL (also registered in Google Cloud).
- Render Free spin-down: compatible as-is — EventSource reconnects with
  `since` replay/`recovery` refetch, dashboard polls (1 s panel / 2 s
  transport) re-wake the service. No keepalive, no extra polling.

## 4. Remaining cloud-only verification (D1-E+, NOT this phase)

Neon provisioning, Render staging deploy + health check, Vercel deployment
against the real Render URL, Google OAuth consent/redirect approval, live
broadcast discovery/polling/announcements, OBS rendering of live events,
Free-tier sleep/wake measurement, CU-hour/egress budgeting. Do NOT assume
Render Free is production-reliable — this phase proves compatibility only.

## Quick reference

| | Render (prod) | Local dev |
|---|---|---|
| Command | build: `npm ci --include=dev && npm run build` · start: `npm start` (see `render.yaml`; a bare `npm install` under `NODE_ENV=production` omits devDependencies and fails the build with `TS2688: Cannot find type definition file for 'vite/client'`) | `npm run dev:dual` + `vite` |
| Listener | `0.0.0.0:$PORT` (one) | `127.0.0.1:3004` + `:3003` |
| Transport | `STATE_TRANSPORT=embedded` | external (default) |
| Persistence | `PERSISTENCE_BACKEND=postgres` | `file` (default) |
| Runtime | Node 22 (`.nvmrc`, `engines`) | Node 22 recommended |
| Health | Render check → `/api/readyz` | — |
