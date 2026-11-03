import {
  MANUAL_RITES,
  TIDEBOUND_LIBRARY,
  contributeScouts,
  contributeShields,
} from "../content/tidebound";
import { snapshotCounters } from "../engine/predicates";
import {
  closeSessionVote,
  closeStream,
  noteSessionCommand,
  openStream,
  overrideSessionVote,
  resolveSessionVote,
  type StreamSession,
} from "../engine/lifecycle";
import {
  collectCandidates,
  fireTemplate,
  type EventTemplate,
} from "../engine/templates";
import type { TriggerContext } from "../engine/triggers";
import type { GameEngine } from "../engine/engine";
import { isVoteClosed } from "../engine/vote";
import type { GameResult, WorldState } from "../engine/types";

/**
 * Phase 5G-7 — runtime gameplay wiring (pure glue, no DOM/Phaser).
 *
 * The domain (vote/meter/template/lifecycle) knows HOW to validate, count,
 * and fire; the engine knows how to PROCESS events. Neither decides WHEN the
 * collective story advances — that policy lives here, exactly as specified
 * in the approved 5G-6 contract:
 *
 * - threshold evaluation runs at most once per processed event and fires at
 *   most one template (no recursive cascades, no pending state);
 * - a closing vote resolves and fires exactly once, synchronously, on the
 *   transition that closes it (no deferred winner, no second firing);
 * - meter contributions happen once per processed eligible command;
 * - stream open/close evaluate their named trigger moments;
 * - manual rites fire only via the explicit approved list (never vote options).
 *
 * Every function is pure: inputs are never mutated, outputs are fresh
 * references only where the domain clones. The app shell adopts returned
 * worlds/sessions via direct assignment (never loadWorld, which would wipe
 * viewer cooldowns).
 */

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** Outcome of one firing evaluation. At most one template fires. */
export interface FiringOutcome {
  world: WorldState;
  fired: string | null;
  /** Newly appended deeds the runtime must surface through the story channel. */
  newDeeds: string[];
  /** Machine-readable reason when nothing fired. */
  reason?: string;
}

/** Deeds appended by a firing, derived from the tail diff (never re-read). */
export function newDeedsSince(before: WorldState, after: WorldState): string[] {
  const beforeDeeds = Array.isArray(before.deeds) ? before.deeds : [];
  const afterDeeds = Array.isArray(after.deeds) ? after.deeds : [];
  if (afterDeeds.length < beforeDeeds.length) return [];
  return afterDeeds.slice(beforeDeeds.length).filter((d): d is string => typeof d === "string");
}

// ---------------------------------------------------------------------------
// Threshold evaluation (single unified path, §6 contract)
// ---------------------------------------------------------------------------

/**
 * Build the threshold context the policy requires: a snapshot of every
 * readable counter (shared vocabulary only — no second counter list), so
 * level-triggered templates match the live world exactly once per
 * evaluation. Corrupt counters were already omitted by the snapshot.
 */
export function thresholdContext(world: WorldState): TriggerContext {
  return { kind: "threshold", counterValues: snapshotCounters(world) };
}

/**
 * Evaluate threshold candidates against the live world and fire at most one
 * template (highest weight wins, input order breaks ties — per
 * selectTemplate, no second ranking system). No cascade: the caller must
 * adopt the returned world and move on; a second evaluation happens only on
 * the next processed event.
 */
export function evaluateThresholds(world: WorldState, library: unknown): FiringOutcome {
  const collected = collectCandidates(thresholdContext(world), library, world);
  if (!collected.ok) return { world, fired: null, newDeeds: [], reason: collected.reason };
  if (collected.template === null) return { world, fired: null, newDeeds: [] };
  const fired = fireTemplate(collected.template, world);
  if (!fired.ok) return { world, fired: null, newDeeds: [], reason: fired.reason };
  return {
    world: fired.world,
    fired: collected.template.id,
    newDeeds: newDeedsSince(world, fired.world),
  };
}

/**
 * Evaluate one named lifecycle moment (streamOpen / streamClose) against the
 * library and fire at most one matching template. Same one-firing rule as
 * the threshold path.
 */
export function evaluateStreamMoment(
  world: WorldState,
  library: unknown,
  kind: "streamOpen" | "streamClose",
): FiringOutcome {
  const collected = collectCandidates({ kind }, library, world);
  if (!collected.ok) return { world, fired: null, newDeeds: [], reason: collected.reason };
  if (collected.template === null) return { world, fired: null, newDeeds: [] };
  const fired = fireTemplate(collected.template, world);
  if (!fired.ok) return { world, fired: null, newDeeds: [], reason: fired.reason };
  return {
    world: fired.world,
    fired: collected.template.id,
    newDeeds: newDeedsSince(world, fired.world),
  };
}

// ---------------------------------------------------------------------------
// Meter contributions (one attempt per processed eligible command)
// ---------------------------------------------------------------------------

export interface ContributionStep {
  world: WorldState;
  session: StreamSession;
  contributed: boolean;
  reason?: string;
}

/**
 * Attempt exactly one meter contribution for a processed command result.
 * `!scout` feeds pale-chart, `!shield` feeds beacon-oil; every other action
 * is a no-op (returns the inputs unchanged). The domain enforces one
 * contribution per actor per stream, gating, retirement, and atomicity —
 * nothing is duplicated or re-checked here. Paid results never reach this
 * path (the caller gates on action).
 */
export function contributeForCommand(
  world: WorldState,
  session: StreamSession,
  action: GameResult["action"],
  actorId: string | undefined,
): ContributionStep {
  if (action !== "search" && action !== "shield") {
    return { world, session, contributed: false, reason: "not-a-contribution" };
  }
  if (typeof actorId !== "string" || actorId.length === 0) {
    return { world, session, contributed: false, reason: "invalid-actor" };
  }
  const r =
    action === "search"
      ? contributeScouts(session, world, [actorId])
      : contributeShields(session, world, [actorId]);
  if (!r.ok) return { world, session, contributed: false, reason: r.reason };
  return {
    world: r.world,
    session: r.session,
    contributed: r.accepted.length > 0,
    reason: r.accepted.length > 0 ? undefined : (r.skipped[0]?.reason ?? "skipped"),
  };
}

// ---------------------------------------------------------------------------
// Vote close → resolve → fire (exactly once per close transition)
// ---------------------------------------------------------------------------

export interface VoteCloseStep {
  session: StreamSession;
  world: WorldState;
  /** True when this call performed the open → closed transition. */
  closedNow: boolean;
  fired: string | null;
  newDeeds: string[];
  winner: string | null;
  reason?: string;
}

function noVoteChange(session: StreamSession, world: WorldState, reason?: string): VoteCloseStep {
  return { session, world, closedNow: false, fired: null, newDeeds: [], winner: null, reason };
}

/**
 * Resolve the active vote against the live world and fire the winner.
 * Precondition: the vote is already closed (checked by the caller via the
 * close transition). Null winner (no ballots / stale winner) and fire
 * failures are no-ops that preserve the world byte-for-byte — never a
 * fallback to runner-up, never a random pick.
 */
export function resolveAndFireVote(
  session: StreamSession,
  world: WorldState,
  library: unknown,
): VoteCloseStep {
  if (session.activeVote === null) {
    return { ...noVoteChange(session, world), reason: "no-active-vote" };
  }
  const resolved = resolveSessionVote(session, world, library);
  if (!resolved.ok) {
    return { ...noVoteChange(session, world), reason: resolved.reason };
  }
  if (resolved.winner === null) {
    return { ...noVoteChange(session, world), reason: resolved.reason ?? "no-winner" };
  }
  const template = (Array.isArray(library) ? library : []).find(
    (t): t is EventTemplate =>
      typeof t === "object" && t !== null && (t as { id?: unknown }).id === resolved.winner,
  );
  if (!template) {
    return { ...noVoteChange(session, world), winner: resolved.winner, reason: "winner-not-in-library" };
  }
  const fired = fireTemplate(template, world);
  if (!fired.ok) {
    return { ...noVoteChange(session, world), winner: resolved.winner, reason: fired.reason };
  }
  return {
    session,
    world: fired.world,
    closedNow: false,
    fired: resolved.winner,
    newDeeds: newDeedsSince(world, fired.world),
    winner: resolved.winner,
  };
}

/**
 * Advance the vote clock for one processed command and, ONLY on the exact
 * transition open → closed, resolve and fire the winner synchronously.
 * Every other call leaves the world untouched. Paid events, ticks, and
 * retraction/compensation results must never reach this function (the caller
 * gates on the result shape); the domain additionally ignores them.
 */
export function noteVoteCommandAndMaybeFire(
  session: StreamSession,
  world: WorldState,
  library: unknown,
): VoteCloseStep {
  if (session.activeVote === null || session.phase !== "open") {
    return noVoteChange(session, world);
  }
  const wasClosed = isVoteClosed(session.activeVote);
  const noted = noteSessionCommand(session);
  if (!noted.ok) {
    return { ...noVoteChange(session, world), reason: noted.reason };
  }
  const next: StreamSession = noted.session;
  if (wasClosed || !isVoteClosed(next.activeVote)) {
    return { ...noVoteChange(next, world), reason: wasClosed ? "already-closed" : undefined };
  }
  // The close transition happened in this exact call: resolve + fire once.
  const fired = resolveAndFireVote(next, world, library);
  return { ...fired, session: next, closedNow: true };
}

/**
 * Manual creator close. Fires only when this call performs the open → closed
 * transition; an already-closed vote resolves nothing and fires nothing
 * (repeat eligibility additionally backstops any double-fire).
 */
export function closeVoteAndFire(
  session: StreamSession,
  world: WorldState,
  library: unknown,
): VoteCloseStep & { didClose: boolean } {
  if (session.activeVote === null) {
    return { ...noVoteChange(session, world), didClose: false, reason: "no-active-vote" };
  }
  // closeSessionVote requires an open session; a closed session keeps its vote.
  if (session.phase !== "open") {
    return { ...noVoteChange(session, world), didClose: false, reason: "invalid-session" };
  }
  const wasClosed = isVoteClosed(session.activeVote);
  const closed = closeSessionVote(session);
  if (!closed.ok) {
    return { ...noVoteChange(session, world), didClose: false, reason: closed.reason };
  }
  if (wasClosed) {
    return { ...noVoteChange(closed.session, world), didClose: false, reason: "already-closed" };
  }
  const fired = resolveAndFireVote(closed.session, world, library);
  return { ...fired, session: closed.session, closedNow: true, didClose: true };
}

/**
 * Creator override: record the auditable deed, fire the chosen winner
 * immediately, then close the vote — atomically from the runtime's point of
 * view. A later close observes the closed vote and skips firing. On fire
 * failure the deed stands as the audit trail and the vote still closes
 * (explicit creator act, deterministic, no retry loop).
 */
export function overrideVoteAndFire(
  session: StreamSession,
  world: WorldState,
  library: unknown,
  optionIndex: unknown,
): VoteCloseStep & { didClose: boolean; winner: string | null } {
  const failed = (reason: string, w: WorldState = world, s: StreamSession = session): VoteCloseStep & {
    didClose: boolean;
    winner: string | null;
  } => ({ session: s, world: w, closedNow: false, fired: null, newDeeds: [], winner: null, didClose: false, reason });
  const overridden = overrideSessionVote(session, world, optionIndex, library);
  if (!overridden.ok) return failed(overridden.reason);
  const template = (Array.isArray(library) ? library : []).find(
    (t): t is EventTemplate =>
      typeof t === "object" && t !== null && (t as { id?: unknown }).id === overridden.winner,
  );
  let w = overridden.world;
  let fired: string | null = null;
  let reason: string | undefined;
  if (!template) {
    reason = "winner-not-in-library";
  } else {
    const f = fireTemplate(template, overridden.world);
    if (!f.ok) {
      reason = f.reason;
    } else {
      w = f.world;
      fired = overridden.winner;
    }
  }
  const newDeeds = newDeedsSince(world, w);
  // Close the vote as part of the same explicit act; idempotent if closed.
  if (session.phase !== "open" || session.activeVote === null) {
    return { session, world: w, closedNow: false, fired, newDeeds, winner: overridden.winner, didClose: false, reason };
  }
  const closed = closeSessionVote(session);
  if (!closed.ok) {
    return { session, world: w, closedNow: false, fired, newDeeds, winner: overridden.winner, didClose: false, reason };
  }
  return { session: closed.session, world: w, closedNow: true, fired, newDeeds, winner: overridden.winner, didClose: true, reason };
}

// ---------------------------------------------------------------------------
// Stream open / close with lifecycle firing
// ---------------------------------------------------------------------------

export interface StreamOpenResult {
  ok: true;
  world: WorldState;
  session: StreamSession;
  fired: string | null;
  newDeeds: string[];
  reason?: string;
}

export interface StreamOpenFailure {
  ok: false;
  reason: string;
}

/**
 * Open the next stream session, then evaluate streamOpen candidates once.
 * Repeat policy gates refire (e.g. matins fires once per chapter), so reloads
 * and resets mid-chapter are safe no-ops.
 */
export function openStreamAndFire(
  world: WorldState,
  library: unknown = TIDEBOUND_LIBRARY,
): StreamOpenResult | StreamOpenFailure {
  const opened = openStream(world);
  if (!opened.ok) return opened;
  const fired = evaluateStreamMoment(opened.world, library, "streamOpen");
  return {
    ok: true,
    world: fired.world,
    session: opened.session,
    fired: fired.fired,
    newDeeds: fired.newDeeds,
    reason: fired.reason,
  };
}

export interface StreamCloseResult {
  ok: true;
  world: WorldState;
  session: StreamSession;
  fired: string | null;
  newDeeds: string[];
  reason?: string;
}

export interface StreamCloseFailure {
  ok: false;
  reason: string;
}

/**
 * Evaluate streamClose candidates against the pre-close world (the deed
 * belongs to the closing stream), fire at most one, then close. Firing
 * never touches streamCount, so the session binding check inside
 * closeStream still holds.
 */
export function closeStreamAndFire(
  world: WorldState,
  session: StreamSession,
  library: unknown = TIDEBOUND_LIBRARY,
): StreamCloseResult | StreamCloseFailure {
  const fired = evaluateStreamMoment(world, library, "streamClose");
  const closed = closeStream(fired.world, session);
  if (!closed.ok) return closed;
  return {
    ok: true,
    world: closed.world,
    session: closed.session,
    fired: fired.fired,
    newDeeds: fired.newDeeds,
    reason: fired.reason,
  };
}

// ---------------------------------------------------------------------------
// Manual creator rites (explicit approved actions only)
// ---------------------------------------------------------------------------

export interface RiteResult {
  ok: boolean;
  world: WorldState;
  fired: string | null;
  newDeeds: string[];
  reason?: string;
}

/**
 * Fire one manual rite by template id. Only ids in MANUAL_RITES are
 * accepted — route and Kindling templates are vote-only and can never fire
 * here, and arbitrary template ids are rejected without touching the world.
 * Full domain gates apply (predicate, repeat, affordability, effects).
 */
export function fireRite(
  world: WorldState,
  library: unknown,
  templateId: unknown,
): RiteResult {
  if (typeof templateId !== "string" || !(MANUAL_RITES as readonly string[]).includes(templateId)) {
    return { ok: false, world, fired: null, newDeeds: [], reason: "not-a-rite" };
  }
  const template = (Array.isArray(library) ? library : []).find(
    (t): t is EventTemplate =>
      typeof t === "object" && t !== null && (t as { id?: unknown }).id === templateId,
  );
  if (!template) {
    return { ok: false, world, fired: null, newDeeds: [], reason: "unknown-template" };
  }
  const fired = fireTemplate(template, world);
  if (!fired.ok) {
    return { ok: false, world, fired: null, newDeeds: [], reason: fired.reason };
  }
  return { ok: true, world: fired.world, fired: templateId, newDeeds: newDeedsSince(world, fired.world) };
}

// ---------------------------------------------------------------------------
// Runtime result gating (single definition of "a processed event counts")
// ---------------------------------------------------------------------------

const PAID_ACTIONS: ReadonlySet<string> = new Set([
  "paid_strike",
  "paid_supply",
  "paid_elite",
  "paid_story",
]);

/**
 * Whether an engine result represents a processed viewer/paid event (as
 * opposed to world-internal noise: ticks, retractions, compensations,
 * ledger-duplicate rejections — all actorName "world"). Threshold scans and
 * meter contributions run only for these; paid results are included here
 * (their catalysts can trip thresholds) while vote clocks exclude them
 * separately in the runtime.
 */
export function isProgressableResult(r: GameResult): boolean {
  if (r.actorName === "world") return false;
  if (r.eventId.startsWith("tick-")) return false;
  return true;
}

/** Paid catalyst results never advance votes or meters (locked 5G rule). */
export function isPaidResult(r: GameResult): boolean {
  return PAID_ACTIONS.has(r.action);
}

export interface HandledResult {
  session: StreamSession;
  /** True when this result closed a vote AND fired its winner. */
  voteFired: boolean;
  /** Template id fired by this result, if any (vote or threshold — at most one). */
  fired: string | null;
  /** True when this result advanced a meter. */
  contributed: boolean;
}

/**
 * Single wiring point for one processed engine result. Mirror of the app
 * runtime's onResult hook — tests drive this directly for full-fidelity
 * coverage of the wiring order. Steps, in order:
 *
 * 1. direct command consequences (meter contributions for !scout/!shield),
 * 2. assembly reaction (vote clock; firing at most once on the close
 *    transition — a firing consumes this result's threshold opportunity),
 * 3. ambient threshold reaction (at most one firing).
 *
 * Paid catalysts trip thresholds but never vote or contribute; ticks,
 * retractions, compensations, and ledger-duplicate rejections advance
 * nothing and fire nothing. New deeds are pushed through the existing
 * story channel (no fabricated GameResult).
 */
export function handleProcessedResult(
  engine: GameEngine,
  session: StreamSession,
  r: GameResult,
  library: unknown = TIDEBOUND_LIBRARY,
): HandledResult {
  let voteFired = false;
  let fired: string | null = null;
  let contributed = false;
  if (isProgressableResult(r) && !isPaidResult(r)) {
    if (r.action === "search" || r.action === "shield") {
      const c = contributeForCommand(engine.world, session, r.action, r.actorId);
      session = c.session;
      engine.world = c.world;
      contributed = c.contributed;
    }
    if (session.activeVote !== null) {
      const stepped = noteVoteCommandAndMaybeFire(session, engine.world, library);
      session = stepped.session;
      engine.world = stepped.world;
      for (const d of stepped.newDeeds) engine.pushStory(d);
      voteFired = stepped.fired !== null;
      if (voteFired) fired = stepped.fired;
    }
  }
  if (isProgressableResult(r) && !voteFired) {
    const t = evaluateThresholds(engine.world, library);
    if (t.fired !== null) {
      engine.world = t.world;
      for (const d of t.newDeeds) engine.pushStory(d);
      fired = t.fired;
    }
  }
  return { session, voteFired, fired, contributed };
}
