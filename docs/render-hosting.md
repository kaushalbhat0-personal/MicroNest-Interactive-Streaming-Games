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

- `vercel.json` rewrite `/api/:path*` → Render `/api/:path*` (placeholder
  domain). Same-origin browser calls, no frontend change, secrets stay in
  the Authorization header (forwarded by the rewrite).
- `CORS_ORIGINS` (comma-separated explicit origins, e.g.
  `https://tidebound-dash.example.com`). Production boots fail without it.
- Render env names: `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT` (injected),
  `PERSISTENCE_BACKEND=postgres`, `DATABASE_URL` (Neon **pooled** TLS URL),
  `AUTHORITY_TOKEN` (shared with state transport embedded — same process),
  `STATE_TRANSPORT=embedded`, `CORS_ORIGINS`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
  `GOOGLE_TOKEN_ENCRYPTION_KEY`, `DASHBOARD_URL`. Which service needs each:
  ALL on the single Render service; Vercel needs none (static + rewrite).
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
  `/api/youtube/oauth-callback` URL (see placeholder above).

## 3. Remaining cloud-only verification (D1-E+, NOT this phase)

Neon provisioning, Render staging deploy + health check, Vercel rewrite
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
