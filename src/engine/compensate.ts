// Phase 5G-3 — safe paid-catalyst compensation (pure, no clock, no I/O).
//
// A retraction creates NEW history; it never rewrites old history. This
// module decides the single deterministic compensating consequence for one
// applied ledger entry and returns a new world with BOTH the gameplay
// compensation AND the applied→compensated ledger transition applied.
//
// Hard rules (enforced by construction, proven by tests):
// - No blind inverse arithmetic: resources/keep/threat are never decremented,
//   chapters never rewound, deeds/secrets/flags never removed, elites never
//   removed or resurrected, counters never decremented.
// - Story beats are never evaluated here: compensation cannot start a second
//   catalyst chain (it only ever appends a deed and, in one narrow Gale case,
//   restores enemy HP).
// - Votes/meters live outside WorldState gameplay fields and are untouched.
// - Historical ledger fields are immutable: only status/compensatedAtIso/
//   compensationNote change, exactly once.

import { SIM } from "./config";
import { applyEffect } from "./effects";
import { validatePaidLedgerEntry } from "./ledger";
import type { PaidLedgerAppliedEntry, PaidLedgerTierKey, WorldState } from "./types";

/** Machine-safe compensation notes. No platform text, no payer, no amounts. */
export const COMPENSATION_NOTES = {
  galeExact: "gale-exact-reversal",
  galeNarrative: "gale-narrative-compensation",
  supply: "supply-narrative-compensation",
  herald: "herald-narrative-compensation",
  bell: "bell-narrative-compensation",
} as const;

export type CompensateResult =
  | {
      ok: true;
      world: WorldState;
      entry: PaidLedgerAppliedEntry;
      summary: string;
      note: string;
      /** True only for the narrow Gale exact-reversal path. */
      exact: boolean;
      /** False when the deed log was already at cap (transition still applied). */
      deedApplied: boolean;
    }
  | { ok: false; reason: string };

const DEEDS = {
  galeExact: "The Gale's fury ebbs — the wound it dealt closes.",
  galeNarrative: "The storm relents — the Gloam steadies.",
  supply: "A supply convoy is recalled beyond the Pale — Cinderholm keeps what was earned.",
  herald: "The Herald's claim falters, but Vex has seen Cinderholm.",
  bell: "The echo fades, but the Bell was heard.",
} as const;

/**
 * Compensate one applied ledger entry. Pure: inputs are never mutated; the
 * returned world is a fresh clone carrying both the compensation and the
 * ledger transition. Fails closed (no mutation, explicit reason) for
 * non-applied, unknown, or already-resolved entries.
 */
export function compensatePaid(
  world: WorldState,
  entry: PaidLedgerAppliedEntry,
  nowIso: string,
): CompensateResult {
  if (!validatePaidLedgerEntry(entry)) {
    return { ok: false, reason: "invalid-entry" };
  }
  if (entry.status !== "applied") {
    return { ok: false, reason: "already-resolved" };
  }
  if (!world || typeof world !== "object" || !Array.isArray((world as WorldState).paidLedger)) {
    return { ok: false, reason: "invalid-world" };
  }
  const idx = world.paidLedger.findIndex((e) => e.eventId === entry.eventId);
  if (idx < 0) return { ok: false, reason: "entry-not-in-world" };
  const stored = world.paidLedger[idx];
  if (stored.status !== "applied" || !validatePaidLedgerEntry(stored)) {
    return { ok: false, reason: "already-resolved" };
  }
  // The world's stored copy is the source of truth (it survives reloads;
  // the caller's copy may be stale). Tier comes from stored history, never
  // re-derived from live creator configuration.
  const tier: PaidLedgerTierKey = (stored as PaidLedgerAppliedEntry).tierKey;

  let working = structuredClone(world);
  let summary: string;
  let note: string;
  let exact = false;

  if (tier === "paid_strike") {
    if (galeExactEligible(working, stored as PaidLedgerAppliedEntry)) {
      // Narrow exact reversal: the same live non-elite instance, same wave,
      // same chapter. HP only ever decreases within an instance in this
      // engine (no enemy heal exists), so hp + strike damage cannot exceed
      // maxHp; the min() clamp is defense-in-depth, not load-bearing.
      working.enemy.hp = Math.min(working.enemy.maxHp, working.enemy.hp + SIM.paidStrikeDamage);
      summary = DEEDS.galeExact;
      note = COMPENSATION_NOTES.galeExact;
      exact = true;
    } else {
      // Kill, respawn, replacement, or drift: never resurrect, never rewind
      // the wave, never claw back kill rewards. Narrative only.
      summary = DEEDS.galeNarrative;
      note = COMPENSATION_NOTES.galeNarrative;
    }
  } else if (tier === "paid_supply") {
    // Supplies may have been spent and keep HP changed through later play;
    // blind subtraction would punish innocent later actions. Narrative only.
    summary = DEEDS.supply;
    note = COMPENSATION_NOTES.supply;
  } else if (tier === "paid_elite") {
    // Non-reversible after commit: the elite, its arrival history, Vex
    // flags, location strain, and any later defeat all stand.
    summary = DEEDS.herald;
    note = COMPENSATION_NOTES.herald;
  } else {
    // paid_story: chapter/arc advances, secrets, and deeds stand.
    summary = DEEDS.bell;
    note = COMPENSATION_NOTES.bell;
  }

  // Persistent history remembers both the catalyst and the easing. The deed
  // log is capped by existing effect rules; a full log skips the deed but
  // never blocks the ledger transition (no retry loop, no second attempt).
  let deedApplied = true;
  const deedResult = applyEffect({ op: "appendDeed", deed: summary }, working);
  if (deedResult.ok) {
    working = deedResult.world;
  } else {
    deedApplied = false;
  }

  const updated: PaidLedgerAppliedEntry = {
    ...(stored as PaidLedgerAppliedEntry),
    status: "compensated",
    compensatedAtIso: nowIso,
    compensationNote: note,
  };
  working.paidLedger[idx] = updated;
  return { ok: true, world: working, entry: updated, summary, note, exact, deedApplied };
}

/**
 * Narrow Gale exact-reversal gate. ALL must hold:
 * - full checkpoint equality (arc/chapter/wave): any drift is a safety
 *   signal, never a rewind (§15 absolute rule);
 * - the enemy is alive (a kill can never be un-killed, §6);
 * - the enemy is not elite (replacements are never restored, §6).
 *
 * Instance identity without an instance id: every enemy replacement in this
 * engine changes waveNumber (spawnNextWave) or isElite (spawnElite), and no
 * revive path exists — so (same wave ∧ alive ∧ non-elite) identifies the
 * same instance exactly, not approximately. Enemy NAME is deliberately not
 * used: names repeat across waves.
 *
 * Fail closed: a malformed enemy record can never satisfy the gate, so a
 * corrupt world falls back to narrative compensation instead of throwing.
 */
function galeExactEligible(world: WorldState, entry: PaidLedgerAppliedEntry): boolean {
  const cp = entry.appliedCheckpoint;
  if (world.currentArc !== cp.arc || world.currentChapter !== cp.chapter || world.waveNumber !== cp.wave) {
    return false;
  }
  const enemy = world.enemy;
  if (!enemy || typeof enemy.hp !== "number" || !Number.isFinite(enemy.hp) || enemy.hp <= 0) return false;
  if (typeof enemy.maxHp !== "number" || !Number.isFinite(enemy.maxHp)) return false;
  if (enemy.isElite) return false;
  return true;
}
