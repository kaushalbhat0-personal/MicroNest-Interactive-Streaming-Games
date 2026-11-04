/**
 * T4F-B — shared authoritative snapshot contract (RENDERER-SAFE).
 *
 * One authoritative Tidebound runtime publishes versioned, privacy-scrubbed
 * snapshots; the landscape and portrait renderers consume them read-only.
 * This module is pure (no DOM, no Phaser, no timers, no network) and must
 * stay renderer-safe: only `import type` from engine/presentation modules,
 * never value imports from authority-only modules (engine/engine,
 * engine/queue, youtube/client, persistence/store, runtime/progression,
 * authority/*, app). The import-boundary test (tests/t4f-b-boundary.test.ts)
 * enforces this mechanically.
 *
 * Privacy (by construction — see sanitizeWorldForSnapshot):
 * - uniqueSearchers (actor ids) → length-preserving anonymized placeholders.
 * - paidLedger (actor ids, platform ids, amounts, tiers) → dropped; only a
 *   public count summary travels.
 * - totalPaidMinorUnits (an internal amount) → zeroed.
 * - private ballot maps → never transmitted; only the public VoteModel
 *   (option labels, commands, counts, winner) travels.
 * - GameResult.actorId → stripped from recent.
 * No OAuth data, stream keys, raw platform payloads, or currency travel.
 */

import type { FeedEntry } from "../engine/feed";
import type { StreamSession } from "../engine/lifecycle";
import type { GameResult, WorldState } from "../engine/types";
import type { VoteModel } from "../presentation/tidebound-presentation";
import type { BannerItem, ViewerFeedItem } from "../presentation/viewer-feed";

/** Snapshot protocol version. Renderers reject anything else (safe state). */
export const SNAPSHOT_PROTOCOL = 1;

/** Transport-assigned monotonic sequence (server stamps on publish). */
export type SnapshotSeq = number;

/**
 * Public paid-event census. Counts only — never amounts, currency, payers,
 * tiers, or platform ids. Mirrors the dashboard's ledgerStatus readout shape
 * so both surfaces describe the same history without sharing internals.
 */
export interface PaidCensus {
  applied: number;
  compensated: number;
  noted: number;
  total: number;
}

/**
 * One authoritative snapshot. Built atomically from a single refresh, so a
 * published worldRev always represents one coherent state transition —
 * a renderer never combines an old world with newer vote/feed data while
 * presenting it as one revision.
 */
export interface SnapshotV1 {
  /** Protocol/schema version (must equal SNAPSHOT_PROTOCOL). */
  v: number;
  /** Session identity (deterministic `stream-N`, never a secret). */
  sessionId: string;
  streamNumber: number;
  sessionPhase: StreamSession["phase"];
  /**
   * Coherent-state revision. Increments exactly when the revision signature
   * changes (see REVISION_RULES). Starts at 1 on first publish.
   */
  worldRev: number;
  /** ISO wall-clock of publication (display/diagnostics only). */
  atIso: string;
  /** Sanitized world (see sanitizeWorldForSnapshot). */
  world: WorldState;
  /** Count behind world.uniqueSearchers (contents are anonymized). */
  uniqueSearcherCount: number;
  /** Public paid-event census (ledger contents never travel). */
  paid: PaidCensus;
  /** Public vote projection (no ballot map). Null phase when dormant. */
  vote: VoteModel;
  /** Engine story log (bounded by the engine, newest-first). */
  storyLog: string[];
  /** Batched event feed (text/count/action only — no actor ids). */
  feed: FeedEntry[];
  /** Recent results minus actorId (drives renderer animations + moment). */
  recent: GameResult[];
  /** Prebuilt authoritative viewer feed (display names + outcomes only). */
  viewerFeed: ViewerFeedItem[];
  /** Single visible banner (or null). Renderer shows it verbatim. */
  banner: BannerItem | null;
  /** Authority pause state (affects the visible display). */
  paused: boolean;
}

// ---------------------------------------------------------------------------
// Revision semantics (locked for the prototype)
// ---------------------------------------------------------------------------

/**
 * REVISION_RULES — exactly when worldRev increments.
 *
 * worldRev bumps if and only if revisionSignature() changes. The signature
 * covers every renderer-visible fact and nothing else:
 *
 * BUMPS on (meaningful, viewer-visible changes):
 * - applied commands / paid catalysts (world HP/threat/resources/wave/…)
 * - enemy attacks and threat decay (tick results that changed the world)
 * - world progression (arc/chapter, deeds, storyFlags, meters, locations)
 * - vote open / ballot-count change / clock change / close / winner
 * - viewer feed changes (new item ids) and banner changes (current id)
 * - session changes (new sessionId/streamNumber/phase)
 * - pause changes (paused overlay state)
 *
 * NEVER bumps on (renderer-invisible internals):
 * - persistence writes / autosave timing
 * - announcement delivery status (chat ephemera, not game state)
 * - YouTube connection state (dashboard-only readout)
 * - publication timestamps (atIso is excluded from the signature)
 * - identical republish (same signature → same worldRev, still broadcast
 *   with a fresh transport seq so late joiners converge)
 */
export const REVISION_RULES = [
  "bump: applied commands and paid catalysts (world deltas)",
  "bump: enemy ticks and threat decay that changed the world",
  "bump: world progression (arc/chapter/deeds/flags/meters/locations)",
  "bump: vote open/update(clock+tally)/close/winner",
  "bump: viewer feed item ids and current banner id",
  "bump: session identity/phase changes",
  "bump: pause changes",
  "never: persistence, announcements, connection state, timestamps",
] as const;

// ---------------------------------------------------------------------------
// Sanitizers (privacy by construction)
// ---------------------------------------------------------------------------

/** Placeholder that preserves reef-lantern counts without leaking actor ids. */
export const ANONYMIZED_SEARCHER = "viewer";

/**
 * Clone a world for renderer publication. Strips everything the renderer
 * must not receive; see module doc. Never mutates the input.
 */
export function sanitizeWorldForSnapshot(world: WorldState): WorldState {
  return {
    ...world,
    enemy: { ...world.enemy },
    factionState: { ...world.factionState },
    storyFlags: { ...world.storyFlags },
    discoveredSecrets: [...world.discoveredSecrets],
    unlockedLocations: [...world.unlockedLocations],
    uniqueSearchers: world.uniqueSearchers.map(() => ANONYMIZED_SEARCHER),
    eventCounters: { ...world.eventCounters },
    locationState: { ...world.locationState },
    latent: world.latent.map((l) => ({ ...l })),
    repeatState: {
      onceFired: [...world.repeatState.onceFired],
      chapterFired: world.repeatState.chapterFired.map((c) => ({ ...c })),
      cooldownUntilStream: { ...world.repeatState.cooldownUntilStream },
    },
    deeds: [...world.deeds],
    // Renderer-invisible internals: ledger entries carry actor ids,
    // platform ids, amounts and tiers; the amount total is currency data.
    paidLedger: [],
    totalPaidMinorUnits: 0,
  };
}

/** Strip actorId from results (renderer needs everything else for animation). */
export function sanitizeRecent(recent: GameResult[]): GameResult[] {
  return recent.map((r) => {
    const { actorId: _dropped, ...rest } = r;
    void _dropped;
    return {
      ...rest,
      storyMessages: [...r.storyMessages],
      visual: { ...r.visual },
    };
  });
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface SnapshotInputs {
  world: WorldState;
  session: StreamSession;
  storyLog: string[];
  feed: FeedEntry[];
  recent: GameResult[];
  viewerFeed: ViewerFeedItem[];
  banner: BannerItem | null;
  paused: boolean;
  /** Prebuilt authority-side via voteModel(session, world, library). */
  vote: VoteModel;
  paid: PaidCensus;
  worldRev: number;
  atIso: string;
}

/** Build one atomic, coherent snapshot (authority side). */
export function buildSnapshot(inp: SnapshotInputs): SnapshotV1 {
  return {
    v: SNAPSHOT_PROTOCOL,
    sessionId: inp.session.sessionId,
    streamNumber: inp.session.streamNumber,
    sessionPhase: inp.session.phase,
    worldRev: inp.worldRev,
    atIso: inp.atIso,
    world: sanitizeWorldForSnapshot(inp.world),
    uniqueSearcherCount: inp.world.uniqueSearchers.length,
    paid: { ...inp.paid },
    vote: structuredVoteClone(inp.vote),
    storyLog: [...inp.storyLog],
    feed: inp.feed.map((e) => ({ ...e })),
    recent: sanitizeRecent(inp.recent),
    viewerFeed: inp.viewerFeed.map((i) => ({ ...i })),
    banner: inp.banner ? { ...inp.banner } : null,
    paused: inp.paused,
  };
}

function structuredVoteClone(v: VoteModel): VoteModel {
  return {
    ...v,
    options: v.options.map((o) => ({ ...o })),
  };
}

/**
 * Revision signature: every renderer-visible fact, nothing else.
 * atIso and transport seq are excluded (time alone is not a revision).
 */
export function revisionSignature(s: Omit<SnapshotV1, "atIso">): string {
  const w = s.world;
  return JSON.stringify([
    s.sessionId,
    s.streamNumber,
    s.sessionPhase,
    w.heroHp, w.maxHeroHp, w.keepHp, w.maxKeepHp,
    w.keepShieldUntil,
    w.threatLevel, w.resolve, w.resources,
    w.enemy.hp, w.enemy.maxHp, w.enemy.isElite, w.enemy.name, w.enemy.faction,
    w.waveNumber,
    w.currentArc, w.currentChapter, w.streamCount,
    w.locationState, w.factionState, w.storyFlags,
    w.discoveredSecrets, w.unlockedLocations,
    w.eventCounters,
    w.deeds,
    s.uniqueSearcherCount,
    s.paid,
    s.vote,
    s.storyLog,
    s.feed,
    s.recent.map((r) => [r.eventId, r.action, r.actorName, r.summary]),
    s.viewerFeed.map((i) => i.id),
    s.banner?.id ?? null,
    s.paused,
  ]);
}

/** worldRev bumps iff the signature changed. */
export function shouldBumpRevision(prevSig: string | null, nextSig: string): boolean {
  if (prevSig === null) return true;
  return prevSig !== nextSig;
}

// ---------------------------------------------------------------------------
// Validation (renderer side: reject before render, never render partial)
// ---------------------------------------------------------------------------

export type SnapshotProblem =
  | "bad-shape"
  | "bad-protocol"
  | "bad-rev"
  | "bad-session";

/** Structural + protocol validation. Monotonicity is checked by the caller. */
export function validateSnapshot(s: unknown): { ok: true; snapshot: SnapshotV1 } | { ok: false; reason: SnapshotProblem } {
  if (!s || typeof s !== "object") return { ok: false, reason: "bad-shape" };
  const c = s as Record<string, unknown>;
  if (c.v !== SNAPSHOT_PROTOCOL) return { ok: false, reason: "bad-protocol" };
  if (typeof c.worldRev !== "number" || !Number.isInteger(c.worldRev) || c.worldRev < 1) {
    return { ok: false, reason: "bad-rev" };
  }
  if (typeof c.sessionId !== "string" || c.sessionId.length === 0) return { ok: false, reason: "bad-session" };
  if (typeof c.streamNumber !== "number" || !Number.isFinite(c.streamNumber)) return { ok: false, reason: "bad-session" };
  if (!c.world || typeof c.world !== "object") return { ok: false, reason: "bad-shape" };
  if (!c.vote || typeof c.vote !== "object") return { ok: false, reason: "bad-shape" };
  if (!Array.isArray(c.storyLog) || !Array.isArray(c.feed) || !Array.isArray(c.recent)) {
    return { ok: false, reason: "bad-shape" };
  }
  if (!Array.isArray(c.viewerFeed)) return { ok: false, reason: "bad-shape" };
  return { ok: true, snapshot: s as SnapshotV1 };
}

/** Stale delivery: an older worldRev (or same rev from an older session). */
export function isStaleSnapshot(current: SnapshotV1 | null, incoming: SnapshotV1): boolean {
  if (!current) return false;
  if (incoming.sessionId !== current.sessionId) {
    // A new session always supersedes (authority restart / new stream).
    // An old session id after a newer one is stale.
    return incoming.streamNumber <= current.streamNumber;
  }
  return incoming.worldRev < current.worldRev;
}

/**
 * Rebuild the minimal read-only session stub a renderer needs for
 * renderOverlay. Ballots stay empty BY DESIGN: vote counts come from the
 * prebuilt public vote model (passed separately as the hud `vote`
 * override), and feed attribution is baked into the prebuilt
 * viewerFeed items. The stub must never be used for mutation.
 */
export function rendererSessionStub(s: Pick<SnapshotV1, "sessionId" | "streamNumber" | "sessionPhase">): StreamSession {
  return {
    sessionId: s.sessionId,
    streamNumber: s.streamNumber,
    phase: s.sessionPhase,
    activeVote: null,
    meterContributors: {},
  };
}
