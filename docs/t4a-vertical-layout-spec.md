# T4A — Vertical 9:16 Layout Spec (1080×1920, Reframe — Not Crop)

> Read-only audit + proposed portrait composition. Do not scale or crop the `1920×1080` scene. Reframe the existing world so Keeper, lighthouse, Vessel, and interactions stay readable. No Phaser/CSS/HTML modified in this phase; recommendation is for T4C.

---

## 1. Why scaling/cropping fails

- Overlay is fixed `1920×1080` (`overlay.html:9-14`; rails `272+352px`, `css:79-98`). Fit-width into `1080×1920` is `1080/1920 = 0.5625×` pillarboxed `1080×608`; effective type `23→12.9, 21→11.8, 16→9, 14→7.9` — illegible, rails dominate narrow width.
- Center-crop `1080×1920` from `1920×1080` keeps only `1080/1920 = 56%` of width: would amputate keep (`x120–320`) or vessel (`x1420`) or reef edges; beam (`350→1150`) and moon (`1560,175`) cannot survive a single vertical slice.
- Portrait viewers (Shorts/Reels/TikTok, mobile chat overlay) need stacked hierarchy, ≥22px choices, and thumb-safe lower third — landscape side-rails cannot provide it.

**Approved direction:** reframe, not crop.

---

## 2. World-coordinate inventory (what must stay visible)

`GameScene.ts` (`W=1920 H=1080 HORIZON=660`, camera `setBounds` only, `:139`):

| Entity | Anchor (world px) | Extent | Portrait requirement |
|---|---|---|---|
| Sky/stars/moon/clouds | Moon `1560,175 r46`, bands `420,240 / 1250,330` | Full `0–660` | Keep gradient + moon (reposition to `x~780` in portrait frame); stars procedural, safe |
| Sea/waves | `0,660–1080`, chop `0.35+threat/100*0.9` | Full width | Keep; narrow frame still reads as sea |
| Cinderholm + lighthouse | Keep `120,640 200×130`, tower `245,430 110×260`, lamp `300,392 r15`, beam `350,380→1150,300/484` | x ~120–1150 (beam), y ~372–770 | **Must keep lamp + tower + keep bar**; beam can shorten/angle inward |
| Keeper skiff | Container `720,800`, lantern `778,760`, hero bar `628,926` | x ~610–834, y ~754–940 | **Must keep skiff + lantern + Keeper label**; signature focus |
| Pale reef | Posts `x850–1250 y850/884`, label `y962` | x ~850–1250 | **Must keep ≥3 lantern posts + label**; progress signal |
| Gloam Vessel | Container `1420,780` (`210×84`, masts to `y~570`), bar `1280,566`, labels `1420,630/660` | x ~1285–1555, y ~560–864 | **Must keep hull + masts + HP/label**; readable threat |
| Chapel | Steps `470–560/726–800`, flame `525,706` | x ~470–560 | Keep if frame allows; first to soften (secondary) |
| Canvas bars/labels | Keep `205,592 190×20`, hero `628,926 184×20`, vessel `1280,566 200×20`; labels 20–26px | World-anchored | Keep; enlarge to ≥26px effective in portrait (see §5) |

Critical interactions: `hitEnemy` burst `1420,740`, `healHero` `720,820`, `shieldKeep` bubble `300,560 r235`, `discovery` reef burst, `majorStory` `960,420` — all must land inside the portrait frame (see camera options).

---

## 3. Camera strategy — three options, one recommendation

### Option 1 — One responsive camera (zoom + scroll per aspect)

Single `GameScene` reads container aspect and sets `zoom/scroll` to fit key anchors.

- Pros: one scene, no duplication; world state untouched.
- Cons: `1920×1080` world (`aspect 16:9`) cannot fit `9:16` (`aspect 0.5625`) at readable zoom without letterboxing or cutting sides; Keeper (`x720`) and Vessel (`x1420`) are `700px` apart — a single portrait viewport (`~608px` wide at 1×) cannot contain both plus keep (`x120–320`) without `zoom ~0.4×` (illegible) or aggressive pan (loses one focal point during play). Transient `shake/flash` (`playResult`) would need aspect-aware magnitudes. Violates `zoom=1` assumption across `syncWorld` bar positions.

Verdict: **reject** — forces unreadable zoom or constant panning.

### Option 2 — Presentation-specific camera/layout config (RECOMMENDED)

Keep one `GameScene` + world state + assets; add a **portrait layout configuration** (positions/visibility/beam length/label sizes/camera bounds) selected by output format. World semantics, Keeper art/anim, Vessel atlas, engine — untouched.

Concretely (T4C work, described here only):

- Portrait world frame: define `PW=1080 PH=1920` logical stage; reposition (not rescale) entity containers along a vertical stack: sky `0–700`, lighthouse upper-third, skiff mid, reef lower-mid, vessel mid-right but pulled inward.
- Camera: `cameras.main.setBounds(0,0,PW,PH-portraitWorldH)` + `centerOn` per beat OR fixed portrait arrangement with `zoom ~1` and re-authored `x` positions (preferred: fixed arrangement, no follow, no per-frame scroll — preserves `shake/flash` behavior).
- Beam: shorten (`350,380→~800,320/460`) so it stays in frame; moon recenter to `x~800 y~180`.
- Labels/bars: re-anchor to new container positions; bump canvas labels to 28–34px (portrait output px) for mobile.
- DOM: separate portrait HUD (stacked, see §4), not repositioned landscape rails.

- Pros: least invasive (config + layout, no new scene, no asset change); world state shared; effects coherent (bursts use re-anchored coords); testable via format flag.
- Cons: requires careful reposition map + regression screenshots; beam/moon artistic judgment (keep painterly feel).

### Option 3 — Dedicated portrait scene reusing world state + assets

Fork `GameScene` into `GameScenePortrait` with bespoke composition, sharing `WorldState`, `keeperAnims`, textures.

- Pros: full art freedom; landscape untouched.
- Cons: duplicate builders/sync/effects to maintain; drift risk (every `syncWorld`/`playResult` change ×2); heaviest review; violates least-invasive principle.

Verdict: **reserve** — only if Option 2 cannot achieve readability in T4C spikes.

**Recommendation: Option 2.** One scene, two layout configs, format-selected. No Keeper/Vessel/engine change. T4C spike must prove: Keeper recognizable, lighthouse visible, Vessel readable, no clipped interactions, waves/effects coherent (see gate §8).

---

## 4. Proposed portrait layout (1080×1920 output px)

Stacked top-to-bottom (thumb-safe lower third for platform chat):

```
┌──────────────────────┐
│ TOP 1080×210         │  y0-210: TIDEBOUND · LIVE 34px; ARC/CHAPTER 16px; STREAM 13px pill
│ Title + LIVE + story │  Story moment 32px (2 lines) + Next 18px (1 line)
├──────────────────────┤
│ WORLD 1080×980       │  y210-1190: reframed diorama (lighthouse upper, skiff mid,
│ Reframed diorama     │  vessel mid-right pulled in, reef lower, moon recentered)
│ Canvas + HP chips    │  DOM HP chips overlay (Keeper/Keep/Vessel 18px tabular)
├──────────────────────┤
│ VOTE 1080×~340       │  y1190-1530: Assembly (dormant 1 line / open prompt 30px +
│ Assembly             │  choices 24px + tally 18px + clock) — strongest temp focus
├──────────────────────┤
│ FEED 1080×~220       │  y1530-1750: Action feed 3 entries (name 20 / desc 18)
├──────────────────────┤
│ COMMANDS 1080×~170   │  y1750-1920: Decide + Act hints 18px + !help 15px (thumb-safe)
└──────────────────────┘
```

### Region dimensions (portrait output px @1080×1920)

| Region | Geometry | Type | Content |
|---|---|---|---|
| Top identity | `x0 w1080, y0 h96` | Title 36 bold 0.2em; LIVE 16; arc/ch 16; stream 13 pill | `TIDEBOUND · ● LIVE` + `ARC I · CHAPTER I · STREAM n` subline |
| Story | `x40 w1000, y96 h~150` | Moment 32/1.3 (2-line clamp), Next 18 gold | `storyLog[0]` + `Next · objective`; no recap here |
| World | `x0 w1080, y250 h~940` | Canvas labels 28–34; DOM chips 18 tabular | Reframed canvas + `Keeper 34/40 · Keep 28/30 · Vessel 46/60` chips (top of world, 18px on scrim) + threat sentence 16px |
| Vote | `x40 w1000, y1190 h~340` (collapses to 80 when dormant) | Kicker 13, prompt 30/1.25, opt 24 / key 18 (36px box) / cmd 20 / n 22 tabular, tally 18, verdict 22 | Same `voteModel` as landscape; larger touch-agnostic text (viewer surface is non-interactive; sizes for legibility, not touch) |
| Feed | `x40 w1000, y1530 h~220` | Name 20 bold, desc 18, kind 12 chip | 3 attributed entries (see feed spec); 2-line desc clamp; ellipsis names |
| Commands | `x40 w1000, y1750 h~170` | Group 18, cmd 18 teal bold, help 15 | `Decide: !voteA !voteB` first (vote priority), then `Act: !strike !mend !shield…`, `Explore: …`, `!help` line. Cooldowns abbreviated (`3s`) |
| Memory | Collapsed in portrait | — | Deeds/recap **hidden** on 9:16 viewer surface (creator console retains); vex merged into event banner |
| Event banner | `x60 w960, y210 (over world top)` | Title 24 + sub 17 | Temporary 4–6s; same source as landscape |

Height budget: `96+150+940+340+220+170 = 1916px` (+margins) — fits `1920` with vote open; dormant vote collapses (+260 freed → world grows to ~1200 or feed to 4). Specify collapse rule in T4C.

Safe areas (portrait): action-safe 48px sides (`48–1032`), title-safe 120px top, thumb-safe bottom 220px reserved for platform chat/composer (no critical HUD below `y1700` except command hints). OBS portrait source `1080×1920` transparent; no player chrome in OBS but simulcast phone preview must respect thumb-safe.

---

## 5. Typography (portrait output px) + scale rationale

| Token | Landscape 1080p | Portrait 1080×1920 (output) | Why |
|---|---|---|---|
| Title | 20 | **36** | Mobile viewing distance; platform chrome competes |
| Story moment | 23 | **32** | 2-line clamp; strongest after title |
| Story next | 14 | **18** | 1 line |
| Vote prompt | 22 | **30** | Decision must scan in <2s |
| Vote opt / cmd / n | 16/15/16 | **24 / 20 / 22** | List readable at arm's length |
| Vote tally / verdict | 14/16 | **18 / 22** | Verdict gold bold |
| Feed name / desc | 18/16 | **20 / 18** | Names 1-line ellipsis |
| HP chips | 16 | **18 tabular** | On-scrim chips over world |
| Cmd group / help | 14/13 | **18 / 15** | Thumb-safe, glanceable |
| Kicker/kind | 11 | **12–13** | Decorative only |

CSS px vs output px: portrait OBS source is `1080×1920`; author portrait CSS at `1080×1920` so `1 portrait-CSS px = 1 portrait output px`. **Do not** reuse landscape CSS px (different stage size). At `720×1280` portrait source, `effective = portraitCSS × 720/1080 = 0.667×`: `32→21.3, 30→20, 24→16, 18→12` — headline/prompt hold, feed desc borderline; acceptable with 3-entry cap. Document scale explicitly in T4E OBS guide.

---

## 6. Responsive rules

- Format-selected composition (landscape `1920×1080` vs portrait `1080×1920`), not media-query adaptation of one layout. Creator picks format per broadcast (T4E toggle = preview/source switch, never world mutation).
- Portrait DOM is a separate stacked structure reusing the same projections (`headerModel`, `voteModel`, feed items, `threatModel`); no new engine fields.
- Canvas: Option 2 config branch (`isPortrait ? portraitLayout : landscapeLayout`) for container positions + label sizes + beam/moon; single `Phaser.Game`, single scene instance; `update` waves/clouds unchanged (narrow frame still animates coherently).
- Reduced motion parity: portrait honors same `matchMedia` gate; banner/feed entry transform-only; no autoplay video.

---

## 7. Accessibility (portrait)

- Heading order preserved (title → story → vote → feed → commands); `aria-live=polite` story + open vote; event banner `assertive` once.
- Feed names full in `aria-label`, visual ellipsis only; kind chips never sole signal.
- Contrast: HP chips + vote/feed panels on `rgba(10,6,24,.82)` scrim (raise from `.6` for mobile glare); canvas labels ≥28px high-contrast.
- No viewer interaction on overlay (non-interactive, `pointer-events:none`); creator retry controls stay in console with ≥44px targets.

---

## 8. Performance

- Same bounds as landscape: feed 3, vote 1, story 1, world 1 — ~25 DOM nodes; `innerHTML` per tick retained; transform-only animation.
- No second game instance; portrait reposition is one-time per format switch (not per tick); particle/tween budgets unchanged; `content-visibility:auto` on collapsed memory (hidden in portrait).

---

## 9. Risks / dependencies

- Beam/moon reposition is artistic judgment — needs visual sign-off (T4B boards) to preserve painterly identity.
- Vessel pull-inward must not break `hitEnemy` burst staging (`1420,740` → re-anchored); T4C spike must re-anchor all five burst points.
- Chapel may soften out of portrait frame — accept if reef + keep + skiff + vessel hold; document as intentional secondary loss.
- `!voteC` gap affects portrait equally (Decide row advertises `!voteB` only until resolved).
- Thumb-safe vs platform variance (Shorts vs Reels vs TikTok chat height) — use 220px conservative reserve; T4F verifies on device.

---

## 10. T4B gate (portrait)

Owner signs: Option 2 recommendation, region map (§4), type scale (§5), world reposition principles (§2), memory-hidden-in-portrait decision, T4C spike acceptance (Keeper recognizable, lighthouse visible, Vessel readable, no clipped bursts, motion coherent at `1080×1920` + `720×1280`).
