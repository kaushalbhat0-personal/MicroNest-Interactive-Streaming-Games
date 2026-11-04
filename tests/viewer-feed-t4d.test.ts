/**
 * T4D — viewer feed, aggregation, banner queue, HP chips, cooldown hints.
 * Pure + store tests over authoritative GameResults (never raw chat).
 * Privacy: no actorId/yt/platform/amount/payer/internal ids in output.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMANDS, QUEUE, SIM } from "../src/engine/config";
import { GameEngine } from "../src/engine/engine";
import { tideboundGenesis, KINDLING_VOTE, ROUTE_VOTE, TIDEBOUND_LIBRARY } from "../src/content/tidebound";
import { castSessionVote, closeSessionVote, openSessionVote, openStream } from "../src/engine/lifecycle";
import type { GameResult, WorldState } from "../src/engine/types";
import { renderOverlay } from "../src/presentation/hud";
import { voteModel } from "../src/presentation/tidebound-presentation";
import {
  aggregateFeedItems,
  bannerForResult,
  BannerQueue,
  BANNER_HOLD_MS,
  BANNER_MAX_PENDING,
  buildViewerFeedItem,
  cooldownHints,
  GROUP_WINDOW_MS,
  hpChipModels,
  ViewerFeedStore,
  VISIBLE_LANDSCAPE,
  VISIBLE_PORTRAIT,
  type ViewerFeedItem,
  type VoteFeedCtx,
} from "../src/presentation/viewer-feed";

const T0 = 1_000_000;

function harness() {
  let t = T0;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  const engine = new GameEngine({ now }, tideboundGenesis(new Date(t).toISOString()));
  const drain = () => {
    const out: GameResult[] = [];
    for (let i = 0; i < 500 && engine.queue.size > 0; i++) {
      advance(QUEUE.minGapMs + 50);
      out.push(...engine.pump());
    }
    return out;
  };
  return { engine, drain, advance, now };
}

function voteCtxFor(world: WorldState, sessionBallots: Record<string, number>, phase: VoteFeedCtx["phase"], totalBallots: number, labels: string[]): VoteFeedCtx {
  return {
    phase,
    totalBallots,
    ballots: sessionBallots,
    options: labels.map((label, i) => ({ label, command: `!vote${"ABC"[i]}` })),
  };
}

function openedSession() {
  const r = openStream(tideboundGenesis());
  if (!r.ok) throw new Error("expected open");
  return r.session;
}

function render(input: Parameters<typeof renderOverlay>[1]): string {
  const el = { innerHTML: "" } as unknown as HTMLElement;
  renderOverlay(el, input);
  return el.innerHTML;
}

function countOccurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// TASK A — authoritative mapping
// ---------------------------------------------------------------------------

describe("T4D-A — accepted command mapping", () => {
  it("maps !strike to struck + actual enemy + actual HP", () => {
    const { engine, drain } = harness();
    engine.ingestCommand("u1", "Kaushal", "!strike", "e1");
    const [r] = drain();
    expect(r.action).toBe("attack");
    const item = buildViewerFeedItem(r, { world: engine.world, at: T0 })!;
    expect(item.actor).toBe("Kaushal");
    expect(item.verb).toBe("struck");
    expect(item.target).toContain("Gloam Vessel");
    expect(item.outcome).toContain("decreased");
    expect(item.delta).toBe(`Vessel ${engine.world.enemy.hp}/${engine.world.enemy.maxHp}`);
    expect(item.status).toBe("applied");
  });

  it("maps killing blow to repelled (never invented supplies)", () => {
    const { engine, drain } = harness();
    engine.world.enemy.hp = SIM.attackDamage;
    engine.ingestCommand("u1", "Kai", "!strike", "ek");
    const [r] = drain();
    expect(r.visual.spawnWave).toBe(true);
    const item = buildViewerFeedItem(r, { world: engine.world, at: T0 })!;
    expect(item.outcome).toContain("repelled");
    expect(item.delta).toContain("0/");
    expect(item.status).toBe("applied");
  });

  it("maps !mend to restored + actual Keeper HP (after-value only, no fabricated gain)", () => {
    const { engine, drain } = harness();
    engine.world.heroHp = 50;
    engine.ingestCommand("u1", "ViewerTwo", "!mend", "e2");
    drain();
    const item = buildViewerFeedItem(engine.recentResults[0], { world: engine.world, at: T0 })!;
    expect(item.verb).toBe("restored");
    expect(item.delta).toBe(`Keeper ${engine.world.heroHp}/${engine.world.maxHeroHp}`);
    // Clamped heal: after-value truth, never a +12 claim when only +4 landed.
    engine.world.heroHp = 96;
    engine.ingestCommand("u2", "B", "!mend", "e3");
    drain();
    const clamped = buildViewerFeedItem(engine.recentResults[0], { world: engine.world, at: T0 })!;
    expect(clamped.delta).toBe(`Keeper 100/${engine.world.maxHeroHp}`);
    expect(clamped.outcome).not.toContain("+12");
  });

  it("maps !scout new vs duplicate via visual.discovery", () => {
    const { engine, drain, advance } = harness();
    engine.ingestCommand("s1", "ViewerFour", "!scout", "sc1");
    drain();
    const fresh = buildViewerFeedItem(engine.recentResults[0], { world: engine.world, at: T0 })!;
    expect(fresh.verb).toBe("scouted");
    expect(fresh.delta).toContain("charts");
    advance(11_000);
    engine.ingestCommand("s1", "ViewerFour", "!scout", "sc2");
    drain();
    const dup = buildViewerFeedItem(engine.recentResults[0], { world: engine.world, at: T0 })!;
    expect(dup.outcome).toContain("already charted");
  });

  it("maps !shield to ward with authoritative 12s duration", () => {
    const { engine, drain } = harness();
    engine.ingestCommand("u1", "ViewerThree", "!shield", "sh1");
    drain();
    const item = buildViewerFeedItem(engine.recentResults[0], { world: engine.world, at: T0 })!;
    expect(item.verb).toBe("protected");
    expect(item.outcome).toContain(`${Math.round(SIM.shieldDurationMs / 1000)}s`);
  });

  it("maps !ring/!hide to actual threat/resolve snapshots", () => {
    const { engine, drain, advance } = harness();
    engine.ingestCommand("u1", "Kai", "!ring", "r1");
    drain();
    const ring = buildViewerFeedItem(engine.recentResults[0], { world: engine.world, at: T0 })!;
    expect(ring.delta).toContain(`threat ${engine.world.threatLevel}`);
    advance(9000);
    engine.ingestCommand("u2", "Rho", "!hide", "h1");
    drain();
    const hide = buildViewerFeedItem(engine.recentResults[0], { world: engine.world, at: T0 })!;
    expect(hide.delta).toContain("threat");
    expect(hide.delta).toContain("resolve");
  });

  it("maps !tribute/!defy applied + rejected-effect (still visible, muted)", () => {
    const { engine, drain } = harness();
    engine.world.resources = 20;
    engine.ingestCommand("u1", "Ash", "!tribute", "t1");
    drain();
    const ok = buildViewerFeedItem(engine.recentResults[0], { world: engine.world, at: T0 })!;
    expect(ok.status).toBe("applied");
    expect(ok.delta).toContain("standing");
    engine.world.resources = 3;
    engine.ingestCommand("u2", "Ash", "!tribute", "t2");
    drain();
    const poor = buildViewerFeedItem(engine.recentResults[0], { world: engine.world, at: T0 })!;
    expect(poor.status).toBe("rejected-effect");
    expect(poor.outcome).toContain("5 supplies");
    engine.world.enemy.faction = "";
    engine.ingestCommand("u3", "Ash", "!defy", "d1");
    drain();
    const noFac = buildViewerFeedItem(engine.recentResults[0], { world: engine.world, at: T0 })!;
    expect(noFac.status).toBe("rejected-effect");
    expect(noFac.outcome).toContain("no faction");
  });

  it("maps !help as low-priority applied deed", () => {
    const { engine, drain } = harness();
    engine.ingestCommand("u1", "Sam", "!help", "help1");
    drain();
    const item = buildViewerFeedItem(engine.recentResults[0], { world: engine.world, at: T0 })!;
    expect(item.verb).toBe("asked");
    expect(item.status).toBe("applied");
  });

  it("maps all three vote tokens via the private ballot map (!voteC preserved)", () => {
    const { engine, drain } = harness();
    const stream = openStream(engine.world);
    if (!stream.ok) throw new Error("open");
    let session = stream.session;
    const v = openSessionVote(session, { ...KINDLING_VOTE, library: TIDEBOUND_LIBRARY });
    if (!v.ok) throw new Error("vote open");
    session = v.session;
    const m = voteModel(session, engine.world, TIDEBOUND_LIBRARY);
    expect(m.options[2].command).toBe("!voteC");
    // Three ballots, one per option (latest-wins per actor).
    for (const [actor, idx] of [["a", 0], ["b", 1], ["c", 2]] as const) {
      const casted = castSessionVote(session, actor, idx);
      if (!casted.ok) throw new Error("cast");
      session = casted.session;
    }
    const m2 = voteModel(session, engine.world, TIDEBOUND_LIBRARY);
    const ctx = voteCtxFor(engine.world, { ...session.activeVote!.ballots }, "open", m2.totalBallots, m2.options.map((o) => o.label));
    for (const [actor, name] of [["a", "Ann"], ["b", "Bo"], ["c", "Cy"]] as const) {
      engine.ingestCommand(actor, name, actor === "a" ? "!voteA" : actor === "b" ? "!voteB" : "!voteC", `v-${actor}`);
    }
    const results = drain();
    expect(results).toHaveLength(3);
    const items = results.map((r) => buildViewerFeedItem(r, { world: engine.world, vote: ctx, at: T0 })!);
    expect(items.every((i) => i.verb === "voted" && i.status === "applied")).toBe(true);
    expect(items.every((i) => i.outcome.includes("voices"))).toBe(true);
  });

  it("vote with no open assembly renders muted rejected-effect", () => {
    const { engine, drain } = harness();
    engine.ingestCommand("u1", "Rin", "!voteA", "vx");
    drain();
    const item = buildViewerFeedItem(engine.recentResults[0], { world: engine.world, vote: null, at: T0 })!;
    expect(item.verb).toBe("voted");
    expect(item.status).toBe("rejected-effect");
    expect(item.outcome).toContain("not been called");
  });
});

describe("T4D-A — fallback, privacy, paid fiction, muted", () => {
  it("falls back to A watcher (blank / yt: / channel-id)", () => {
    const world = tideboundGenesis();
    const mk = (actorName: string): GameResult => ({ eventId: "x", action: "attack", summary: "s", actorName, storyMessages: [], visual: { hitEnemy: true } });
    expect(buildViewerFeedItem(mk(""), { world, at: 1 })!.actor).toBe("A watcher");
    expect(buildViewerFeedItem(mk("   "), { world, at: 1 })!.actor).toBe("A watcher");
    expect(buildViewerFeedItem(mk("yt:UC12345678901234567890"), { world, at: 1 })!.actor).toBe("A watcher");
    expect(buildViewerFeedItem(mk("UCabcdefghijklmnopqrstuv"), { world, at: 1 })!.actor).toBe("A watcher");
  });

  it("exposes no actorId/yt/platform/amount/chat/internal ids", () => {
    const { engine, drain } = harness();
    engine.ingestPaid("yt:UC-DONOR", "Donor", 75000, "INR", "P-1");
    engine.ingestCommand("yt:UC-XYZ", "SomeViewer", "!strike", "cmd-1");
    drain();
    for (const r of engine.recentResults) {
      const item = buildViewerFeedItem(r, { world: engine.world, at: T0 });
      if (!item) continue;
      expect("actorId" in item).toBe(false);
      // id is an internal dedupe key only (never rendered to DOM — the
      // render integration test below asserts the HTML carries no yt:).
      const { id: _id, ...rendered } = item;
      const blob = JSON.stringify(rendered);
      for (const leak of ["yt:", "UC-DONOR", "UC-XYZ", "75000", "INR", "Donor", "platformEventId", "meter.", "c.vex", "opcode"]) {
        expect(blob).not.toContain(leak);
      }
    }
  });

  it("paid uses fictional labels only (Someone, never payer/amount)", () => {
    const { engine, drain } = harness();
    const tiers: Array<[number, string]> = [[5000, "paid_strike"], [15000, "paid_supply"], [75000, "paid_elite"], [150000, "paid_story"]];
    for (const [amount, key] of tiers) {
      engine.ingestPaid("donor-id", "Rich Donor", amount, "INR", `P-${key}`);
    }
    drain();
    const actions = engine.recentResults.map((r) => r.action);
    for (const [, key] of tiers) expect(actions).toContain(key);
    for (const r of engine.recentResults.filter((r) => r.action.startsWith("paid_"))) {
      const item = buildViewerFeedItem(r, { world: engine.world, at: T0 })!;
      expect(item.actor).toBe("Someone");
      const { id: _id, at: _at, ...rendered } = item;
      const blob = JSON.stringify(rendered);
      expect(blob).not.toContain("Rich Donor");
      for (const amt of ["5000", "15000", "75000", "150000"]) expect(blob).not.toContain(amt);
      expect(blob).not.toContain("INR");
    }
  });

  it("suppresses duplicates + world noise; mutes cooldown (never a deed)", () => {
    const world = tideboundGenesis();
    const dup: GameResult = { eventId: "d", action: "duplicate", summary: "x", actorName: "A", storyMessages: [], visual: {} };
    const tick: GameResult = { eventId: "tick-1", action: "rejected", summary: "world noise", actorName: "world", storyMessages: [], visual: {} };
    expect(buildViewerFeedItem(dup, { world, at: 1 })).toBeNull();
    expect(buildViewerFeedItem(tick, { world, at: 1 })).toBeNull();
    const cd: GameResult = { eventId: "c", action: "cooldown", summary: "Kaushal: !strike is on cooldown.", actorName: "Kaushal", actorId: "u1", storyMessages: [], visual: {} };
    const muted = buildViewerFeedItem(cd, { world, at: 1 })!;
    expect(muted.status).toBe("cooldown");
    expect(muted.outcome).toContain("3s");
    expect(muted.verb).not.toBe("struck");
  });
});

// ---------------------------------------------------------------------------
// TASK B — aggregation
// ---------------------------------------------------------------------------

function feedItem(id: string, actor: string, action: ViewerFeedItem["action"], verb: string, target: string, outcome: string, at: number, status: ViewerFeedItem["status"] = "applied", delta?: string): ViewerFeedItem {
  return { id, actor, verb, target, outcome, delta, kind: "action", action, at, status };
}

describe("T4D-B — rapid-event aggregation", () => {
  it(`groups >3 same-verb in ${GROUP_WINDOW_MS}ms into +N others`, () => {
    const items = [0, 1, 2, 3, 4].map((i) =>
      feedItem(`e${i}`, `V${i}`, "attack", "struck", "the Gloam Vessel", "enemy health decreased", T0 - i * 200, "applied", "Vessel 40/60"),
    );
    const agg = aggregateFeedItems(items, VISIBLE_LANDSCAPE);
    expect(agg.rows).toHaveLength(1);
    const row = agg.rows[0];
    expect(row.kind).toBe("group");
    if (row.kind !== "group") throw new Error("group");
    expect(row.count).toBe(5);
    expect(row.leadActor).toBe("V0");
    expect(row.othersCount).toBe(4);
    expect(row.items).toHaveLength(5);
    expect(row.items.map((m) => m.actor)).toEqual(["V0", "V1", "V2", "V3", "V4"]);
  });

  it("does not group 3 or fewer, different actions, or different targets", () => {
    const three = [0, 1, 2].map((i) => feedItem(`t${i}`, `V${i}`, "attack", "struck", "the Gloam Vessel", "o", T0 - i * 100));
    expect(aggregateFeedItems(three, 5).rows).toHaveLength(3);
    const mixed = [
      feedItem("a", "A", "attack", "struck", "the Gloam Vessel", "o", T0),
      feedItem("b", "B", "heal", "restored", "the Keeper's crew", "o", T0),
    ];
    expect(aggregateFeedItems(mixed, 5).rows).toHaveLength(2);
    const targets = [
      feedItem("a", "A", "attack", "struck", "the Gloam Vessel", "o", T0),
      feedItem("b", "B", "attack", "struck", "the Pale Reaches", "o", T0),
      feedItem("c", "C", "attack", "struck", "the Gloam Vessel", "o", T0),
      feedItem("d", "D", "attack", "struck", "the Gloam Vessel", "o", T0),
    ];
    // Non-consecutive same-target runs of <4 stay single (no misleading merge).
    expect(aggregateFeedItems(targets, 5).rows.every((r) => r.kind === "single")).toBe(true);
  });

  it("respects the grouping window and never groups decisive/rare kinds", () => {
    const spread = [0, 1, 2, 3].map((i) => feedItem(`s${i}`, `V${i}`, "attack", "struck", "T", "o", T0 - i * 1000));
    // Span 3000ms > window: newest + next form a run of 2 only.
    expect(aggregateFeedItems(spread, 5).rows.every((r) => r.kind === "single")).toBe(true);
    for (const action of ["paid_story", "paid_elite", "help", "rejected", "cooldown"] as const) {
      const items = [0, 1, 2, 3].map((i) => feedItem(`${action}${i}`, "S", action, "v", "T", "o", T0 - i * 50, action === "cooldown" ? "cooldown" : action === "rejected" ? "rejected-effect" : "applied"));
      expect(aggregateFeedItems(items, 5).rows.every((r) => r.kind === "single")).toBe(true);
    }
  });

  it("mixed outcomes reuse nothing falsely (generic outcome + newest delta)", () => {
    const items = [
      feedItem("a", "A", "attack", "struck", "T", "repelled — the light holds", T0, "applied", "Vessel 0/60"),
      feedItem("b", "B", "attack", "struck", "T", "enemy health decreased", T0 - 100, "applied", "Vessel 40/60"),
      feedItem("c", "C", "attack", "struck", "T", "enemy health decreased", T0 - 200, "applied", "Vessel 47/60"),
      feedItem("d", "D", "attack", "struck", "T", "enemy health decreased", T0 - 300, "applied", "Vessel 53/60"),
    ];
    const agg = aggregateFeedItems(items, 5);
    const row = agg.rows[0];
    if (row.kind !== "group") throw new Error("group");
    expect(row.outcome).toBe("acts shape the tide");
    expect(row.delta).toBe("Vessel 0/60");
  });

  it("bounds history at 30 with id dedupe", () => {
    const store = new ViewerFeedStore(() => T0);
    const world = tideboundGenesis();
    for (let i = 0; i < 40; i++) {
      store.push({ eventId: `e${i}`, action: "attack", summary: "s", actorName: `V${i}`, actorId: `u${i}`, storyMessages: [], visual: { hitEnemy: true } }, { world });
    }
    expect(store.list()).toHaveLength(30);
    const before = store.list().length;
    store.push({ eventId: "e39", action: "attack", summary: "s", actorName: "Dup", actorId: "ux", storyMessages: [], visual: {} }, { world });
    expect(store.list()).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// TASK C — banner queue
// ---------------------------------------------------------------------------

describe("T4D-C — event banner queue", () => {
  it("maps all ten categories from authoritative signals", () => {
    const world = tideboundGenesis();
    const at = T0;
    const heal: GameResult = { eventId: "h", action: "heal", summary: "s", actorName: "A", storyMessages: [], visual: { healHero: true } };
    expect(bannerForResult(heal, world, at)?.category).toBe("keeper-healing");
    const ward: GameResult = { eventId: "w", action: "shield", summary: "s", actorName: "A", storyMessages: [], visual: { shieldKeep: true } };
    expect(bannerForResult(ward, world, at)?.category).toBe("ward");
    const supply: GameResult = { eventId: "ps", action: "paid_supply", summary: "s", actorName: "S", storyMessages: [], visual: { shieldKeep: true } };
    expect(bannerForResult(supply, world, at)).toBeNull();
    const elite: GameResult = { eventId: "e", action: "paid_elite", summary: "s", actorName: "S", storyMessages: [], visual: { spawnElite: true } };
    expect(bannerForResult(elite, world, at)?.category).toBe("elite-arrival");
    const strike: GameResult = { eventId: "p", action: "paid_strike", summary: "s", actorName: "S", storyMessages: [], visual: { hitEnemy: true } };
    expect(bannerForResult(strike, world, at)?.category).toBe("major-hit");
    const killWorld = { ...world, enemy: { ...world.enemy, hp: 0 } };
    const kill: GameResult = { eventId: "k", action: "attack", summary: "s", actorName: "A", storyMessages: [], visual: { hitEnemy: true, spawnWave: true } };
    expect(bannerForResult(kill, killWorld, at)?.category).toBe("repelled");
    const story: GameResult = { eventId: "m", action: "paid_story", summary: "s", actorName: "S", storyMessages: ["The bell tolls over the drowned city."], visual: { majorStory: true } };
    const storyBanner = bannerForResult(story, world, at)!;
    expect(storyBanner.category).toBe("story-beat");
    expect(storyBanner.sub.length).toBeLessThanOrEqual(90);
    const waveMsg: GameResult = { eventId: "wv", action: "attack", summary: "s", actorName: "A", storyMessages: ["A new wave gathers beyond the reef."], visual: { hitEnemy: true } };
    expect(bannerForResult(waveMsg, world, at)?.category).toBe("wave-progression");
    expect(bannerForResult({ eventId: "x", action: "help", summary: "s", actorName: "A", storyMessages: [], visual: {} }, world, at)).toBeNull();
    expect(bannerForResult({ eventId: "y", action: "cooldown", summary: "s", actorName: "A", storyMessages: [], visual: {} }, world, at)).toBeNull();
  });

  it("orders pending by explicit priority, dedupes, bounds overflow", () => {
    let t = T0;
    const q = new BannerQueue(() => t);
    const mk = (id: string, category: Parameters<typeof bannerForResult>[0] extends never ? never : import("../src/presentation/viewer-feed").BannerCategory, priority: number) =>
      ({ id, category, title: id, sub: id, at: t, priority });
    q.enqueue(mk("low", "wave-progression", 30));
    q.enqueue(mk("high", "vote-result", 100));
    q.enqueue(mk("mid", "keeper-healing", 50));
    expect(q.pendingCount()).toBe(3);
    expect(q.enqueue(mk("high", "vote-result", 100))).toBe(false);
    expect(q.current()?.id).toBe("high");
    t += BANNER_HOLD_MS + 1;
    expect(q.current()?.id).toBe("mid");
    t += BANNER_HOLD_MS + 1;
    expect(q.current()?.id).toBe("low");
    // Overflow: bounded to BANNER_MAX_PENDING, lowest dropped.
    const q2 = new BannerQueue(() => T0);
    (["wave-progression", "vote-opening", "ward", "keeper-healing", "major-hit"] as const).forEach((c, i) =>
      q2.enqueue({ id: `b${i}`, category: c, title: c, sub: c, at: T0, priority: [30, 40, 45, 50, 60][i] }),
    );
    expect(q2.pendingCount()).toBe(BANNER_MAX_PENDING);
  });

  it("never repeats on polling/sync and drops stale on reset", () => {
    let t = T0;
    const q = new BannerQueue(() => t);
    const w1 = { ...tideboundGenesis(), waveNumber: 1 };
    const w2 = { ...w1, waveNumber: 2 };
    q.syncWorld(w1, "quiet");
    q.syncWorld(w1, "quiet");
    expect(q.pendingCount()).toBe(0);
    q.syncWorld(w2, "quiet");
    expect(q.pendingCount()).toBe(1);
    q.syncWorld(w2, "quiet");
    expect(q.pendingCount()).toBe(1);
    expect(q.current()?.category).toBe("enemy-arrival");
    q.clear();
    expect(q.current()).toBeNull();
    expect(q.pendingCount()).toBe(0);
    q.syncWorld(w2, "quiet");
    expect(q.pendingCount()).toBe(0);
  });

  it("vote open/result banners are short (never the full card)", () => {
    let t = T0;
    const q = new BannerQueue(() => t);
    const session = openedSession();
    const open = openSessionVote(session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!open.ok) throw new Error("open");
    const m = voteModel(open.session, tideboundGenesis(), TIDEBOUND_LIBRARY);
    q.syncVote({ phase: "none", id: null, prompt: "", options: [], winnerLabel: null, winnerReason: null }, session.sessionId);
    q.syncVote({ phase: m.phase, id: m.id, prompt: m.prompt, options: m.options.map((o) => ({ label: o.label, command: o.command })), winnerLabel: m.winnerLabel, winnerReason: m.winnerReason }, open.session.sessionId);
    const opening = q.current()!;
    expect(opening.category).toBe("vote-opening");
    expect(opening.sub).toContain("!voteA");
    let s = open.session;
    const c = castSessionVote(s, "v1", 1);
    if (!c.ok) throw new Error("cast");
    s = c.session;
    const closed = closeSessionVote(s);
    if (!closed.ok) throw new Error("close");
    t += BANNER_HOLD_MS + 1;
    const m2 = voteModel(closed.session, tideboundGenesis(), TIDEBOUND_LIBRARY);
    q.syncVote({ phase: m2.phase, id: m2.id, prompt: m2.prompt, options: m2.options.map((o) => ({ label: o.label, command: o.command })), winnerLabel: m2.winnerLabel, winnerReason: m2.winnerReason }, closed.session.sessionId);
    const result = q.current()!;
    expect(result.category).toBe("vote-result");
    expect(result.sub.length).toBeLessThanOrEqual(90);
    expect(result.sub).not.toContain("voice");
  });
});

// ---------------------------------------------------------------------------
// TASK D/E — HP chips + cooldown hints
// ---------------------------------------------------------------------------

describe("T4D-D — HP chips reflect authoritative values", () => {
  it("shows Keeper/Keep/Vessel with status words (never color-alone)", () => {
    const chips = hpChipModels(tideboundGenesis());
    expect(chips.map((c) => c.key)).toEqual(["keeper", "keep", "vessel"]);
    const sunk = hpChipModels({ ...tideboundGenesis(), enemy: { ...tideboundGenesis().enemy, hp: 0 } });
    expect(sunk[2].status).toBe("repelled");
    const low = hpChipModels({ ...tideboundGenesis(), heroHp: 10, keepHp: 5 });
    expect(low[0].status).toBe("low");
    expect(low[1].status).toBe("low");
    const elite = hpChipModels({ ...tideboundGenesis(), enemy: { ...tideboundGenesis().enemy, hp: 110, maxHp: 110, isElite: true } });
    expect(elite[2].status).toBe("elite");
    for (const c of chips) expect(c.aria).toContain(c.label);
  });
});

describe("T4D-E — cooldown hints use configured values (no countdown)", () => {
  it("covers all 12 commands with exact Ns durations", () => {
    const hints = cooldownHints();
    expect(hints).toHaveLength(12);
    const byCmd = new Map(hints.map((h) => [h.command, h.seconds]));
    expect(byCmd.get("!strike")).toBe(3);
    expect(byCmd.get("!mend")).toBe(5);
    expect(byCmd.get("!voteA")).toBe(5);
    expect(byCmd.get("!voteB")).toBe(5);
    expect(byCmd.get("!voteC")).toBe(5);
    for (const [key, entry] of Object.entries(COMMANDS)) {
      const display = key === "!votea" ? "!voteA" : key === "!voteb" ? "!voteB" : key === "!votec" ? "!voteC" : key;
      expect(byCmd.get(display)).toBe(Math.ceil(entry.cooldownMs / 1000));
    }
  });
});

// ---------------------------------------------------------------------------
// Motion / privacy / render integration
// ---------------------------------------------------------------------------

describe("T4D-FG — motion budgets hold without animation coupling", () => {
  it("banner hold is timestamp-based (5s, independent of animation)", () => {
    expect(BANNER_HOLD_MS).toBe(5000);
    let t = T0;
    const q = new BannerQueue(() => t);
    q.enqueue({ id: "b", category: "ward", title: "Ward up", sub: "holds", at: t, priority: 45 });
    expect(q.current()?.id).toBe("b");
    t += 4999;
    expect(q.current()?.id).toBe("b");
    t += 2;
    expect(q.current()).toBeNull();
  });

  it("reduced-motion CSS kills animation system-wide", () => {
    const css = readFileSync(new URL("../src/presentation/tidebound.css", import.meta.url), "utf8");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("animation: none");
  });
});

describe("T4D-H — overlay render integration", () => {
  it("landscape shows 5 rows, portrait 3, with aggregation + overflow + banner slot rules", () => {
    const { engine, drain } = harness();
    const actors = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const cmds = ["!strike", "!mend", "!shield", "!ring", "!hide", "!scout", "!defy", "!help"] as const;
    actors.forEach((a, i) => engine.ingestCommand(`u${i}`, a, cmds[i], `e${i}`));
    drain();
    const session = openedSession();
    const land = render({ world: engine.world, session, storyLog: ["Tide"], feed: [], recent: engine.recentResults, paused: false, format: "landscape" });
    expect(countOccurrences(land, "tb-feed-item")).toBe(VISIBLE_LANDSCAPE);
    expect(land).toContain("+3 more acts");
    expect(land).toContain("(3s)");
    expect(land).toContain("Keeper");
    const port = render({ world: engine.world, session, storyLog: ["Tide"], feed: [], recent: engine.recentResults, paused: false, format: "portrait" });
    expect(countOccurrences(port, "tb-feed-item")).toBe(VISIBLE_PORTRAIT);
    // Portrait: vex merges into banner — no standalone vex card restored.
    expect(port).not.toContain("tb-vexwrap");
    expect(port).toContain("tb-banner-slot");
  });

  it("burst collapses to +N others without misattribution", () => {
    const { engine, drain } = harness();
    for (let i = 0; i < 5; i++) engine.ingestCommand(`u${i}`, `V${i}`, "!mend", `m${i}`);
    // Same-tick burst: identical stamps force the grouping window.
    const world = engine.world;
    const recent = drain();
    expect(recent.filter((r) => r.action === "heal")).toHaveLength(5);
    const store = new ViewerFeedStore(() => T0);
    for (const r of recent) store.push(r, { world });
    const session = openedSession();
    const html = render({ world, session, storyLog: [], feed: [], recent, paused: false, format: "landscape", viewerFeedItems: store.list() });
    expect(html).toContain("+4 others");
    expect(html).toContain("tb-feed-aggregate");
  });

  it("banner renders assertive once, vote verdict stays on the card", () => {
    const session = openedSession();
    const html = render({
      world: tideboundGenesis(), session, storyLog: [], feed: [], recent: [], paused: false, format: "landscape",
      banner: { id: "b1", category: "vote-result", title: "The assembly has spoken", sub: "chose Parley", at: T0, priority: 100 },
    });
    expect(html).toContain("tb-banner");
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain("The assembly has spoken");
  });

  it("rendered HTML leaks no identities, amounts, or internals", () => {
    const { engine, drain } = harness();
    engine.ingestPaid("yt:UC-D", "Donor", 75000, "INR", "P-1");
    engine.ingestCommand("yt:UC-X", "SomeViewer", "!strike", "e1");
    drain();
    const session = openedSession();
    for (const format of ["landscape", "portrait"] as const) {
      const html = render({ world: engine.world, session, storyLog: engine.storyLog, feed: [], recent: engine.recentResults, paused: false, format });
      for (const leak of ["yt:UC", "platformEventId", "75000", "Donor", "actorId", "opcode", "c.vex.met", "meter.pale"]) {
        expect(html).not.toContain(leak);
      }
      expect(html).toContain('aria-label="Tidebound live overlay"');
    }
  });
});
