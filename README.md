# Emberkeep — persistent living-world interaction prototype (Phase 1 + 2)

A minimal proof that **viewer actions → canonical events → queue → triggers →
persistent world/story state → visuals** can run a game for months without new
content. One hero, one keep, one enemy slot, primitive Phaser shapes — no art
pipeline, no backend framework.

Phase 2 adds a **read-only YouTube Live Chat ingestion spike**: the same engine,
untouched, can now be fed by real livestream chat alongside the simulator.

## Quick start

```powershell
npm install

# Terminal 1 — local file persistence (data/world-state.json)
npm run persist-server

# Terminal 2 — YouTube sidecar (optional; simulation works without it)
npm run youtube-server

# Terminal 3 — dev console with simulation panel
npm run dev
```

Open **http://localhost:5173/** — game on the left, dev simulation panel on
the right. Open **http://localhost:5173/overlay.html** for the clean OBS view
(unchanged by Phase 2 — no YouTube code, no credentials, no panel).

> The persist-server is optional: without it the app falls back to
> localStorage. With it, state lives in a real file and survives browser wipes.

## The 17-step demo

1. Launch (`persist-server` + `dev`), open `/`.
2. See the world: keep, hero, goblin, HP bars, threat, resources.
3. Viewer `Kaushal` → `!strike` → **Send Command**. Enemy flashes, HP drops.
4. Change viewer to `B` → `!mend`. Hero HP rises, green burst.
5. Five different viewers → `!scout` each (change viewer id each time).
   After the 5th unique scout: *"discovered something hidden beyond the
   forest"* — flag `forest_secret_discovered`, Whispering Woods unlocked.
6. Send **₹500** paid event → **ELITE Warlord Ghash** spawns, threat +25.
7. Many `!strike`s (vary viewer ids to dodge cooldowns) until the elite falls
   → threat −20, resources up, **chapter advances** (never an ending).
8. **Save World** (or wait 2s for autosave). Stop both terminals.
9. Restart both, reload `/` → exact same HP/threat/resources/arc/chapter.
10. Add as OBS Browser Source (below) → game stays readable; repeated attacks
    batch into *"4 viewers attacked the enemy!"*.

## OBS Browser Source

1. `npm run build` (or use dev URL).
2. Serve `dist/` (e.g. `npx vite preview`) or use the dev overlay URL.
3. OBS → Sources → **+ → Browser**:
   - URL: `http://localhost:5173/overlay.html?transparent=1`
   - Width **1920**, Height **1080**, FPS 30.
   - ✅ *Shutdown source when not visible* (saves CPU).
4. For transparency over gameplay footage: the `?transparent=1` flag makes the
   Phaser canvas transparent. (Scene art is dark by design for the prototype;
   chroma/luma key the dark background if you need full keying.)

## Architecture

```
viewer input (panel; later: chat)
  → canonical event {eventId, actorId, command|amount}   src/engine/types.ts
  → EventQueue (paid-first, deduped, bounded=100)        src/engine/queue.ts
  → GameEngine.pump() + tick()                           src/engine/engine.ts
      ├─ whitelist check (src/engine/config.ts COMMANDS)
      ├─ per-viewer cooldowns, global min-gap bound
      ├─ deterministic sim (fixed damage, counter variance — no RNG)
      └─ story beats (src/engine/story.ts) → flags, arcs/chapters, endless waves
  → FeedAggregator (visual batching, 1.5s window)        src/engine/feed.ts
  → Phaser GameScene (shapes + text, zero game logic)    src/phaser/GameScene.ts
  → WorldStore → file server → data/world-state.json     src/persistence/store.ts
                     (fallback: localStorage)
```

Key invariants: chat is **data** (only whitelisted tokens act); the engine has
no DOM/Phaser imports and is fully testable with an injected clock; the scene
only renders.

## Configuration (creator-facing)

- Commands: `COMMANDS` in `src/engine/config.ts` — token → what it does + cooldown.
- Paid tiers: `PAID_TIERS[currency]` in minor units — ₹50 strike / ₹100 supply /
  ₹500 elite / ₹1000 story. Currency-aware with a `DEFAULT` fallback.

## Tests

```powershell
npm test        # 40 deterministic tests (injected clock, mocked YouTube API)
```

Covers: attack/heal effects, cooldowns, duplicate IDs, paid priority, ₹500
elite, unique-searcher counting, secret unlock, save/restore round-trip,
restart-without-reset, invalid-event rejection, feed batching, elite-kill arc
advance.

## Known limitations (prototype)

- No real chat/platform input — panel simulates viewers.
- Single machine; file + localStorage only (no DB, by design for this phase).
- Dev page and overlay both read the save file; only the dev page writes.
- Enemy AI is a fixed-interval striker; no pathfinding (not needed for Phase 1).
- `dist/` Phaser bundle is ~1.5MB unminified-chunked — fine locally.

---

# Phase 2 — YouTube Live Chat ingestion spike (read-only)

```
YouTube Live
  → sidecar server/youtube-server.mjs (OAuth, discovery, polling, mapping)
  → SSE /api/youtube/stream (canonical events only, no secrets)
  → browser src/youtube/client.ts (whitelist pre-check + engine.ingest)
  → EXISTING queue → EXISTING engine → world/story → Phaser (all untouched)
```

## Official API mechanisms used

- **Discovery**: `GET liveBroadcasts.list?part=snippet&broadcastStatus=active&broadcastType=event`
  (exactly one of `broadcastStatus`/`id`/`mine` — never combined), ownership
  verified client-side via `channels.list?mine=true`, falling back once to
  `broadcastType=all` for persistent stream keys. Result: `snippet.liveChatId`.
- **Transport**: `GET liveChatMessages.list?liveChatId&part=id,snippet,authorDetails`
  with `pageToken`/`nextPageToken` continuation, honoring `pollingIntervalMillis`
  (clamped to a 10s floor / 30s ceiling for the spike). Quota: 5 units/call.
- **Events consumed**: `textMessageEvent.messageText` (commands), `superChatEvent`
  + `superStickerEvent` (`amountMicros` + ISO 4217 `currency`), everything else
  ignored. Stable dedup key: `yt:<messageId>`.
- **NOT used**: `liveChatMessages.streamList` (push). It is the officially
  recommended low-latency path, but it is **gRPC-only** (needs a generated client
  from `stream_list.proto` + grpc channel pooling) — disproportionate for a spike.
  Polling `list` is the documented REST alternative.

## OAuth setup (local, one time)

1. Google Cloud Console → enable **YouTube Data API v3** → create an **OAuth
   client (Desktop)** → download the JSON.
2. Save the download **as-is** (the `{"installed": …}` wrapper is accepted) to:
   - Windows: `%USERPROFILE%\.emberkeep\youtube-client.json`
   - macOS/Linux: `~/.emberkeep/youtube-client.json`

   (Or set `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` env vars instead.
   Never paste secrets into chat, and never put them inside the project:
   the browser dev server can reach project files, so secrets live in your
   user profile, outside the repo.)
3. `npm run youtube-server` → open `/`, switch **Input source → YouTube Live** →
   **1 · Authorize with Google** → consent in the opened tab (loopback callback
   on `127.0.0.1:3002`) → **2 · Connect to live chat**.
4. Tokens are stored in `~/.emberkeep/youtube-tokens.json` (chmod 0600) and
   refreshed automatically. Status badge shows DISCONNECTED → AUTH_REQUIRED →
   CONNECTING → LIVE_CHAT_FOUND → STREAMING, plus RECONNECTING / STREAM_ENDED /
   ERROR with reasons.

## Behavior notes

- The adapter forwards **any `!`-prefixed text** as a command *candidate* and all
  Super Chats/Stickers as `paid_event`s; the **engine stays authoritative** —
  unknown tokens are rejected, cooldowns/dedup/queue/tiers all apply unchanged.
- Micros → minor units honors zero-decimal currencies (JPY etc.).
- Reconnect: stale tokens → fresh page; transient errors → exponential backoff
  2s→60s, max 10 attempts, then ERROR. Ended chat → STREAM_ENDED + discovery
  retry every 60s.
- Dedup: engine `seen` set (in-memory) + stable `yt:` ids + SSE replay of the
  last-200 buffer by `Last-Event-ID` (browser also persists its last id). Full
  app-restart replay across YouTube history is a known edge (see limitations).
- Quota math: default 10,000 units/day ≈ 2,000 `list` calls/day. The 10s poll
  floor is a deliberate quota guard; request a quota increase for 24/7 use.
- Credential rule: the browser never sees client secrets or tokens — it only
  receives canonical events over same-origin SSE via the Vite proxy.
- Dev hook `POST /api/youtube/inject` replays a raw YouTube-shaped message
  through the mapper — manual end-to-end test without a live stream
  (disable with `YT_ALLOW_INJECT=0`).
- Removing `server/youtube/*` + `src/youtube/client.ts` leaves a fully working
  simulation game: the engine has zero YouTube references (verified by grep).

---

# Phase 3 — real-YouTube validation + ingestion hardening (no live creds available)

**Status: REAL LIVE VERIFICATION NOT AVAILABLE.** No YouTube credentials or test
broadcast were provided in this environment, so no real livestream was tested.
Everything below separates what was verified locally from what was not.

## What changed (hardening only, zero new gameplay)

- **Currency correction** (`src/engine/config.ts`, `src/engine/engine.ts`):
  tier comparison is now currency-aware via `toTierUnits()` — zero-decimal
  currencies (JPY, KRW, …) scale ×100 before comparing against tier thresholds,
  so ¥500 correctly reaches elite. INR behavior is byte-identical
  (`formatPaidLabel` keeps `₹500 INR`). No currency conversion anywhere.
- **Restart cursor** (`server/youtube/adapter.mjs`): best-effort checkpoint
  `data/.youtube-cursor.json` (0600, gitignored) recording the newest observed
  platform message per live chat. After a sidecar restart, already-observed
  history is skipped (exact id match → slice; otherwise timestamp filter) —
  not an event ledger, just a resume pointer. Visible in `/status` as `cursor`.
- **Token persistence for refresh** now covered by a dedicated test
  (expired access token + refresh token → silent refresh → STREAMING).
- **Diagnostics**: `seen` now counts API-observed items (pre-cursor), so
  `seen − (commands + paid + ignored)` = cursor-skipped replays.

## Verified locally (tests + live sidecar process)

- 40/40 tests, `tsc` clean, `vite build` clean (overlay unchanged).
- Sidecar smoke test: status/auth-guard/inject/SSE-replay all correct.
- Load: 100-command burst + 5 paid → queue capped at 100 (5 `dropped-full`),
  paid jumps the normal lane, 100 attacks batch to one feed line, full drain
  responsive. No redesign of queue limits needed.
- Local pipeline latency (map→ingest→process): sub-millisecond; the live budget
  is therefore: poll wait (0–10s+, floor is the deliberate quota guard) + 250ms
  pump interval + 100ms min-gap — acceptable for community-driven consequences,
  not for twitch-reflex gameplay (which this game is not).
- Parity: sim `!strike` ≡ YouTube `!strike` (same damage/action); sim ₹500 ≡
  YouTube ₹500 Super Chat (both `paid_elite`).
- Quota math: 5 units/poll; 10s floor ≈ 8,640 calls/day ≈ over the 10k default
  quota — request an increase before 24/7 use, or raise the floor.

## NOT verified (needs a real stream)

OAuth against Google, broadcast discovery, live chat polling, real Super Chat,
stream-end transition, multi-viewer live behavior, OBS rendering of live events.

## StreamList decision: OPTION A — keep REST polling

Evidence: the local pipeline is sub-millisecond, so polling interval dominates
latency either way; gameplay is community-consequence driven (seconds of delay
are immaterial); gRPC adds a generated client + channel management for no
gameplay-relevant gain at this scale. Revisit only if measured live latency
proves chat interaction feels broken.
