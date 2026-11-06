# G2-A4 — Cinderholm Environment Assembly (Implementation + Evidence)

Status: PASS WITH CARRYOVER. First playable Cinderholm environment assembled
in Phaser from the supplied P1 plates. All 5 art layers load with zero
console/page/request errors; keeper (all 6 contract anims) and vessel idle
loop play from the published atlases; reduced-motion and missing-atlas
fallbacks verified; landscape + portrait staged. Additive only: no existing
source, asset, atlas, or wiring file was modified; nothing published.

## 1. Asset inventory (measured, not assumed)

Source: `design/art-bible/working/p1-environment/` (6 files used of 8;
`p1-environmentreference/` is empty by design — no reference was sought).

| File | Size | Role assigned | Evidence |
|---|---|---|---|
| `p1-sky/tidebound-sky-1.jpg` | 2096×1184 opaque | Backdrop sky (depth 0, full-bleed) | Full-frame storm clouds, no alpha needed |
| `p1-farmountains/tidebound-farmountains-1-png.png` | 2096×1184 RGBA | Far range (depth 1, alpha band y~296–1008 src) | PIL row coverage 0% above y197, 0% at y1085; misty peaks + tiny lit windows |
| `p1-castlewithlighhouse/tidebound-castle-lighthouse.png` | 2096×1184 RGBA | Headland + cliff landmass (depth 2) | Tower top-right; opaque cliff wall full-width below src y~500; dark edges (91,83,80) — no halo on dark scene |
| `p1-waves/tidebound-waves-1.jpg` | 2096×1184 opaque | Tidal sea (depth 3, geometry-masked below waterline) | Full-frame open-sea texture; any sub-band reads as sea |
| `p1-frontrocks/tidebound-frontstones.png` | 2096×1184 RGBA | Foreground shore (depth 4) | 0% cover above src y394, 100% at bottom; dark edges (100,90,81); center dips to a tidal channel (rock top ~y870–900 display at x780–1060) |

Deliberately NOT used: `tidebound-sky-1-png.png` (keyed transparency holes
carry cyan fringe — PIL edge sample (110,131,160) over 149k edge pixels;
the JPG twin is clean), `tidebound-farmountains-1.jpg` (white backing, no
alpha — unusable as a layer), `tidebound-waves-1-png.png` (mottled alpha
holes 20–90% coverage would speckle everything behind it).

Characters/sheets reused read-only from publication: `tb-chars` (28 frames,
360px cells, `KEEPER_POSES` contract) and `tb-vessel` (4 frames 512×288,
4fps loop) via direct import of `src/phaser/keeperAnims.ts` /
`src/phaser/vesselAnims.ts` — no duplicated metadata, no atlas rebuild, no
publication.

## 2. Scene architecture

New Phaser scene `CinderholmEnvScene` (isolated page, no GameScene contact):

- Depths: sky 0 / mountains 1 / castle 2 / sea 3 (rect-masked at waterline)
  / foam lip 3.2 / vessel 3.5 / rocks 4 / keeper 5. Fixed camera, no scroll
  (matches game contract).
- Sea waterline: landscape y690, portrait y1226; procedural foam rects soften
  the mask cut (no art). Mountains get a ±12px 26s drift (parallax breath);
  foam alpha pulses. All motion reduced-gated.
- Keeper: contract origin (0.5,1), scale 0.78/0.8, all six anims registered
  from `KEEPER_POSES` (never double-registered), `?keeperPreview=` lock with
  one-shot replay mirroring GameScene. Default plays the idle loop for
  observation (production holds frame 0 per W1-R — documented difference).
- Staging (display px, from PIL alpha profiles, confirmed on screenshots):
  landscape keeper (641,771) on the west rock mass, vessel (1053,785) riding
  the inlet; portrait keeper (430,1595), vessel (705,1346) moored at the
  castle steps.
- Fallbacks (never blank): per-texture existence checks; `?noatlas=1`
  withholds atlases → primitive keeper/vessel markers with labels.

## 3. Verification (local, disposable `vite` only)

Capture: `qa/capture_cinderholm_env.py` (python playwright, system chromium).
5 runs, all with 0 console errors, 0 failed requests, 0 HTTP errors,
0 loader errors:

- `landscape-idle.png` — full composite; keeper `keeper-idle` playing
  (frames 00–03 observed), vessel `vessel-idle-side` playing (00–03).
- `portrait-idle.png` — reframe coherent; keeper grounded on rock ridge.
- `landscape-reduced.png` — 0 tweens; keeper/vessel static frame 0, stopped.
- `landscape-strike-lock.png` — `?keeperPreview=strike` cycles
  strike _01→_03 and replays (lock path proven).
- `landscape-noatlas.png` — environment intact; primitive keeper/vessel
  markers + labels, scene never blank.
- Full trace + states: `screenshots/g2a4-cinderholm-env-2026-11-06/runtime-report.json`.

## 4. Exact new files (additive; zero modifications to tracked files)

- `design/art-bible/working/world-art-production/previews/cinderholm-env.html`
- `design/art-bible/working/world-art-production/previews/cinderholm-env.ts`
- `design/art-bible/working/world-art-production/qa/capture_cinderholm_env.py`
- `screenshots/g2a4-cinderholm-env-2026-11-06/` (5 PNG + 5 JSON + runtime-report.json)
- This document.

Preview URL (dev server): `/design/art-bible/working/world-art-production/previews/cinderholm-env.html?format=landscape`
(`?format=portrait`, `?reduced=1`, `?keeperPreview=<pose>`, `?noatlas=1`).

## 5. Regression

- Focused keeper suites + full suite + `tsc --noEmit`: see final report §8
  (run after assembly; preview files are outside `tsconfig.include` and
  import contracts without altering them).
- `git diff --check`: clean. No staged changes. No runtime/source/asset
  modifications; supplied plates only read, never written.

## 6. Known visual limitations (carryovers)

1. Portrait is a center-crop reframe: side composition is lost; keeper and
   vessel had to be restaged per format (documented in-scene constants).
2. The waterline is a straight mask cut across the cliff base; the foam lip
   softens it but side-by-side art direction could supply a shaped shoreline.
3. Vessel overlaps the castle stair base (reads as moored; accepted for V1).
4. Sky-PNG, mountains-JPG (white), waves-PNG (mottle) twins are unusable as
   layers — flagged, not modified.
5. Keeper plays the idle loop in this preview; production holds frame 0
   (W1-R). Any GameScene integration must keep the stationary rule.
6. Plates are ~2–3.5MB PNGs served as-is; production use needs compressed
   derivatives via an approved pipeline (no publication done here).
