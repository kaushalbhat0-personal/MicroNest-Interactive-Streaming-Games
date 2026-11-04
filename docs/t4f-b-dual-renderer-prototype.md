# T4F-B — Shared Authority + Dual Renderer Prototype: Implementation Report

## 1. Verdict

**PASS WITH CARRYOVER — CORE ARCHITECTURE VERIFIED**

One authoritative Tidebound runtime drives two independent read-only
renderers (landscape 1920×1080, portrait 1080×1920) from a single
state/event pipeline. No duplicate simulation, ingestion, votes, commands,
or announcements. All 1036 tests pass (971 pre-existing + 65 new), the
production build succeeds, and live Chromium verification confirms shared
revisions, vote/feed parity, and reconnect recovery on both outputs.

Carryovers (not failures — explicitly out of scope for a prototype):
browser-memory authority (no server-side migration yet), localhost-only
transport without an authority credential, and OBS/YouTube encoder delivery
untouched. No production readiness is claimed; no dual-encoder or OBS
dual-feed emission is claimed or verified.

## 2. Architecture implemented

```text
                    YouTube chat
                         |
                  ONE ingestion path (dashboard page only)
                         |
              AUTHORITATIVE RUNTIME (keeper console, index.html)
              GameEngine + EventQueue + WorldState (src/app.ts)
              StreamSession + ballot box + vote clock (engine/lifecycle)
              ViewerFeedStore + BannerQueue (presentation/viewer-feed)
              YouTubeSource ingestion + announcement sender (sole)
              Persistence writes (WorldStore)
              Vote announcement + retry logic
                         |
              change-gated publisher (src/authority/publisher.ts)
              versioned snapshot, worldRev on coherent change only
                         |  POST /api/state/publish
                         v
              STATE-TRANSPORT SERVER (server/state-server.mjs :3003)
              monotonic seq · bounded replay buffer (50) · SSE fan-out
              read-only for renderers (no mutation endpoints exist)
                         |
              Snapshot (GET /api/state/snapshot) + Sequenced SSE
              (GET /api/state/stream?since=&format=) + status
                         |
              +----------+----------+
              |                     |
         LANDSCAPE              PORTRAIT
         RENDERER               RENDERER
         overlay.html           overlay.html?format=portrait
         1920×1080              1080×1920
         one Phaser.Game        one Phaser.Game
         read-only subscribe    read-only subscribe
              |                     |
         OBS SOURCE L           OBS SOURCE P
         (creator adds these; prototype does not configure OBS)
```

Deviation from the T4F-A sketch (deliberate, documented): the authority
lives in the keeper-console dashboard page (browser memory), not in a
server process — the same place it lived before this prototype. The
publisher is additive: the dashboard keeps its existing game canvas and
console behavior byte-for-byte; the overlay pages changed from
second-simulation owners into pure subscribers. Server-side authority
migration is the stated T4F-C candidate, not a silent assumption.

## 3. Authority/renderer ownership boundaries

Authority owns (exactly one of each, all in the dashboard page):
GameEngine + WorldState, EventQueue + command processing, the 250ms
pump/tick loop, StreamSession + ballot box + vote clock + auto-close,
FeedAggregator + ViewerFeedStore + BannerQueue, YouTubeSource ingestion,
vote announcement + retry, persistence writes, and the sole state
publisher (`createStatePublisher`, attached once, dashboard only).

Each renderer owns: one Phaser.Game, one GameScene, its format's
presentation config, a read-only snapshot/SSE subscription, and local
animation/reduced-motion behavior.

Renderers do NOT own (mechanically enforced by
tests/t4f-b-boundary.test.ts, which scans file text — not comments):
GameEngine, EventQueue, command ingestion, YouTubeSource, ballot
mutation (`cast/open/closeSessionVote`), vote clock, simulation pump/tick
(`.pump(`, `.tick(`, `.ingest*`), persistence writes (`store.save(`),
announcement sending, or the publish endpoint (no POST in renderer code).
Renderer + shared modules never value-import authority-only modules
(`import type` is erased and allowed). The renderer's 1s scene re-sync is
presentation-only (wall-clock shield expiry between snapshots); it calls
nothing but `GameScene.syncWorld`.

Entry points: `src/main.ts` → authority (`createRuntime({withPanel:true})`
+ publisher); `src/overlay.ts` → renderer (`bootRenderer()` only, no
`createRuntime`). `src/app.ts` still constructs exactly one
`new Phaser.Game(` (pinned by the existing T4E test) — the authority's
console preview; each renderer page constructs its own single game.

## 4. Snapshot and event schema

Protocol version 1 (`SNAPSHOT_PROTOCOL` / `TRANSPORT_PROTOCOL`;
anything else is refused into a safe waiting state).

`SnapshotV1` (`src/shared/snapshot.ts`):
`v, sessionId, streamNumber, sessionPhase, worldRev, atIso`,
sanitized `world`, `uniqueSearcherCount`, `paid` census
`{applied, compensated, noted, total}`, public `vote` (VoteModel:
phase/id/prompt/options with label+command+votes+leading/totalBallots/
commandsProcessed/maxCommands/clockProgress/closingSoon/winner*),
`storyLog`, `feed` (FeedEntry text/count/action), `recent` (GameResult
minus `actorId`), `viewerFeed` (prebuilt items), `banner` (or null),
`paused`.

Privacy (by construction, tested): `uniqueSearchers` → length-preserving
`"viewer"` placeholders (reef lanterns keep working, actor ids never
travel); `paidLedger` → `[]` + `totalPaidMinorUnits` → 0 (actor ids,
platform ids, amounts, currency, tiers never travel); private ballot maps
never travel (only the public tally); `GameResult.actorId` stripped.
Public display names and fictional outcomes travel only where the existing
HUD/feed logic renders them.

Transport events (`server/state-server.mjs`): `state` (full snapshot +
seq), `heartbeat`, `recovery` (replay impossible → refetch), `:ping`
comments. Renderer deliveries are classified per event: apply (next seq),
stale (≤ cursor or older worldRev → ignored), gap (> cursor+1 → refetch).
A lower-seq snapshot that is NOT stale (server restart epoch) is applied
and the cursor re-adopted — never a wedge.

## 5. Revision semantics

`worldRev` starts at 1 on first publish and bumps iff
`revisionSignature()` changes (implemented in
`src/shared/snapshot.ts`, rules in `REVISION_RULES`). A published
revision is built atomically from one refresh, so it always represents
one coherent transition.

Bumps: applied commands/paid catalysts, world-changing ticks (enemy
attacks, threat decay), progression (arc/chapter/deeds/flags/meters/
locations), vote open/ballot/clock/close/winner, feed item ids, current
banner id, session identity/phase, pause. Never bumps: persistence,
announcement delivery, connection state, timestamps (`atIso` excluded),
identical republish (still broadcast with a fresh seq for late joiners).

## 6. Transport endpoints and recovery behavior

Host: `server/state-server.mjs` (Node builtins only, sibling to the
persist server — not mixed into it), default port 3003, proxied as
`/api/state` by vite (`/api/youtube` and `/api` proxies untouched).
`npm run state-server`; `npm run dev:dual` starts persist + state + vite.

- `POST /api/state/publish {protocol:1, snapshot}` → `{ok, seq}`.
  Validates 512KB cap (413), protocol (400), shape (400); rejects stale
  worldRev (409, never rewinds). Bounded replay buffer (50 snapshots).
  Slow subscribers get `recovery` and are dropped — the authority is
  never blocked.
- `GET /api/state/snapshot` → `{seq, snapshot}` | 404 `no-snapshot`.
- `GET /api/state/stream?since=&format=` (SSE) → ordered replay of
  retained `seq > since`, `recovery` when the cursor predates the window
  (off-by-one fixed: `since=0` with a fresh buffer replays, recovers
  only on real loss), then live events + heartbeats; per-format
  subscriber counts; cleanup on disconnect.
- `GET /api/state/status` → protocol/seq/worldRev/snapshotAt/
  subscribers/buffer — dashboard readout, read-only.

Renderer recovery (`src/renderer/transport-client.ts`): gap → refetch
`/snapshot`, resume from its seq; stale → ignored; protocol mismatch →
waiting state; heartbeat stall (45s) → resubscribe; backoff reconnect
(1s→15s cap). Unavailability → disconnected notice; **no simulation
fallback exists in renderer code** (asserted by test + live probe).

Authority lifecycle limits (stated, with safe states): authority refresh/
close ends the game (browser memory); renderers keep the last good frame
with a waiting notice; authority restart publishes a new sessionId and
renderers fully resync; renderer refresh/disconnect never touches
authority state.

## 7. Landscape and portrait URL behavior

Same page, format-selected, same as before: `overlay.html` (landscape
1920×1080) and `overlay.html?format=portrait` (portrait 1080×1920).
Both subscribe to the same authority; `?format=` also labels the
server-side subscriber count and `?transparent=1` still works.
`?debug=1` keeps the connection pill visible for verification (it hides
while live so the broadcast frame stays clean).

Reuse: `GameScene`, `hud.renderOverlay` (+ additive optional public-vote
override — existing callers unchanged), `viewer-feed` projections,
`tidebound-presentation` projections, `tidebound.css`, keeper assets and
anims. No HUD redesign, no layout changes, no game logic in renderers.
Renderer animation replays for newly seen results are bounded (3 per
snapshot, oldest-first, deduped) — animation progress may differ while
event identity, order, and state stay identical.

## 8. Dashboard changes

- New "Dual-output status" block in the OBS card: authoritative revision
  (+ publish/seq counts), per-renderer subscription lines, transport
  reachability. Copy explicitly states that copying a URL never
  configures OBS/YouTube and that encoder delivery is a separate step.
- Format card reframed from mutually-exclusive runtime mode to preview
  preference ("opening either never restarts the stream session");
  honesty denials preserved; stale "restarts the stream session" claims
  in the format card and troubleshooting note corrected for the new
  resubscribe-and-catch-up behavior. All T4E-pinned strings kept.
- Publisher syncs the block every publish + every 2s (guarded DOM
  writes; renderers have no such nodes → no-ops).

## 9. Tests added and exact results

New suites (65 tests, all passing):
- `tests/t4f-b-snapshot.test.ts` (18): contract shape, privacy strips
  (actor ids, ledger, amounts, ballots, actorId), revision bump rules
  (commands, votes, pause, feed/banner; timestamps never), validation +
  staleness, session stub.
- `tests/t4f-b-transport.test.ts` (12): pure sequencing core
  (classify/cursor/backoff), delivery decisions (apply/ignore/refetch/
  epoch adoption), and live state-server integration on port 31313:
  404-before-publish, publish validation (protocol/shape/since),
  monotonic seq, stale rejection, status, ordered replay + live fan-out,
  recovery on cursor predating the 50-deep buffer.
- `tests/t4f-b-parity.test.ts` (8): one command → one result, redelivery
  collapse, vote opens once/closes once, identical worldRev + paint
  fingerprints across a transport round-trip, matching prompt/tally/
  winner, single feed appearance with stable ids, banner identity,
  tick/progression reflection.
- `tests/t4f-b-boundary.test.ts` (10): single GameEngine/YouTubeSource/
  pump/publisher in authority; renderer+shared import boundary
  (comment-stripped, segment-aware); no simulation/mutation constructs
  or POSTs in renderer code; overlay entry boots the renderer only.
- `tests/t4f-b-recovery.test.ts` (7): mid-vote refresh convergence,
  closed-vote convergence, forced gap → refetch, stale rejection,
  protocol refusal, unreachable-authority → disconnected wording with
  "never simulate", GET-only client.
- `tests/t4f-b-layout.test.ts` (10): renderer dims, fallback, overlay
  markup + live-pill hiding, entry wiring, reduced-motion presence,
  dashboard dual block + copy honesty, format-card reframe.

## 10. Existing regression results

Baseline before implementation: 37 files / 971 tests passing.
After: **43 files / 1036 tests, all passing** (`npm test`), `tsc
--noEmit` clean, `vite build` succeeds (overlay + main entries).
No existing test was modified, weakened, or deleted. T4D/T4E contract
tests (feed/banner/layout/honesty) pass untouched.

## 11. Browser verification and screenshots

Live Chromium (Playwright 1.64.1, `--no-proxy-server` required by the
local system proxy for loopback) against vite :5173 + persist :3001 +
state :3003. Harness kept in temp (`t4fb-verify/`, not part of the repo);
raw log in `results.json` there.

- Dashboard boots as authority; first snapshot published within ~250ms
  of dashboard load (~10ms in the best run); page owns `__tbGame`;
  overlay pages expose `__tbRenderer` and no `__tbGame`.
- Landscape + portrait subscribe to the same authority and share the
  worldRev (observed `rev=7/7 seq=10/10` on first contact).
- One `#btn-command` click bumps exactly one revision on both outputs
  (`rev 7→8/8`); feed event `cmd-mw2i8joa-1` carried once in the shared
  snapshot with stable ids.
- Route vote opens once; the prompt ("Which road through the Pale?")
  matches across outputs; tallies/winners come from the same snapshot.
- Portrait reload mid-vote resubscribes and converges (`rev=9/9`,
  no reset); landscape close/reopen converges (`rev=9/9`).
- Dashboard dual block shows `worldRev 9 · 3 publish(es) · seq 12`,
  per-renderer subscriptions, and transport reachability.
- Reduced-motion portrait (dedicated probe): CONNECTED in ~2s,
  1080×1920 canvas booted, HUD painted, zero page errors.
- Zero page errors on all surfaces. One benign console line: a 409 on
  first contact between a fresh authority and a server holding an older
  run's revision — the designed stale-revision guard; the publisher
  rebased and continued (`worldRev 9 · 3 publish(es) · seq 12`).
- 17/19 harness checks passed outright; the 2 misses were 25s
  initial-subscribe polls starved by SwiftShader software rasterization
  (three full-res Phaser canvases), and both surfaces were proven by
  every downstream check plus the dedicated RM probe above.

Screenshots: `screenshots/t4f-b/landscape-live.png`,
`portrait-live.png`, `dashboard-dual.png`,
`portrait-reduced-motion.png` — landscape and portrait show the same
chapter/stream/HP/vote/feed at `worldRev 9 · seq 12`; the RM shot shows
the same world at `worldRev 10 · seq 13` with a live canvas.

## 12. Performance measurements and limitations

Measured on this machine (NOT the creator's GTX 1650 / 8GB Windows box —
no creator-machine benchmarks are claimed):
- Renderer FPS (headless SwiftShader software raster, rAF over 2.5s):
  landscape 3.6, portrait 2.9. This is an environment lower bound (three
  full-resolution Phaser canvases on a software GL); the 30 FPS target
  stays a creator-hardware gate for T4F-C.
- Command-to-both-renderers latency: ~1158ms end-to-end in this
  environment (dashboard click → same worldRev painted in both pages;
  dominated by the 250ms engine tick + 400ms publisher poll + harness
  poll granularity, not by transport).
- Heap (Chromium `performance.memory`): landscape 20 MB, portrait
  26 MB, dashboard 21 MB — no leak signal; all renderers stay mounted
  for the session by design.
- Event backlog: bounded everywhere (engine queue cap, feed history 30,
  banner 3 pending + 1 visible, transport replay 50, per-subscriber
  backlog 50 with recovery-drop instead of blocking).
- Reconnection recovery: resubscribe + snapshot refetch converged on
  the first post-reload snapshot in both the portrait-reload and
  landscape close/reopen probes; exact wall-time is
  environment-dependent (CPU-starved here) and was not pinned to a
  millisecond claim.
- 30 FPS sustained + 30-minute dual-output soak on the creator machine
  remain later release gates (T4F-C criteria), explicitly not claimed.

## 13. Known gaps

1. Browser-memory authority: dashboard refresh/close restarts the game.
   Safe waiting states implemented; server-side migration is T4F-C.
2. Localhost-only transport without an authority credential: any local
   page can POST snapshots. Documented; needs auth before any hostile
   network. The server runs no simulation and influences no game state.
3. No OBS/encoder work: URLs must be added as Browser Sources by hand;
   dual-encoder delivery untouched.
4. Publisher poll (400ms) sets the latency floor; intermediate revisions
   between polls batch into one publish (renderers replay animations
   from the retained `recent` list — no event loss, bounded replays).
5. Snapshot payloads (~tens of KB) broadcast whole per revision; no
   delta encoding in the prototype.
6. `vite preview` does not apply dev proxies (`/api/*` need the sidecar
   servers + proxy); verification used `vite dev`, like the existing
   workflow.

## 14. Exact files modified/created

Created: `src/shared/snapshot.ts`, `src/shared/transport-core.ts`,
`src/authority/publisher.ts`, `src/renderer/transport-client.ts`,
`src/renderer/apply-snapshot.ts`, `src/renderer/renderer.ts`,
`server/state-server.mjs`, `tests/t4f-b-snapshot.test.ts`,
`tests/t4f-b-transport.test.ts`, `tests/t4f-b-parity.test.ts`,
`tests/t4f-b-boundary.test.ts`, `tests/t4f-b-recovery.test.ts`,
`tests/t4f-b-layout.test.ts`, `docs/t4f-b-dual-renderer-prototype.md`
(this file), `screenshots/t4f-b/*` (4 PNGs).

Modified (additive only; pre-existing dirty content preserved):
`src/overlay.ts` (clean file: renderer entry), `src/app.ts` (+import,
+7-line publisher attach), `src/presentation/hud.ts` (+optional public
`vote` override), `index.html` (+dual block, +format-card reframe,
+troubleshooting correction), `overlay.html` (+status pill),
`vite.config.ts` (+`/api/state` proxy), `package.json` (+`state-server`,
+`dev:dual` scripts).

Untouched: all engine rules, content, art, vote semantics, command
mappings, feed copy, banner priorities, OAuth scopes, moderation copy,
existing tests, `data/`, `server/youtube-*`.

## 15. Git integrity confirmation

Before: branch `main` @ `79a363c`, 18 modified + 23 untracked files
recorded; no commits/pushes/stashes/resets/cleans/checkouts performed
during this prototype. After: `git status --short` shows only the files
listed in §14 as added/modified on top of the pre-existing entries;
`git diff --stat` for pre-existing files shows only the additive hunks
above. Full command list in §16 of the final response.

## 16. Recommended T4F-C scope

1. Server-side authority migration (game survives dashboard refresh;
   renderers unaffected) with persistence + YouTube attach.
2. Authority credential for `/api/state/publish`; renderer TLS posture.
3. OBS dual-feed delivery + YouTube dual-encoder workflow (keys,
   canvases, rehearsal checklist) — the actual emission gate.
4. Creator-machine soak: sustained 30 FPS + 30-minute dual-output on
   the GTX 1650 / 8GB box.
5. Transport deltas + publish batching review if payload/latency
   budgets tighten. Do NOT start T4F-C here.
