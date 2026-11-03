import { advanceChapter } from "./story";
import type { LocationState, WorldState } from "./types";

/**
 * Phase 4D slice 3 — closed effect/opcode executor.
 *
 * Predicates ask questions; effects change the world. An effect is plain
 * serializable data naming EXACTLY one allowlisted change. There is no
 * generic set-path operator: every mutable target has its own opcode.
 *
 * API: applyEffect(effect, world) -> { ok: true, world } | { ok: false, reason }
 * The input world is never mutated (clone-then-apply). Either the whole
 * effect applies or nothing does — no partial mutation, no exceptions for
 * malformed input.
 *
 * Deliberately independent: no predicates, no engine, no queue, no I/O.
 * Composition of multiple effects belongs to a later slice.
 */

// ---------------------------------------------------------------------------
// Data model (discriminated union, JSON-safe)
// ---------------------------------------------------------------------------

export type Effect =
  | { op: "setFlag"; flag: string }
  | { op: "clearFlag"; flag: string }
  | { op: "addStanding"; faction: string; amount: number }
  | { op: "setLocation"; location: string; state: LocationState }
  | { op: "addSupplies"; amount: number }
  | { op: "addResolve"; amount: number }
  | { op: "addAttention"; id: string; amount: number }
  | { op: "appendDeed"; deed: string }
  | { op: "advanceChapter" };

export type EffectResult = { ok: true; world: WorldState } | { ok: false; reason: string };

// Bounds use existing domain conventions (clamp 0..100 like threat/standing;
// resources floor 0 like engine arithmetic; resolve is a 0..100 pool).
export const MAX_RESOLVE = 100;
export const MAX_DEEDS = 50; // Phase 4A cap; full log rejects appends (no silent loss)
export const MAX_DEED_LENGTH = 280; // one-liners only; oversized deeds rejected, never cut

const LOCATION_STATES: ReadonlySet<string> = new Set(["sound", "strained", "lost"]);

/**
 * Minimal safe transition graph (Phase 4A defined no rules; this is the
 * smallest deterministic rule). Damage and recovery both pass through
 * `strained`: no instant sound->lost collapse, no lost->sound resurrection,
 * no same-state no-ops. Catastrophe is modeled by later composition.
 */
const LOCATION_TRANSITIONS: Record<LocationState, ReadonlySet<LocationState>> = {
  sound: new Set(["strained"]),
  strained: new Set(["sound", "lost"]),
  lost: new Set(["strained"]),
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// ---------------------------------------------------------------------------
// Validation (shape-only, world-free) + application (world-dependent checks)
// ---------------------------------------------------------------------------

/**
 * Shape validation. False (never throws) for: unknown op, missing/wrong
 * operands, bad enums, non-finite or zero amounts, empty/oversized deeds.
 * World-dependent applicability (unknown faction/location/latent, illegal
 * transition, full deeds) is checked at apply time, not here.
 */
export function validateEffect(e: unknown): e is Effect {
  if (!isRecord(e) || typeof e.op !== "string") return false;
  const nonzero = (v: unknown): v is number => isFiniteNumber(v) && v !== 0;
  switch (e.op) {
    case "setFlag":
    case "clearFlag":
      return isNonEmptyString(e.flag);
    case "addStanding":
      return isNonEmptyString(e.faction) && nonzero(e.amount);
    case "setLocation":
      return (
        isNonEmptyString(e.location) && typeof e.state === "string" && LOCATION_STATES.has(e.state)
      );
    case "addSupplies":
    case "addResolve":
      return nonzero(e.amount);
    case "addAttention":
      return isNonEmptyString(e.id) && nonzero(e.amount);
    case "appendDeed":
      return (
        typeof e.deed === "string" && e.deed.trim().length > 0 && e.deed.length <= MAX_DEED_LENGTH
      );
    case "advanceChapter":
      return true; // no operands; extra keys ignored, never reinterpreted
    default:
      return false;
  }
}

/** Applies a shape-valid effect to the (already cloned) world. Null = applied. */
function applyValid(e: Effect, w: WorldState): string | null {
  switch (e.op) {
    case "setFlag":
      w.storyFlags[e.flag] = true;
      return null;
    case "clearFlag":
      delete w.storyFlags[e.flag];
      return null;
    case "addStanding": {
      const cur = w.factionState[e.faction];
      if (typeof cur !== "number" || !Number.isFinite(cur)) return "unknown-faction";
      w.factionState[e.faction] = clamp(cur + e.amount, 0, 100);
      return null;
    }
    case "setLocation": {
      const known = e.location in w.locationState || w.unlockedLocations.includes(e.location);
      if (!known) return "unknown-location";
      const current: LocationState = w.locationState[e.location] ?? "sound"; // pristine default
      if (!LOCATION_TRANSITIONS[current].has(e.state)) return "invalid-transition";
      w.locationState[e.location] = e.state;
      return null;
    }
    case "addSupplies":
      w.resources = Math.max(0, w.resources + e.amount); // floor only, no ceiling (engine precedent)
      return null;
    case "addResolve":
      w.resolve = clamp(w.resolve + e.amount, 0, MAX_RESOLVE);
      return null;
    case "addAttention": {
      const entry = w.latent.find((l) => l.id === e.id);
      if (!entry) return "unknown-latent"; // adjust only; creation is a later slice
      entry.attention = clamp(entry.attention + e.amount, 0, 100);
      return null;
    }
    case "appendDeed": {
      if (w.deeds.length >= MAX_DEEDS) return "deeds-full"; // explicit failure, never silent loss
      w.deeds.push(e.deed.trim());
      return null;
    }
    case "advanceChapter":
      advanceChapter(w); // canonical path; its message is discarded (deeds are separate effects)
      return null;
  }
}

/**
 * Applies an ordered list of effects with ALL-OR-NOTHING semantics.
 *
 * Pre-validates every element with validateEffect() (single source of truth
 * for shape) before touching state, then applies sequentially to one working
 * clone so later effects see earlier effects' changes. First applicability
 * failure aborts the whole operation: the caller's world is never mutated and
 * no partial world escapes. Intermediate worlds are internal only.
 */
export function applyEffects(effects: unknown, world: WorldState): EffectResult {
  if (!Array.isArray(effects)) return { ok: false, reason: "invalid-effects-list" };
  if (effects.length === 0) return { ok: false, reason: "empty-effects" };
  for (let i = 0; i < effects.length; i++) {
    if (!validateEffect(effects[i])) return { ok: false, reason: `invalid-effect-at-index:${i}` };
  }
  let working = structuredClone(world);
  for (let i = 0; i < effects.length; i++) {
    const r = applyEffect(effects[i] as Effect, working);
    if (!r.ok) return { ok: false, reason: `effect-failed-at-index:${i}:${r.reason}` };
    working = r.world;
  }
  return { ok: true, world: working };
}

/**
 * One effect + one world -> one new world (or explicit failure).
 * Malformed effects fail closed with a reason; the input world is cloned
 * first and never mutated; applicability failures leave no partial change
 * because checks run before any write within their own case.
 */
export function applyEffect(effect: unknown, world: WorldState): EffectResult {
  if (!validateEffect(effect)) return { ok: false, reason: "invalid-effect" };
  const next = structuredClone(world); // WorldState is plain data (engine.ts precedent)
  const failure = applyValid(effect, next);
  if (failure) return { ok: false, reason: failure };
  return { ok: true, world: next };
}
