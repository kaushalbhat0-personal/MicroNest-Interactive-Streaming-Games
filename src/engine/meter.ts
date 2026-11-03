import type { WorldState } from "./types";

/**
 * Phase 5C — community meters (persistent multi-stream contribution projects).
 *
 * Each meter is plain data: an id, a target, and unit text. The persistent
 * value lives in `eventCounters["meter.<id>"]` and survives streams; the
 * per-stream contributor set is ephemeral session state (see lifecycle.ts)
 * and resets every stream. No manager subsystem, no database, no variable
 * contribution amounts: each valid contribution is exactly +1.
 *
 * Completion retires the meter: once the counter reaches target, further
 * contributions are rejected (`meter-complete`) so the value never grows
 * meaninglessly. A future project gets a new meter id — never a reset.
 */

export const METER_COUNTER_PREFIX = "meter.";
export const MAX_METER_ID_LENGTH = 64;
export const MAX_METER_UNIT_LENGTH = 64;

/** Slug namespace: lowercase alphanumerics joined by single hyphens. No dots. */
export const METER_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface MeterDefinition {
  id: string;
  target: number;
  unitText: string;
}

/** Ephemeral per-stream contributor lists, keyed by meter id. Never persisted. */
export type MeterContributors = Record<string, string[]>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** True for syntactically valid meter ids (the `meter.<id>` suffix rule). */
export function isValidMeterId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length >= 1 &&
    id.length <= MAX_METER_ID_LENGTH &&
    METER_ID_RE.test(id)
  );
}

/** Canonical persistent counter name for a meter id. */
export function meterCounterName(id: string): string {
  return `${METER_COUNTER_PREFIX}${id}`;
}

/** Shape validation. False (never throws) for any malformed definition. */
export function validateMeterDefinition(m: unknown): m is MeterDefinition {
  if (!isRecord(m)) return false;
  if (!isValidMeterId(m.id)) return false;
  if (typeof m.target !== "number" || !Number.isInteger(m.target) || m.target <= 0) {
    return false;
  }
  if (
    typeof m.unitText !== "string" ||
    m.unitText.trim().length === 0 ||
    m.unitText.length > MAX_METER_UNIT_LENGTH
  ) {
    return false;
  }
  return true;
}

/**
 * Set validation for a small group of meter definitions: every entry valid,
 * no duplicate active ids. Plain data check — not a registry or manager.
 */
export function validateMeterSet(defs: unknown): boolean {
  if (!Array.isArray(defs)) return false;
  const seen = new Set<string>();
  for (const d of defs) {
    if (!validateMeterDefinition(d)) return false;
    if (seen.has(d.id)) return false;
    seen.add(d.id);
  }
  return true;
}

/** A fresh (empty) per-stream contributor set. Pure. */
export function freshMeterContributors(): MeterContributors {
  return {};
}

/** Shape guard for ephemeral contributor sets. False (never throws) when malformed. */
export function validateMeterContributors(v: unknown): v is MeterContributors {
  if (!isRecord(v)) return false;
  for (const [k, arr] of Object.entries(v)) {
    if (!isValidMeterId(k)) return false;
    if (!Array.isArray(arr)) return false;
    const seen = new Set<string>();
    for (const a of arr) {
      if (typeof a !== "string" || a.length === 0) return false;
      if (seen.has(a)) return false;
      seen.add(a);
    }
  }
  return true;
}

export type ContributeResult =
  | { ok: true; world: WorldState; contributors: MeterContributors }
  | { ok: false; reason: string };

/**
 * Contribute exactly +1 to a meter. Atomic: every input is validated before
 * any clone is made, and success updates the persistent counter AND the
 * session contributor set together. Any failure leaves both untouched.
 *
 * Rules: valid definition, non-empty actor, actor not yet counted for this
 * meter this stream (one contribution per actor per stream), counter not
 * already at/above target (completed meters are retired, never extended).
 */
export function contributeToMeter(
  world: unknown,
  contributors: unknown,
  meter: unknown,
  actorId: unknown,
): ContributeResult {
  if (!validateMeterDefinition(meter)) return { ok: false, reason: "invalid-meter-definition" };
  if (typeof actorId !== "string" || actorId.length === 0) {
    return { ok: false, reason: "invalid-actor" };
  }
  if (!validateMeterContributors(contributors)) return { ok: false, reason: "invalid-contributors" };
  if (!isRecord(world) || !isRecord(world.eventCounters)) {
    return { ok: false, reason: "invalid-world" };
  }
  const name = meterCounterName(meter.id);
  const seen = contributors[meter.id] ?? [];
  if (seen.includes(actorId)) return { ok: false, reason: "duplicate-contributor" };
  const raw = (world.eventCounters as Record<string, unknown>)[name];
  const current = raw === undefined ? 0 : raw;
  if (
    typeof current !== "number" ||
    !Number.isInteger(current) ||
    current < 0
  ) {
    return { ok: false, reason: "invalid-counter" };
  }
  if (current >= meter.target) return { ok: false, reason: "meter-complete" };
  // All checks passed: commit both halves together on fresh clones.
  const nextWorld = structuredClone(world) as unknown as WorldState;
  (nextWorld.eventCounters as Record<string, number>)[name] = current + 1;
  const nextContributors: MeterContributors = {};
  for (const [k, arr] of Object.entries(contributors)) nextContributors[k] = [...arr];
  nextContributors[meter.id] = [...seen, actorId];
  return { ok: true, world: nextWorld, contributors: nextContributors };
}
