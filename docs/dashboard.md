# Tidebound Creator Dashboard — Architecture

Final state after UX-001C (audit) → UX-002 (shell) → UX-003 (Overview) →
UX-004 (Control Room) → UX-005 (Activity) → UX-006 (Settings) → UX-007A
(hardening). Single route: `index.html` → `src/main.ts` →
`createRuntime({ withPanel: true })` in `src/app.ts`. The viewer overlay
(`overlay.html` → `src/overlay.ts`, `withPanel: false`) is a separate entry
and shares only engine + presentation read models.

## 1. Information architecture

Hash-routed (`#overview` / `#control` / `#activity` / `#settings`,
invalid → Overview) with a desktop rail, mobile bottom tabs, sticky
header (runtime + YouTube pills + next-action line), and a global alert
banner. No routing dependency.

| Section | Responsibility | Character |
|---|---|---|
| Overview | Session/connection/world status, next action, story moment, activity preview | Observational (read-only + links) |
| Control Room | Pause/resume, votes + audited overrides, rites, danger zone (end-stream, reset) | Operational (all mutating controls) |
| Activity | Filterable timeline, queue, ledger, diagnostics | Historical/diagnostic (read-only) |
| Settings | Source radios, YouTube stepper, rehearsal, saves, OBS card, diagnostics | Configuration |

Cross-links: Overview mirrors link to owning sections (`#control`,
`#activity`, `#settings`); alert banner links match `nextActionModel`
destinations for shared conditions.

## 2. Dashboard modules (`src/dashboard/`)

All pure, zero-import, zero-DOM (enforced by tests):

- `shell.ts` — hash mapping, alert derivation (`computeAlerts`), alert HTML,
  thin DOM sync (`initShell` once, `syncShellStatus` with signature diffing).
- `overview.ts` — `nextActionModel` (17-branch deterministic priority) and
  summary-line helpers. Never claims chat reception except on STREAMING.
- `control.ts` — availability models mirroring engine validation order
  (condition → repeat → supplies → resolve) plus dialog copy. The engine
  re-validates every call, so UI mistakes can only hide actions.
- `activity.ts` — event normalization, filter predicates, queue/ledger
  summaries. Fixed stream order (vote-live → processed → story → deeds →
  ledger); no cross-stream chronology is claimed.
- `settings.ts` — stepper derivation (done only on positive evidence),
  recovery mapping (verified commands only), OBS config from origin + route.

## 3. State and data flow (`src/app.ts`)

`renderPanelState(rt)` reads authoritative models (`headerModel`,
`threatModel`, `voteModel`, `youtubeDisplayModel`, `ledgerStatus`, queue,
`recentResults`, `storyLog`, `deeds`, `paidLedger`, `persistFrom`) and
writes text/attributes plus signature-diffed innerHTML regions. Handlers in
`wirePanel` are registered once; confirmation for override/end-stream/reset
goes through one native `<dialog>` with single-run semantics.

## 4. Polling lifecycle (exactly three intervals, unchanged)

1. 250ms engine pump/tick (`renderPanelState` on change only).
2. 1000ms shield/scene sync.
3. 1000ms panel refresh + YouTube sidecar status poll (3s inside client).

Per render: ~60 `getElementById` lookups (hash-cost), one `offsetHeight`
read of the small sticky subtree (single forced reflow, write change-gated),
one cached `matchMedia` query object, timeline build over bounded sources
(results ≤30, story ≤40, deeds/ledger display-capped; counts stay exact).
Filter buttons update text only (focus-safe); list regions rewrite only on
signature change and contain no focusables; no live regions on poll-driven
nodes. Deliberately no memoization beyond this — measured cost is
negligible next to the pre-existing vote-card innerHTML rebuild.

## 5. Isolation boundaries

- `src/engine/*`, `src/youtube/*`, `server/*`, `src/persistence/*`,
  `src/phaser/*`, HUD/overlay: behavior-frozen; dashboard only reads.
- `WorldStore.save()/load()` return values (`"file"|"local"|"none"`) are
  recorded, never reinterpreted; `"local"` is info, never failure.
- Rehearsal calls engine ingest only — it cannot reach YouTube transport;
  in YouTube mode its inputs disable with a reason.
- Amounts, payer ids, currency, and platform ids never leave the ledger
  module (`pickLedgerFields` drops them by construction).

## 6. Legacy ID preservation

All 63 original IDs exist exactly once (suite-enforced `it.each`), zero
duplicate IDs repo-wide, controls moved node-for-node (listeners travel
with nodes), handler payloads asserted identical. Region tests pin every
operating control to Control Room/Settings and readouts to Overview.

## 7. Known limitations

- Vote history is text-matched (engine keeps no vote log); some decided
  votes surface only as story deeds.
- `!voteA/B` engine summaries read "assembly has not been called" even
  mid-vote (engine copy, out of scope).
- `persistFrom:"local"` also covers total-storage failure (API cannot
  distinguish); wording claims only "browser-only".
- Sticky preview offset is JS-tracked; a mid-poll resize settles within 1s.
- Deed/timeline DOM caps display (15/50) while counts stay exact.

## 8. Browser verification remaining (never yet performed)

No browser tooling exists in this environment; nothing below is claimed:
cold-load five-second comprehension; pause/resume toggle; vote lifecycle +
override dialog (cancel/Escape/confirm/focus restore); rite disabled
reasons; rehearsal gating across source switch; stepper walk-through to
verified streaming; copy fallback; 1440px + 390px layouts; keyboard-only
tour; screen-reader silence during polls; reduced-motion pass.
