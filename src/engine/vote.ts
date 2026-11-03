import { applyEffect } from "./effects";
import { isEligibleTemplate, isRepeatEligible, validateEventTemplate } from "./templates";
import type { WorldState } from "./types";

/**
 * Phase 5C — viewer voting (session-only, deterministic, no clock).
 *
 * A vote chooses; it never executes. The winning option is a validated
 * template ID that the caller feeds into the existing `fireTemplate()` path.
 * Paid events never touch a vote (no weight, no counter influence).
 *
 * Vote state lives on StreamSession (see lifecycle.ts) and is NEVER
 * persisted. Duplicate event processing is safe by construction: ballots are
 * keyed by actorId (latest vote wins, replays collapse) and the command
 * counter advances only via `noteCommandProcessed()`, which the caller
 * invokes exactly once per dequeued + processed chat command — the same
 * dedup boundary the EventQueue already enforces (queue `seen` ids), so no
 * second dedup system exists here.
 */

export interface ActiveVote {
  /** Deterministic id for audit lines (e.g. creator-override deeds). */
  id: string;
  /** 2–3 template IDs, distinct. The vote only selects among these. */
  options: string[];
  /** Session context that opened the vote (normally the stream session id). */
  scope: string;
  /** Command-count bound: the vote closes once this many commands processed. */
  maxCommands: number;
  /** How many relevant commands have been processed since opening. */
  commandsProcessed: number;
  /** Exactly one ballot per actorId: actorId -> option index. Latest wins. */
  ballots: Record<string, number>;
  /** True after the command bound is reached or a manual close. */
  closed: boolean;
}

export const MAX_VOTE_ID_LENGTH = 64;
export const MAX_VOTE_OPTION_ID_LENGTH = 64;
export const MAX_VOTE_SCOPE_LENGTH = 128;
export const MAX_VOTE_ACTOR_LENGTH = 128;
export const MIN_VOTE_OPTIONS = 2;
export const MAX_VOTE_OPTIONS = 3;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Shape guard. False (never throws) for any malformed vote data. */
export function validateActiveVote(v: unknown): v is ActiveVote {
  if (!isRecord(v)) return false;
  if (
    typeof v.id !== "string" ||
    v.id.trim().length === 0 ||
    v.id.length > MAX_VOTE_ID_LENGTH
  ) {
    return false;
  }
  if (
    !Array.isArray(v.options) ||
    v.options.length < MIN_VOTE_OPTIONS ||
    v.options.length > MAX_VOTE_OPTIONS
  ) {
    return false;
  }
  const seen = new Set<string>();
  for (const o of v.options) {
    if (typeof o !== "string" || o.length === 0 || o.length > MAX_VOTE_OPTION_ID_LENGTH) {
      return false;
    }
    if (seen.has(o)) return false;
    seen.add(o);
  }
  if (
    typeof v.scope !== "string" ||
    v.scope.trim().length === 0 ||
    v.scope.length > MAX_VOTE_SCOPE_LENGTH
  ) {
    return false;
  }
  if (
    typeof v.maxCommands !== "number" ||
    !Number.isInteger(v.maxCommands) ||
    v.maxCommands <= 0
  ) {
    return false;
  }
  if (
    typeof v.commandsProcessed !== "number" ||
    !Number.isInteger(v.commandsProcessed) ||
    v.commandsProcessed < 0
  ) {
    return false;
  }
  if (typeof v.closed !== "boolean") return false;
  if (!isRecord(v.ballots)) return false;
  for (const [actor, idx] of Object.entries(v.ballots)) {
    if (actor.length === 0 || actor.length > MAX_VOTE_ACTOR_LENGTH) return false;
    if (
      typeof idx !== "number" ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= v.options.length
    ) {
      return false;
    }
  }
  return true;
}

function cloneVote(v: ActiveVote): ActiveVote {
  return { ...v, options: [...v.options], ballots: { ...v.ballots } };
}

export type OpenVoteInput = {
  id: unknown;
  options: unknown;
  scope: unknown;
  maxCommands: unknown;
  /** Content library the options must come from (validated, not executed). */
  library: unknown;
};

/**
 * Open a vote. Pure: validates input + option shape + option identity against
 * the library, establishes the deterministic command-count bound, and returns
 * a fresh vote. Never mutates WorldState, never executes any option.
 * Eligibility/affordability are NOT checked here — options can go stale
 * between opening and resolution, so `resolveVote()` rechecks the winner
 * against the live world fail-closed.
 */
export function openVote(
  input: OpenVoteInput,
): { ok: true; vote: ActiveVote } | { ok: false; reason: string } {
  if (!isRecord(input)) return { ok: false, reason: "invalid-vote-input" };
  const { id, options, scope, maxCommands, library } = input;
  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    id.length > MAX_VOTE_ID_LENGTH
  ) {
    return { ok: false, reason: "invalid-vote-id" };
  }
  if (
    !Array.isArray(options) ||
    options.length < MIN_VOTE_OPTIONS ||
    options.length > MAX_VOTE_OPTIONS
  ) {
    return { ok: false, reason: "invalid-option-count" };
  }
  const seen = new Set<string>();
  for (const o of options) {
    if (typeof o !== "string" || o.length === 0 || o.length > MAX_VOTE_OPTION_ID_LENGTH) {
      return { ok: false, reason: "invalid-option-id" };
    }
    if (seen.has(o)) return { ok: false, reason: "duplicate-option" };
    seen.add(o);
  }
  if (!Array.isArray(library)) return { ok: false, reason: "invalid-templates-list" };
  for (const o of options) {
    const t = (library as unknown[]).find((t) => isRecord(t) && t.id === o);
    if (!t || !validateEventTemplate(t)) {
      return { ok: false, reason: `invalid-option-template:${o}` };
    }
  }
  if (
    typeof scope !== "string" ||
    scope.trim().length === 0 ||
    scope.length > MAX_VOTE_SCOPE_LENGTH
  ) {
    return { ok: false, reason: "invalid-scope" };
  }
  if (
    typeof maxCommands !== "number" ||
    !Number.isInteger(maxCommands) ||
    maxCommands <= 0
  ) {
    return { ok: false, reason: "invalid-max-commands" };
  }
  return {
    ok: true,
    vote: {
      id,
      options: [...(options as string[])],
      scope,
      maxCommands,
      commandsProcessed: 0,
      ballots: {},
      closed: false,
    },
  };
}

/**
 * Cast a ballot. Pure: returns a new vote, never mutates the input, never
 * touches WorldState, never executes templates. Latest vote wins; repeating
 * the same option is idempotent. No weighting, no payment influence — there
 * is no amount parameter by design.
 */
export function castVote(
  vote: unknown,
  actorId: unknown,
  optionIndex: unknown,
): { ok: true; vote: ActiveVote } | { ok: false; reason: string } {
  if (!validateActiveVote(vote)) return { ok: false, reason: "invalid-vote" };
  if (vote.closed || vote.commandsProcessed >= vote.maxCommands) {
    return { ok: false, reason: "vote-closed" };
  }
  if (
    typeof actorId !== "string" ||
    actorId.length === 0 ||
    actorId.length > MAX_VOTE_ACTOR_LENGTH
  ) {
    return { ok: false, reason: "invalid-actor" };
  }
  if (
    typeof optionIndex !== "number" ||
    !Number.isInteger(optionIndex) ||
    optionIndex < 0 ||
    optionIndex >= vote.options.length
  ) {
    return { ok: false, reason: "invalid-option-index" };
  }
  const next = cloneVote(vote);
  next.ballots[actorId] = optionIndex;
  return { ok: true, vote: next };
}

/**
 * Advance the vote clock by exactly one processed command.
 *
 * COMMAND-COUNT BOUNDARY (the only clock a vote has): the caller invokes
 * this exactly once per successfully processed chat_command event that is
 * relevant to the session while the vote is open. Paid events NEVER invoke
 * this (they process normally but change neither ballots nor the counter).
 * Duplicate deliveries never reach this (the EventQueue `seen` set drops
 * repeat eventIds before processing). Reaching `maxCommands` closes the
 * vote deterministically — no wall-clock involved.
 */
export function noteCommandProcessed(
  vote: unknown,
): { ok: true; vote: ActiveVote } | { ok: false; reason: string } {
  if (!validateActiveVote(vote)) return { ok: false, reason: "invalid-vote" };
  if (vote.closed) return { ok: false, reason: "vote-closed" };
  const next = cloneVote(vote);
  next.commandsProcessed += 1;
  if (next.commandsProcessed >= next.maxCommands) next.closed = true;
  return { ok: true, vote: next };
}

/** Manual/creator close. Idempotent: closing a closed vote is a no-op success. */
export function closeVote(
  vote: unknown,
): { ok: true; vote: ActiveVote } | { ok: false; reason: string } {
  if (!validateActiveVote(vote)) return { ok: false, reason: "invalid-vote" };
  const next = cloneVote(vote);
  next.closed = true;
  return { ok: true, vote: next };
}

/**
 * True when the vote accepts no more ballots. Malformed votes report closed
 * (fail closed) rather than open.
 */
export function isVoteClosed(vote: unknown): boolean {
  if (!validateActiveVote(vote)) return true;
  return vote.closed || vote.commandsProcessed >= vote.maxCommands;
}

/** Distinct-voter counts per option index. Pure, world-free. */
export function tallyVote(
  vote: unknown,
): { ok: true; counts: number[] } | { ok: false; reason: string } {
  if (!validateActiveVote(vote)) return { ok: false, reason: "invalid-vote" };
  const counts = new Array<number>(vote.options.length).fill(0);
  for (const idx of Object.values(vote.ballots)) counts[idx] += 1;
  return { ok: true, counts };
}

export type ResolveVoteResult =
  | { ok: true; winner: string | null; counts: number[]; reason?: string }
  | { ok: false; reason: string };

function isWorldLike(w: unknown): w is WorldState {
  return isRecord(w) && isRecord(w.eventCounters);
}

/**
 * Determine the winner. Pure and deterministic:
 * - highest distinct-voter count wins; persistent ties go to the lowest
 *   option index (strict `>` keeps the first leader);
 * - no ballots => no winner (null), never a random pick;
 * - the winning option is revalidated against the live world/library
 *   (existence + shape + condition eligibility + repeat eligibility). A
 *   stale/ineligible winner fails closed to null — it never silently falls
 *   through to a runner-up and never executes. Affordability stays with
 *   `fireTemplate()`, the final gate.
 * Never mutates the world, never fires anything.
 */
export function resolveVote(
  vote: unknown,
  world: unknown,
  library: unknown,
): ResolveVoteResult {
  if (!validateActiveVote(vote)) return { ok: false, reason: "invalid-vote" };
  if (!Array.isArray(library)) return { ok: false, reason: "invalid-templates-list" };
  if (!isWorldLike(world)) return { ok: false, reason: "invalid-world" };
  const counts = new Array<number>(vote.options.length).fill(0);
  for (const idx of Object.values(vote.ballots)) counts[idx] += 1;
  if (counts.every((c) => c === 0)) {
    return { ok: true, winner: null, counts, reason: "no-ballots" };
  }
  let best = 0;
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] > counts[best]) best = i;
  }
  const winnerId = vote.options[best];
  const tmpl = (library as unknown[]).find((t) => isRecord(t) && t.id === winnerId);
  if (!tmpl || !validateEventTemplate(tmpl)) {
    return { ok: true, winner: null, counts, reason: "winner-invalid" };
  }
  const elig = isEligibleTemplate(tmpl, world);
  if (!elig.ok) return { ok: true, winner: null, counts, reason: "winner-invalid" };
  if (!elig.eligible) return { ok: true, winner: null, counts, reason: "winner-ineligible" };
  const rep = isRepeatEligible(tmpl, world);
  if (!rep.ok) return { ok: true, winner: null, counts, reason: "winner-invalid" };
  if (!rep.eligible) {
    return { ok: true, winner: null, counts, reason: "winner-repeat-ineligible" };
  }
  return { ok: true, winner: winnerId, counts };
}

/**
 * Explicit creator/manual override. Validates the chosen option against the
 * library (existence + shape), then records an auditable deed on a working
 * world clone via the existing `appendDeed` effect — no separate audit log.
 * Ballots are never modified or reinterpreted; the returned `winner` must
 * still pass through `fireTemplate()` like any community-chosen option.
 */
export function applyCreatorOverride(
  vote: unknown,
  world: unknown,
  optionIndex: unknown,
  library: unknown,
): { ok: true; world: WorldState; winner: string } | { ok: false; reason: string } {
  if (!validateActiveVote(vote)) return { ok: false, reason: "invalid-vote" };
  if (!Array.isArray(library)) return { ok: false, reason: "invalid-templates-list" };
  if (!isWorldLike(world)) return { ok: false, reason: "invalid-world" };
  if (
    typeof optionIndex !== "number" ||
    !Number.isInteger(optionIndex) ||
    optionIndex < 0 ||
    optionIndex >= vote.options.length
  ) {
    return { ok: false, reason: "invalid-option-index" };
  }
  const winnerId = vote.options[optionIndex];
  const tmpl = (library as unknown[]).find((t) => isRecord(t) && t.id === winnerId);
  if (!tmpl || !validateEventTemplate(tmpl)) {
    return { ok: false, reason: `invalid-option-template:${winnerId}` };
  }
  const deed = `The flame leaned toward ${winnerId} — keeper override of vote ${vote.id}.`;
  const r = applyEffect({ op: "appendDeed", deed }, world);
  if (!r.ok) return { ok: false, reason: `override-deed-failed:${r.reason}` };
  return { ok: true, world: r.world, winner: winnerId };
}
