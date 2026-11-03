// Canonical domain types. WORLD STATE IS DATA — it lives here, not in UI code.

export type CanonicalEventKind = "chat_command" | "paid_event" | "paid_retraction";

export interface CanonicalChatCommand {
  kind: "chat_command";
  /** Stable unique id; duplicates must be ignored. */
  eventId: string;
  actorId: string;
  actorName: string;
  /** Raw chat text, e.g. "!strike". Treated as DATA, never executed. */
  command: string;
  receivedAt: string; // ISO timestamp
  /** Input provenance. Engine behavior never depends on it. */
  source?: string;
  /** Original platform message id, if any. Engine behavior never depends on it. */
  platformEventId?: string;
}

export interface CanonicalPaidEvent {
  kind: "paid_event";
  eventId: string;
  actorId: string;
  actorName: string;
  /** Minor units (e.g. paise). 500 INR === 50000. */
  amount: number;
  currency: string; // ISO 4217, e.g. "INR"
  receivedAt: string;
  /** Input provenance. Engine behavior never depends on it. */
  source?: string;
  /** Original platform message id, if any. Engine behavior never depends on it. */
  platformEventId?: string;
}

export type CanonicalEvent = CanonicalChatCommand | CanonicalPaidEvent | CanonicalPaidRetraction;

/**
 * Phase 5G-1 — paid retraction candidate (boundary only, no ledger yet).
 *
 * Records ONLY: "the platform says message X was deleted/retracted."
 * It never claims X was a paid event (the 5G-2 ledger decides that) and
 * carries no amount, currency, payer, text, tier, or compensation.
 * The engine must process this kind with ZERO world mutation.
 */
export interface CanonicalPaidRetraction {
  kind: "paid_retraction";
  /** Uniquely identifies THIS retraction signal; never equals the original eventId. */
  eventId: string;
  /** Platform id of the referenced (possibly paid) message. Opaque, never interpreted. */
  refPlatformId: string;
  receivedAt: string; // ISO timestamp
  /** Input provenance. Engine behavior never depends on it. */
  source?: string;
  /** Platform id of the retraction signal message itself, if any. */
  platformEventId?: string;
}

export interface EnemyState {
  name: string;
  hp: number;
  maxHp: number;
  isElite: boolean;
  difficulty: number;
  faction: string;
}

export type LocationState = "sound" | "strained" | "lost";

export interface LatentThreat {
  id: string;
  /** 0..100, same scale as WorldState.threatLevel. Storage only in this slice. */
  attention: number;
}

/**
 * Repeat bookkeeping for EventTemplates (Phase 4D slice 8A).
 * Records SUCCESSFUL firings only — selection never writes here.
 * Chapter entries carry their own (arc, chapter) identity so no clearing
 * pass is needed: stale chapters simply stop matching. Per-id replace
 * semantics keep every collection bounded by the template count.
 */
export interface TemplateRepeatState {
  /** Ids of once-templates that have fired (each at most once in the list). */
  onceFired: string[];
  /** Per-chapter firings; at most one entry per template id (latest wins). */
  chapterFired: Array<{ id: string; arc: number; chapter: number }>;
  /** Template id -> first streamCount at which it becomes eligible again. */
  cooldownUntilStream: Record<string, number>;
}

/**
 * Phase 5G-2 — persistent paid-event causality ledger (gameplay only).
 *
 * Answers, across restarts: "did this exact paid event affect the world, and
 * what catalyst consequence was applied?" NOT a financial ledger: no
 * processor ids, no receipts, no payouts. Actor id persists because it is
 * already part of the canonical paid event (reconciliation key, not PII).
 */
export type PaidLedgerTierKey = "paid_strike" | "paid_supply" | "paid_elite" | "paid_story";

export interface PaidLedgerCheckpoint {
  arc: number;
  chapter: number;
  wave: number;
}

export type PaidLedgerStatus = "applied" | "compensated" | "retraction-noted";

interface PaidLedgerBase {
  /** Canonical id of the recorded signal. Idempotency key. */
  eventId: string;
  /** Platform message id the record refers to. Retraction lookup key. */
  platformEventId: string;
  status: PaidLedgerStatus;
}

/** A paid event that affected the world. Full payment context required. */
export interface PaidLedgerAppliedEntry extends PaidLedgerBase {
  status: "applied" | "compensated";
  actorId: string;
  /** Exact minor units as applied. */
  amount: number;
  currency: string;
  /** Tier resolved at application time. Historical: never re-derived from
   * current PAID_TIERS (creator configuration may change later). */
  tierKey: PaidLedgerTierKey;
  /** Deterministic engine time of application (ISO). */
  appliedAtIso: string;
  /** streamCount + 1 at application (matches openStream streamNumber). */
  appliedAtStream: number;
  /** Post-application settled world position (arc/chapter/wave primitives). */
  appliedCheckpoint: PaidLedgerCheckpoint;
  /** 5G-3 only. Never written by gameplay in 5G-2. */
  compensatedAtIso?: string;
  /** 5G-3 only. Never written by gameplay in 5G-2. */
  compensationNote?: string;
}

/**
 * A retraction signal whose original paid event cannot yet be resolved
 * (unknown ref, or original not yet arrived). Reference fields ONLY:
 * inventing actor/amount/tier here is forbidden, so payment fields are
 * absent by construction (not merely optional). 5G-3 uses these to link a
 * late original to its pending retraction.
 */
export interface PaidLedgerNoteEntry extends PaidLedgerBase {
  status: "retraction-noted";
  notedAtIso: string;
  notedAtStream: number;
}

export type PaidLedgerEntry = PaidLedgerAppliedEntry | PaidLedgerNoteEntry;

export interface WorldState {
  worldId: string;
  worldName: string;
  currentArc: number;
  currentChapter: number;
  heroHp: number;
  maxHeroHp: number;
  keepHp: number;
  maxKeepHp: number;
  keepShieldUntil: number; // epoch ms; 0 = no shield
  threatLevel: number; // 0..100
  resources: number;
  enemy: EnemyState;
  waveNumber: number;
  discoveredSecrets: string[];
  unlockedLocations: string[];
  factionState: Record<string, number>;
  storyFlags: Record<string, boolean>;
  uniqueSearchers: string[];
  searchProgress: number;
  eventCounters: Record<string, number>;
  totalViewerActions: number;
  totalPaidEvents: number;
  totalPaidMinorUnits: number;
  lastUpdated: string;
  // ---- Phase 4B slice 1: persistent foundation (storage only, no evaluation) ----
  /** Save-format version. 2 since the 5G-2 paid ledger; v1 saves load via defaults. */
  schemaVersion: number;
  /** Streams survived. Incremented at stream close (later slice). */
  streamCount: number;
  /** Append-only one-line history. Written by a later slice; stored here. */
  deeds: string[];
  /**
   * Community hope/resolve pool. Starts at 50.
   * NOTE: `resources` (below) IS the supplies pool — resources === supplies.
   * There is exactly one persisted supplies value and it keeps the historical
   * field name so existing saves stay valid.
   */
  resolve: number;
  /** Per-location condition. Parallel to `unlockedLocations`; no bonuses. */
  locationState: Record<string, LocationState>;
  /** Dormant threats. Storage only; surfacing logic comes in a later slice. */
  latent: LatentThreat[];
  /** Template repeat bookkeeping. Written only on successful firing (later slice). */
  repeatState: TemplateRepeatState;
  /**
   * Phase 5G-2 — durable paid-event causality record. Grows only via paid
   * application / retraction notes; never rewinds gameplay. Bounded (see
   * ledger.ts); schema v2+.
   */
  paidLedger: PaidLedgerEntry[];
}

/** Result the engine hands to rendering / feed after processing one event. */
export interface GameResult {
  eventId: string;
  /** Machine-readable action key for batching + visuals. */
  action:
    | "attack"
    | "heal"
    | "search"
    | "shield"
    | "ring"
    | "hide"
    | "tribute"
    | "defy"
    | "help"
    | "paid_strike"
    | "paid_supply"
    | "paid_elite"
    | "paid_story"
    | "rejected"
    | "cooldown"
    | "duplicate";
  summary: string;
  actorName: string;
  /**
   * Originating viewer for chat_command results. Set only there: paid,
   * retraction, compensation, tick, and ledger-duplicate results carry no
   * actor (paid attribution lives in the ledger, not in results). Lets the
   * runtime attribute meter contributions to the acting viewer without
   * re-interpreting display names (which are not unique keys).
   */
  actorId?: string;
  storyMessages: string[];
  visual: VisualCue;
}

export interface VisualCue {
  hitEnemy?: boolean;
  hitHero?: boolean;
  healHero?: boolean;
  shieldKeep?: boolean;
  spawnElite?: boolean;
  spawnWave?: boolean;
  discovery?: boolean;
  majorStory?: boolean;
  shake?: boolean;
}

export interface StoryBeat {
  id: string;
  blurb: string;
}

export function initialWorld(nowIso?: string): WorldState {
  return {
    worldId: "emberkeep-prototype",
    worldName: "Emberkeep",
    currentArc: 1,
    currentChapter: 1,
    heroHp: 100,
    maxHeroHp: 100,
    keepHp: 100,
    maxKeepHp: 100,
    keepShieldUntil: 0,
    threatLevel: 10,
    resources: 20,
    enemy: {
      name: "Goblin Raider",
      hp: 60,
      maxHp: 60,
      isElite: false,
      difficulty: 1,
      faction: "goblins",
    },
    waveNumber: 1,
    discoveredSecrets: [],
    unlockedLocations: ["emberkeep-gate"],
    factionState: { goblins: 30, villagers: 60 },
    storyFlags: {},
    uniqueSearchers: [],
    searchProgress: 0,
    eventCounters: {},
    totalViewerActions: 0,
    totalPaidEvents: 0,
    totalPaidMinorUnits: 0,
    lastUpdated: nowIso ?? new Date().toISOString(),
    schemaVersion: 2,
    streamCount: 0,
    deeds: [],
    resolve: 50,
    locationState: {},
    latent: [],
    repeatState: { onceFired: [], chapterFired: [], cooldownUntilStream: {} },
    paidLedger: [],
  };
}
