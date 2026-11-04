/**
 * UX-004 — Control Room availability models (PURE, no DOM, no imports).
 *
 * Availability mirrors the engine's locked validation order without
 * executing anything: the engine remains authoritative (fireRite /
 * overrideVoteAndFire / closeVoteAndFire re-validate on every call), so a
 * UI-side mistake can only hide an action, never force one through.
 *
 * Zero imports, like overview.ts: app.ts assembles inputs from existing
 * models (voteModel, isEligibleTemplate, isRepeatEligible, template cost,
 * queue/ledger/YouTube state) and this module returns per-control
 * {available, reason} pairs plus dialog copy. Reasons cite actual state.
 */

export interface Availability {
  available: boolean;
  /** Null when available. Always a concrete, state-grounded sentence. */
  reason: string | null;
}

const ok = (): Availability => ({ available: true, reason: null });
const no = (reason: string): Availability => ({ available: false, reason });

// ---------------------------------------------------------------------------
// Session toggle (both buttons stay mounted; one is hidden at a time).
// ---------------------------------------------------------------------------

export interface SessionAvailability {
  showPause: boolean;
  showResume: boolean;
  /** Status line under the toggle. */
  stateLine: string;
}

export function sessionAvailability(paused: boolean, queueSize: number): SessionAvailability {
  return {
    showPause: !paused,
    showResume: paused,
    stateLine: paused
      ? queueSize > 0
        ? `Runtime paused — ${queueSize} event(s) held. Resume to let them flow.`
        : "Runtime paused — incoming events are held. Resume to let them flow."
      : "Runtime running — events are flowing.",
  };
}

// ---------------------------------------------------------------------------
// Votes: open / close / override. Mirrors lifecycle rejection reasons:
// open → "vote-active"/"invalid-session"; close → "no-active-vote"/
// "already-closed"/"invalid-session"; override → "no-active-vote"/
// "invalid-option-index" (engine-validated per click).
// ---------------------------------------------------------------------------

export interface VoteAvailabilityInput {
  /** voteModel phase; anything else reads as "none". */
  votePhase: string;
  /** rt.session.phase === "open". */
  sessionOpen: boolean;
  /** voteModel options length (2 for route/Kindling votes). */
  optionCount: number;
}

export interface VoteAvailability {
  open: Availability;
  close: Availability;
  /** One entry per override button (Lean 1st/2nd/3rd). */
  overrides: [Availability, Availability, Availability];
}

export function voteAvailability(i: VoteAvailabilityInput): VoteAvailability {
  const phase = i.votePhase === "open" || i.votePhase === "closed" ? i.votePhase : "none";
  const count = Number.isFinite(i.optionCount) && i.optionCount > 0 ? Math.floor(i.optionCount) : 0;
  const open: Availability = !i.sessionOpen
    ? no("Session is not open.")
    : phase === "open"
      ? no("A vote is already open — close it first.")
      : ok();
  const close: Availability =
    phase === "open"
      ? ok()
      : phase === "closed"
        ? no("This vote is already decided.")
        : no("No vote is running.");
  const overrides: [Availability, Availability, Availability] = [0, 1, 2].map((idx) => {
    if (phase === "none") return no("No vote is running — overrides need an open vote.");
    if (phase === "closed") return no("This vote is already decided — overrides apply while voting is open.");
    if (idx >= count) {
      return no(
        count === 0
          ? "This vote has no options to lean toward."
          : `This vote has only ${count} option${count === 1 ? "" : "s"} — nothing ${idx + 1}${idx + 1 === 3 ? "rd" : "th"} to lean toward.`,
      );
    }
    return ok();
  }) as [Availability, Availability, Availability];
  return { open, close, overrides };
}

// ---------------------------------------------------------------------------
// Rites: mirrors fireTemplate's locked order — condition → repeat →
// supplies → resolve. Inputs are engine reads (isEligibleTemplate,
// isRepeatEligible, template.cost, world.resources/resolve); the fixed
// requirement blurbs below restate each template's own condition.
// ---------------------------------------------------------------------------

export interface RiteAvailabilityInput {
  templateId: string;
  conditionOk: boolean;
  repeatOk: boolean;
  /** template.repeat.kind ("once" | "perChapter" | "endless" | …). */
  repeatKind: string | null;
  suppliesCost: number;
  resolveCost: number;
  resources: number;
  resolve: number;
  /** Live threat level / kills / beacon-oil counts for grounded reasons. */
  threatLevel: number;
  kills: number;
  beaconOil: number;
}

const RITE_REQUIREMENTS: Record<string, string> = {
  "sable-mending-rite": "Requires Sable met (story-gated).",
  "tide-prayer": "Requires threat 50+.",
  "ilya-duel": "Requires parley with Ilya and 3 kills.",
  "cinderholm-rekindle": "Requires Cinderholm lost with 5 beacon oil.",
  "rho-plain-speech": "Requires Rho friendly — once per world.",
};

function riteRepeatReason(kind: string | null): string {
  if (kind === "once") return "Already told — this rite fires once per world.";
  if (kind === "perChapter") return "Already told this chapter.";
  return "Not available right now.";
}

export function riteAvailability(i: RiteAvailabilityInput): Availability {
  if (!RITE_REQUIREMENTS[i.templateId]) return no("Unknown rite.");
  if (!i.conditionOk) {
    // Grounded extras where the template condition names a live counter.
    if (i.templateId === "tide-prayer" && Number.isFinite(i.threatLevel)) {
      return no(`Requires threat 50+ (now ${i.threatLevel}).`);
    }
    if (i.templateId === "ilya-duel" && Number.isFinite(i.kills)) {
      return no(`Requires parley with Ilya and 3 kills (kills now ${i.kills}).`);
    }
    if (i.templateId === "cinderholm-rekindle" && Number.isFinite(i.beaconOil)) {
      return no(`Requires Cinderholm lost with 5 beacon oil (oil now ${i.beaconOil}/5).`);
    }
    return no(RITE_REQUIREMENTS[i.templateId]);
  }
  if (!i.repeatOk) return no(riteRepeatReason(i.repeatKind));
  const supplies = Number.isFinite(i.suppliesCost) && i.suppliesCost > 0 ? i.suppliesCost : 0;
  const resolveCost = Number.isFinite(i.resolveCost) && i.resolveCost > 0 ? i.resolveCost : 0;
  const haveSupplies = Number.isFinite(i.resources) ? i.resources : 0;
  const haveResolve = Number.isFinite(i.resolve) ? i.resolve : 0;
  if (haveSupplies < supplies) return no(`Needs ${supplies} supplies (have ${haveSupplies}).`);
  if (haveResolve < resolveCost) return no(`Needs ${resolveCost} resolve (have ${haveResolve}).`);
  return ok();
}

/** Static requirement blurb for the rite card (template's own condition). */
export function riteRequirement(templateId: string): string {
  return RITE_REQUIREMENTS[templateId] ?? "Unknown rite.";
}

// ---------------------------------------------------------------------------
// Rehearsal gating: simulation-only tools, separated from live controls.
// The handlers themselves are untouched — gating is presentation-layer
// safety. Switching sources keeps the existing radio handlers.
// ---------------------------------------------------------------------------

export interface RehearsalAvailability {
  enabled: boolean;
  sourceLine: string;
  reason: string | null;
}

export function rehearsalAvailability(source: "simulation" | "youtube"): RehearsalAvailability {
  if (source === "youtube") {
    return {
      enabled: false,
      sourceLine: "Input source: YouTube Live — rehearsal disabled.",
      reason: "Rehearsal is simulation-only. Switch to Simulation to rehearse.",
    };
  }
  return {
    enabled: true,
    sourceLine: "Input source: Simulation — rehearsal active.",
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// Destructive-action dialog copy. Verified against actual handlers:
// - endStream: closeStreamAndFire evaluates streamClose candidates (at most
//   one firing), closes the stream, then a fresh stream opens and saves.
// - reset: loadWorld(genesis) → openStreamAndFire → save (overwrites).
// ---------------------------------------------------------------------------

export interface ConfirmCopy {
  title: string;
  body: string;
  confirmLabel: string;
}

export function endStreamCopy(): ConfirmCopy {
  return {
    title: "Close this stream?",
    body: "The stream closes (one closing moment may fire), the world persists, and a fresh stream opens immediately. Audience ballots on any open vote are left behind with the closing stream.",
    confirmLabel: "Close stream & open next",
  };
}

export function resetCopy(): ConfirmCopy {
  return {
    title: "Reset Tidebound to its beginning?",
    body: "The world returns to genesis, a fresh stream opens, and the save is overwritten. Deeds, meters, and progress are lost. This cannot be undone.",
    confirmLabel: "Reset world",
  };
}

export function overrideCopy(optionLabel: string): ConfirmCopy {
  return {
    title: `Lean toward “${optionLabel}”?`,
    body: "This records an auditable keeper deed and fires the rite for the chosen path immediately — bypassing the audience vote. Ballots are left untouched. The vote then closes.",
    confirmLabel: "Lean (bypass vote)",
  };
}
