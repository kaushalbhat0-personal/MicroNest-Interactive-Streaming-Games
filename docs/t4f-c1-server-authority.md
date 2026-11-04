# T4F-C1 — Server-Side Authority Migration + Transport Security: Implementation Report

## 1. Verdict

**PASS WITH CARRYOVER — SOLE SERVER AUTHORITY VERIFIED**

The authoritative Tidebound runtime now lives in a persistent server
process. The dashboard is a token-gated control client that constructs no
simulation; both renderers remain read-only subscribers on the unchanged
T4F-B snapshot/SSE protocol (plus credential gating). Dashboard refresh,
navigation, and closure no longer reset the game. All 1070 tests pass,
TypeScript and production build succeed, and live Chromium verification
confirms control actions, shared revisions, vote parity, and lifecycle
survival with zero page errors.

Carryovers: no OBS/encoder work, no real broadcast, no 30 FPS / 30-minute
soak claims (T4F-C3 gates); token provisioning is operator paste
(T4F-C2 may add a friendlier pairing flow).

## 2. Architecture before/after

Before (T4F-B):

```text
dashboard page = authority (engine, loop, YouTube, announce, publisher)
  → POST /api/state/publish (open) → state-server :3003 → renderers
```

After (T4F-C1):

```text
YouTube chat → sidecar :3002 (unchanged)
  → AUTHORITY SERVER :3004 (sole engine, queue, session, ballots, clock,
     tick loop, feed/banners, ingest, announce, snapshots, persistence)
  → POST /api/state/publish (Bearer) → state-server :3003 (read-only fan-out)
  → dashboard control client (preview + panel, zero simulation)
  → landscape overlay.html 1920×1080 + portrait ?format=portrait 1080×1920
```

`src/app.ts` lost `createRuntime` (~570 lines deleted); panel rendering
(`wirePanel`/`renderPanelState`) is untouched and fed by a `Runtime` view.
`src/main.ts` boots one preview game + `ServerRuntime` (control API only)
+ snapshot-following canvas. `src/authority/publisher.ts` (browser
publishing) is deleted — no browser page publishes anything.

## 3. Authority lifecycle

States: `starting → recovering → running ⇄ paused`, plus `stopped`
(clean shutdown) and `failed` (unrecoverable, exits non-zero). Exposed on
public `GET /api/authority/status` with session, worldRev, timers,
queueSize, `recoveredFrom`, `persistFrom`.

- Single authority per process (module guard; double start throws) and
  per data dir (lockfile `data/authority.lock` with live-pid check;
  second process exits 1 with "already running"; stale locks taken over
  with a warning — both tested).
- Every timer is registry-tracked (pump 250ms, publish 400ms, YT status
  3s, debounce one-shots); `stop()` drains all, flushes a save, closes
  sockets (`closeAllConnections` before `close`), releases the lock.
  Verified: timer count returns to 0.
- Shutdown: SIGINT/SIGTERM → stopped → exit(0).

## 4. Persistence and recovery guarantees

Persisted: world save (`data/world-state.json`, validated by the existing
`normalizeWorld`), authority token (`data/authority-token.json`, 0600),
YouTube cursor (`data/authority-cursor.json`). Ephemeral: session,
ballots, vote clock, queue, storyLog, feed/banners, announce map, source
selection (safe default: simulation).

- Valid save → same session identity across reboots (tested: streamCount
  + deeds preserved, sessionId identical).
- Corrupt save → explicit fresh genesis flagged `corrupt-save-fresh`
  (tested; never silent, never a crash).
- Missing save → `fresh-genesis`. Reload/recover paths set `recovering`
  transiently. Crash-safe recovery beyond file validation is NOT claimed.

## 5. Security changes and threat boundaries

- `POST /api/state/publish` now requires `Authorization: Bearer <token>`
  (constant-time compare, header only — query tokens rejected with 401).
- All 17 control mutations + the dashboard readout require the same
  token; only `/api/authority/status` is public (counters only).
- Token resolution: `AUTHORITY_TOKEN` env (tests) else generated 32-byte
  hex persisted 0600 (gitignored via `data/*.json`). Never logged,
  never returned, never in snapshots/SSE/URLs; absence verified by tests
  across status/dashboard/snapshot/SSE payloads.
- Bodies capped (64KB control, 512KB publish), per-endpoint schema
  validation (400s), no token oracle (uniform 401s).
- Client bundles contain no token file/env access, no publish route, no
  `import.meta.env` secrets (static audits). All servers bind 127.0.0.1
  (state-server hardened to loopback in this phase).
- Threat boundary, stated plainly: same-origin renderer pages and any
  party without the token can only read. The operator-held dashboard
  token is dev provisioning (paste once); production pairing is T4F-C2.

## 6. Dashboard migration

- Zero `new GameEngine/EventQueue/YouTubeSource` + zero `.pump/.tick` in
  `app.ts`, `main.ts`, `dashboard/*` (audited). The single preview
  `Phaser.Game` moved to `main.ts` (still exactly one).
- `ServerRuntime` (`src/dashboard/server-runtime.ts`, the only browser
  module allowed to fetch) implements the `Runtime` view: read views
  over the control-plane cache; all 14 mutations POST and return the
  server's outcome strings. Failures surface as explicit strings
  (`authority-unreachable`, `unauthorized — set the authority token in
  Settings`) — outcomes are awaited before flashing, never fabricated.
- `app.ts` control methods are now `Promise`-based; all call sites await.
  Panel rendering, DOM ids, T4E format behavior, and copy buttons are
  unchanged (dashboard still shows both renderer URLs + per-renderer
  status + worldRev, now server-sourced).
- New Settings card: authority lifecycle line, token password field +
  save, status line. Boot waits for an accepted token before wiring the
  panel (no crash states, no fake data).

## 7. Renderer separation

Unchanged code, strengthened guarantees: renderers still subscribe to
snapshot + SSE only, still construct no authority objects (boundary
tests intact and extended), still never POST. The publish endpoint they
don't call is now credential-gated anyway (defense in depth).

## 8. YouTube integration

Ingestion and announcements moved server-side with T3 behavior
preserved: same OAuth scopes (sidecar untouched), same whitelist +
ballot path (`castSessionVote`, latest-wins), same event identities
(`vote:<session>:<vote>:open|close`), same serialized send with sidecar
dedupe/rate-limit/typed errors/`uncertain` handling, same retry
semantics (verbatim text, no vote mutation), same `na-simulation`
statuses when source is simulation. Single SSE subscription guarded
(`if (ytReader) return` — double source-switch yields one connection,
tested). Dashboard refresh/close cannot duplicate listeners (nothing
subscribes in the browser anymore). No real messages sent; all sends in
tests go to a stub. Source selection is server state (safe default
simulation across restarts).

## 9. Snapshot protocol compatibility

Fully preserved: SnapshotV1 shape, protocol v1, worldRev semantics,
monotonic seq, session identity, 50-deep replay, heartbeats, stale
rejection, gap recovery, slow-subscriber recovery-drop, epoch
re-adoption. Visible changes still bump worldRev (verified live:
command 46→47-class transitions, vote open/close). Privacy contract
intact (same sanitizers; control-plane full world/ballots/actorIds stay
behind the token-gated keeper channel, never in snapshots/SSE —
asserted by no-token-echo tests).

## 10. Test totals and failures

**46 files / 1070 tests, all passing** (T4F-B baseline 1036 + 34 net new;
`tsc --noEmit` clean; `vite build` succeeds; no failures).

- `tests/t4f-c1-authority.test.ts` (11): in-process double-start refusal,
  cross-process lockfile refusal, stale-lock takeover, deterministic
  reboot identity, corrupt/missing-save behavior, headless rev advance
  + pause lifecycle, command→vote→close with announcement identity,
  single ingest subscription, server-to-server publish, no credential
  leakage.
- `tests/t4f-c1-security.test.ts` (14): token helper (env/file/weak/
  parse/compare), full 17-endpoint auth matrix, malformed/oversized
  bodies, authed flows, static audits (proxy mapping, loopback binds,
  client-bundle hygiene, constant-time compares).
- `tests/t4f-c1-dashboard.test.ts` (8): no simulation construction in
  browser entries, fetch confined to the client module, single preview
  game + snapshot preview, server-confirmed outcomes, full route list,
  async panel methods, auth-card surface + copy.
- Migrated pins (same strictness, relocated ownership, each noted
  inline): interval/game counts in dashboard-activity/-settings/
  -control/-overview/-shell/-hardening + format-t4e; persistence
  payload pin; `parseOverlayFormat` ownership; boundary authority
  section (zero browser construction, one server engine/loop); transport
  publish auth (+401 cases). No test was weakened to pass.

Browser (Chromium, full-fidelity vite proxy): **13/14 checks, zero page
errors, zero console errors**. Token accept, lifecycle display, shared
rev (46/46), one command rendered in both outputs, shared vote prompt,
dashboard refresh/close/reopen with session continuity (`stream-1`,
rev monotonic), dual-output block. The single miss (portrait-reload
resubscribe poll) starved under SwiftShader contention; the post-reload
screenshot proves convergence (open vote + full feed at current rev),
and the reconnect code path is unchanged + covered by T4F-B suites.

## 11. Performance measurements

Local dev machine only (no creator-HW claims; 30 FPS + soak stay T4F-C3):
- Authority process: worker ~30 MB working set / ~71 MB private
  (+ tsx parent ~9/55 MB) at worldRev ~48 with subscribers.
- Control-plane payload 5988 B; snapshot 5539 B (1 s poll + change-gated
  publish are cheap on loopback).
- Command click → both renderers painted: ~8.3 s wall in the harness
  (≈6 s hidden-button wait + server budget of 250 ms tick + 400 ms
  publish cadence); first snapshot <250 ms after authority boot.
- Authority status under load: `{worldRev: 48, timers: 2, queueSize: 0,
  lifecycle: running}`; replay buffer bounded at 50; SSE backlog 50
  with recovery-drop (unchanged).
- No duplicate loops/timers (registry count exposed and tested).

## 12. Files created and modified

Created: `server/authority-server.ts`, `server/authority-token.mjs`,
`server/authority-token.d.mts`, `src/dashboard/server-runtime.ts`,
`tests/t4f-c1-authority.test.ts`, `tests/t4f-c1-security.test.ts`,
`tests/t4f-c1-dashboard.test.ts`, `docs/t4f-c1-server-authority.md`,
`screenshots/t4f-c1/*` (3 PNGs). Deleted: `src/authority/publisher.ts`
(superseded; no browser page publishes).

Modified: `src/app.ts` (−createRuntime, async control methods, view
interfaces, no fetch), `src/main.ts` (server-backed boot + preview),
`src/dashboard/settings.ts` untouched (auth card is markup-only in
`index.html`), `index.html` (+authority card), `server/state-server.mjs`
(loopback bind + Bearer gate), `vite.config.ts` (+`/api/authority`
proxy), `package.json` (+`authority-server` script, tsx devDependency;
`dependencies` still exactly `["phaser"]`), 7 pinned test files
(migration notes), `tests/t4f-b-boundary.test.ts`,
`tests/t4f-b-transport.test.ts`.

Untouched: engine rules, content, art, vote semantics, feed/banner
copy, HUD, sidecar/OAuth/moderation, persist-server, all saves.

## 13. Git integrity confirmation

Branch `main` @ `79a363c` (unchanged); all pre-existing modifications
preserved; T4F-B work intact underneath. No commits, pushes, stashes,
resets, cleans, or checkouts. Pre-existing `data/world-state.json` was
never written by C1 verification (isolated temp data dir used).

## 14. Remaining risks

1. Operator-paste token provisioning is usable but spartan; rotation/
   pairing UX is future work (T4F-C2).
2. Subscriber counts are eventually consistent (closed SSE sockets drain
   asynchronously) — cosmetic only.
3. Sidecar-down behavior is fail-closed (`DISCONNECTED/
   sidecar-unreachable`) and chat during authority downtime is missed
   (cursor resumes only buffered history) — documented limits.
4. `vite preview` does not apply dev proxies (pre-existing workflow
   note); verification used `vite dev` like the existing workflow.
5. Four servers for dev (persist, youtube, state, authority) — could be
   consolidated later; each has one job today.

## 15. Exact next recommended phase

**T4F-C2: creator-machine delivery** — (1) token pairing/rotation UX +
production secret posture; (2) OBS dual-feed setup + YouTube
dual-encoder workflow (keys, canvases, rehearsal checklist); (3) optional
server consolidation; (4) hand off to **T4F-C3: sustained-30-FPS +
30-minute dual-output soak on the GTX 1650 / 8 GB creator box**. Do not
start T4F-C2 here. Do not claim OBS or dual-encoder readiness.
