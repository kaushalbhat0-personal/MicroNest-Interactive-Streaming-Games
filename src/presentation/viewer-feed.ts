/**
 * T4D — Authoritative viewer activity feed + event banner queue (PURE + stores).
 *
 * Presenter-only layer: builds viewer-facing `ViewerFeedItem`s from
 * authoritative normalized `GameResult`s (never raw YouTube messages),
 * aggregates rapid bursts, queues event banners, models HP chips and
 * cooldown hints. No engine semantics change, no Keeper/Vessel art change.
 *
 * Privacy: output carries display names + outcomes only. `actorId`,
 * platform ids, amounts/currency, raw chat, payer identity, internal
 * ids/flags/counters/opcodes never appear in items or DOM attrs by
 * construction (eventId is a dedupe key only, never rendered).
 */

import { COMMANDS, SIM } from "../engine/config";
import type { GameResult, WorldState } from "../engine/types";
import { classifyMoment } from "./tidebound-presentation";

// ---------------------------------------------------------------------------
// Constants (locked: match T4B/T4A budgets)
// ---------------------------------------------------------------------------

/** Bounded internal history (matches engine recentResults retention). */
export const VIEWER_FEED_HISTORY_MAX = 30;
/** Rapid-event grouping window (matches QUEUE.batchWindowMs). */
export const GROUP_WINDOW_MS = 1500;
/** Minimum run length before `+N others` collapsing. */
export const MIN_GROUP_SIZE = 4;
/** Visible rows: landscape 5 / portrait 3 (T4B locked). */
export const VISIBLE_LANDSCAPE = 5;
export const VISIBLE_PORTRAIT = 3;
/** Event banner hold: 5s (within approved 4–6s). Never tied to animation. */
export const BANNER_HOLD_MS = 5000;
/** Bounded pending queue (single visible + up to N pending). */
export const BANNER_MAX_PENDING = 3;
/** Bounded dedupe memory (FIFO evict). */
const BANNER_SEEN_MAX = 50;

// ---------------------------------------------------------------------------
// ViewerFeedItem schema (T4B §2.1 locked)
// ---------------------------------------------------------------------------

export interface ViewerFeedItem {
  /** GameResult.eventId — dedupe key only, never rendered to DOM. */
  id: string;
  /** Display name | "A watcher" (missing) | "Someone" (paid). Never actorId. */
  actor: string;
  /** struck | restored | scouted | protected | sounded | doused | honored … */
  verb: string;
  /** Gloam Vessel | Keeper's crew | lighthouse | Pale Reaches | assembly … */
  target: string;
  /** Plain words, no internal ids. */
  outcome: string;
  /** Presenter-joined actual world snapshot (e.g. "46/60"), never parsed prose. */
  delta?: string;
  kind: "action" | "consequence" | "moment";
  /** Existing machine signal (styling + burst join). */
  action: GameResult["action"];
  /** Received-at ms (store-assigned stable stamp; fallback arrival order). */
  at: number;
  status: "applied" | "cooldown" | "rejected-effect";
}

/** Minimal vote context for ballot attribution (no ballots leak to DOM). */
export interface VoteFeedCtx {
  phase: "none" | "open" | "closed";
  totalBallots: number;
  /** actorId -> option index (latest-wins map, private). */
  ballots: Record<string, number>;
  options: Array<{ label: string; command: string }>;
}

export interface BuildCtx {
  world: WorldState;
  vote?: VoteFeedCtx | null;
  /** Stable stamp; store assigns Date.now() when omitted. */
  at?: number;
}

// ---------------------------------------------------------------------------
// Sanitization (privacy by construction)
// ---------------------------------------------------------------------------

const ANON = "A watcher";
const PAID_ACTOR = "Someone";

function sanitizeActor(raw: unknown): string {
  if (typeof raw !== "string") return ANON;
  // Collapse whitespace/control, trim. Never invent a name.
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return ANON;
  // Never expose transport identities on the viewer surface.
  if (cleaned.startsWith("yt:")) return ANON;
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(cleaned)) return ANON;
  return cleaned;
}

function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function factionLabel(world: WorldState): string {
  const f = (world.enemy.faction ?? "").trim();
  if (!f) return "";
  return `the ${cap(f)}`;
}

function enemyLabel(world: WorldState): string {
  const n = (world.enemy.name ?? "").trim();
  return n.length > 0 ? `the ${n}` : "the Gloam Vessel";
}

/** Extract the whitelisted command token from an engine cooldown summary.
 *  Engine format (engine.ts): `${actorName}: ${command} is on cooldown.`
 *  Summary is authoritative engine prose (not raw chat); strict allowlist,
 *  null when unrecognized — never guessed. */
function cooldownCommandFromSummary(summary: string): string | null {
  const m = /(![a-z0-9]+)\s+is on cooldown/i.exec(summary);
  if (!m) return null;
  const token = m[1].toLowerCase();
  return token in COMMANDS ? token : null;
}

export function cooldownSecondsFor(commandToken: string): number | null {
  const entry = COMMANDS[commandToken];
  if (!entry) return null;
  return Math.max(1, Math.ceil(entry.cooldownMs / 1000));
}

// ---------------------------------------------------------------------------
// Authoritative builder (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Build one viewer feed item from an authoritative GameResult + live world.
 * Returns null for suppressed noise (duplicates, world-actor ledger/tick
 * notes) — never rendered on the viewer surface.
 *
 * Deltas are actual post-application world snapshots (HP, threat, standing,
 * charts) or authoritative config constants (ward 12s, cooldown Ns).
 * Outcomes are never invented: clamped heals show the after-value only
 * (no fabricated +N), kills show repelled (visual.spawnWave), duplicate
 * scouts show already-charted (visual.discovery).
 */
export function buildViewerFeedItem(result: GameResult, ctx: BuildCtx): ViewerFeedItem | null {
  const { world } = ctx;
  const at = typeof ctx.at === "number" && Number.isFinite(ctx.at) ? ctx.at : 0;
  const base = {
    id: result.eventId,
    kind: classifyMoment(result.action, !!result.visual.majorStory),
    action: result.action,
    at,
  } as const;

  // Transport/internal noise: never a viewer deed.
  if (result.action === "duplicate") return null;
  if (result.action === "rejected" && result.actorName === "world") return null;
  if (result.action === "cooldown" && result.actorName === "world") return null;

  // Cooldown: muted system note, never a deed. Exact remaining ms lives
  // only in the engine's in-memory map (no actor identity on the viewer
  // surface), so show the configured duration as an estimate, never a
  // fabricated live countdown.
  if (result.action === "cooldown") {
    const actor = sanitizeActor(result.actorName);
    const token = cooldownCommandFromSummary(result.summary);
    const secs = token ? cooldownSecondsFor(token) : null;
    return {
      ...base,
      actor,
      verb: "paused",
      target: "on cooldown",
      outcome: secs !== null ? `wait ~${secs}s — the ward rekindles` : "on cooldown — try again shortly",
      status: "cooldown",
    };
  }

  // Paid catalysts: fictional presentation only. Summary contains the payer
  // display name + payment label by engine construction — never used here.
  if (
    result.action === "paid_strike" ||
    result.action === "paid_supply" ||
    result.action === "paid_elite" ||
    result.action === "paid_story"
  ) {
    const enemyHp = `${Math.max(0, world.enemy.hp)}/${world.enemy.maxHp}`;
    switch (result.action) {
      case "paid_strike":
        return { ...base, actor: PAID_ACTOR, verb: "called", target: "the storm", outcome: "the Vessel reels", delta: `Vessel ${enemyHp}`, status: "applied" };
      case "paid_supply":
        return { ...base, actor: PAID_ACTOR, verb: "sent", target: "a supply convoy", outcome: "the keep breathes", delta: `Supplies ${world.resources} · Keep ${world.keepHp}/${world.maxKeepHp}`, status: "applied" };
      case "paid_elite":
        return { ...base, actor: PAID_ACTOR, verb: "drew", target: "the Herald's Attention", outcome: "an elite vessel answers", delta: `Vessel ${enemyHp}`, status: "applied" };
      case "paid_story":
        return { ...base, actor: PAID_ACTOR, verb: "tolled", target: "the Bell", outcome: "the world holds its breath", status: "applied" };
    }
  }

  // Chat-command effects (authoritative action keys).
  const actor = sanitizeActor(result.actorName);
  switch (result.action) {
    case "attack": {
      const killed = !!result.visual.spawnWave || world.enemy.hp <= 0;
      const delta = `Vessel ${Math.max(0, world.enemy.hp)}/${world.enemy.maxHp}`;
      if (killed) {
        return { ...base, actor, verb: "struck", target: enemyLabel(world), outcome: "repelled — the light holds", delta, status: "applied" };
      }
      return { ...base, actor, verb: "struck", target: enemyLabel(world), outcome: "enemy health decreased", delta, status: "applied" };
    }
    case "heal": {
      const delta = `Keeper ${world.heroHp}/${world.maxHeroHp}`;
      return { ...base, actor, verb: "restored", target: "the Keeper's crew", outcome: "the crew breathes", delta, status: "applied" };
    }
    case "search": {
      const n = Math.min(5, world.uniqueSearchers.length);
      if (result.visual.discovery) {
        return { ...base, actor, verb: "scouted", target: "the Pale Reaches", outcome: "new marks charted", delta: `charts ${n}/5`, status: "applied" };
      }
      return { ...base, actor, verb: "scouted", target: "the Pale Reaches", outcome: "already charted — new eyes needed", status: "applied" };
    }
    case "shield": {
      const secs = Math.round(SIM.shieldDurationMs / 1000);
      return { ...base, actor, verb: "protected", target: "the lighthouse", outcome: `the beacon holds ${secs}s`, status: "applied" };
    }
    case "ring": {
      return { ...base, actor, verb: "sounded", target: "the drowned bell", outcome: "the Gloam presses", delta: `threat ${world.threatLevel}`, status: "applied" };
    }
    case "hide": {
      return { ...base, actor, verb: "doused", target: "the lantern", outcome: "danger fades at a cost", delta: `threat ${world.threatLevel} · resolve ${world.resolve}`, status: "applied" };
    }
    case "tribute": {
      const faction = factionLabel(world) || "a faced faction";
      const standing = faction ? (world.factionState[world.enemy.faction] ?? 0) : 0;
      return { ...base, actor, verb: "honored", target: faction, outcome: "standing grows (5 supplies offered)", delta: `standing ${standing}`, status: "applied" };
    }
    case "defy": {
      const faction = factionLabel(world) || "a faced faction";
      const standing = world.factionState[world.enemy.faction] ?? 0;
      return { ...base, actor, verb: "defied", target: faction, outcome: "the faction bristles", delta: `standing ${standing} · threat ${world.threatLevel}`, status: "applied" };
    }
    case "help": {
      return { ...base, actor, verb: "asked", target: "the commands", outcome: "showed command list", status: "applied" };
    }
    case "rejected": {
      // Accepted command with failed effect (!tribute w/o supplies,
      // !defy w/o faction, vote when closed). Still visible, muted —
      // never masquerading as successful gameplay. Engine summaries are
      // allowlisted (not raw chat); unknown shapes fall closed to a
      // generic muted note.
      const s = result.summary;
      if (s.includes("cannot tribute") || s.includes("needs 5 supplies")) {
        const faction = factionLabel(world) || "a faced faction";
        return { ...base, actor, verb: "honored", target: faction, outcome: "needs 5 supplies", status: "rejected-effect" };
      }
      if (s.includes("to honor")) {
        return { ...base, actor, verb: "honored", target: "a faced faction", outcome: "no faction to honor", status: "rejected-effect" };
      }
      if (s.includes("to defy")) {
        return { ...base, actor, verb: "defied", target: "a faced faction", outcome: "no faction to defy", status: "rejected-effect" };
      }
      if (s.includes("assembly has not been called")) {
        // Vote-ballot path: the GameResult is inert by design; the ballot
        // rode the session side-path. Attribute via the private ballot map.
        const v = ctx.vote;
        const ballotIdx =
          v && result.actorId && typeof v.ballots[result.actorId] === "number" ? v.ballots[result.actorId] : null;
        if (v && v.phase === "open" && ballotIdx !== null && v.options[ballotIdx]) {
          const label = v.options[ballotIdx].label || `option ${"ABC"[ballotIdx] ?? ballotIdx + 1}`;
          return { ...base, actor, verb: "voted", target: "the assembly", outcome: `counted — ${label} (${v.totalBallots} voices)`, status: "applied" };
        }
        return { ...base, actor, verb: "voted", target: "the assembly", outcome: "the assembly has not been called", status: "rejected-effect" };
      }
      return { ...base, actor, verb: "acted", target: "the tide", outcome: "did not take hold", status: "rejected-effect" };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Bounded store (preserves attribution, stable stamps, dedupe)
// ---------------------------------------------------------------------------

export class ViewerFeedStore {
  private items: ViewerFeedItem[] = [];
  constructor(private readonly now: () => number = () => Date.now()) {}

  push(result: GameResult, ctx: Omit<BuildCtx, "at">): ViewerFeedItem[] {
    const at = this.now();
    // Dedupe: SSE replay + queue.seen replays collapse naturally.
    if (this.items.some((i) => i.id === result.eventId)) return this.items;
    const built = buildViewerFeedItem(result, { ...ctx, at });
    if (!built) return this.items;
    this.items.unshift(built);
    this.items = this.items.slice(0, VIEWER_FEED_HISTORY_MAX);
    return this.items;
  }

  /** Direct insert for tests (explicit stamps, no result mapping). */
  insert(item: ViewerFeedItem): ViewerFeedItem[] {
    if (this.items.some((i) => i.id === item.id)) return this.items;
    this.items.unshift(item);
    this.items = this.items.slice(0, VIEWER_FEED_HISTORY_MAX);
    return this.items;
  }

  list(): ViewerFeedItem[] {
    return this.items;
  }

  clear(): void {
    this.items = [];
  }
}

// ---------------------------------------------------------------------------
// Rapid-event aggregation (+N others, bounded, deterministic)
// ---------------------------------------------------------------------------

export type DisplayRow =
  | { kind: "single"; item: ViewerFeedItem }
  | {
      kind: "group";
      action: GameResult["action"];
      verb: string;
      target: string;
      outcome: string;
      delta?: string;
      groupKind: ViewerFeedItem["kind"];
      /** Underlying records, newest-first (attribution preserved). */
      items: ViewerFeedItem[];
      leadActor: string;
      othersCount: number;
      count: number;
      at: number;
    };

export interface AggregateResult {
  rows: DisplayRow[];
  /** Underlying items beyond the visible rows (`+N more acts`). */
  overflow: number;
  /** Total underlying items considered. */
  total: number;
}

/** Actions that never merge (decisive/rare/low-priority). */
const NEVER_GROUP: ReadonlySet<string> = new Set(["paid_story", "paid_elite", "help", "rejected", "cooldown", "duplicate"]);

/**
 * Grouping rules (locked):
 * - newest-first (at desc, id asc tie-break), consecutive runs only;
 * - same action AND same target, all status applied, groupable action;
 * - run length >= MIN_GROUP_SIZE (4) within GROUP_WINDOW_MS (1500ms);
 * - mixed viewers preserved (lead +N others, full actor list kept);
 * - mixed outcomes never imply uniformity: unanimous outcome/delta reused,
 *   otherwise generic outcome + newest delta (current world truth).
 */
export function aggregateFeedItems(
  items: ViewerFeedItem[],
  visible: number,
  windowMs: number = GROUP_WINDOW_MS,
  minGroup: number = MIN_GROUP_SIZE,
): AggregateResult {
  // Newest-first (at desc). Ties keep input order via stable sort: callers
  // pass newest-first lists (store/recent), so same-tick bursts preserve
  // recency and group correctly. No id tie-break (id order is oldest-first
  // and would invert bursts sharing one stamp).
  const sorted = [...items].sort((a, b) => b.at - a.at);
  const rows: DisplayRow[] = [];
  let i = 0;
  while (i < sorted.length) {
    const head = sorted[i];
    const groupable =
      head.status === "applied" && !NEVER_GROUP.has(head.action);
    if (!groupable) {
      rows.push({ kind: "single", item: head });
      i += 1;
      continue;
    }
    // Extend the consecutive run while key matches and window holds.
    let j = i + 1;
    while (
      j < sorted.length &&
      sorted[j].status === "applied" &&
      sorted[j].action === head.action &&
      sorted[j].target === head.target &&
      head.at - sorted[j].at <= windowMs
    ) {
      j += 1;
    }
    const run = sorted.slice(i, j);
    if (run.length >= minGroup) {
      const outcomes = new Set(run.map((r) => r.outcome));
      const deltas = new Set(run.map((r) => r.delta ?? ""));
      const unanimousOutcome = outcomes.size === 1;
      const unanimousDelta = deltas.size === 1;
      rows.push({
        kind: "group",
        action: head.action,
        verb: head.verb,
        target: head.target,
        outcome: unanimousOutcome ? head.outcome : "acts shape the tide",
        delta: unanimousDelta ? head.delta : (head.delta ?? undefined),
        groupKind: head.kind,
        items: run,
        leadActor: head.actor,
        othersCount: run.length - 1,
        count: run.length,
        at: head.at,
      });
      i = j;
    } else {
      for (const r of run) rows.push({ kind: "single", item: r });
      i = j;
    }
  }
  // Visible-row window; overflow counts underlying items (not rows).
  const shown: DisplayRow[] = rows.slice(0, visible);
  const shownItems = shown.reduce((n, r) => n + (r.kind === "group" ? r.count : 1), 0);
  return { rows: shown, overflow: Math.max(0, sorted.length - shownItems), total: sorted.length };
}

// ---------------------------------------------------------------------------
// Event banner queue (10 approved categories, single visible, bounded)
// ---------------------------------------------------------------------------

export type BannerCategory =
  | "enemy-arrival"
  | "elite-arrival"
  | "major-hit"
  | "repelled"
  | "keeper-healing"
  | "ward"
  | "wave-progression"
  | "vote-opening"
  | "vote-result"
  | "story-beat";

export interface BannerItem {
  /** Stable dedupe key (eventId / vote identity / wave identity). */
  id: string;
  category: BannerCategory;
  title: string;
  sub: string;
  at: number;
  priority: number;
}

export const BANNER_PRIORITY: Record<BannerCategory, number> = {
  "vote-result": 100,
  repelled: 90,
  "elite-arrival": 85,
  "story-beat": 80,
  "enemy-arrival": 70,
  "major-hit": 60,
  "keeper-healing": 50,
  ward: 45,
  "vote-opening": 40,
  "wave-progression": 30,
};

function short(s: string, max = 90): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Map one authoritative result + post-application world to at most one
 * banner. Priority: repelled (kill) wins over major-hit for the same blow
 * (no overlapping presentation of the same event). paid_supply's
 * shieldKeep visual never raises a ward banner (supply, not ward).
 * !help / cooldown / duplicate / world-noise never banner.
 */
export function bannerForResult(result: GameResult, world: WorldState, at: number): BannerItem | null {
  const v = result.visual;
  if (result.action === "duplicate" || result.action === "cooldown" || result.action === "help") return null;
  if (result.actorName === "world") return null;
  const enemyHp = `${Math.max(0, world.enemy.hp)}/${world.enemy.maxHp}`;

  // Final blow wins over major-hit for the same killing blow.
  const killed = !!v.spawnWave || ((result.action === "attack" || result.action === "paid_strike") && world.enemy.hp <= 0);
  if (killed && (result.action === "attack" || result.action === "paid_strike" || v.hitEnemy)) {
    return {
      id: `repelled:${result.eventId}`,
      category: "repelled",
      title: "Repelled",
      sub: "the Vessel sinks — the light holds",
      at,
      priority: BANNER_PRIORITY["repelled"],
    };
  }
  if (v.spawnElite || result.action === "paid_elite") {
    return {
      id: `elite:${result.eventId}`,
      category: "elite-arrival",
      title: "Herald's Attention",
      sub: "an elite vessel answers — hold the light",
      at,
      priority: BANNER_PRIORITY["elite-arrival"],
    };
  }
  if (result.action === "paid_strike" && v.hitEnemy) {
    return {
      id: `hit:${result.eventId}`,
      category: "major-hit",
      title: "A telling blow",
      sub: `the Vessel reels (${enemyHp})`,
      at,
      priority: BANNER_PRIORITY["major-hit"],
    };
  }
  if (v.healHero) {
    return {
      id: `heal:${result.eventId}`,
      category: "keeper-healing",
      title: "The crew breathes",
      sub: `Keeper ${world.heroHp}/${world.maxHeroHp}`,
      at,
      priority: BANNER_PRIORITY["keeper-healing"],
    };
  }
  if (v.shieldKeep && result.action !== "paid_supply") {
    return {
      id: `ward:${result.eventId}`,
      category: "ward",
      title: "Ward up",
      sub: "the beacon holds 12s",
      at,
      priority: BANNER_PRIORITY["ward"],
    };
  }
  if (v.majorStory || result.action === "paid_story") {
    const msg = result.storyMessages[0] ?? "the tide turns";
    return {
      id: `story:${result.eventId}`,
      category: "story-beat",
      title: "The story turns",
      sub: short(msg),
      at,
      priority: BANNER_PRIORITY["story-beat"],
    };
  }
  // Wave mentions without a major-story flag (authoritative storyMessages,
  // keyword-gated; arrival itself is waveNumber-driven in syncWorld).
  const waveMsg = result.storyMessages.find((m) => /\bwave\b/i.test(m));
  if (waveMsg && !v.spawnWave) {
    return {
      id: `waveprog:${result.eventId}`,
      category: "wave-progression",
      title: "The tide turns",
      sub: short(waveMsg),
      at,
      priority: BANNER_PRIORITY["wave-progression"],
    };
  }
  return null;
}

export interface VoteBannerCtx {
  phase: "none" | "open" | "closed";
  id: string | null;
  prompt: string;
  options: Array<{ label: string; command: string }>;
  winnerLabel: string | null;
  winnerReason: string | null;
}

export class BannerQueue {
  private currentItem: BannerItem | null = null;
  private shownAt = 0;
  private pending: BannerItem[] = [];
  private seen: string[] = [];
  private lastVoteKey: string | null = null;
  private lastWave: number | null = null;
  private lastVexStage: string | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  private markSeen(id: string): boolean {
    if (this.seen.includes(id)) return false;
    if (this.currentItem?.id === id) return false;
    if (this.pending.some((p) => p.id === id)) return false;
    this.seen.push(id);
    if (this.seen.length > BANNER_SEEN_MAX) this.seen = this.seen.slice(-BANNER_SEEN_MAX);
    return true;
  }

  enqueue(item: BannerItem): boolean {
    if (!this.markSeen(item.id)) return false;
    this.pending.push(item);
    // Deterministic order: priority desc, at asc, id asc.
    this.pending.sort((a, b) =>
      b.priority !== a.priority ? b.priority - a.priority : a.at !== b.at ? a.at - b.at : a.id < b.id ? -1 : 1,
    );
    // Bounded overflow: drop the lowest-priority oldest (last after sort).
    while (this.pending.length > BANNER_MAX_PENDING) this.pending.pop();
    return true;
  }

  /** Event-driven only: map one processed result (never called from sync). */
  pushResult(result: GameResult, world: WorldState): boolean {
    const item = bannerForResult(result, world, this.now());
    if (!item) return false;
    return this.enqueue(item);
  }

  /**
   * World-driven arrivals/transitions (poll-safe: dedupe by stable wave/vex
   * identity, so routine polling/sync never repeats a banner).
   * Vex stages merge into the banner (no separate persistent card).
   */
  syncWorld(world: WorldState, vexStage: string | null): void {
    const t = this.now();
    if (this.lastWave === null) {
      this.lastWave = world.waveNumber;
    } else if (world.waveNumber !== this.lastWave) {
      const wave = world.waveNumber;
      this.lastWave = wave;
      if (world.enemy.hp > 0) {
        if (world.enemy.isElite) {
          this.enqueue({
            id: `arrival:elite:wave:${wave}`,
            category: "elite-arrival",
            title: "Herald's Attention",
            sub: "an elite vessel answers — hold the light",
            at: t,
            priority: BANNER_PRIORITY["elite-arrival"],
          });
        } else {
          this.enqueue({
            id: `arrival:wave:${wave}`,
            category: "enemy-arrival",
            title: "The Gloam stirs",
            sub: "a vessel answers the deep",
            at: t,
            priority: BANNER_PRIORITY["enemy-arrival"],
          });
        }
      }
    }
    if (this.lastVexStage === null) {
      this.lastVexStage = vexStage;
    } else if (vexStage !== this.lastVexStage) {
      const prev = this.lastVexStage;
      this.lastVexStage = vexStage;
      if (vexStage === "driven-off" && prev !== "driven-off") {
        this.enqueue({ id: `vex:driven-off:${t}`, category: "repelled", title: "Vex driven off", sub: "Cinderholm breathes", at: t, priority: BANNER_PRIORITY["repelled"] });
      } else if (vexStage === "raid" && prev !== "raid") {
        this.enqueue({ id: `vex:raid:${t}`, category: "elite-arrival", title: "Herald Vex raids", sub: "Cinderholm strains", at: t, priority: BANNER_PRIORITY["elite-arrival"] });
      } else if (vexStage === "watchful" && prev === "quiet") {
        this.enqueue({ id: `vex:watchful:${t}`, category: "wave-progression", title: "Vex watches", sub: "the deep grows bold", at: t, priority: BANNER_PRIORITY["wave-progression"] });
      } else if (vexStage === "escalated" && prev !== "escalated") {
        this.enqueue({ id: `vex:escalated:${t}`, category: "elite-arrival", title: "Herald's Attention", sub: "an elite vessel answers — hold the light", at: t, priority: BANNER_PRIORITY["elite-arrival"] });
      }
    }
  }

  /**
   * Vote open/close transitions only (dormant never banners).
   * Result banner carries the decisive outcome only (short); the vote card
   * retains the detailed tally (no duplication of the full card).
   */
  syncVote(vote: VoteBannerCtx, sessionId: string): void {
    const t = this.now();
    const key = `${sessionId}:${vote.id ?? "none"}:${vote.phase}`;
    if (this.lastVoteKey === null) {
      this.lastVoteKey = key;
      return;
    }
    if (key === this.lastVoteKey) return;
    this.lastVoteKey = key;
    if (vote.phase === "open" && vote.id) {
      const cmds = vote.options.map((o) => o.command).filter(Boolean);
      const tail = cmds.length > 0 ? ` · type ${cmds.join(" / ")}` : "";
      this.enqueue({
        id: `vote:${sessionId}:${vote.id}:open`,
        category: "vote-opening",
        title: "The assembly is called",
        sub: short(`${vote.prompt}${tail}`, 90),
        at: t,
        priority: BANNER_PRIORITY["vote-opening"],
      });
    } else if (vote.phase === "closed" && vote.id) {
      const sub = vote.winnerLabel ? `chose ${vote.winnerLabel}` : "no winner — the tide stays its course";
      this.enqueue({
        id: `vote:${sessionId}:${vote.id}:close`,
        category: "vote-result",
        title: "The assembly has spoken",
        sub: short(sub, 90),
        at: t,
        priority: BANNER_PRIORITY["vote-result"],
      });
    }
  }

  /** Single visible banner; hold expiry by timestamp (never animation). */
  current(): BannerItem | null {
    const t = this.now();
    if (this.currentItem && t - this.shownAt < BANNER_HOLD_MS) return this.currentItem;
    const next = this.pending.shift() ?? null;
    this.currentItem = next;
    this.shownAt = next ? t : 0;
    return this.currentItem;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  /** World reset/replacement: no stale banner survives. */
  clear(): void {
    this.currentItem = null;
    this.shownAt = 0;
    this.pending = [];
    this.seen = [];
    this.lastVoteKey = null;
    this.lastWave = null;
    this.lastVexStage = null;
  }
}

// ---------------------------------------------------------------------------
// HP chips (authoritative world-state, tabular, never color-alone)
// ---------------------------------------------------------------------------

export interface HpChip {
  key: "keeper" | "keep" | "vessel";
  label: string;
  text: string;
  /** Status word when attention is needed (low/down/fallen/repelled/elite). */
  status: string | null;
  aria: string;
}

export function hpChipModels(world: WorldState): HpChip[] {
  const keeperFrac = world.maxHeroHp > 0 ? world.heroHp / world.maxHeroHp : 1;
  const keepFrac = world.maxKeepHp > 0 ? world.keepHp / world.maxKeepHp : 1;
  const vesselHp = Math.max(0, world.enemy.hp);
  const keeperStatus = world.heroHp <= 0 ? "down" : keeperFrac < 0.3 ? "low" : null;
  const keepStatus = world.keepHp <= 0 ? "fallen" : keepFrac < 0.3 ? "low" : null;
  const vesselStatus = vesselHp <= 0 ? "repelled" : world.enemy.isElite ? "elite" : null;
  return [
    {
      key: "keeper",
      label: "Keeper",
      text: `Keeper ${world.heroHp}/${world.maxHeroHp}`,
      status: keeperStatus,
      aria: `Keeper ${world.heroHp} of ${world.maxHeroHp}${keeperStatus ? `, ${keeperStatus}` : ""}`,
    },
    {
      key: "keep",
      label: "Keep",
      text: `Keep ${world.keepHp}/${world.maxKeepHp}`,
      status: keepStatus,
      aria: `Keep ${world.keepHp} of ${world.maxKeepHp}${keepStatus ? `, ${keepStatus}` : ""}`,
    },
    {
      key: "vessel",
      label: "Vessel",
      text: `Vessel ${vesselHp}/${world.enemy.maxHp}`,
      status: vesselStatus,
      aria: `Vessel ${vesselHp} of ${world.enemy.maxHp}${vesselStatus ? `, ${vesselStatus}` : ""}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Command cooldown hints (authoritative config, static — no countdown)
// ---------------------------------------------------------------------------

export interface CooldownHint {
  /** Display token (!voteA). */
  command: string;
  seconds: number;
  label: string;
}

/**
 * Static per-command durations from COMMANDS.cooldownMs (authoritative).
 * The viewer surface carries no actor identity and the engine cooldown
 * store is in-memory per-viewer only, so a personalized remaining-time
 * countdown is unavailable by design — show `(Ns)` durations instead of
 * fabricating a live countdown (documented limitation, no flicker, no
 * per-frame DOM updates).
 */
export function cooldownHints(): CooldownHint[] {
  const out: CooldownHint[] = [];
  for (const [key, entry] of Object.entries(COMMANDS)) {
    const display =
      key === "!votea" ? "!voteA" : key === "!voteb" ? "!voteB" : key === "!votec" ? "!voteC" : key;
    out.push({ command: display, seconds: Math.max(1, Math.ceil(entry.cooldownMs / 1000)), label: `(${Math.max(1, Math.ceil(entry.cooldownMs / 1000))}s)` });
  }
  return out;
}
