import { isEligible, validatePredicate, type Predicate } from "./predicates";
import { applyEffects, validateEffect, type Effect } from "./effects";
import {
  matchesTrigger,
  validateTrigger,
  validateTriggerContext,
  type Trigger,
} from "./triggers";
import type { TemplateRepeatState, WorldState } from "./types";

/**
 * Phase 4D slice 5 — EventTemplate data + read-only eligibility.
 *
 * A template is reusable world-event DATA: an id, a predicate question, and
 * the ordered effect list that a LATER slice may execute atomically via
 * applyEffects(). This slice answers only "which templates are eligible?"
 * It never selects, never executes, never mutates, never spends, never
 * records. Weight/repeat/cost are validated shape-only; triggers do not
 * exist yet (deferred by slice scope).
 */

// ---------------------------------------------------------------------------
// Data model (plain data, JSON-safe — no functions, no expressions)
// ---------------------------------------------------------------------------

export type RepeatPolicy =
  | { kind: "once" }
  | { kind: "perChapter" }
  | { kind: "endless" }
  | { kind: "cooldownStreams"; streams: number };

export interface TemplateCost {
  supplies?: number;
  resolve?: number;
}

export interface EventTemplate {
  id: string;
  condition: Predicate;
  effects: Effect[];
  repeat: RepeatPolicy;
  cost?: TemplateCost;
  weight: number;
  /** Named moment this template belongs to. Metadata only; never executes. */
  trigger: Trigger;
}

/** Precedent: chat commands are capped at 64 chars (queue.ts isValid). */
export const MAX_TEMPLATE_ID_LENGTH = 64;

const REPEAT_KINDS: ReadonlySet<string> = new Set(["once", "perChapter", "endless", "cooldownStreams"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Shape-only validation. False (never throws) for any malformed authoring data. */
export function validateEventTemplate(t: unknown): t is EventTemplate {
  if (!isRecord(t)) return false;
  if (typeof t.id !== "string" || t.id.length === 0 || t.id.length > MAX_TEMPLATE_ID_LENGTH) {
    return false;
  }
  if (!validatePredicate(t.condition)) return false;
  if (!Array.isArray(t.effects) || t.effects.length === 0) return false;
  if (!t.effects.every(validateEffect)) return false;
  if (!isRecord(t.repeat) || typeof t.repeat.kind !== "string" || !REPEAT_KINDS.has(t.repeat.kind)) {
    return false;
  }
  if (t.repeat.kind === "cooldownStreams") {
    if (!isFiniteNumber(t.repeat.streams) || !Number.isInteger(t.repeat.streams) || t.repeat.streams <= 0) {
      return false;
    }
  }
  if (t.cost !== undefined) {
    if (!isRecord(t.cost)) return false;
    for (const k of ["supplies", "resolve"] as const) {
      const v = (t.cost as Record<string, unknown>)[k];
      if (v !== undefined && (!isFiniteNumber(v) || v < 0)) return false;
    }
  }
  if (!isFiniteNumber(t.weight)) return false;
  if (!validateTrigger(t.trigger)) return false; // missing trigger is malformed, never defaulted
  return true;
}

// ---------------------------------------------------------------------------
// Read-only eligibility
// ---------------------------------------------------------------------------

export type TemplateEligibility = { ok: true; eligible: boolean } | { ok: false; reason: string };

/**
 * Valid template + condition true -> eligible; valid + false -> ineligible.
 * Malformed template -> invalid (never collapsed into "ineligible", so
 * authoring errors stay visible). Pure: no mutation, no execution.
 */
export function isEligibleTemplate(template: unknown, world: WorldState): TemplateEligibility {
  if (!validateEventTemplate(template)) return { ok: false, reason: "invalid-template" };
  return { ok: true, eligible: isEligible(template.condition, world) };
}

export type TemplateScan = { ok: true; eligibleIds: string[] } | { ok: false; reason: string };

/**
 * Read-only scan: eligible template ids in deterministic input order.
 * Empty collection is valid (a library may legitimately hold zero templates).
 * Any malformed entry or duplicate id rejects the whole scan fail-closed —
 * returning duplicate ids would make later selection ambiguous.
 * Weight is ignored; nothing is executed, spent, or recorded.
 */
export function scanTemplates(templates: unknown, world: WorldState): TemplateScan {
  if (!Array.isArray(templates)) return { ok: false, reason: "invalid-templates-list" };
  const seen = new Set<string>();
  const eligibleIds: string[] = [];
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    if (!validateEventTemplate(t)) return { ok: false, reason: `invalid-template-at-index:${i}` };
    if (seen.has(t.id)) return { ok: false, reason: `duplicate-template-id:${t.id}` };
    seen.add(t.id);
    if (isEligible(t.condition, world)) eligibleIds.push(t.id);
  }
  return { ok: true, eligibleIds };
}

export type TemplateFireResult = { ok: true; world: WorldState } | { ok: false; reason: string };

/**
 * Selection-free template firing: the caller supplies the exact template.
 *
 * Locked order of operations: validate -> condition eligibility ->
 * repeat eligibility -> affordability -> cost deduction on a working clone ->
 * ordered effect application -> successful-firing record. Cost, effects, and
 * bookkeeping commit together or not at all. No weight use, no selection,
 * no triggers — those belong to other slices.
 */
export function fireTemplate(template: unknown, world: WorldState): TemplateFireResult {
  if (!validateEventTemplate(template)) return { ok: false, reason: "invalid-template" };
  if (!isEligible(template.condition, world)) return { ok: false, reason: "template-ineligible" };
  const rep = isRepeatEligible(template, world);
  if (!rep.ok) return { ok: false, reason: rep.reason }; // malformed repeat state: fail closed
  if (!rep.eligible) return { ok: false, reason: "template-repeat-ineligible" };
  const suppliesCost = template.cost?.supplies ?? 0;
  const resolveCost = template.cost?.resolve ?? 0;
  if (world.resources < suppliesCost) return { ok: false, reason: "insufficient-supplies" };
  if (world.resolve < resolveCost) return { ok: false, reason: "insufficient-resolve" };
  const working = structuredClone(world);
  working.resources -= suppliesCost; // affordability verified: stays >= 0, no clamp needed
  working.resolve -= resolveCost;
  const result = applyEffects(template.effects, working);
  if (!result.ok) return { ok: false, reason: `template-effects-failed:${result.reason}` };
  // Record only on full success. Effects cannot touch repeat state or clocks
  // (no opcode addresses them), so a record failure here is defensive-only —
  // but it still fails the whole operation atomically rather than splitting
  // effects from bookkeeping.
  const recorded = recordTemplateFire(template, result.world);
  if (!recorded.ok) return { ok: false, reason: `template-repeat-record-failed:${recorded.reason}` };
  return { ok: true, world: recorded.world };
}

export type TemplateSelection = { ok: true; template: EventTemplate | null } | { ok: false; reason: string };

/** Read-only affordability: same rule firing enforces, without deducting. */
function isAffordable(t: EventTemplate, world: WorldState): boolean {
  return world.resources >= (t.cost?.supplies ?? 0) && world.resolve >= (t.cost?.resolve ?? 0);
}

/**
 * Deterministic template selection (read-only, no firing).
 *
 * Pipeline: validate all -> eligible conditions -> affordable costs ->
 * candidates -> exactly one winner or none. Ranking: highest weight wins,
 * input order breaks ties (strict comparison keeps the first). Weight is a
 * deterministic priority, never chance: no RNG exists in this slice, and
 * weighted randomness remains an undecided later policy, not a default.
 * The winner is returned as a decoupled clone so callers cannot mutate the
 * input library through the result.
 */
export function selectTemplate(templates: unknown, world: WorldState): TemplateSelection {
  if (!Array.isArray(templates)) return { ok: false, reason: "invalid-templates-list" };
  const seen = new Set<string>();
  let best: EventTemplate | null = null;
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    if (!validateEventTemplate(t)) return { ok: false, reason: `invalid-template-at-index:${i}` };
    if (seen.has(t.id)) return { ok: false, reason: `duplicate-template-id:${t.id}` };
    seen.add(t.id);
    if (!isEligible(t.condition, world)) continue;
    const rep = isRepeatEligible(t, world);
    if (!rep.ok) return { ok: false, reason: rep.reason }; // malformed repeat state: fail closed
    if (!rep.eligible) continue; // repeat-exhausted is a normal skip, not an error
    if (!isAffordable(t, world)) continue;
    if (best === null || t.weight > best.weight) best = t;
  }
  return { ok: true, template: best === null ? null : structuredClone(best) };
}

/**
 * WHEN-layer collection: filter the library to templates whose trigger
 * matches the supplied moment, then delegate to selectTemplate() — the sole
 * source of truth for condition/repeat/affordability/weight semantics.
 * Validation precedes filtering (a malformed template aborts even if its
 * trigger would not match). Read-only; selectTemplate() is not modified.
 */
export function collectCandidates(
  context: unknown,
  templates: unknown,
  world: WorldState,
): TemplateSelection {
  if (!validateTriggerContext(context)) return { ok: false, reason: "invalid-trigger-context" };
  if (!Array.isArray(templates)) return { ok: false, reason: "invalid-templates-list" };
  const seen = new Set<string>();
  const matched: EventTemplate[] = [];
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    if (!validateEventTemplate(t)) return { ok: false, reason: `invalid-template-at-index:${i}` };
    if (seen.has(t.id)) return { ok: false, reason: `duplicate-template-id:${t.id}` };
    seen.add(t.id);
    if (matchesTrigger(t.trigger, context)) matched.push(t);
  }
  if (matched.length === 0) return { ok: true, template: null };
  return selectTemplate(matched, world);
}

export function defaultRepeatState(): TemplateRepeatState {
  return { onceFired: [], chapterFired: [], cooldownUntilStream: {} };
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * Shape validation for persisted repeat bookkeeping. Missing field is NOT
 * handled here (normalization owns defaults); a present-but-malformed
 * record fails closed — never silently repaired.
 */
export function validateRepeatState(rs: unknown): rs is TemplateRepeatState {
  if (!isRecord(rs)) return false;
  if (!Array.isArray(rs.onceFired) || !rs.onceFired.every((id) => typeof id === "string" && id.length > 0)) {
    return false;
  }
  if (
    !Array.isArray(rs.chapterFired) ||
    !rs.chapterFired.every(
      (e) =>
        isRecord(e) &&
        typeof e.id === "string" &&
        e.id.length > 0 &&
        isPositiveInt(e.arc) &&
        (e.arc as number) >= 1 &&
        isPositiveInt(e.chapter) &&
        (e.chapter as number) >= 1,
    )
  ) {
    return false;
  }
  if (!isRecord(rs.cooldownUntilStream)) return false;
  for (const v of Object.values(rs.cooldownUntilStream)) {
    if (!isPositiveInt(v)) return false;
  }
  return true;
}

export type RepeatEligibilityResult = { ok: true; eligible: boolean } | { ok: false; reason: string };

/**
 * Pure repeat eligibility: has this template's repeat policy already been
 * exhausted? Reads the policy + repeat state + stream/arc/chapter clocks.
 * Never mutates, never fires, never touches effects or costs.
 */
export function isRepeatEligible(template: unknown, world: WorldState): RepeatEligibilityResult {
  if (!validateEventTemplate(template)) return { ok: false, reason: "invalid-template" };
  const rs = world.repeatState === undefined ? defaultRepeatState() : world.repeatState;
  if (!validateRepeatState(rs)) return { ok: false, reason: "invalid-repeat-state" };
  if (!isPositiveInt(world.streamCount)) return { ok: false, reason: "invalid-world" };
  switch (template.repeat.kind) {
    case "once":
      return { ok: true, eligible: !rs.onceFired.includes(template.id) };
    case "endless":
      return { ok: true, eligible: true };
    case "perChapter":
      return {
        ok: true,
        eligible: !rs.chapterFired.some(
          (e) => e.id === template.id && e.arc === world.currentArc && e.chapter === world.currentChapter,
        ),
      };
    case "cooldownStreams": {
      const until = rs.cooldownUntilStream[template.id];
      if (until === undefined) return { ok: true, eligible: true };
      return { ok: true, eligible: world.streamCount >= until };
    }
  }
}

export type RecordFireResult = { ok: true; world: WorldState } | { ok: false; reason: string };

/**
 * Pure successful-firing record: returns a clone with ONLY repeat
 * bookkeeping updated. Never applies effects, deducts costs, advances
 * chapter/stream, or calls fireTemplate(). NOT wired into firing yet.
 */
export function recordTemplateFire(template: unknown, world: WorldState): RecordFireResult {
  if (!validateEventTemplate(template)) return { ok: false, reason: "invalid-template" };
  const rs = world.repeatState === undefined ? defaultRepeatState() : world.repeatState;
  if (!validateRepeatState(rs)) return { ok: false, reason: "invalid-repeat-state" };
  if (!isPositiveInt(world.streamCount)) return { ok: false, reason: "invalid-world" };
  if (!isPositiveInt(world.currentArc) || world.currentArc < 1) return { ok: false, reason: "invalid-world" };
  if (!isPositiveInt(world.currentChapter) || world.currentChapter < 1) {
    return { ok: false, reason: "invalid-world" };
  }
  const next = structuredClone(world);
  next.repeatState = {
    onceFired: [...rs.onceFired],
    chapterFired: rs.chapterFired.map((e) => ({ ...e })),
    cooldownUntilStream: { ...rs.cooldownUntilStream },
  };
  const R = next.repeatState;
  switch (template.repeat.kind) {
    case "once":
      if (!R.onceFired.includes(template.id)) R.onceFired.push(template.id);
      break;
    case "endless":
      break; // no bookkeeping by definition
    case "perChapter":
      // Replace semantics: at most one entry per id (latest chapter wins).
      R.chapterFired = R.chapterFired.filter((e) => e.id !== template.id);
      R.chapterFired.push({ id: template.id, arc: world.currentArc, chapter: world.currentChapter });
      break;
    case "cooldownStreams":
      // Fired during stream S -> eligible again at stream S + N.
      R.cooldownUntilStream[template.id] = world.streamCount + template.repeat.streams;
      break;
  }
  return { ok: true, world: next };
}
