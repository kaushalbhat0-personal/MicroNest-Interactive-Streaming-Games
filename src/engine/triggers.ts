import { isKnownCounter } from "./predicates";

/**
 * Phase 4D slice 9 — trigger stubs (WHEN layer, data only).
 *
 * A trigger answers "why should the library be considered at this moment?"
 * It never mutates, fires, times, or reaches outside its inputs. Four kinds
 * only: streamOpen / streamClose (named lifecycle moments, behavior deferred),
 * threshold (deterministic numeric level, no crossing history), manual
 * (explicit creator/application trigger point, behavior deferred).
 */

// ---------------------------------------------------------------------------
// Data model (plain data, JSON-safe)
// ---------------------------------------------------------------------------

/** Counter names resolve through the shared predicate allowlist (no second vocabulary). */
export type AllowedCounter = string;

export type Trigger =
  | { kind: "streamOpen" }
  | { kind: "streamClose" }
  | { kind: "threshold"; counter: AllowedCounter; value: number }
  | { kind: "manual" };

export interface TriggerContext {
  kind: "streamOpen" | "streamClose" | "threshold" | "manual";
  counterValues?: Partial<Record<string, number>>;
}

const TRIGGER_KINDS: ReadonlySet<string> = new Set(["streamOpen", "streamClose", "threshold", "manual"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Shape validation. False (never throws) for any malformed trigger data. */
export function validateTrigger(t: unknown): t is Trigger {
  if (!isRecord(t) || typeof t.kind !== "string" || !TRIGGER_KINDS.has(t.kind)) return false;
  if (t.kind === "threshold") {
    return isKnownCounter(t.counter) && isFiniteNumber(t.value);
  }
  return true;
}

/** Shape validation for the supplied moment. False (never throws) when malformed. */
export function validateTriggerContext(c: unknown): c is TriggerContext {
  if (!isRecord(c) || typeof c.kind !== "string" || !TRIGGER_KINDS.has(c.kind)) return false;
  if (c.counterValues !== undefined) {
    if (!isRecord(c.counterValues)) return false;
    for (const v of Object.values(c.counterValues)) {
      if (!isFiniteNumber(v)) return false;
    }
  }
  return true;
}

/**
 * Pure moment matching. Same-kind moments match; threshold additionally
 * requires the named counter's supplied value to be finite and >= the
 * trigger value (inclusive). Missing counter value => false. No history,
 * no crossing detection, no world access, no mutation.
 */
export function matchesTrigger(trigger: unknown, context: unknown): boolean {
  if (!validateTrigger(trigger)) return false;
  if (!validateTriggerContext(context)) return false;
  if (trigger.kind !== context.kind) return false;
  if (trigger.kind === "threshold") {
    const v = context.counterValues?.[trigger.counter];
    return isFiniteNumber(v) && v >= trigger.value;
  }
  return true;
}
