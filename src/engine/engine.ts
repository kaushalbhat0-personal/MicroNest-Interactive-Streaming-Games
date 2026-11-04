import { COMMANDS, QUEUE, SIM, formatPaidLabel, tiersFor, toTierUnits, type PaidTier } from "./config";
import { compensatePaid } from "./compensate";
import { EventQueue, type EnqueueOutcome } from "./queue";
import {
  addRetractionNoteEntry,
  appendPaidLedgerEntry,
  findLedgerEntriesByPlatformId,
  findLedgerEntryByEventId,
  findRetractionNoteEntry,
  makeRetractionNoteEntry,
} from "./ledger";
import { evaluateBeats } from "./story";
import {
  initialWorld,
  type CanonicalEvent,
  type GameResult,
  type PaidLedgerAppliedEntry,
  type WorldState,
} from "./types";

export type { EnqueueOutcome };

export interface EngineOptions {
  now?: () => number;
  onResult?: (r: GameResult) => void;
}

let idCounter = 0;
export function makeEventId(prefix = "ev"): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/**
 * Deterministic game simulation. Pure domain logic: no DOM, no Phaser.
 * Time is injected via `now()` so tests can control cooldowns exactly.
 */
export class GameEngine {
  readonly queue = new EventQueue();
  world: WorldState;
  storyLog: string[] = [];
  recentResults: GameResult[] = [];
  private cooldowns = new Map<string, number>();
  private lastProcessAt = 0;
  private lastEnemyAttackAt = 0;
  private processedCount = 0;
  private readonly now: () => number;
  private readonly onResult?: (r: GameResult) => void;

  constructor(opts: EngineOptions = {}, seed?: WorldState) {
    this.now = opts.now ?? (() => Date.now());
    this.onResult = opts.onResult;
    this.world = seed ?? initialWorld(new Date(this.now()).toISOString());
    this.lastEnemyAttackAt = this.now();
  }

  // ---------- ingestion ----------

  ingest(ev: CanonicalEvent): EnqueueOutcome {
    return this.queue.enqueue(ev);
  }

  ingestCommand(actorId: string, actorName: string, rawText: string, eventId?: string): EnqueueOutcome {
    // Whitelist: normalize, strip to first token, lowercase. Unknown => rejected.
    const token = rawText.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!(token in COMMANDS)) return "rejected-invalid";
    return this.ingest({
      kind: "chat_command",
      eventId: eventId ?? makeEventId("cmd"),
      actorId,
      actorName,
      command: token,
      receivedAt: new Date(this.now()).toISOString(),
    });
  }

  ingestPaid(
    actorId: string,
    actorName: string,
    amountMinor: number,
    currency: string,
    eventId?: string,
  ): EnqueueOutcome {
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) return "rejected-invalid";
    return this.ingest({
      kind: "paid_event",
      eventId: eventId ?? makeEventId("paid"),
      actorId,
      actorName,
      amount: Math.round(amountMinor),
      currency,
      receivedAt: new Date(this.now()).toISOString(),
    });
  }

  // ---------- processing ----------

  /** Process up to QUEUE.maxPerTick events, honoring the global min gap. */
  pump(): GameResult[] {
    const out: GameResult[] = [];
    for (let i = 0; i < QUEUE.maxPerTick; i++) {
      if (this.now() - this.lastProcessAt < QUEUE.minGapMs && this.processedCount > 0) break;
      const ev = this.pendingFront.shift() ?? this.queue.dequeue();
      if (!ev) break;
      this.lastProcessAt = this.now();
      out.push(this.processOne(ev));
    }
    return out;
  }

  /** Time-based simulation: enemy attacks, shield expiry, threat decay. */
  tick(): GameResult[] {
    const w = this.world;
    const now = this.now();
    const messages: string[] = [];
    if (now - this.lastEnemyAttackAt >= SIM.enemyAttackIntervalMs) {
      this.lastEnemyAttackAt = now;
      if (w.enemy.hp > 0 && (w.heroHp > 0 || w.keepHp > 0)) {
        const variance = this.processedCount % 3; // deterministic, no RNG
        const base = w.enemy.isElite ? SIM.eliteEnemyDamage : SIM.enemyDamage;
        let dmg = base + variance;
        if (now < w.keepShieldUntil) {
          dmg = Math.max(1, Math.round(dmg * (1 - SIM.shieldBlockFraction)));
        }
        const keepDmg = Math.round(dmg * SIM.keepShareOfEnemyDamage);
        const heroDmg = dmg - keepDmg;
        w.keepHp = Math.max(0, w.keepHp - keepDmg);
        w.heroHp = Math.max(0, w.heroHp - heroDmg);
        w.threatLevel = Math.min(100, w.threatLevel + 1);
        messages.push(`${w.enemy.name} strikes! Hero −${heroDmg}, Keep −${keepDmg}.`);
      } else if (w.enemy.hp <= 0) {
        this.spawnNextWave();
        messages.push(`A new threat approaches: ${w.enemy.name} (wave ${w.waveNumber}).`);
      }
      if (w.threatLevel > 0) w.threatLevel = Math.max(0, w.threatLevel - SIM.threatDecayPerTick);
    }
    w.lastUpdated = new Date(now).toISOString();
    const story = evaluateBeats(w, this.beatCtx());
    const all = [...messages, ...story];
    if (all.length > 0) {
      for (const m of all) this.pushStory(m);
      const r: GameResult = {
        eventId: `tick-${now}`,
        action: "rejected",
        summary: messages.join(" "),
        actorName: "world",
        storyMessages: story,
        visual: { shake: messages.length > 0 },
      };
      return [r];
    }
    return [];
  }

  /** Replace world (load). Also re-prime queue dedup + cooldowns sanely. */
  loadWorld(w: WorldState): void {
    this.world = structuredClone(w);
    if (!Array.isArray(this.world.paidLedger)) this.world.paidLedger = [];
    this.cooldowns.clear();
    // Persistent idempotency: redelivered paid events stay duplicates even
    // though the in-memory queue `seen` set is fresh after a restart.
    this.queue.primeSeen(this.world.paidLedger.map((e) => e.eventId));
    this.lastEnemyAttackAt = this.now();
  }

  resetWorld(): void {
    this.world = initialWorld(new Date(this.now()).toISOString());
    this.storyLog = [];
    this.recentResults = [];
    this.cooldowns.clear();
    this.queue.clear();
    this.lastEnemyAttackAt = this.now();
    this.pushStory("The world of Tidebound begins anew. The lantern holds, for now…");
  }

  // ---------- internals ----------

  private beatCtx() {
    return { now: this.now(), keepLowThreshold: 0.4, threatHighThreshold: 70 };
  }

  // Events deferred by the global min-gap wait here, ahead of the queue.
  private pendingFront: CanonicalEvent[] = [];

  private processOne(ev: CanonicalEvent): GameResult {
    // Phase 5G-2 — retraction candidate: ledger lookup, ZERO gameplay
    // mutation. 5G-3 will decide the compensating response; this slice only
    // records an unresolvable signal as a bounded reference-only note.
    // recentResults/onResult are runtime ephemera (not world state) and keep
    // the signal observable to the creator console without touching gameplay.
    if (ev.kind === "paid_retraction") {
      return this.processRetraction(ev);
    }
    // Phase 5G-2 — persistent idempotency BEFORE any mutation. The in-memory
    // queue `seen` set already dedups within a session; the ledger extends
    // that guarantee across restarts. A compensated payment is history and
    // must never be resurrected.
    if (ev.kind === "paid_event") {
      const known = findLedgerEntryByEventId(this.ledger(), ev.eventId);
      if (known && (known.status === "applied" || known.status === "compensated")) {
        const result: GameResult = {
          eventId: ev.eventId,
          action: "rejected",
          summary:
            known.status === "applied"
              ? `Duplicate paid event ${ev.eventId} ignored (ledger: already applied).`
              : `Duplicate paid event ${ev.eventId} ignored (ledger: compensated, history stands).`,
          actorName: "world",
          storyMessages: [],
          visual: {},
        };
        this.recentResults.unshift(result);
        this.recentResults = this.recentResults.slice(0, 30);
        this.onResult?.(result);
        return result;
      }
    }
    this.processedCount += 1;
    const w = this.world;
    w.totalViewerActions += 1;
    const bump = (k: string) => {
      w.eventCounters[k] = (w.eventCounters[k] ?? 0) + 1;
    };

    let result: GameResult;
    let paidCtx: { ev: Extract<CanonicalEvent, { kind: "paid_event" }>; tier: PaidTier } | null = null;
    if (ev.kind === "chat_command") {
      result = this.applyCommand(ev, bump);
    } else {
      w.totalPaidEvents += 1;
      w.totalPaidMinorUnits += ev.amount;
      bump("paid_events");
      // Single tier-resolution point: the ledger records exactly the tier
      // that is applied below (never re-derived later from live config).
      const tiers = tiersFor(ev.currency);
      // Currency-aware: zero-decimal currencies (JPY, …) are scaled so that
      // thresholds keep their meaning. No conversion between currencies.
      const tier = tiers.find((t) => toTierUnits(ev.amount, ev.currency) >= t.minMinor) ?? tiers[tiers.length - 1];
      result = this.applyPaid(ev, bump, tier);
      paidCtx = { ev, tier };
    }
    const story = evaluateBeats(w, this.beatCtx());
    result.storyMessages.push(...story);
    for (const m of story) this.pushStory(m);
    if (paidCtx) {
      const entry = this.recordPaidApplication(paidCtx.ev, paidCtx.tier);
      // Phase 5G-3 §5 (retraction-before-original): a note for this platform
      // message is already pending, so the same compensation decision runs
      // immediately — exactly once, in this same processing. The note is
      // preserved as historical evidence. The world shows catalyst +
      // compensation, never a denial that the catalyst happened.
      const key = paidCtx.ev.platformEventId ?? paidCtx.ev.eventId;
      if (entry && findRetractionNoteEntry(this.ledger(), key)) {
        const stored = findLedgerEntryByEventId(this.ledger(), entry.eventId);
        if (stored && stored.status === "applied") this.applyCompensation(stored);
      }
    }
    // Wave respawn is handled in tick; but a killing blow deserves an immediate note.
    w.lastUpdated = new Date(this.now()).toISOString();
    this.recentResults.unshift(result);
    this.recentResults = this.recentResults.slice(0, 30);
    this.onResult?.(result);
    return result;
  }

  /** Defensive read: worlds loaded outside normalizeWorld may lack the field. */
  private ledger() {
    if (!Array.isArray(this.world.paidLedger)) this.world.paidLedger = [];
    return this.world.paidLedger;
  }

  /**
   * Phase 5G-3 retraction resolution. Looks the reference up in the ledger:
   * applied → compensate exactly once (new history, never a rewind);
   * compensated → already resolved; existing note → still waiting;
   * unknown → bounded reference-only note. No counters, no beats, no vote or
   * meter interaction on any path.
   */
  private processRetraction(ev: Extract<CanonicalEvent, { kind: "paid_retraction" }>): GameResult {
    const base = {
      eventId: ev.eventId,
      actorName: "world",
      storyMessages: [] as string[],
      visual: {},
    };
    const finish = (summary: string): GameResult => {
      const result: GameResult = { ...base, action: "rejected", summary };
      this.recentResults.unshift(result);
      this.recentResults = this.recentResults.slice(0, 30);
      this.onResult?.(result);
      return result;
    };
    const ledger = this.ledger();
    const matches = findLedgerEntriesByPlatformId(ledger, ev.refPlatformId);
    const applied = matches.find((e) => e.status === "applied");
    if (applied) {
      const compensated = this.applyCompensation(applied);
      if (compensated) return compensated;
      // Fails closed: the catalyst history stands untouched.
      return finish(`Retraction of ${ev.refPlatformId} could not be compensated safely — history stands.`);
    }
    if (matches.some((e) => e.status === "compensated")) {
      return finish(`Retraction of ${ev.refPlatformId} already resolved — history stands.`);
    }
    if (findRetractionNoteEntry(ledger, ev.refPlatformId)) {
      return finish(`Retraction of ${ev.refPlatformId} already noted — awaiting its original.`);
    }
    const stream = this.world.streamCount + 1;
    const r = addRetractionNoteEntry(
      ledger,
      makeRetractionNoteEntry(ev.eventId, ev.refPlatformId, new Date(this.now()).toISOString(), stream),
      // ^ bounded inside addRetractionNoteEntry (evict oldest notes first)
    );
    this.world.paidLedger = r.ledger;
    return finish(
      r.duplicate
        ? `Retraction of ${ev.refPlatformId} already noted — awaiting its original.`
        : `Retraction of ${ev.refPlatformId} noted — no matching paid event yet.`,
    );
  }

  /**
   * Perform the 5G-3 compensation for one applied entry: adopt the compensated
   * world (gameplay easing + ledger transition, atomically), surface the new
   * history in the story log and recent results. Never touches counters,
   * beats, votes, or meters. Returns null only if the entry is no longer
   * compensable (fail closed, world untouched).
   */
  private applyCompensation(entry: PaidLedgerAppliedEntry): GameResult | null {
    const r = compensatePaid(this.world, entry, new Date(this.now()).toISOString());
    if (!r.ok) return null;
    this.world = r.world;
    const result: GameResult = {
      // Deterministic and distinct from both the catalyst and the signal.
      eventId: `comp:${entry.eventId}`,
      action: "rejected",
      summary: r.summary,
      actorName: "world",
      storyMessages: [],
      visual: {},
    };
    this.pushStory(r.summary);
    this.recentResults.unshift(result);
    this.recentResults = this.recentResults.slice(0, 30);
    this.onResult?.(result);
    return result;
  }

  /**
   * Append the causality record for a just-applied paid event. The caller
   * has already mutated the world (catalyst + beats); the checkpoint below
   * therefore captures the settled post-application position 5G-3 needs to
   * distinguish narrow reversals from late compensation. Atomic with the
   * world mutation: same in-memory object, same persisted save.
   * Returns the stored entry for retraction-before-original linkage.
   */
  private recordPaidApplication(
    ev: Extract<CanonicalEvent, { kind: "paid_event" }>,
    tier: PaidTier,
  ): PaidLedgerAppliedEntry | null {
    const w = this.world;
    const entry: PaidLedgerAppliedEntry = {
      status: "applied",
      eventId: ev.eventId,
      // Sim-originated events carry no platform id; fall back to the
      // canonical id (namespaces differ from platform ids, so no false match).
      platformEventId: ev.platformEventId ?? ev.eventId,
      actorId: ev.actorId,
      amount: ev.amount,
      currency: ev.currency,
      tierKey: tier.key,
      appliedAtIso: new Date(this.now()).toISOString(),
      appliedAtStream: w.streamCount + 1,
      appliedCheckpoint: { arc: w.currentArc, chapter: w.currentChapter, wave: w.waveNumber },
    };
    const r = appendPaidLedgerEntry(this.ledger(), entry);
    w.paidLedger = r.ledger;
    return entry;
  }

  private checkCooldown(actorId: string, command: string): boolean {
    const key = `${actorId}:${command}`;
    const last = this.cooldowns.get(key) ?? -Infinity;
    const cd = COMMANDS[command]?.cooldownMs ?? 0;
    if (this.now() - last < cd) return false;
    this.cooldowns.set(key, this.now());
    return true;
  }

  private applyCommand(
    ev: Extract<CanonicalEvent, { kind: "chat_command" }>,
    bump: (k: string) => void,
  ): GameResult {
    const w = this.world;
    const base = {
      eventId: ev.eventId,
      actorName: ev.actorName,
      actorId: ev.actorId,
      storyMessages: [] as string[],
    };
    if (!this.checkCooldown(ev.actorId, ev.command)) {
      return { ...base, action: "cooldown", summary: `${ev.actorName}: ${ev.command} is on cooldown.`, visual: {} };
    }
    switch (ev.command) {
      case "!strike": {
        bump("attacks");
        if (w.enemy.hp <= 0) {
          return { ...base, action: "attack", summary: `${ev.actorName} strikes at shadows — no enemy stands.`, visual: {} };
        }
        w.enemy.hp = Math.max(0, w.enemy.hp - SIM.attackDamage);
        w.threatLevel = Math.max(0, w.threatLevel - 1);
        const killed = w.enemy.hp <= 0;
        if (killed) {
          bump("kills");
          if (w.enemy.isElite) {
            bump("elites_defeated");
            w.resources += 10;
          } else {
            w.resources += 4;
          }
        }
        const msg = killed
          ? `${ev.actorName} dealt the killing blow to ${w.enemy.name}! (+resources)`
          : `${ev.actorName} strikes ${w.enemy.name} (−${SIM.attackDamage} HP).`;
        this.pushStory(killed ? msg : "");
        return { ...base, action: "attack", summary: msg, visual: { hitEnemy: true, shake: true, spawnWave: killed } };
      }
      case "!mend": {
        bump("heals");
        const before = w.heroHp;
        w.heroHp = Math.min(w.maxHeroHp, w.heroHp + SIM.healAmount);
        const gained = w.heroHp - before;
        const msg = `${ev.actorName} mends the crew (+${gained} HP).`;
        return { ...base, action: "heal", summary: msg, visual: { healHero: true } };
      }
      case "!scout": {
        bump("searches");
        w.searchProgress = Math.min(100, w.searchProgress + SIM.searchProgressPerSearch);
        const isNew = !w.uniqueSearchers.includes(ev.actorId);
        if (isNew) w.uniqueSearchers.push(ev.actorId);
        const msg = isNew
          ? `${ev.actorName} scouts the Pale (${w.uniqueSearchers.length}/${SIM.uniqueSearchersForSecret} scouts).`
          : `${ev.actorName} scouts again — new eyes are needed (${w.uniqueSearchers.length}/${SIM.uniqueSearchersForSecret}).`;
        return { ...base, action: "search", summary: msg, visual: { discovery: isNew } };
      }
      case "!shield": {
        bump("shields");
        w.keepShieldUntil = this.now() + SIM.shieldDurationMs;
        const msg = `${ev.actorName} raises a ward over the beacon!`;
        return { ...base, action: "shield", summary: msg, visual: { shieldKeep: true } };
      }
      case "!ring": {
        bump("rings");
        w.threatLevel = Math.min(100, w.threatLevel + 8);
        const msg = `${ev.actorName} sounds the drowned bell! The Gloam stirs (+8 threat).`;
        return { ...base, action: "ring", summary: msg, visual: { shake: true } };
      }
      case "!hide": {
        bump("hides");
        w.threatLevel = Math.max(0, w.threatLevel - 6);
        w.resolve = Math.max(0, w.resolve - 5);
        const msg = `${ev.actorName} douses the lantern. Danger fades (−6 threat, −5 resolve).`;
        return { ...base, action: "hide", summary: msg, visual: {} };
      }
      case "!tribute": {
        // Targeting convention: honor the faction of the currently faced enemy.
        // No targeting UI, no new subsystem — the encounter defines relevance.
        if (w.resources < 5) {
          return { ...base, action: "rejected", summary: `${ev.actorName} cannot tribute (needs 5 supplies).`, visual: {} };
        }
        const faction = w.enemy.faction;
        if (!faction) {
          return { ...base, action: "rejected", summary: `${ev.actorName} finds no faction to honor.`, visual: {} };
        }
        bump("tributes");
        w.resources -= 5;
        w.factionState[faction] = Math.min(100, (w.factionState[faction] ?? 0) + 5);
        const msg = `${ev.actorName} offers tribute to the ${faction} (+5 standing).`;
        return { ...base, action: "tribute", summary: msg, visual: {} };
      }
      case "!defy": {
        const faction = w.enemy.faction;
        if (!faction) {
          return { ...base, action: "rejected", summary: `${ev.actorName} finds no faction to defy.`, visual: {} };
        }
        bump("defies");
        w.factionState[faction] = Math.max(0, (w.factionState[faction] ?? 0) - 5);
        w.threatLevel = Math.min(100, w.threatLevel + 4);
        const msg = `${ev.actorName} defies the ${faction}! (−5 standing, +4 threat).`;
        return { ...base, action: "defy", summary: msg, visual: { shake: true } };
      }
      case "!votea":
      case "!voteb":
      case "!votec": {
        // Reserved for audience voting. Whitelisted so ingestion accepts the
        // token, but deliberately inert: no state change, no counters, no templates.
        // Votes open through the session API when the assembly is called.
        return { ...base, action: "rejected", summary: `${ev.actorName}: the assembly has not been called.`, visual: {} };
      }
      case "!help": {
        const cmds = Object.entries(COMMANDS)
          .map(([c, m]) => `${c} — ${m.does}`)
          .join(" · ");
        return { ...base, action: "help", summary: `Commands: ${cmds}`, visual: {} };
      }
      default:
        return { ...base, action: "rejected", summary: `Unknown command ${ev.command}.`, visual: {} };
    }
  }

  private applyPaid(
    ev: Extract<CanonicalEvent, { kind: "paid_event" }>,
    bump: (k: string) => void,
    tier: PaidTier,
  ): GameResult {
    const w = this.world;
    const label = formatPaidLabel(ev.amount, ev.currency);
    const base = { eventId: ev.eventId, actorName: ev.actorName, storyMessages: [] as string[] };
    switch (tier.key) {
      case "paid_strike": {
        bump("paid_strikes");
        if (w.enemy.hp > 0) w.enemy.hp = Math.max(0, w.enemy.hp - SIM.paidStrikeDamage);
        const msg = `${ev.actorName} (${label}) calls down a GALE CALL (−${SIM.paidStrikeDamage} to ${w.enemy.name})!`;
        this.pushStory(msg);
        return { ...base, action: "paid_strike", summary: msg, visual: { hitEnemy: true, shake: true } };
      }
      case "paid_supply": {
        bump("paid_supplies");
        w.resources += 30;
        w.keepHp = Math.min(w.maxKeepHp, w.keepHp + 10);
        const msg = `${ev.actorName} (${label}) sends a supply convoy! +30 supplies, keep repaired.`;
        this.pushStory(msg);
        return { ...base, action: "paid_supply", summary: msg, visual: { shieldKeep: true } };
      }
      case "paid_elite": {
        bump("elite_arrivals");
        this.spawnElite();
        const msg = `${ev.actorName} (${label}) has drawn the Herald's Attention…`;
        this.pushStory(msg);
        return { ...base, action: "paid_elite", summary: msg, visual: { spawnElite: true, shake: true } };
      }
      case "paid_story": {
        bump("major_story_events");
        w.resources += 20;
        w.threatLevel = Math.min(100, w.threatLevel + 5);
        const msg = `${ev.actorName} (${label}) tolls the Bell! The world holds its breath…`;
        this.pushStory(msg);
        return { ...base, action: "paid_story", summary: msg, visual: { majorStory: true, shake: true } };
      }
    }
  }

  private spawnElite(): void {
    const w = this.world;
    const d = w.waveNumber + 1;
    w.enemy = {
      name: "Elite Herald of the Gloam",
      hp: 60 + d * 25,
      maxHp: 60 + d * 25,
      isElite: true,
      difficulty: d,
      faction: "gloam",
    };
    w.threatLevel = Math.min(100, w.threatLevel + 25);
  }

  /** Endless encounters: each fallen vessel returns stronger. Reuses the same visuals. */
  private spawnNextWave(): void {
    const w = this.world;
    w.waveNumber += 1;
    const wasElite = w.enemy.isElite;
    const d = w.waveNumber + (wasElite ? 1 : 0);
    const hp = 50 + d * 15;
    w.enemy = {
      name: wasElite ? "Gloam Vessel" : d % 4 === 0 ? "Gloam Mauler" : "Gloam Vessel",
      hp,
      maxHp: hp,
      isElite: false,
      difficulty: d,
      faction: "gloam",
    };
    w.threatLevel = Math.min(100, w.threatLevel + 3);
    w.searchProgress = 0;
  }

  /** Append a story line with the arc/chapter prefix. Public so the runtime
   * can surface template-firing deeds through the same story channel
   * (no fabricated GameResults for template firings). */
  pushStory(msg: string): void {
    if (!msg) return;
    this.storyLog.unshift(`[Arc ${this.world.currentArc}·Ch ${this.world.currentChapter}] ${msg}`);
    this.storyLog = this.storyLog.slice(0, 40);
  }
}
