import type { LocationState, WorldState } from "./types";
import { isValidMeterId, METER_COUNTER_PREFIX } from "./meter";

/**
 * Phase 4C slice 2 — read-only condition predicates.
 *
 * A predicate is a QUESTION asked of the world. It reads state and returns
 * a boolean. It can never change the world: no I/O, no mutation, no clock,
 * no randomness, no references to anything but the world it is given.
 *
 * Predicates are plain serializable data (safe to persist inside a future
 * EventTemplate). They form TREES via allOf/anyOf/noneOf — there is no
 * named-reference system, so cycles are impossible by construction.
 */

// ---------------------------------------------------------------------------
// Data model (discriminated union, JSON-safe)
// ---------------------------------------------------------------------------

/** Derived faction posture. NEVER persisted — computed from factionState. */
export type Attitude = "hostile" | "wary" | "neutral" | "friendly" | "allied";

/** Derived latent-threat attention level. NEVER persisted. */
export type LatentBand = "low" | "medium" | "high";

export type Predicate =
  | { op: "gte"; counter: string; value: number }
  | { op: "lte"; counter: string; value: number }
  | { op: "eq"; counter: string; value: number }
  | { op: "between"; counter: string; min: number; max: number }
  | { op: "flagSet"; flag: string }
  | { op: "flagUnset"; flag: string }
  | { op: "counterGte"; counter: string; gte: number }
  | { op: "locationIs"; location: string; state: LocationState }
  | { op: "attitudeIs"; faction: string; attitude: Attitude }
  | { op: "latentBand"; id: string; band: LatentBand }
  | { op: "allOf"; predicates: Predicate[] }
  | { op: "anyOf"; predicates: Predicate[] }
  | { op: "noneOf"; predicates: Predicate[] };

// ---------------------------------------------------------------------------
// Derivations (explicit, deterministic, bounded — Phase 4A decided these
// are derived, not stored; Phase 4A named the categories but set no cut
// points, so this slice defines the cut points below. Changing them later
// is a constant edit, never a model change.)
// ---------------------------------------------------------------------------

/** Even quintiles over the 0..100 standing scale. */
export function attitudeOf(standing: number): Attitude {
  if (!Number.isFinite(standing)) return "neutral";
  const v = Math.min(100, Math.max(0, standing));
  if (v < 20) return "hostile";
  if (v < 40) return "wary";
  if (v < 60) return "neutral";
  if (v < 80) return "friendly";
  return "allied";
}

/** Even thirds over the bounded 0..100 attention scale. */
export function latentBandOf(attention: number): LatentBand {
  if (!Number.isFinite(attention)) return "low";
  const v = Math.min(100, Math.max(0, attention));
  if (v < 34) return "low";
  if (v < 67) return "medium";
  return "high";
}

// ---------------------------------------------------------------------------
// Counter read paths (explicit allowlist — no arbitrary property access)
// ---------------------------------------------------------------------------

/**
 * Named numeric concepts the comparison operators may read. Core names map
 * to WorldState fields (or documented array-length derivations); the rest
 * are the exact event-counter keys the engine/story write today, read via
 * `eventCounters[key] ?? 0` (absent counter reads as 0, matching engine
 * precedent). Unknown names are invalid — never silently zero.
 */
const EVENT_COUNTER_NAMES: ReadonlySet<string> = new Set([
  "attacks",
  "kills",
  "elites_defeated",
  "heals",
  "searches",
  "shields",
  "secrets_found",
  "paid_events",
  "paid_strikes",
  "paid_supplies",
  "elite_arrivals",
  "major_story_events",
]);

function readCounter(w: WorldState, name: string): number | null {
  if (CORE_COUNTER_NAMES.has(name)) return CORE_COUNTER_READERS[name](w);
  if (EVENT_COUNTER_NAMES.has(name)) return w.eventCounters[name] ?? 0;
  if (isMeterCounterName(name)) {
    const v = w.eventCounters[name];
    if (v === undefined) return 0;
    // Fail closed on corrupted values: meters only ever hold finite totals >= 0.
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  }
  return null;
}

/**
 * Shared counter vocabulary (core concepts + engine-written event counters).
 * Single source of truth: readCounter() and trigger thresholds both resolve
 * through this table, so no second counter vocabulary can drift apart.
 */
const CORE_COUNTER_READERS: Record<string, (w: WorldState) => number> = {
  streamCount: (w) => w.streamCount,
  resources: (w) => w.resources, // resources === supplies (Phase 4B decision)
  resolve: (w) => w.resolve,
  threatLevel: (w) => w.threatLevel,
  waveNumber: (w) => w.waveNumber,
  currentArc: (w) => w.currentArc,
  currentChapter: (w) => w.currentChapter,
  scouts: (w) => w.uniqueSearchers.length, // derived: distinct contributors
  secrets: (w) => w.discoveredSecrets.length, // derived: discoveries made
  deeds: (w) => w.deeds.length, // derived: history length
};

const CORE_COUNTER_NAMES: ReadonlySet<string> = new Set(Object.keys(CORE_COUNTER_READERS));

/** Single source of truth for reading a named counter from a world. */
export function resolveCounter(w: WorldState, name: string): number | null {
  return readCounter(w, name);
}

/**
 * Read-only snapshot of every readable counter in the shared vocabulary:
 * all core concepts, all engine-written event counters, and every
 * `meter.<id>` counter currently present in the world. Unreadable or
 * non-finite values are omitted (never silently zeroed) so a single corrupt
 * counter fails closed for itself without poisoning a threshold evaluation.
 * Used by the runtime to build threshold trigger contexts.
 */
export function snapshotCounters(w: WorldState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of [...CORE_COUNTER_NAMES, ...EVENT_COUNTER_NAMES]) {
    const v = readCounter(w, name);
    if (v !== null && Number.isFinite(v)) out[name] = v;
  }
  const counters = w.eventCounters;
  if (counters && typeof counters === "object") {
    for (const key of Object.keys(counters)) {
      if (key in out || !isMeterCounterName(key)) continue;
      const v = readCounter(w, key);
      if (v !== null && Number.isFinite(v)) out[key] = v;
    }
  }
  return out;
}

/** True iff name is a community meter counter (`meter.<slug>`, valid id syntax). */
export function isMeterCounterName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (!name.startsWith(METER_COUNTER_PREFIX)) return false;
  return isValidMeterId(name.slice(METER_COUNTER_PREFIX.length));
}

/** True iff name is a readable counter in the shared vocabulary. */
export function isKnownCounter(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (CORE_COUNTER_NAMES.has(name) || EVENT_COUNTER_NAMES.has(name)) return true;
  // Phase 5C: the persistent `meter.<id>` namespace resolves through the same
  // counter vocabulary (no second system). Invalid meter syntax stays unknown.
  return isMeterCounterName(name);
}

// ---------------------------------------------------------------------------
// Validation (author-time boundary) + evaluation (runtime)
// ---------------------------------------------------------------------------

/** Maximum nesting depth. Predicates are trees; this only stops absurd input. */
export const MAX_PREDICATE_DEPTH = 20;

const ATTITUDES: ReadonlySet<string> = new Set(["hostile", "wary", "neutral", "friendly", "allied"]);
const LATENT_BANDS: ReadonlySet<string> = new Set(["low", "medium", "high"]);
const LOCATION_STATES: ReadonlySet<string> = new Set(["sound", "strained", "lost"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Structural validation. Returns false (never throws) for: unknown op,
 * missing/wrong-typed operands, invalid enums, non-finite numbers,
 * min > max, invalid nested children, or depth beyond MAX_PREDICATE_DEPTH.
 */
export function validatePredicate(p: unknown, depth = 0): p is Predicate {
  if (!isRecord(p)) return false;
  if (depth > MAX_PREDICATE_DEPTH) return false;
  if (typeof p.op !== "string") return false;
  switch (p.op) {
    case "gte":
    case "lte":
    case "eq":
      return typeof p.counter === "string" && isFiniteNumber(p.value);
    case "between":
      return (
        typeof p.counter === "string" &&
        isFiniteNumber(p.min) &&
        isFiniteNumber(p.max) &&
        (p.min as number) <= (p.max as number)
      );
    case "flagSet":
    case "flagUnset":
      return isNonEmptyString(p.flag);
    case "counterGte":
      return typeof p.counter === "string" && isFiniteNumber(p.gte);
    case "locationIs":
      return isNonEmptyString(p.location) && typeof p.state === "string" && LOCATION_STATES.has(p.state);
    case "attitudeIs":
      return isNonEmptyString(p.faction) && typeof p.attitude === "string" && ATTITUDES.has(p.attitude);
    case "latentBand":
      return isNonEmptyString(p.id) && typeof p.band === "string" && LATENT_BANDS.has(p.band);
    case "allOf":
    case "anyOf":
    case "noneOf":
      return (
        Array.isArray(p.predicates) && p.predicates.every((c) => validatePredicate(c, depth + 1))
      );
    default:
      return false;
  }
}

function evalValid(p: Predicate, w: WorldState): boolean {
  switch (p.op) {
    case "gte": {
      const v = readCounter(w, p.counter);
      return v !== null && Number.isFinite(v) && v >= p.value;
    }
    case "lte": {
      const v = readCounter(w, p.counter);
      return v !== null && Number.isFinite(v) && v <= p.value;
    }
    case "eq": {
      const v = readCounter(w, p.counter);
      return v !== null && Number.isFinite(v) && v === p.value;
    }
    case "between": {
      const v = readCounter(w, p.counter);
      return v !== null && Number.isFinite(v) && v >= p.min && v <= p.max;
    }
    case "flagSet":
      return w.storyFlags[p.flag] === true;
    case "flagUnset":
      return w.storyFlags[p.flag] !== true;
    case "counterGte": {
      const v = readCounter(w, p.counter);
      return v !== null && Number.isFinite(v) && v >= p.gte;
    }
    case "locationIs":
      return w.locationState[p.location] === p.state;
    case "attitudeIs": {
      const standing = w.factionState[p.faction];
      if (typeof standing !== "number" || !Number.isFinite(standing)) return false;
      return attitudeOf(standing) === p.attitude;
    }
    case "latentBand": {
      const entry = w.latent.find((e) => e.id === p.id);
      if (!entry) return false;
      return latentBandOf(entry.attention) === p.band;
    }
    case "allOf":
      return p.predicates.every((c) => evalValid(c, w));
    case "anyOf":
      return p.predicates.some((c) => evalValid(c, w));
    case "noneOf":
      return !p.predicates.some((c) => evalValid(c, w));
  }
}

/**
 * The slice's single output: predicate + world -> boolean.
 * Malformed predicates evaluate to false (never throw, never reinterpreted).
 * The world is only read, never mutated.
 */
export function isEligible(p: unknown, w: WorldState): boolean {
  if (!validatePredicate(p)) return false;
  return evalValid(p, w);
}
