// Phase 5G-2 — persistent paid-event causality ledger (pure, no clock, no I/O).
//
// The ledger records WHICH paid event caused WHICH catalyst consequence.
// It never reverses gameplay (no compensation logic lives here — that is
// 5G-3). All functions are pure: inputs are never mutated, outputs are fresh
// clones. Time/stream values are supplied by the caller (the engine's
// deterministic `now()`), never read here.
//
// Lifecycle vocabulary (5G-4 — no new state machine, these are the only terms):
//   observed        — canonical event accepted by the queue ("queued").
//                     Queue-only; says nothing about gameplay yet.
//   applied         — catalyst processed AND ledger entry recorded.
//   compensated     — applied entry answered by exactly one compensation.
//   retraction-noted— retraction signal recorded without a known original.
//   settled         — stream closed with entries unchallenged. Implicit: no
//                     mutation, no marking; closeStream only bumps streamCount.
// Queue outcomes (queued/duplicate/rejected-invalid/dropped-full) describe
// transport acceptance, never gameplay truth. The ledger is the only
// authority on whether an event affected the world.

import type {
  PaidLedgerAppliedEntry,
  PaidLedgerEntry,
  PaidLedgerNoteEntry,
  PaidLedgerStatus,
  PaidLedgerTierKey,
} from "./types";

/** Target bound for the ledger. See appendPaidLedgerEntry for overflow. */
export const PAID_LEDGER_MAX_ENTRIES = 200;

const TIER_KEYS: ReadonlySet<string> = new Set([
  "paid_strike",
  "paid_supply",
  "paid_elite",
  "paid_story",
]);

const STATUSES: ReadonlySet<string> = new Set(["applied", "compensated", "retraction-noted"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v: unknown, max = 256): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Shape validation. False (never throws) for any malformed entry. Applied
 * and compensated entries require full payment context; retraction-noted
 * entries require only the reference keys plus note timestamps (payment
 * fields must NOT be invented for them, so they are absent, not optional). */
export function validatePaidLedgerEntry(e: unknown): e is PaidLedgerEntry {
  if (!isRecord(e)) return false;
  if (typeof e.status !== "string" || !STATUSES.has(e.status)) return false;
  if (!isNonEmptyString(e.eventId)) return false;
  if (typeof e.platformEventId !== "string" || (e.platformEventId as string).length === 0) return false;
  if ((e.status as PaidLedgerStatus) === "retraction-noted") {
    return (
      typeof e.notedAtIso === "string" &&
      (e.notedAtIso as string).length > 0 &&
      isFiniteNumber(e.notedAtStream) &&
      e.actorId === undefined &&
      e.amount === undefined &&
      e.currency === undefined &&
      e.tierKey === undefined
    );
  }
  if (!isNonEmptyString(e.actorId, 128)) return false;
  if (!isFiniteNumber(e.amount) || (e.amount as number) <= 0) return false;
  if (!isNonEmptyString(e.currency, 8)) return false;
  if (typeof e.tierKey !== "string" || !TIER_KEYS.has(e.tierKey)) return false;
  if (typeof e.appliedAtIso !== "string" || (e.appliedAtIso as string).length === 0) return false;
  if (!isFiniteNumber(e.appliedAtStream) || !Number.isInteger(e.appliedAtStream) || (e.appliedAtStream as number) < 1) {
    return false;
  }
  if (!isRecord(e.appliedCheckpoint)) return false;
  const c = e.appliedCheckpoint as Record<string, unknown>;
  for (const k of ["arc", "chapter", "wave"] as const) {
    if (!isFiniteNumber(c[k]) || !Number.isInteger(c[k]) || (c[k] as number) < 1) return false;
  }
  if (e.compensatedAtIso !== undefined && typeof e.compensatedAtIso !== "string") return false;
  if (e.compensationNote !== undefined && typeof e.compensationNote !== "string") return false;
  return true;
}

/** True for a well-formed ledger: an array of valid entries. */
export function validatePaidLedger(v: unknown): v is PaidLedgerEntry[] {
  return Array.isArray(v) && v.every(validatePaidLedgerEntry);
}

/** Find an entry by the canonical paid eventId (idempotency key). */
export function findLedgerEntryByEventId(
  ledger: PaidLedgerEntry[],
  eventId: string,
): PaidLedgerEntry | undefined {
  return ledger.find((e) => e.eventId === eventId);
}

/**
 * Find entries whose platform message matches a retraction reference.
 * The retraction carries only refPlatformId, so this is the 5G-3 lookup key:
 * applied entries are "matched pending compensation", compensated entries
 * are "already resolved". Reference-only notes are excluded by type.
 */
export function findLedgerEntriesByPlatformId(
  ledger: PaidLedgerEntry[],
  refPlatformId: string,
): PaidLedgerAppliedEntry[] {
  return ledger.filter(
    (e): e is PaidLedgerAppliedEntry =>
      e.status !== "retraction-noted" && e.platformEventId === refPlatformId,
  );
}

/** Find a pending note for a retraction reference (before-original linkage). */
export function findRetractionNoteEntry(
  ledger: PaidLedgerEntry[],
  refPlatformId: string,
): PaidLedgerNoteEntry | undefined {
  return ledger.find(
    (e): e is PaidLedgerNoteEntry =>
      e.status === "retraction-noted" && e.platformEventId === refPlatformId,
  );
}

/** Build the reference-only note entry for one retraction signal. */
export function makeRetractionNoteEntry(
  signalEventId: string,
  refPlatformId: string,
  notedAtIso: string,
  notedAtStream: number,
): PaidLedgerNoteEntry {
  return {
    status: "retraction-noted",
    eventId: signalEventId,
    platformEventId: refPlatformId,
    notedAtIso,
    notedAtStream,
  };
}

export interface AppendResult {
  ledger: PaidLedgerEntry[];
  /** True when the bound was already full of non-evictable entries and the
   * append grew past PAID_LEDGER_MAX_ENTRIES to preserve causality. The
   * overflow is observable via ledger length; eviction resumes once entries
   * reach a terminal status. */
  overflowed: boolean;
}

/**
 * Append one entry under the bound. Evicts oldest `compensated` /
 * `retraction-noted` entries first; `applied` entries are NEVER evicted.
 * Pure: the input array is never mutated.
 */
export function appendPaidLedgerEntry(
  ledger: PaidLedgerEntry[],
  entry: PaidLedgerEntry,
  max = PAID_LEDGER_MAX_ENTRIES,
): AppendResult {
  const next = [...ledger, entry];
  if (next.length <= max) return { ledger: next, overflowed: false };
  const evictable = new Set(
    next.filter((e) => e !== entry && (e.status === "compensated" || e.status === "retraction-noted")),
  );
  if (evictable.size === 0) {
    // Full of applied entries: preserve causality, report the overflow.
    return { ledger: next, overflowed: true };
  }
  const kept: PaidLedgerEntry[] = [];
  let drop = next.length - max;
  for (const e of next) {
    if (drop > 0 && evictable.has(e)) {
      drop -= 1;
      continue;
    }
    kept.push(e);
  }
  return { ledger: kept, overflowed: false };
}

export interface AddNoteResult {
  ledger: PaidLedgerEntry[];
  /** True when an identical note (same signal eventId + ref) already existed. */
  duplicate: boolean;
}

/**
 * Record a retraction signal note. Idempotent: the same signal twice is a
 * duplicate no-op. Notes share the ledger bound and are evictable
 * oldest-first; dropping a note only loses a best-effort pending link,
 * never gameplay history. Pure.
 */
export function addRetractionNoteEntry(
  ledger: PaidLedgerEntry[],
  note: PaidLedgerNoteEntry,
  max = PAID_LEDGER_MAX_ENTRIES,
): AddNoteResult {
  if (
    ledger.some(
      (e) => e.status === "retraction-noted" && e.eventId === note.eventId && e.platformEventId === note.platformEventId,
    )
  ) {
    return { ledger, duplicate: true };
  }
  const r = appendPaidLedgerEntry(ledger, note, max);
  return { ledger: r.ledger, duplicate: false };
}

/** Type guard for applied-tier keys (mirrors PaidTier.key in config.ts). */
export function isPaidLedgerTierKey(v: unknown): v is PaidLedgerTierKey {
  return typeof v === "string" && TIER_KEYS.has(v);
}

export interface LedgerStatus {
  total: number;
  applied: number;
  compensated: number;
  noted: number;
  /** True when the ledger grew past the nominal bound to preserve applied
   * causality (see appendPaidLedgerEntry). Diagnostic only. */
  overflow: boolean;
}

/**
 * Deterministic ledger census for creator diagnostics (5G-4). Counts only —
 * no amounts, no actors, no tiers, no platform ids. Pure, total function.
 */
export function ledgerStatus(ledger: PaidLedgerEntry[]): LedgerStatus {
  let applied = 0;
  let compensated = 0;
  let noted = 0;
  const list = Array.isArray(ledger) ? ledger : [];
  for (const e of list) {
    if (e?.status === "applied") applied += 1;
    else if (e?.status === "compensated") compensated += 1;
    else if (e?.status === "retraction-noted") noted += 1;
    // Unknown shapes count toward total only — never misclassified.
  }
  const total = list.length;
  return { total, applied, compensated, noted, overflow: total > PAID_LEDGER_MAX_ENTRIES };
}
