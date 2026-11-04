# T4F-C2 — Creator-Machine Delivery Guide (Dual-Stream Emission + Token Ops)

Research date: 2026-11-05. All official claims below cite their source;
anything else is labeled UNVERIFIED or THIRD-PARTY.

## 1. Official documentation sources

| # | Title | URL | Accessed | Standing |
|---|-------|-----|----------|----------|
| D1 | Get started with live streaming (YouTube Help) — Dual stream, Encoder vs Auto, shared chat/URL, vertical limitations | https://support.google.com/youtube/answer/2474026 | 2026-11-05 | Official |
| D2 | Choose live encoder settings, bitrates, and resolutions (YouTube Help) — RTMP(S), H.264/H.265/AV1, ladder, keyframes, CBR, audio | https://support.google.com/youtube/answer/2853702?hl=en | 2026-11-05 | Official |
| D3 | Create a YouTube live stream with an encoder (YouTube Help) — keys, RTMP server URL, go-live flow | https://support.google.com/youtube/answer/2907883?hl=en | 2026-11-05 | Official |
| D4 | Browser Source (OBS Knowledge Base) — CEF source, viewport, FPS, shutdown/refresh flags, permissions | https://obsproject.com/kb/browser-source | 2026-11-05 | Official |
| D5 | Launch Parameters (OBS Knowledge Base) — `--multi`, `--portable`, profiles/collections | https://obsproject.com/kb/launch-parameters | 2026-11-05 | Official |
| D6 | Running in Portable Mode (OBS Knowledge Base) — multi-instance support statement | https://obsproject.com/kb/portable-mode | 2026-11-05 | Official |
| D7 | NVENC Application Note, Video Codec SDK 13.0 (NVIDIA Docs) — session policy (8/system non-qualified), Turing throughput table | https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-application-note/index.html | 2026-11-05 | Official |
| D8 | GeForce graphics card comparison (NVIDIA) — GTX 1650 variants, NVENC generations, 4 GB VRAM | https://www.nvidia.com/en-me/geforce/graphics-cards/compare/ | 2026-11-05 | Official |
| D9 | Aitum Vertical 1.6.7 (OBS Forum Resources) — free 9:16 canvas, linked scenes, Win/Mac/Linux, min OBS 29 | https://obsproject.com/forum/resources/aitum-vertical.1715/ | 2026-11-05 | Official listing, third-party plugin |
| D10 | Multiple RTMP outputs plugin (OBS Forum Resources, sorayuki) — multi-RTMP, shared or separate encoders | https://obsproject.com/forum/resources/multiple-rtmp-outputs-plugin.964/ | 2026-11-05 | Official listing, third-party plugin |
| D11 | Branch Output (OPENSPHERE-Inc, GitHub) — per-source RTMP/SRT outputs, NVENC, min OBS 30.1 | https://github.com/OPENSPHERE-Inc/branch-output | 2026-11-05 | Third-party (open source) |

## 2. YouTube Dual Stream findings (D1, D2, D3)

- One broadcast carries horizontal (16:9) + vertical (9:16) at once; one
  go-live notification, one shared watch URL, and **the same live chat on
  both** — chat unity is a platform guarantee, not something Tidebound
  must engineer.
- **Auto mode (default):** YouTube generates the vertical feed itself
  (center crop, fit-to-width, or stacked). One encoder feed only.
- **Encoder mode:** vertical dropdown switches Auto→Encoder with RTMP(S);
  the creator pastes a **second stream key** and sends both formats from
  their own encoders ("check that the vertical and horizontal content
  match, and the correct formats are sent to the corresponding stream
  key"). **Encoder mode cannot be added after the stream starts.**
- Vertical feed limits (official table): no clickable links, no
  midroll/pre-roll ads, no 4K, no Premieres, no live redirect; Shorts
  discovery + memberships/gifts work.
- Ingest spec: RTMP/RTMPS, H.264 (Turing-safe; AV1 needs RTX 40+),
  ≤60 fps, keyframe 2 s (never >4 s), AAC audio, CBR. Bitrate ladder
  (H.264): 1080p30 recommended **14 Mbps** (min 5), 1080p60 → 17,
  720p30 → 8. Portrait 1080×1920@30 sits in the 1080p class — start on
  that ladder row and confirm in rehearsal (applied guidance, not a
  separate official row).
- Combined upload budget (planning): ≈14 + ≈10–14 Mbps ≈ **25–30 Mbps
  sustained upload** for dual 1080p-class; ≈16 Mbps for dual 720p-class.
  YouTube itself recommends a speed test before streaming (D2).

## 3. OBS dual-output capability findings (D4, D5, D6, D9, D10, D11)

- Native OBS Studio emits **one program output to one RTMP server**.
  Two Browser Sources in one scene are two *inputs*, never two feeds —
  claiming otherwise is the exact misconception this phase retires.
- Browser Source (D4): CEF viewport at the configured Width×Height;
  custom FPS (default 30); **"Shutdown source when not visible" OFF by
  default** — hidden sources keep running (JS/SSE alive); when ON the
  page is destroyed and rebuilt on show. Tidebound renderers resubscribe
  and catch up either way (no session reset since T4F-C1); leave it OFF
  for both overlay sources. Hardware acceleration (shared DXGI texture)
  belongs ON for animated WebGL canvases.
- Multiple instances: `--multi` merely suppresses the warning dialog;
  **concurrent instances are supported only in portable mode** (separate
  settings dirs) — sharing one settings dir risks corruption (D6 + staff
  statement). CEF/browser-source quirks have been reported with
  multi-instance setups: treat two-instance operation as heavier and
  less smooth than one instance + plugin.
- Output plugins (all third-party, none bundled): Aitum Vertical (D9:
  free 9:16 canvas + linked scenes + its own streaming output —
  sufficient alone for the vertical key); obs-multi-rtmp (D10: extra RTMP
  targets, shared-or-separate encoder choice); Branch Output (D11:
  per-source RTMP/SRT with dedicated NVENC settings). None are
  verified on the creator machine in this phase (none installed).

## 4. Recommended delivery architecture

**YouTube Dual Stream (Encoder mode) ← single OBS instance ← Aitum
Vertical plugin ← two Tidebound Browser Sources.**

- Main canvas 1920×1080 (landscape Browser Source 1920×1080) → main
  OBS output (NVENC H.264, 1080p30, CBR, keyframe 2 s) → horizontal key.
- Aitum Vertical canvas 1080×1920 (portrait Browser Source 1080×1920,
  linked scene) → vertical dock output (second NVENC session, same
  family settings) → vertical key. Same scheduled broadcast, shared
  chat (D1 guarantee), Shorts discovery.
- Why this over the alternatives: (A) Auto mode needs no second encode
  but surrenders composition to a crop — keep as fallback, not the
  recommendation. (C-plugin multi-RTMP / Branch Output) viable but
  encode the *same* canvas twice unless paired with a vertical canvas
  anyway. (D) Two portable OBS instances doubles browser/CEF/GPU load
  on an 8 GB box and carries the CEF caveat — reserve as fallback.
  (E) External relays add cost/ops with no verified need.
- Encoder load (D7/D8): GTX 1650 (TU117, Volta-class NVENC on most
  units), driver 592.00 ⇒ 8-session budget; two 1080p30-class H.264
  sessions are far inside Turing throughput (≈855 fps P1 budget).
  Gating costs are RAM (8 GB — close everything non-essential), VRAM
  (4 GB — game capture + browser textures + two encodes), and upload
  (≈25–30 Mbps for dual 1080p; drop to 720p ladders if the speed test
  disagrees).

## 5. Creator-machine environment audit (this machine, read-only)

Verified 2026-11-05 on the local Windows box (no installs, no config
changes, no broadcast; no keys read):

- ASUS FX506LH, Win 11 build 26300, i5-10300H (4C/8T), **8,029 MB RAM**
  (an OBS log shows 478 MB free under load — memory pressure is real).
- **GTX 1650, 4 GB VRAM, driver 592.00** (nvidia-smi) + Intel UHD iGPU.
- **OBS 32.1.0 64-bit** ran here 2026-11-04 (log header) with working
  NVENC (12.2/13.0, H.264 + HEVC; AV1 unsupported as expected); a log
  line proves a multi-instance launch was attempted. Current profile is
  an unconfigured 1920×1080@60 "Untitled" setup; binary location not
  resolved (not in Program Files, no shortcut found) — **reinstall path
  UNVERIFIED, manual check below**.
- Installed plugins: stock only (browser, websocket, rtmp-services,
  text, win-capture) — **no multi-output/vertical plugin installed**.
- NVENC session budget: 8/system per D7 at this driver (≥551.76) —
  two sessions fit with headroom (throughput, not the cap, is the
  practical limit; rehearsal confirms).

Manual checks left to the creator (UNVERIFIED until run): reinstall/
locate OBS ≥31.1 + Aitum Vertical; `nvidia-smi` during rehearsal;
Windows Task Manager GPU/VRAM graphs; a speed test for upload.

## 6. Token pairing and security findings

Implemented + tested in this phase (see §11):

- **Rotation without restart**: `POST /api/authority/token/rotate`
  (current-token authed) mints, persists (0600), and adopts a fresh
  credential; the state server re-resolves per publish, so propagation
  needs no restart. Response never contains the value. Old credential
  401s everywhere immediately (tested on control + publish).
- **Revocation = rotation; loss recovery = rotation** (file is the
  source of truth; operator reads it with filesystem trust, re-pastes).
- **Restart behavior**: both servers resolve the same file at boot —
  consistent after restarts, no sync protocol to break.
- **Dashboard UX**: password field (never displayed), Save/Forget/Rotate
  buttons, accepted/rejected/unset states, 401 guidance naming the file.
  localStorage pairing is a documented localhost-trust tradeoff; the
  Forget button clears it for shared machines.
- **Error states**: 401 uniform (no oracle), oversized/malformed bodies
  rejected, rotation failure surfaced (`rotate-persist-failed`).
- Renderer pages remain credential-free by construction (static audits).

## 7. Startup and operational guide

Prerequisites: Node 24+, repo checked out, OBS installed (≥31.1) with
Aitum Vertical, YouTube channel verified + no restrictions (D1), upload
per §4. Legend: **[V]** verified in this phase, **[S]** simulated with
doubles, **[M]** manual creator step, **[U]** unverified until rehearsal.

1. `[V]` Start state transport: `node server/state-server.mjs`
   (or `npm run state-server`) → expect `state-transport server on
   http://127.0.0.1:3003`.
2. `[V]` Start authority: `npx tsx server/authority-server.ts`
   (or `npm run authority-server`) → expect `authority server on
   http://127.0.0.1:3004 (lifecycle=running, recoveredFrom=…)`. First
   boot prints token provisioning guidance (never the value).
3. `[V]` Verify health: `GET /api/authority/status` → `running`;
   `GET /api/state/status` → protocol 1, rising `seq`.
4. `[V]` Pair dashboard: open the console, paste the token from
   `data/authority-token.json` into Settings → Save → expect “Token
   accepted · control channel live”. (Browser-verified.)
5. `[V]` Open `overlay.html` and `overlay.html?format=portrait` (or the
   OBS preview buttons) → both `connected`, same `worldRev`. (Verified.)
6. `[M]` OBS scene(s): main canvas 1920×1080 + Aitum Vertical canvas
   1080×1920, linked scenes; Browser Sources sized exactly
   1920×1080 / 1080×1920, custom FPS 30, shutdown-when-not-visible OFF,
   hardware acceleration ON.
7. `[M]` YouTube Studio: Dual stream ON **before going live**, vertical
   dropdown Auto→**Encoder**, paste horizontal + vertical keys, confirm
   both previews show the right composition.
8. `[M]` Main output → horizontal key (NVENC H.264 1080p30 CBR,
   keyframe 2 s, AAC 128k); vertical dock output → vertical key
   (same family, 1080×1920@30).
9. `[U]` Verify both feed paths without going live: YouTube previews +
   matching worldRev in both overlays + rehearsal checklist (§8).
10. `[S]` Chat/announcements: chat stays unified by platform (D1);
    announcements post once per vote identity (sidecar dedupe, tested
    with stubs — no real messages sent in this phase).
11. Safe shutdown: stop OBS outputs first, then Ctrl+C authority (flushes
    a save, releases the lock), then state transport. Recovery: restart
    in order 1→2; renderers resubscribe and catch up; dashboard re-pairs
    from the unchanged token file (rotation only if exposure is
    suspected).

## 8. Rehearsal checklist (authorized unlisted broadcast only)

Preconditions: explicit creator approval, unlisted/beta stream, Dual
stream ON + Encoder selected BEFORE going live, moderators briefed.
No public stream, no paid-event play, no settings changes mid-show.

- [ ] Both YouTube previews show the right composition (H + V).
- [ ] Both overlays report the same `worldRev` (dashboard dual block).
- [ ] Orientations correct: 1920×1080 landscape, 1080×1920 portrait.
- [ ] One chat command (`!strike`) → exactly one result in both outputs.
- [ ] Open/close a vote → identical prompt/tally/winner both sides.
- [ ] Announcement posted once (vote card `sent`, no duplicates).
- [ ] Wrong/missing token → 401 states, no control (dashboard shows
      guidance; renderers unaffected).
- [ ] Hide/show each OBS source → resubscribes, catches up, no reset.
- [ ] Stop/restart authority mid-rehearsal → renderers wait safely,
      resume on reboot; dashboard re-pairs without a new token.
- [ ] Rotate token mid-rehearsal → old pairing dies, new pairing works,
      stream uninterrupted (control-plane only).
- [ ] Record OBS stats (dropped frames), Task Manager (CPU/GPU/VRAM),
      `nvidia-smi dmon` (encoder %), authority `/status` (timers/queue).

## 9. Performance implications (planning numbers, not claims)

- Two NVENC H.264 1080p30-class encodes: within Turing budget (D7);
  VRAM 4 GB is the tighter box (browser textures + capture + encodes).
- Upload ≈25–30 Mbps dual-1080p; ≈16 Mbps dual-720p; Auto-mode single
  feed as fallback. Rehearsal decides the ladder actually used.
- 8 GB RAM: close browsers/editors during the show (478 MB free was
  observed under load); Node servers measured ≈100 MB combined (C1).
- T4F-C3 instrumentation list: CPU %, GPU %, dedicated VRAM, system
  RAM, NVENC utilization (`nvidia-smi dmon -s u`), renderer FPS (OBS
  stats + custom-FPS sources), dropped frames, RTMP bitrate, authority
  RSS/timers/queue, command→renderer latency. No 30 FPS or soak claims
  in this phase.

## 10. Scope compliance

No game-rule/balance/content/art/HUD/protocol/engine changes. No second
simulation. No real messages, no broadcast, no OAuth re-auth, no Studio
changes. Code changes are confined to token provisioning/security UX
(§6) + one honest OBS-card copy block. T4F-C3 untouched.
