import { describe, expect, it } from "vitest";
import { QUEUE } from "../src/engine/config";
import { GameEngine } from "../src/engine/engine";
import {
  closeStreamAndFire,
  contributeForCommand,
  evaluateStreamMoment,
  evaluateThresholds,
  fireRite,
  handleProcessedResult,
  isPaidResult,
  isProgressableResult,
  newDeedsSince,
  noteVoteCommandAndMaybeFire,
  openStreamAndFire,
  overrideVoteAndFire,
  resolveAndFireVote,
  closeVoteAndFire,
  thresholdContext,
} from "../src/runtime/progression";
import { snapshotCounters } from "../src/engine/predicates";
import {
  castSessionVote,
  openSessionVote,
  openStream,
  type StreamSession,
} from "../src/engine/lifecycle";
import { deserialize, serialize } from "../src/persistence/store";
import { fireTemplate } from "../src/engine/templates";
import {
  KINDLING_VOTE,
  MANUAL_RITES,
  ROUTE_VOTE,
  TIDEBOUND_LIBRARY,
  tideboundGenesis,
} from "../src/content/tidebound";
import type { CanonicalEvent, GameResult, WorldState } from "../src/engine/types";

/** Deterministic engine + session harness. Every pumped result is routed
 *  through handleProcessedResult exactly the way app.ts wires onResult. */
function harness() {
  let t = 1_000_000;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  const engine = new GameEngine({ now }, tideboundGenesis(new Date(t).toISOString()));
  const opened = openStream(engine.world);
  if (!opened.ok) throw new Error(opened.reason);
  let session = opened.session;
  const fired: Array<{ action: string; fired: string | null }> = [];
  const drain = () => {
    const out = [];
    for (let i = 0; i < 500 && engine.queue.size > 0; i++) {
      advance(QUEUE.minGapMs + 50);
      for (const r of engine.pump()) {
        const h = handleProcessedResult(engine, session, r, TIDEBOUND_LIBRARY);
        session = h.session;
        fired.push({ action: r.action, fired: h.fired });
        out.push(r);
      }
    }
    return out;
  };
  return {
    engine,
    drain,
    advance,
    fired,
    get session() {
      return session;
    },
    setSession(s: StreamSession) {
      session = s;
    },
  };
}

function openVote(session: StreamSession, vote: { id: string; options: readonly string[]; maxCommands: number }) {
  const r = openSessionVote(session, { ...vote, library: TIDEBOUND_LIBRARY });
  if (!r.ok) throw new Error(r.reason);
  return r.session;
}

function castAll(session: StreamSession, ballots: Array<[string, number]>) {
  let s = session;
  for (const [actor, idx] of ballots) {
    const r = castSessionVote(s, actor, idx);
    if (!r.ok) throw new Error(r.reason);
    s = r.session;
  }
  return s;
}

function retractionEv(ref: string, signalId = `RT-${ref}`): CanonicalEvent {
  return {
    kind: "paid_retraction",
    eventId: `yt:retraction:${ref}`,
    refPlatformId: ref,
    platformEventId: signalId,
    source: "youtube",
    receivedAt: new Date(1_000_000).toISOString(),
  } as CanonicalEvent;
}

function fakeResult(over: Partial<GameResult>): GameResult {
  return {
    eventId: "ev-1",
    action: "attack",
    summary: "x",
    actorName: "viewer",
    storyMessages: [],
    visual: {},
    ...over,
  };
}

// ---------------------------------------------------------------------------
// §21 gating + helper contracts
// ---------------------------------------------------------------------------

describe("5G-7 — result gating and helpers", () => {
  it("isProgressableResult / isPaidResult classify every engine result kind", () => {
    expect(isProgressableResult(fakeResult({ action: "attack", actorName: "u1" }))).toBe(true);
    expect(isProgressableResult(fakeResult({ action: "cooldown", actorName: "u1" }))).toBe(true);
    expect(isProgressableResult(fakeResult({ action: "rejected", actorName: "u1" }))).toBe(true);
    expect(isProgressableResult(fakeResult({ action: "paid_strike", actorName: "Donor" }))).toBe(true);
    expect(isPaidResult(fakeResult({ action: "paid_strike", actorName: "Donor" }))).toBe(true);
    expect(isPaidResult(fakeResult({ action: "attack", actorName: "u1" }))).toBe(false);
    expect(isProgressableResult(fakeResult({ action: "rejected", actorName: "world" }))).toBe(false);
    expect(isProgressableResult(fakeResult({ action: "rejected", actorName: "x", eventId: "tick-1" }))).toBe(false);
  });

  it("newDeedsSince diffs the tail and degrades safely", () => {
    const base = tideboundGenesis("2026-11-03T00:00:00.000Z");
    const after = { ...base, deeds: [...base.deeds, "a", "b"] };
    expect(newDeedsSince(base, after)).toEqual(["a", "b"]);
    expect(newDeedsSince(base, { ...base })).toEqual([]);
    expect(newDeedsSince(after, base)).toEqual([]);
  });

  it("thresholdContext carries the full shared counter vocabulary", () => {
    const ctx = thresholdContext(tideboundGenesis("2026-11-03T00:00:00.000Z"));
    expect(ctx.kind).toBe("threshold");
    expect(ctx.counterValues).toMatchObject({ threatLevel: 10, scouts: 0, streamCount: 0 });
    expect(typeof ctx.counterValues!["kills"]).toBe("number");
  });

  it("snapshotCounters covers core, event, and meter counters; omits unknown and corrupt values", () => {
    const base = tideboundGenesis("2026-11-03T00:00:00.000Z");
    const w: WorldState = {
      ...base,
      eventCounters: { attacks: 4, "meter.pale-chart": 3, "meter.beacon-oil": "x" as unknown as number },
    };
    const s = snapshotCounters(w);
    expect(s.attacks).toBe(4);
    expect(s["meter.pale-chart"]).toBe(3);
    expect(s.scouts).toBe(0);
    expect(s.threatLevel).toBe(10);
    expect(s.resources).toBe(20);
    expect("meter.beacon-oil" in s).toBe(false); // corrupt value omitted, not zeroed
  });
});

// ---------------------------------------------------------------------------
// §21 threshold evaluation
// ---------------------------------------------------------------------------

describe("5G-7 — threshold evaluation", () => {
  it("genesis world matches nothing and the world object is untouched", () => {
    const { engine } = harness();
    const before = engine.world;
    const r = evaluateThresholds(before, TIDEBOUND_LIBRARY);
    expect(r.fired).toBeNull();
    expect(r.newDeeds).toEqual([]);
    expect(r.world).toBe(before);
  });

  it("invalid library fails closed without touching the world", () => {
    const { engine } = harness();
    const before = engine.world;
    const r = evaluateThresholds(before, null);
    expect(r.fired).toBeNull();
    expect(typeof r.reason).toBe("string");
    expect(r.world).toBe(before);
  });

  it("wren-chart-room fires at five scouts with deed and chapter advance", () => {
    const { engine } = harness();
    engine.world.uniqueSearchers = ["a", "b", "c", "d", "e"];
    const r = evaluateThresholds(engine.world, TIDEBOUND_LIBRARY);
    expect(r.fired).toBe("wren-chart-room");
    expect(r.world.currentChapter).toBe(2);
    expect(r.world.storyFlags["chart-pale-ready"]).toBe(true);
    expect(r.newDeeds).toHaveLength(1);
    expect(r.newDeeds[0]).toContain("Wren");
  });

  it("weight order wins among multiple matches, one firing only", () => {
    const { engine } = harness();
    const w = engine.world;
    w.storyFlags["chart-pale-ready"] = true;
    w.threatLevel = 65;
    w.eventCounters["elite_arrivals"] = 1;
    // vex-raid (8) outranks pale-reaches-storm (7); both conditions hold.
    const r1 = evaluateThresholds(w, TIDEBOUND_LIBRARY);
    expect(r1.fired).toBe("vex-raid");
    expect(r1.world.locationState["pale-reaches"]).toBe("sound");
    expect(r1.newDeeds).toHaveLength(1);
    // Repeat gating retires vex-raid (cooldown 3 streams); storm fires next.
    const r2 = evaluateThresholds(r1.world, TIDEBOUND_LIBRARY);
    expect(r2.fired).toBe("pale-reaches-storm");
    expect(r2.world.locationState["pale-reaches"]).toBe("strained");
  });

  it("no cascade within one evaluation; next evaluation continues", () => {
    const { engine } = harness();
    const w = engine.world;
    w.uniqueSearchers = ["a", "b", "c", "d", "e"];
    w.threatLevel = 65; // storm would match once chart-pale-ready is set...
    const r1 = evaluateThresholds(w, TIDEBOUND_LIBRARY);
    expect(r1.fired).toBe("wren-chart-room");
    // ...but not in the same evaluation that set the flag.
    expect(r1.world.locationState["pale-reaches"]).toBe("sound");
    expect(r1.newDeeds).toHaveLength(1);
    const r2 = evaluateThresholds(r1.world, TIDEBOUND_LIBRARY);
    expect(r2.fired).toBe("pale-reaches-storm");
  });

  it("repeat-ineligible templates never refire", () => {
    const { engine } = harness();
    engine.world.uniqueSearchers = ["a", "b", "c", "d", "e"];
    const once = evaluateThresholds(engine.world, TIDEBOUND_LIBRARY);
    expect(once.fired).toBe("wren-chart-room");
    const twice = evaluateThresholds(once.world, TIDEBOUND_LIBRARY);
    expect(twice.fired).toBeNull();
  });

  it("invalid trigger kinds fail closed without touching the world", () => {
    const { engine } = harness();
    const before = engine.world;
    const r = evaluateStreamMoment(before, TIDEBOUND_LIBRARY, "bogus" as never);
    expect(r.fired).toBeNull();
    expect(typeof r.reason).toBe("string");
    expect(r.world).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// §21 meter contributions
// ---------------------------------------------------------------------------

describe("5G-7 — meter contributions", () => {
  function readyWorld() {
    const w = tideboundGenesis("2026-11-03T00:00:00.000Z");
    w.storyFlags["chart-pale-ready"] = true;
    return w;
  }
  function sessionFor(w: WorldState) {
    const o = openStream(w);
    if (!o.ok) throw new Error("open failed");
    return o.session;
  }

  it("scout contributes once per actor while the chart-room is open", () => {
    const w = readyWorld();
    let s = sessionFor(w);
    const a = contributeForCommand(w, s, "search", "u1");
    expect(a.contributed).toBe(true);
    expect(a.world.eventCounters["meter.pale-chart"]).toBe(1);
    expect(a.session.meterContributors["pale-chart"]).toEqual(["u1"]);
    const b = contributeForCommand(a.world, a.session, "search", "u1");
    expect(b.contributed).toBe(false);
    expect(b.reason).toBe("duplicate-contributor");
    expect(b.world.eventCounters["meter.pale-chart"]).toBe(1);
  });

  it("scout is gated before the chart-room opens; shield is dormant while sound", () => {
    const w = tideboundGenesis("2026-11-03T00:00:00.000Z");
    const s = sessionFor(w);
    const r = contributeForCommand(w, s, "search", "u1");
    expect(r.contributed).toBe(false);
    expect(r.reason).toBe("chart-not-ready");
    expect(r.world).toBe(w);
    const q = contributeForCommand(w, s, "shield", "u1");
    expect(q.contributed).toBe(false);
    expect(q.reason).toBe("beacon-oil-dormant");
    expect(q.world).toBe(w);
  });

  it("shield contributes while cinderholm is strained", () => {
    const w = tideboundGenesis("2026-11-03T00:00:00.000Z");
    w.locationState = { ...w.locationState, cinderholm: "strained" };
    const s = sessionFor(w);
    const r = contributeForCommand(w, s, "shield", "u9");
    expect(r.contributed).toBe(true);
    expect(r.world.eventCounters["meter.beacon-oil"]).toBe(1);
  });

  it("meter retires at target; further contributions are rejected", () => {
    let w = readyWorld();
    let s = sessionFor(w);
    for (let i = 0; i < 10; i++) {
      const r = contributeForCommand(w, s, "search", `scout-${i}`);
      expect(r.contributed).toBe(true);
      w = r.world;
      s = r.session;
    }
    expect(w.eventCounters["meter.pale-chart"]).toBe(10);
    const r = contributeForCommand(w, s, "search", "late-comer");
    expect(r.contributed).toBe(false);
    expect(r.reason).toBe("meter-complete");
    expect(r.world.eventCounters["meter.pale-chart"]).toBe(10);
  });

  it("non-meter actions and missing actors never contribute", () => {
    const w = readyWorld();
    const s = sessionFor(w);
    for (const action of ["attack", "paid_strike", "rejected", "help", "cooldown"] as const) {
      const r = contributeForCommand(w, s, action, "u1");
      expect(r.contributed).toBe(false);
      expect(r.reason).toBe("not-a-contribution");
      expect(r.world).toBe(w);
    }
    const r = contributeForCommand(w, s, "search", undefined);
    expect(r.contributed).toBe(false);
    expect(r.reason).toBe("invalid-actor");
  });

  it("meter crosses streams: contributors reset, totals persist", () => {
    const h = harness();
    h.engine.world.storyFlags["chart-pale-ready"] = true;
    const a = contributeForCommand(h.engine.world, h.session, "search", "u1");
    expect(a.contributed).toBe(true);
    h.engine.world = a.world;
    h.setSession(a.session);
    // New stream: same actor may contribute again (fresh contributor set).
    const opened = openStream(h.engine.world);
    if (!opened.ok) throw new Error(opened.reason);
    h.setSession(opened.session);
    expect(h.session.meterContributors).toEqual({});
    const b = contributeForCommand(h.engine.world, h.session, "search", "u1");
    expect(b.contributed).toBe(true);
    expect(b.world.eventCounters["meter.pale-chart"]).toBe(2);
    // ...while totals survive a save/restore round-trip.
    const loaded = deserialize(serialize(b.world));
    if (!loaded) throw new Error("reload failed");
    expect(loaded.eventCounters["meter.pale-chart"]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §21 vote close → resolve → fire
// ---------------------------------------------------------------------------

describe("5G-7 — vote closing and firing", () => {
  function openRouteVote(s: StreamSession) {
    const r = openSessionVote(s, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!r.ok) throw new Error(r.reason);
    return r.session;
  }

  function closeAll(h: ReturnType<typeof harness>, cmd = "!help") {
    // Advance the clock one command at a time through the real runtime path.
    for (let i = 0; i < 200 && h.session.activeVote && !h.session.activeVote.closed; i++) {
      h.engine.ingestCommand(`clk-${i}`, `Clk${i}`, cmd, `ev-close-${i}`);
      h.drain();
    }
  }

  it("auto-close fires the winner exactly once on the closing command", () => {
    const h = harness();
    h.setSession(openRouteVote(h.session));
    h.setSession(castAll(h.session, [["v1", 1], ["v2", 1], ["v3", 0]]));
    // 25 chat commands close the vote (maxCommands 25).
    for (let i = 0; i < ROUTE_VOTE.maxCommands; i++) {
      h.engine.ingestCommand(`c${i}`, `C${i}`, "!help", `ev-${i}`);
      h.drain();
    }
    expect(h.session.activeVote?.closed).toBe(true);
    const fired = h.fired.filter((f) => f.fired !== null);
    expect(fired).toHaveLength(1);
    expect(fired[0].fired).toBe("route-parley-with-ilya");
    expect(h.engine.world.currentChapter).toBe(2);
    expect(h.engine.world.storyFlags["ilya.parleyed"]).toBe(true);
    expect(h.engine.world.deeds.some((d) => d.includes("parley"))).toBe(true);
  });

  it("manual close fires the winner; a second close is a silent no-op", () => {
    const h = harness();
    h.setSession(openRouteVote(h.session));
    h.setSession(castAll(h.session, [["v1", 1], ["v2", 1]]));
    const first = closeVoteAndFire(h.session, h.engine.world, TIDEBOUND_LIBRARY);
    expect(first.didClose).toBe(true);
    expect(first.fired).toBe("route-parley-with-ilya");
    expect(first.newDeeds).toHaveLength(1);
    h.setSession(first.session);
    h.engine.world = first.world;
    const deeds = [...h.engine.world.deeds];
    const again = closeVoteAndFire(h.session, h.engine.world, TIDEBOUND_LIBRARY);
    expect(again.didClose).toBe(false);
    expect(again.fired).toBeNull();
    expect(h.engine.world.deeds).toEqual(deeds);
  });

  it("no ballots means no winner and no firing", () => {
    const h = harness();
    h.setSession(openRouteVote(h.session));
    const before = h.engine.world;
    const r = closeVoteAndFire(h.session, before, TIDEBOUND_LIBRARY);
    expect(r.didClose).toBe(true);
    expect(r.fired).toBeNull();
    expect(r.reason).toBe("no-ballots");
    expect(r.world).toBe(before);
    expect(before.currentChapter).toBe(1);
  });

  it("stale winner fires nothing and never falls through to runner-up", () => {
    const { engine } = harness();
    const s0 = openRouteVote(mustOpen(engine.world));
    const s1 = castAll(s0, [["v1", 0], ["v2", 0]]);
    // route-dredge-map needs chart-pale-ready (unset): stale winner.
    const r = closeVoteAndFire(s1, engine.world, TIDEBOUND_LIBRARY);
    expect(r.didClose).toBe(true);
    expect(r.fired).toBeNull();
    expect(r.reason).toBe("winner-ineligible");
    // Parley was eligible but lost the ballot: it must NOT fire instead.
    expect(engine.world.currentChapter).toBe(1);
    expect(r.world.deeds.some((d) => d.includes("parley") || d.includes("dredge"))).toBe(false);
  });

  it("creator override fires immediately, closes the vote, blocks later closes", () => {
    const { engine } = harness();
    let s = openRouteVote(mustOpen(engine.world));
    s = castAll(s, [["v1", 0], ["v2", 0]]);
    const o = overrideVoteAndFire(s, engine.world, TIDEBOUND_LIBRARY, 1);
    expect(o.fired).toBe("route-parley-with-ilya");
    expect(o.winner).toBe("route-parley-with-ilya");
    expect(o.didClose).toBe(true);
    expect(o.newDeeds.some((d) => d.includes("flame leaned"))).toBe(true);
    const again = closeVoteAndFire(o.session, o.world, TIDEBOUND_LIBRARY);
    expect(again.didClose).toBe(false);
    expect(again.fired).toBeNull();
  });

  it("invalid override index fails without touching the world", () => {
    const { engine } = harness();
    const before = engine.world;
    const s = openRouteVote(mustOpen(engine.world));
    const r = overrideVoteAndFire(s, engine.world, TIDEBOUND_LIBRARY, 9);
    expect(r.winner).toBeNull();
    expect(r.fired).toBeNull();
    expect(r.world).toBe(before);
  });

  it("manual close with no open vote is a safe no-op", () => {
    const { engine, session } = harness();
    const r = closeVoteAndFire(session, engine.world, TIDEBOUND_LIBRARY);
    expect(r.didClose).toBe(false);
    expect(r.fired).toBeNull();
    expect(r.reason).toBe("no-active-vote");
    expect(r.world).toBe(engine.world);
  });

  it("resolveAndFireVote refuses without an active vote", () => {
    const { engine, session } = harness();
    const r = resolveAndFireVote(session, engine.world, TIDEBOUND_LIBRARY);
    expect(r.fired).toBeNull();
    expect(r.winner).toBeNull();
    expect(r.reason).toBe("no-active-vote");
  });

  it("noteVoteCommandAndMaybeFire is a no-op without an open vote", () => {
    const { engine, session } = harness();
    const r = noteVoteCommandAndMaybeFire(session, engine.world, TIDEBOUND_LIBRARY);
    expect(r.fired).toBeNull();
    expect(r.closedNow).toBe(false);
    expect(r.session).toBe(session);
    expect(r.world).toBe(engine.world);
  });

  it("a vote open at stream close is abandoned; the next stream starts clean", () => {
    const h = harness();
    h.setSession(openRouteVote(h.session));
    h.setSession(castAll(h.session, [["v1", 1]]));
    const closed = closeStreamAndFire(h.engine.world, h.session, TIDEBOUND_LIBRARY);
    expect(closed.ok).toBe(true);
    if (!closed.ok) throw new Error("unreachable");
    // No deeds yet, so no reckoning — and the open vote is NOT fired by closing.
    expect(closed.fired).toBeNull();
    expect(closed.world.deeds).toEqual([]);
    expect(closed.world.streamCount).toBe(1);
    // The abandoned vote does not travel: the next stream opens with no vote.
    const opened = openStream(closed.world);
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.session.activeVote).toBeNull();
    h.setSession(opened.session);
    h.engine.world = opened.world;
  });

  it("paid events never advance the vote clock or touch ballots", () => {
    const h = harness();
    h.setSession(openRouteVote(h.session));
    h.setSession(castAll(h.session, [["donor-x", 1]]));
    const before = JSON.parse(JSON.stringify(h.session.activeVote));
    h.engine.ingestPaid("donor-x", "Donor", 50000, "INR", "paid-1");
    h.drain();
    expect(h.engine.world.totalPaidEvents).toBe(1);
    expect(h.session.activeVote).toEqual(before);
  });

  it("restart carries no pending winner; repeat gating blocks refire", () => {
    const h = harness();
    h.setSession(openRouteVote(h.session));
    h.setSession(castAll(h.session, [["v1", 1], ["v2", 1]]));
    closeAll(h);
    const fired = h.fired.filter((f) => f.fired !== null);
    expect(fired).toHaveLength(1);
    const saved = serialize(h.engine.world);
    const engine2 = new GameEngine({ now: () => 2_000_000 });
    const loaded = deserialize(saved);
    if (!loaded) throw new Error("reload failed");
    engine2.loadWorld(loaded);
    const opened = openStream(engine2.world);
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.session.activeVote).toBeNull();
    const tmpl = TIDEBOUND_LIBRARY.find((t) => t.id === "route-parley-with-ilya")!;
    expect(fireTemplate(tmpl, engine2.world).ok).toBe(false);
  });

  function mustOpen(w: Parameters<typeof openStream>[0]) {
    const o = openStream(w);
    if (!o.ok) throw new Error(o.reason);
    return o.session;
  }
});

// ---------------------------------------------------------------------------
// §21 stream open / close firing
// ---------------------------------------------------------------------------

describe("5G-7 — stream boundaries", () => {
  it("stream open fires matins on a fresh chapter; reopening is a safe no-op", () => {
    const { engine } = harness();
    const first = openStreamAndFire(engine.world, TIDEBOUND_LIBRARY);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.fired).toBe("bellkeeper-matins");
    expect(first.world.storyFlags["tam.warning-given"]).toBe(true);
    expect(first.world.storyFlags["c.rho.met"]).toBe(true);
    expect(first.newDeeds).toHaveLength(1);
    expect(first.newDeeds[0]).toContain("drowned bell");
    const again = openStreamAndFire(first.world, TIDEBOUND_LIBRARY);
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error("unreachable");
    expect(again.fired).toBeNull(); // per-chapter repeat gate holds
    expect(again.world).toBe(first.world);
  });

  it("stream close fires reckoning when deeds exist; deedless streams skip it", () => {
    const h = harness();
    const opened = openStreamAndFire(h.engine.world, TIDEBOUND_LIBRARY);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("unreachable");
    h.engine.world = opened.world;
    h.setSession(opened.session);
    const closed = closeStreamAndFire(h.engine.world, h.session, TIDEBOUND_LIBRARY);
    expect(closed.ok).toBe(true);
    if (!closed.ok) throw new Error("unreachable");
    expect(closed.fired).toBe("tidebound-reckoning");
    expect(closed.newDeeds).toHaveLength(1);
    expect(closed.newDeeds[0]).toContain("keep sleeps");
    // streamCount advances by exactly one; deeds carry over.
    expect(closed.world.streamCount).toBe(1);
    expect(closed.world.deeds.length).toBeGreaterThanOrEqual(2);

    // Deedless stream: no trigger match, close still works.
    const h2 = harness();
    const plain = openStream(h2.engine.world);
    if (!plain.ok) throw new Error(plain.reason);
    const bare = closeStreamAndFire(h2.engine.world, plain.session, TIDEBOUND_LIBRARY);
    expect(bare.ok).toBe(true);
    if (!bare.ok) throw new Error("unreachable");
    expect(bare.fired).toBeNull();
    expect(bare.world.streamCount).toBe(1);
  });

  it("cooldown state spans streams via persisted repeat bookkeeping", () => {
    const { engine } = harness();
    // Arrange a storm-eligible world and fire the heavier match first.
    engine.world.storyFlags["chart-pale-ready"] = true;
    engine.world.threatLevel = 65;
    engine.world.eventCounters["elite_arrivals"] = 1;
    const first = evaluateThresholds(engine.world, TIDEBOUND_LIBRARY);
    expect(first.fired).toBe("vex-raid");
    // Advance two streams; the cooldown (3 streams) still blocks refire.
    let w = first.world;
    for (let i = 0; i < 2; i++) {
      const opened = openStream(w);
      if (!opened.ok) throw new Error(opened.reason);
      const closed = closeStreamAndFire(w, opened.session, TIDEBOUND_LIBRARY);
      if (!closed.ok) throw new Error(closed.reason);
      w = closed.world;
    }
    expect(w.streamCount).toBe(2);
    const blocked = evaluateThresholds(w, TIDEBOUND_LIBRARY);
    expect(blocked.fired).toBe("pale-reaches-storm"); // vex-raid still cooling; storm eligible
  });
});

// ---------------------------------------------------------------------------
// §21 manual creator rites
// ---------------------------------------------------------------------------

describe("5G-7 — manual creator rites", () => {
  it("sable's mending rite fires when eligible", () => {
    const { engine } = harness();
    const before = engine.world;
    const r = fireRite(before, TIDEBOUND_LIBRARY, "sable-mending-rite");
    expect(r.ok).toBe(true);
    expect(r.fired).toBe("sable-mending-rite");
    expect(r.world.resources).toBe(before.resources - 5);
    expect(r.world.factionState["rho"]).toBe(before.factionState["rho"] + 10);
    expect(r.newDeeds).toHaveLength(1);
    expect(r.newDeeds[0]).toContain("Sable");
  });

  it("tide prayer is ineligible below the threat threshold", () => {
    const { engine } = harness();
    const before = engine.world;
    const r = fireRite(before, TIDEBOUND_LIBRARY, "tide-prayer");
    expect(r.ok).toBe(false);
    expect(r.fired).toBeNull();
    expect(r.world).toBe(before);
  });

  it("vote templates and unknown ids are rejected as rites", () => {
    const { engine } = harness();
    for (const id of ["route-dredge-map", "route-parley-with-ilya", "burn-tams-warning", "no-such-rite", 42]) {
      const r = fireRite(engine.world, TIDEBOUND_LIBRARY, id);
      expect(r.ok).toBe(false);
      expect(r.fired).toBeNull();
      expect(r.world).toBe(engine.world);
    }
  });

  it("insufficient supplies blocks firing without side effects", () => {
    const { engine } = harness();
    engine.world.resources = 0;
    const before = engine.world;
    const r = fireRite(before, TIDEBOUND_LIBRARY, "sable-mending-rite");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("insufficient-supplies");
    expect(r.world).toBe(before);
  });

  it("per-chapter rites cannot repeat in the same chapter", () => {
    const { engine } = harness();
    const first = fireRite(engine.world, TIDEBOUND_LIBRARY, "sable-mending-rite");
    expect(first.ok).toBe(true);
    const second = fireRite(first.world, TIDEBOUND_LIBRARY, "sable-mending-rite");
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("template-repeat-ineligible");
    expect(second.world).toBe(first.world);
  });

  it("rekindle requires a lost Cinderholm plus completed oil work", () => {
    const { engine } = harness();
    const w = engine.world;
    w.locationState = { ...w.locationState, cinderholm: "lost" };
    w.eventCounters["meter.beacon-oil"] = 5;
    w.resources = 30;
    const r = fireRite(w, TIDEBOUND_LIBRARY, "cinderholm-rekindle");
    expect(r.ok).toBe(true);
    expect(r.world.locationState["cinderholm"]).toBe("strained");
    expect(w.locationState["cinderholm"]).toBe("lost"); // input untouched
  });

  it("ilya's duel and rho's plain speech gate on their story prerequisites", () => {
    const { engine } = harness();
    // Rho is not yet friendly (30 < 60): no fire.
    expect(fireRite(engine.world, TIDEBOUND_LIBRARY, "rho-plain-speech").ok).toBe(false);
    // Ilya needs c.ilya.met + parleyed + 3 kills.
    const w = engine.world;
    expect(fireRite(w, TIDEBOUND_LIBRARY, "ilya-duel").ok).toBe(false);
    w.storyFlags["c.ilya.met"] = true;
    w.storyFlags["ilya.parleyed"] = true;
    w.eventCounters["kills"] = 3;
    w.resolve = 50;
    const dueled = fireRite(w, TIDEBOUND_LIBRARY, "ilya-duel");
    expect(dueled.ok).toBe(true);
    expect(dueled.world.storyFlags["c.ilya.fate.ally"]).toBe(true);
    expect(dueled.world.storyFlags["c.ilya.fate.enemy"]).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// §21 pacing: at most one firing per processed event, deterministic order
// ---------------------------------------------------------------------------

describe("5G-7 — pacing", () => {
  it("a scripted burst fires at most once per evaluation in causal order", () => {
    const h = harness();
    // Phase 1: five scouts unlock the chart room.
    for (let i = 0; i < 5; i++) h.engine.ingestCommand(`s${i}`, `S${i}`, "!scout", `ev-s-${i}`);
    h.drain();
    // Phase 2: seven rings summon the storm onto the scarred... Pale (still sound).
    for (let i = 0; i < 7; i++) h.engine.ingestCommand(`r${i}`, `R${i}`, "!ring", `ev-r-${i}`);
    h.drain();
    // Phase 3: ten more scouts complete the chart and found the Pale Bell.
    for (let i = 0; i < 10; i++) h.engine.ingestCommand(`t${i}`, `T${i}`, "!scout", `ev-t-${i}`);
    h.drain();
    const fired = h.fired.filter((f) => f.fired !== null).map((f) => f.fired as string);
    // One firing per evaluation is structural; assert the causal order held.
    expect(fired).toEqual(["wren-chart-room", "pale-reaches-storm", "pale-bell-founding"]);
    expect(h.engine.world.currentChapter).toBe(2);
  });

  it("the Pale Bell cannot be founded on unscarred ground: fail closed, no partial state", () => {
    // Content contract: founding heals a strained Pale. With the Pale still
    // sound, the setLocation effect is invalid and the whole firing aborts —
    // the meter stays complete, the world is untouched, and the failure
    // carries a reason instead of silently discarding history.
    const { engine } = harness();
    engine.world.storyFlags["chart-pale-ready"] = true;
    engine.world.eventCounters["meter.pale-chart"] = 10;
    const before = engine.world;
    const r = evaluateThresholds(engine.world, TIDEBOUND_LIBRARY);
    expect(r.fired).toBeNull();
    expect(r.reason).toMatch(/invalid-transition/);
    expect(r.world).toBe(before);
    expect(engine.world.eventCounters["meter.pale-chart"]).toBe(10);
    expect(engine.world.locationState["pale-reaches"]).toBe("sound");
    expect(engine.world.storyFlags["pale-bell-found"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §21 free-first regression: a full arc with zero paid events
// ---------------------------------------------------------------------------

describe("5G-7 — free-first arc requires no paid events", () => {
  it("scouts, rings, votes, and the Kindling advance the saga for free", () => {
    const h = harness();
    // Stream opens: matins fires (tam.warning-given unlocks the Kindling path).
    const opened = openStreamAndFire(h.engine.world, TIDEBOUND_LIBRARY);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("unreachable");
    h.engine.world = opened.world;
    h.setSession(opened.session);
    for (const d of opened.newDeeds) h.engine.pushStory(d);
    expect(opened.fired).toBe("bellkeeper-matins");

    // Chapter 1 → 2: five scouts chart the Pale.
    ["s1", "s2", "s3", "s4", "s5"].forEach((s, i) => h.engine.ingestCommand(s, `S${i}`, "!scout", `ev-s-${i}`));
    h.drain();
    expect(h.engine.world.currentChapter).toBe(2);

    // Threat storm: seven rings summon the Gloam onto the Pale.
    for (let i = 0; i < 7; i++) h.engine.ingestCommand(`r${i}`, `R${i}`, "!ring", `ev-r-${i}`);
    h.drain();
    expect(h.engine.world.locationState["pale-reaches"]).toBe("strained");

    // Ten more scouts complete the chart and found the Pale Bell.
    for (let i = 0; i < 10; i++) h.engine.ingestCommand(`t${i}`, `T${i}`, "!scout", `ev-t-${i}`);
    h.drain();
    expect(h.engine.world.eventCounters["meter.pale-chart"]).toBe(10);
    expect(h.engine.world.storyFlags["pale-bell-found"]).toBe(true);

    // Route vote → parley advances to chapter 3.
    h.setSession(openVote(h.session, ROUTE_VOTE));
    h.setSession(castAll(h.session, [["a1", 1], ["a2", 1], ["a3", 0]]));
    for (let i = 0; i < ROUTE_VOTE.maxCommands; i++) h.engine.ingestCommand(`q${i}`, `Q${i}`, "!help", `ev-q-${i}`);
    h.drain();
    expect(h.engine.world.currentChapter).toBe(3);

    // Kindling → burn Tam's warning advances the arc.
    h.setSession(openVote(h.session, KINDLING_VOTE));
    h.setSession(castAll(h.session, [["b1", 0], ["b2", 0], ["b3", 1]]));
    for (let i = 0; i < KINDLING_VOTE.maxCommands; i++) h.engine.ingestCommand(`k${i}`, `K${i}`, "!help", `ev-k-${i}`);
    h.drain();
    expect(h.engine.world.currentArc).toBe(2);
    expect(h.engine.world.currentChapter).toBe(1);
    expect(h.engine.world.storyFlags["burned.tam-warning"]).toBe(true);

    // Zero paid interaction from first command to last.
    expect(h.engine.world.totalPaidEvents).toBe(0);
    expect(h.engine.world.totalPaidMinorUnits).toBe(0);
    expect(h.engine.world.paidLedger).toEqual([]);
    // ...yet the world remembers everything.
    const deeds = h.engine.world.deeds.join("\n");
    for (const line of ["matins", "lanterns burn", "Gloam storm", "Pale Bell is founded", "parley", "Tam's warning"]) {
      expect(deeds).toContain(line);
    }
  });
});

// ---------------------------------------------------------------------------
// §18 paid safety: catalysts never buy votes, meters, or chapters
// ---------------------------------------------------------------------------

describe("5G-7 — paid-event isolation", () => {
  it("paid catalysts trip thresholds but never advance votes or meters", () => {
    const h = harness();
    h.setSession(openVote(h.session, ROUTE_VOTE));
    h.setSession(castAll(h.session, [["v1", 1]]));
    const before = JSON.parse(JSON.stringify(h.session.activeVote));
    h.engine.ingestPaid("donor", "Donor", 50000, "INR", "paid-elite");
    h.drain();
    expect(h.engine.world.totalPaidEvents).toBe(1);
    // Vote clock and ballots untouched...
    expect(h.session.activeVote).toEqual(before);
    // ...meter counters untouched...
    expect(h.engine.world.eventCounters["meter.pale-chart"]).toBeUndefined();
    expect(h.engine.world.eventCounters["meter.beacon-oil"]).toBeUndefined();
    // ...while the paid catalyst legitimately trips its threshold.
    expect(h.fired.filter((f) => f.fired !== null).map((f) => f.fired)).toEqual(["vex-raid"]);
    expect(h.engine.world.locationState["cinderholm"]).toBe("strained");
  });

  it("retraction and compensation never fire templates or touch votes/meters", () => {
    const h = harness();
    h.setSession(openVote(h.session, ROUTE_VOTE));
    h.setSession(castAll(h.session, [["v1", 1]]));
    const voteBefore = JSON.parse(JSON.stringify(h.session.activeVote));
    h.engine.ingestPaid("donor", "Donor", 5000, "INR", "paid-strike");
    h.drain();
    const matches = h.engine.world.paidLedger.filter((e) => e.status === "applied");
    expect(matches).toHaveLength(1);
    h.engine.ingest(retractionEv(matches[0].platformEventId, "RT-1"));
    h.drain();
    // Compensation happened...
    const compensated = h.engine.world.paidLedger.filter((e) => e.status === "compensated");
    expect(compensated).toHaveLength(1);
    // ...but the vote, its clock, and the meters are untouched...
    expect(h.session.activeVote).toEqual(voteBefore);
    expect(h.engine.world.eventCounters["meter.pale-chart"]).toBeUndefined();
    expect(h.engine.world.eventCounters["meter.beacon-oil"]).toBeUndefined();
    // ...and no template fired anywhere in this sequence.
    expect(h.fired.filter((f) => f.fired !== null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §22 UI/UX: the existing presentation already shows everything needed
// ---------------------------------------------------------------------------

describe("5G-7 — creator console contract", () => {
  it("a completed meter survives restart without refiring", () => {
    // Complete the chart and fire the founding in stream 1.
    const h = harness();
    for (let i = 0; i < 5; i++) h.engine.ingestCommand(`s${i}`, `S${i}`, "!scout", `ev-s-${i}`);
    h.drain();
    for (let i = 0; i < 7; i++) h.engine.ingestCommand(`r${i}`, `R${i}`, "!ring", `ev-r-${i}`);
    h.drain();
    for (let i = 0; i < 10; i++) h.engine.ingestCommand(`t${i}`, `T${i}`, "!scout", `ev-t-${i}`);
    h.drain();
    expect(h.engine.world.eventCounters["meter.pale-chart"]).toBe(10);
    expect(h.fired.filter((f) => f.fired === "pale-bell-founding")).toHaveLength(1);
    // Restart from disk: the counter persists, the contributor set resets,
    // further contributions are refused, and nothing refires.
    const engine2 = new GameEngine({ now: () => 2_000_000 });
    const loaded = deserialize(serialize(h.engine.world));
    if (!loaded) throw new Error("reload failed");
    engine2.loadWorld(loaded);
    expect(engine2.world.eventCounters["meter.pale-chart"]).toBe(10);
    const opened = openStream(engine2.world);
    if (!opened.ok) throw new Error(opened.reason);
    const r = contributeForCommand(engine2.world, opened.session, "search", "late-comer");
    expect(r.contributed).toBe(false);
    expect(r.reason).toBe("meter-complete");
    const t = evaluateThresholds(engine2.world, TIDEBOUND_LIBRARY);
    expect(t.fired).toBeNull();
  });

  it("MANUAL_RITES lists exactly the five approved rites, never vote templates", () => {
    expect([...MANUAL_RITES]).toEqual([
      "sable-mending-rite",
      "tide-prayer",
      "ilya-duel",
      "cinderholm-rekindle",
      "rho-plain-speech",
    ]);
    const voteIds = [...ROUTE_VOTE.options, ...KINDLING_VOTE.options];
    for (const id of voteIds) {
      expect(MANUAL_RITES as readonly string[]).not.toContain(id);
    }
  });
});
