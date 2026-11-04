# T4B — Typography + Motion Spec (exact output-px + mapping)

> Design/spec only. No code/CSS changes made. All values are **output pixels**
> (what the viewer sees in OBS / on device), not authoring conveniences.
> Reference stages: landscape `1920×1080`, portrait `1080×1920`
> (`1 ref px = 1 output px` at native source size).

---

## 1. Scale mapping rule (locked — read before using any number)

- **Landscape family:** author at `1920×1080`. At any other landscape output width `W`,
  `effective = ref × W / 1920`. OBS scales the whole `1920×1080` bitmap linearly.
  - `1280×720`: factor `1280/1920 = 0.667`.
- **Portrait family:** author at `1080×1920` as a **separate composition** (never a scaled landscape).
  At any other portrait output width `W`, `effective = portraitRef × W / 1080`.
  - `720×1280`: factor `720/1080 = 0.667`.
- **Never** equate CSS px with output px without stating the scale factor and stage.
  T4E OBS guide must print both columns (ref + effective).

---

## 2. Exact type scales (output px)

### 2.1 Landscape — ref 1920×1080 → effective 1280×720

| Token | Ref @1080p | @720p (`×0.667`) | Weight / leading / notes |
|---|---|---|---|
| Game title | 20 | 13.3 | bold, 0.24em, gold `#ffd166` |
| LIVE | 13 | 8.7 | bold, red dot 8px + `LIVE` gold; pulse 1.6 s (static reduced-motion) |
| Arc / chapter | 13 | 8.7 | subline, dim |
| Stream pill | 11 | 7.3 | pill, dim — decorative only |
| Story headline (moment) | 23 | 15.3 | 1.32 leading, `#fff3d6`, 2-line clamp, strongest surface |
| Story Next / objective | 14 | 9.3 | gold, 1 line |
| Premise (first join) | 14 | 9.3 | dim-ink, 1 line, until first deed |
| Vote question (prompt) | 22 | 14.7 | bold, 1.3 leading, 2-line clamp |
| Vote kicker (`What are we deciding?`) | 12 | 8.0 | dim — decorative |
| Vote choice label | 16 | 10.7 | `lbl` flex-1, wraps |
| Vote key chip (A/B/C) | 14 | 9.3 | bold, 28px box landscape |
| Vote command (`!voteA`) | 15 | 10.0 | bold teal, `nowrap` |
| Vote count | 16 | 10.7 | bold tabular, right-aligned |
| Leading tag | 11 | 7.3 | bold gold pill — never sole signal (paired with `◆/◇` + bold label) |
| Vote totals | 14 | 9.3 | dim tabular |
| Closing-soon | 13 | 8.7 | bold rose + words `closing soon` |
| Vote verdict | 16 | 10.7 | winner gold bold |
| Activity name | 18 | 12.0 | bold, 1-line ellipsis (~18–22 chars) |
| Activity description | 16 | 10.7 | dim-ink, 2-line clamp (`line-clamp:2`) |
| Health (DOM chips) | 16 | 10.7 | tabular (`Keeper 34/40 · Keep 28/30 · Vessel 46/60`) |
| Threat/resolve/supplies | 15 | 10.0 | stat rows; sentences 13 → 8.7 |
| Command instructions | 14 | 9.3 | group; label 11 → 7.3 decorative; cmd teal-bold |
| Command help | 13 | 8.7 | faint, centered — quiet by design |
| Secondary metadata (kickers/kind/deeds/recap/vex) | 11–13 / vex 16 | 7.3–8.7 / 10.7 | kickers decorative-only; vex 16 bold rose/green + words (never color-alone) |
| Canvas labels (world-anchored) | 26/24/22/20 + bars 20px | 17.3/16/14.7/13.3 | keep/vessel 26, ward/skiff 24, HP/reef 22, chapel 20 (unchanged sizes; T4C moves keep bar x205→x340) |

720p verdict: headline 15.3 / prompt 14.7 / verdict 10.7 hold at viewing distance; choice rows tall enough (28px box → 18.7px); 11px kickers (~7.3px) + help (~8.7px) decorative-only — accepted, headline carries meaning.

### 2.2 Portrait — ref 1080×1920 → effective 720×1280

| Token | Ref @1080×1920 | @720×1280 (`×0.667`) | Weight / leading / notes |
|---|---|---|---|
| Game title | 36 | 24.0 | bold, 0.2em, gold |
| LIVE | 16 | 10.7 | bold, red dot + pulse (static reduced-motion) |
| Arc / chapter | 16 | 10.7 | subline |
| Stream pill | 13 | 8.7 | decorative |
| Story headline | 32 | 21.3 | 1.3 leading, 2-line clamp |
| Story Next | 18 | 12.0 | gold, 1 line |
| Premise | 16 | 10.7 | 1 line |
| Vote question | 30 | 20.0 | bold, 1.25 leading, 2-line clamp |
| Vote kicker | 13 | 8.7 | decorative |
| Vote choice | 24 | 16.0 | wraps |
| Vote key chip | 18 | 12.0 | bold, 36px box portrait |
| Vote command | 20 | 13.3 | bold teal `nowrap` |
| Vote count | 22 | 14.7 | bold tabular |
| Vote totals | 18 | 12.0 | dim tabular |
| Vote verdict | 22 | 14.7 | winner gold bold |
| Activity name | 20 | 13.3 | bold, 1-line ellipsis (~24 chars) |
| Activity description | 18 | 12.0 | 2-line clamp |
| Health chips | 18 | 12.0 | tabular on `.82` scrim |
| Threat sentence (portrait) | 16 | 10.7 | on-scrim |
| Command instructions | 18 | 12.0 | group; cmd teal-bold |
| Command help | 15 | 10.0 | quiet floor (≥15 ref so ≥10 effective) |
| Secondary (kickers) | 12–13 | 8.0–8.7 | decorative only |
| Canvas labels (portrait) | 28–34 | 18.7–22.7 | re-anchored in T4C reframe |

Portrait 720-line verdict: story 21.3 / prompt 20 / choices 16 / verdict 14.7 hold on phones; feed desc 12 borderline — accepted with 3-entry cap.

### 2.3 Floors (locked)

- Body glanceable text ≥16 output px landscape ref / ≥18 portrait ref; help floor 13 / 15 ref respectively.
- 11–13px kickers are decorative-only and never the sole signal (always paired with words/shapes).
- Line length: landscape rail 364px → ~38–44 chars at 16px; portrait 1000px → ~55–60 chars at 18px.
- Tabular numbers everywhere counts appear (`font-variant-numeric:tabular-nums`).

---

## 3. Motion spec (locked)

| Pattern | Timing | Reduced-motion |
|---|---|---|
| Feed entry | `translateY(6px) + fade`, 160 ms ease-out, transform/opacity only | instant insert, no animation |
| Event banner | in 180 ms (rise+fade), hold 4–6 s, out 200 ms fade; queue depth 1 (replace, no stack) | instant swap in/out, same hold duration |
| Vote open → close transition | border emphasis change instant; clock bar width steps per command (no smooth tween required) | same (no animation to remove) |
| Canvas bursts/shake/flash | existing budgets (`playResult`: shake 180ms, flash 220/300ms, bursts ×14) | **suppressed entirely** — no shake, no flash, no burst (fixes T4A-noted single-burst exception `:233-235`) |
| LIVE dot pulse | 1.6 s opacity 1→0.55→1, CSS only | static full-opacity dot |
| Waves/clouds/skiff bob/vessel sway | existing ambient (`update` + tweens) | frozen (existing `reducedMotion` gate) |

Performance rules: transform/opacity-only HUD animation; `content-visibility:auto` on memory panels; feed caps (5/3) keep DOM ~25–40 nodes; no layout-thrash properties (`width/height/top/left`) in animations; one `Phaser.Game` instance across formats.

---

## 4. Contrast / sizing (a11y floors, locked)

- Text on `rgba(10,6,24,.78)` landscape / `.82` portrait scrim: ink `#f4efe4`, dim `#b9b3c7`, gold `#ffd166` (never faint `#8d89a0` for meaningful text).
- State never color-alone: `●/◐/○` + CONDITION words, `Leading` + `◆/◇` + bold, `✦` deeds, harm/aid words (`· harm`), `closing soon` words.
- Viewer overlay non-interactive (`pointer-events:none`, no focusables). Creator controls ≥44px (existing). Portrait glanceable hints ≥15 ref px (no viewer touch targets to size).
- Screen-reader: full names in `aria-label` (visual ellipsis only); feed batch `polite`/`atomic=false`; banner `assertive` once; clocks/meters `progressbar` with values.

---

## 5. Worked mapping examples

- Landscape prompt `22 ref` → 720p `22 × 0.667 = 14.7 effective`. Author 22, verify 14.7 on 720p screenshot at viewing distance.
- Feed name `18 ref` → 720p `12.0 effective`. Acceptable (names short + ellipsis + full `aria-label`).
- Portrait story `32 ref` → 720×1280 `32 × 0.667 = 21.3 effective`. Holds on phones.
- Kicker `11 ref` → 720p `7.3 effective` — decorative only, never carries sole meaning (locked acceptance).
