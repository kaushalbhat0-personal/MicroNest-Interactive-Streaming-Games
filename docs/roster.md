# Tidebound — MVP Character Roster (authoring data, Phase 5E)

No entity system. Names, roles, and portraits live here (later: creator
JSON). Only the mechanical keys below touch `WorldState`, using the
locked convention:

- `c.<id>.met` — story flag: first canonical appearance.
- `c.<id>.trust` — faction standing 0–100 (`factionState["<id>"]`,
  read via `attitudeIs`, moved via `addStanding`). There is NO `c.<id>.trust`
  event counter: no opcode writes event counters, so trust lives in standing.
- `c.<id>.fate.<ally|enemy|unnamed|dead>` — story flag, exactly one ever
  (authoring discipline: fate changes clear the old flag and set the new one
  in a single atomic effect list).
- `c.<id>.at.<location>` — story flag, at most one true per character;
  relocation sets the new flag and clears the old one in one atomic effect list.

Prefix `c.` is reserved. Nothing here populates gameplay state — keys are
created by templates/deeds when canon demands it (see `src/content/tidebound.ts`
for the canonical seed and the 18-template MVP library).

## 1. Bearer — streamer protagonist (no `c.` record; IS the save)

The keeper's apprentice. All Bearer state is world state (hero HP, resolve,
deeds). Never gains a character record — the Bearer is the lens, not an entry.

## 2. Sable — ally #1 / attachment

- Role: ex-Reclaimer engine-tender; keeps the lantern's ironwork alive.
- Expected keys: `c.sable.met`, `factionState["sable"]` (mentorship/repair fiction),
  `c.sable.fate.ally`, `c.sable.at.cinderholm`.
- Bond vector: repair work + dredge-map confession arc.

## 3. Wren — ally #2 / meter driver

- Role: Chartmaker apprentice; scouting and charting fiction.
- Expected keys: `c.wren.met`, `factionState["wren"]` (gates chart-sharing),
  `c.wren.fate.ally`, `c.wren.at.pale-reaches` (after the bell-founding).
- Bond vector: unique-searcher scouting; chart-progress meter driver (5C).

## 4. Old Tam — mystery / stakes

- Role: former Bearer, half-Unnamed; living cost-of-failure.
- Expected keys: `c.tam.met`, `c.tam.fate.unnamed` (already true at start —
  set by opening canon, not by play), `c.tam.at.cinderholm`.
- No trust track: Tam is memory, not a project. Layer-1 key.

## 5. Bellkeeper Rho — trust-track proof / mystery vector

- Role: tended the drowned chapel; speaks in bell-sequences until trusted.
- Expected keys: `c.rho.met`, `factionState["rho"]` (≥60 unlocks plain speech —
  the process proof for the convention), `c.rho.at.chapel-steps`.
- This is the character the convention must prove itself on first.

## 6. Ilya Vane — rival

- Role: bearer of gilded Highspire; believes the protagonist's flame is stolen.
- Expected keys: `c.ilya.met`, `factionState["ilya"]` (doubles as rivalry gauge;
  high standing + `fate.ally` = uneasy-ally path), `c.ilya.fate.enemy`
  (opening state), `c.ilya.at.highspire`.
- Duel/parley beats key off `factionState["ilya"]` bands.

## 7. Herald Vex — recurring antagonist

- Role: the Cantor's field commander; elite-slot encounters.
- Expected keys: `c.vex.met` (first summoning), `c.vex.fate.enemy`.
- No trust track: Vex escalates via latent attention + defeat flags
  (`c.vex.driven-off`, `c.vex.humbled` as plain story flags), never friendship.
