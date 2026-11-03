import { isKnownCounter, resolveCounter } from "./predicates";
import type { TriggerContext } from "./triggers";
import type { WorldState } from "./types";
import {
  applyCreatorOverride,
  castVote,
  closeVote,
  isVoteClosed,
  noteCommandProcessed,
  openVote,
  resolveVote,
  validateActiveVote,
  type ActiveVote,
} from "./vote";
import {
  contributeToMeter,
  validateMeterContributors,
  validateMeterDefinition,
  type MeterContributors,
} from "./meter";

/**
 * Phase 5B — stream lifecycle foundation (pure, deterministic, no clock).
 * Phase 5C — the session is the home for ephemeral community mechanics:
 * `activeVote` (session-only vote state, never persisted) and
 * `meterContributors` (per-stream contributor lists, reset every stream;
 * the persistent `meter.<id>` totals live in WorldState.eventCounters).
 *
 * Establishes the runtime/session boundary: openStream() opens an episode
 * session, closeStream() advances streamCount and closes it. WorldState is
 * never mutated in place; session state is ephemeral and never persisted.
 */

export interface StreamSession {
  /** Deterministic id: `stream-${streamNumber}`. No randomness, no timestamps. */
  sessionId: string;
  /** 1-based episode number: world.streamCount + 1 at open time. */
  streamNumber: number;
  phase: "open" | "closed";
  /** Session-only vote. Null when no vote is running. Never persisted. */
  activeVote: ActiveVote | null;
  /** Session-only per-meter contributor lists. Fresh `{}` every stream. Never persisted. */
  meterContributors: MeterContributors;
}

export type LifecycleResult = {
  ok: true;
  world: WorldState;
  session: StreamSession;
  context: TriggerContext;
} | {
  ok: false;
  reason: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Minimal shape guard. Full save validation stays in the persistence boundary. */
function isLifecycleWorld(w: unknown): w is WorldState {
  return (
    isRecord(w) &&
    typeof w.streamCount === "number" &&
    Number.isInteger(w.streamCount) &&
    w.streamCount >= 0
  );
}

function isSessionShape(s: unknown): s is StreamSession {
  if (
    !isRecord(s) ||
    typeof s.sessionId !== "string" ||
    typeof s.streamNumber !== "number" ||
    !Number.isInteger(s.streamNumber) ||
    s.streamNumber < 1 ||
    (s.phase !== "open" && s.phase !== "closed")
  ) {
    return false;
  }
  if (s.activeVote !== null && s.activeVote !== undefined && !validateActiveVote(s.activeVote)) {
    return false;
  }
  if (s.meterContributors !== undefined && !validateMeterContributors(s.meterContributors)) {
    return false;
  }
  // Strict for sessions this slice creates: both ephemera must be present.
  // Sessions built before 5C (absent fields) are still readable upstream —
  // openStream() always produces the full shape below.
  if (s.activeVote === undefined || s.meterContributors === undefined) return false;
  return true;
}

function isOpenSession(s: unknown): s is StreamSession {
  return isSessionShape(s) && s.phase === "open";
}

/**
 * Open the next episode. World is returned untouched (same reference);
 * a fresh session is created with no vote and empty contributor sets —
 * the stream boundary resets all ephemera by construction.
 * Deterministic: same world => same session.
 */
export function openStream(world: WorldState): LifecycleResult {
  if (!isLifecycleWorld(world)) return { ok: false, reason: "invalid-world" };
  const streamNumber = world.streamCount + 1;
  return {
    ok: true,
    world,
    session: {
      sessionId: `stream-${streamNumber}`,
      streamNumber,
      phase: "open",
      activeVote: null,
      meterContributors: {},
    },
    context: { kind: "streamOpen" },
  };
}

/**
 * Close the current episode. streamCount advances by exactly one on a
 * working clone; the input world and session are untouched. The session
 * must be open and bound to this world (streamNumber === streamCount + 1),
 * otherwise the close is rejected — no double-close, no cross-world close.
 * Ephemeral vote/contributor state travels with the (now closed) session
 * object and disappears with it; it is never written into the world.
 */
export function closeStream(world: WorldState, session: StreamSession): LifecycleResult {
  if (!isLifecycleWorld(world)) return { ok: false, reason: "invalid-world" };
  if (
    !isOpenSession(session) ||
    session.streamNumber !== world.streamCount + 1 ||
    session.sessionId !== `stream-${session.streamNumber}`
  ) {
    return { ok: false, reason: "invalid-session" };
  }
  const next = structuredClone(world);
  next.streamCount += 1;
  return {
    ok: true,
    world: next,
    session: { ...session, phase: "closed" },
    context: { kind: "streamClose" },
  };
}

/**
 * Build a threshold trigger context from live world values, using the
 * single shared counter vocabulary (isKnownCounter/resolveCounter).
 * Unknown counters fail closed — never silently zero. Phase 5C: this is
 * also how a `meter.<id>` completion becomes eligible — the caller
 * supplies `meter.<id>` names here and matches them against a threshold
 * trigger with the same counter/value. No new trigger kind exists.
 */
export function supplyThresholdContext(
  world: WorldState,
  counters: unknown,
): { ok: true; context: TriggerContext } | { ok: false; reason: string } {
  if (!isLifecycleWorld(world)) return { ok: false, reason: "invalid-world" };
  if (!Array.isArray(counters)) return { ok: false, reason: "invalid-counters-list" };
  const counterValues: Record<string, number> = {};
  for (const name of counters) {
    if (!isKnownCounter(name)) return { ok: false, reason: "invalid-counter" };
    const v = resolveCounter(world, name);
    if (v === null) return { ok: false, reason: "invalid-counter" }; // unreachable; defensive
    counterValues[name] = v;
  }
  return { ok: true, context: { kind: "threshold", counterValues } };
}

// ---------------------------------------------------------------------------
// Phase 5C — session vote glue (thin delegates over vote.ts; still pure).
// The session must be open. Every helper clones and returns a new session;
// inputs are never mutated.
// ---------------------------------------------------------------------------

export type SessionResult =
  | { ok: true; session: StreamSession }
  | { ok: false; reason: string };

/**
 * Open a vote on the session. Rejects when a vote is already running
 * (`vote-active`) — opening never silently discards live ballots. A closed
 * vote may be replaced by a fresh one.
 */
export function openSessionVote(
  session: StreamSession,
  args: { id: unknown; options: unknown; maxCommands: unknown; library: unknown; scope?: unknown },
): SessionResult {
  if (!isOpenSession(session)) return { ok: false, reason: "invalid-session" };
  if (session.activeVote !== null && !isVoteClosed(session.activeVote)) {
    return { ok: false, reason: "vote-active" };
  }
  const r = openVote({
    id: args.id,
    options: args.options,
    scope: args.scope ?? session.sessionId,
    maxCommands: args.maxCommands,
    library: args.library,
  });
  if (!r.ok) return r;
  return { ok: true, session: { ...session, activeVote: r.vote } };
}

/** Cast one ballot on the session vote. Latest vote wins per actor. */
export function castSessionVote(
  session: StreamSession,
  actorId: unknown,
  optionIndex: unknown,
): SessionResult {
  if (!isOpenSession(session)) return { ok: false, reason: "invalid-session" };
  if (session.activeVote === null) return { ok: false, reason: "no-active-vote" };
  const r = castVote(session.activeVote, actorId, optionIndex);
  if (!r.ok) return r;
  return { ok: true, session: { ...session, activeVote: r.vote } };
}

/**
 * Advance the session vote clock by one processed command. The runtime calls
 * this exactly once per processed chat_command result while the vote is open:
 * any non-world, non-tick, non-paid result advances the clock, including
 * cooldown and rejected outcomes (participation is counted, not just
 * successful effects). Never call for paid events (they process normally
 * but must not move the vote clock) and never for retraction/compensation
 * results. Duplicate deliveries never reach here (queue dedup).
 */
export function noteSessionCommand(session: StreamSession): SessionResult {
  if (!isOpenSession(session)) return { ok: false, reason: "invalid-session" };
  if (session.activeVote === null) return { ok: false, reason: "no-active-vote" };
  const r = noteCommandProcessed(session.activeVote);
  if (!r.ok) return r;
  return { ok: true, session: { ...session, activeVote: r.vote } };
}

/** Manual/creator close of the session vote. Idempotent. */
export function closeSessionVote(session: StreamSession): SessionResult {
  if (!isOpenSession(session)) return { ok: false, reason: "invalid-session" };
  if (session.activeVote === null) return { ok: false, reason: "no-active-vote" };
  const r = closeVote(session.activeVote);
  if (!r.ok) return r;
  return { ok: true, session: { ...session, activeVote: r.vote } };
}

/**
 * Resolve the session vote against the live world/library. Read-only:
 * returns the winner id (or null for no-ballots / stale winner) plus the
 * distinct-voter counts. The caller fires the winner via `fireTemplate()`.
 */
export function resolveSessionVote(
  session: StreamSession,
  world: WorldState,
  library: unknown,
):
  | { ok: true; winner: string | null; counts: number[]; reason?: string }
  | { ok: false; reason: string } {
  if (!isSessionShape(session)) return { ok: false, reason: "invalid-session" };
  if (session.activeVote === null) return { ok: false, reason: "no-active-vote" };
  return resolveVote(session.activeVote, world, library);
}

/**
 * Explicit creator override for the session vote. Records an auditable
 * deed on a working world clone ("The flame leaned toward …") via the
 * existing effect machinery; ballots are untouched. The returned winner
 * must still pass through `fireTemplate()`.
 */
export function overrideSessionVote(
  session: StreamSession,
  world: WorldState,
  optionIndex: unknown,
  library: unknown,
):
  | { ok: true; world: WorldState; winner: string }
  | { ok: false; reason: string } {
  if (!isSessionShape(session)) return { ok: false, reason: "invalid-session" };
  if (session.activeVote === null) return { ok: false, reason: "no-active-vote" };
  return applyCreatorOverride(session.activeVote, world, optionIndex, library);
}

// ---------------------------------------------------------------------------
// Phase 5C — session meter glue (thin delegates over meter.ts; still pure).
// ---------------------------------------------------------------------------

export type MeterSessionResult =
  | { ok: true; world: WorldState; session: StreamSession }
  | { ok: false; reason: string };

/**
 * Contribute +1 from one actor to one meter. Atomic: the persistent
 * `meter.<id>` counter and the session contributor set update together or
 * not at all. One contribution per actor per stream; completed meters are
 * retired (`meter-complete`).
 */
export function contributeToSessionMeter(
  session: StreamSession,
  world: WorldState,
  meter: unknown,
  actorId: unknown,
): MeterSessionResult {
  if (!isOpenSession(session)) return { ok: false, reason: "invalid-session" };
  if (!validateMeterDefinition(meter)) return { ok: false, reason: "invalid-meter-definition" };
  const r = contributeToMeter(world, session.meterContributors, meter, actorId);
  if (!r.ok) return r;
  return { ok: true, world: r.world, session: { ...session, meterContributors: r.contributors } };
}

/**
 * Reset the session contributor sets (stream-boundary helper). A fresh
 * `openStream()` already starts empty; this covers explicit resets without
 * touching the persistent meter totals.
 */
export function resetSessionMeterContributors(session: StreamSession): SessionResult {
  if (!isSessionShape(session)) return { ok: false, reason: "invalid-session" };
  return { ok: true, session: { ...session, meterContributors: {} } };
}

// ---------------------------------------------------------------------------
// Recap selection: deterministic deed picker for the stream-open ceremony.
// Deeds are bare strings (no metadata by design), so priority is derived
// from a documented keyword convention. Authors mark important deeds with
// consequence/kill vocabulary; everything else reads as routine.
// ---------------------------------------------------------------------------

export type DeedKind = "consequence" | "kill" | "routine";

const CONSEQUENCE_RE =
  /\b(chapter|arc|advanced|unlock|awakened|standing|reputation|alliance|betray|lost|reclaimed|strained|gate|bell|oath|burned|sacrifice|fell|fallen|collapsed|saved|doomed)\b/i;
const KILL_RE = /\b(killing blow|killed|slain|slew|defeated|felled|victory|triumph)\b/i;

/** Classify one deed line. Non-strings fail safe to routine (presentational only). */
export function classifyDeed(deed: unknown): DeedKind {
  if (typeof deed !== "string") return "routine";
  if (CONSEQUENCE_RE.test(deed)) return "consequence";
  if (KILL_RE.test(deed)) return "kill";
  return "routine";
}

/**
 * Select up to `limit` deeds, consequence-first, newest-first within each
 * priority. Default 3, clamped to 1..5. Pure: never mutates the world.
 */
export function selectRecapDeeds(world: WorldState, limit?: number): string[] {
  const n =
    typeof limit === "number" && Number.isInteger(limit) && limit >= 1 ? Math.min(limit, 5) : 3;
  const deeds = isRecord(world) && Array.isArray(world.deeds)
    ? world.deeds.filter((d): d is string => typeof d === "string")
    : [];
  const buckets: Record<DeedKind, string[]> = { consequence: [], kill: [], routine: [] };
  for (let i = deeds.length - 1; i >= 0; i--) {
    buckets[classifyDeed(deeds[i])].push(deeds[i]);
  }
  return [...buckets.consequence, ...buckets.kill, ...buckets.routine].slice(0, n);
}
