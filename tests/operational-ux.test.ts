import { describe, expect, it } from "vitest";
import { compensatePaid } from "../src/engine/compensate";
import { GameEngine } from "../src/engine/engine";
import { QUEUE } from "../src/engine/config";
import { FeedAggregator } from "../src/engine/feed";
import { tideboundGenesis, ROUTE_VOTE, TIDEBOUND_LIBRARY } from "../src/content/tidebound";
import {
  castSessionVote,
  noteSessionCommand,
  openSessionVote,
  openStream,
  resolveSessionVote,
} from "../src/engine/lifecycle";
import { renderOverlay } from "../src/presentation/hud";

function harness(seedNow = 1_000_000) {
  let t = seedNow;
  const now = () => t;
  const engine = new GameEngine({ now }, tideboundGenesis(new Date(t).toISOString()));
  const feed = new FeedAggregator(now);
  const drain = () => {
    const out = [];
    for (let i = 0; i < 2000 && engine.queue.size > 0; i++) {
      t += QUEUE.minGapMs + 50;
      const rs = engine.pump();
      for (const r of rs) feed.push(r);
      out.push(...rs);
    }
    return out;
  };
  return { engine, drain, feed, now: () => t };
}

function paidEv(ref: string, amount: number) {
  return {
    kind: "paid_event",
    eventId: `yt:${ref}`,
    actorId: "yt:UC-DONOR",
    actorName: "Donor",
    amount,
    currency: "INR",
    receivedAt: new Date(1_000_000).toISOString(),
    source: "youtube",
    platformEventId: ref,
  } as const;
}

function retractionEv(ref: string) {
  return {
    kind: "paid_retraction",
    eventId: `yt:retraction:${ref}`,
    refPlatformId: ref,
    platformEventId: `RT-${ref}`,
    source: "youtube",
    receivedAt: new Date(1_000_000).toISOString(),
  } as const;
}

describe("Phase 5G-5 — operational readiness / lifecycle UX", () => {
  // ---- §9 free-viewer viability (§14 idempotency-adjacent, no paid events) ----

  it("free-only stream produces decisions, consequences, uncertainty, progression", () => {
    const { engine, drain } = harness();
    // Five unique scouts light the lanterns (collective goal with progress).
    for (let i = 0; i < 5; i++) {
      expect(engine.ingestCommand(`s${i}`, `Scout${i}`, "!scout", `cmd-scout-${i}`)).toBe("queued");
    }
    drain();
    expect(engine.world.uniqueSearchers).toHaveLength(5);
    expect(engine.world.discoveredSecrets).toContain("five-lanterns");
    expect(engine.world.eventCounters["secrets_found"]).toBe(1);
    // Free strikes kill the vessel (visible consequence + wave progression).
    for (let i = 0; i < 9; i++) {
      expect(engine.ingestCommand(`k${i}`, `Striker${i}`, "!strike", `cmd-strike-${i}`)).toBe("queued");
    }
    drain();
    expect(engine.world.eventCounters["kills"]).toBe(1);
    expect(engine.world.enemy.hp).toBe(0);
    // Every other free command lands a distinct consequence.
    const acts: Array<[string, string, string]> = [
      ["m1", "Mender", "!mend"],
      ["w1", "Warden", "!shield"],
      ["r1", "Ringer", "!ring"],
      ["h1", "Hider", "!hide"],
      ["t1", "Tributary", "!tribute"],
      ["d1", "Defier", "!defy"],
      ["h9", "Helper", "!help"],
    ];
    for (const [id, name, cmd] of acts) {
      expect(engine.ingestCommand(id, name, cmd, `cmd-${id}`)).toBe("queued");
    }
    const results = drain();
    expect(results.every((r) => ["heal", "shield", "ring", "hide", "tribute", "defy", "help"].includes(r.action))).toBe(true);
    // Story moved without a single paid event; paid counters untouched.
    expect(engine.storyLog.length).toBeGreaterThan(0);
    expect(engine.world.totalPaidEvents).toBe(0);
    expect(engine.world.totalPaidMinorUnits).toBe(0);
    expect(engine.world.paidLedger).toEqual([]);
  });

  it("free votes resolve a winner at the domain level without touching paid state", () => {
    const { engine, drain } = harness();
    drain();
    const opened = openStream(engine.world);
    if (!opened.ok) throw new Error("expected open");
    let session = opened.session;
    const v = openSessionVote(session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!v.ok) throw new Error(v.reason);
    session = v.session;
    for (const [actor, idx] of [["v1", 1], ["v2", 1], ["v3", 0]] as const) {
      const c = castSessionVote(session, actor, idx);
      if (!c.ok) throw new Error(c.reason);
      session = c.session;
    }
    for (let i = 0; i < ROUTE_VOTE.maxCommands; i++) {
      const n = noteSessionCommand(session);
      if (!n.ok) throw new Error(n.reason);
      session = n.session;
    }
    const resolved = resolveSessionVote(session, engine.world, TIDEBOUND_LIBRARY);
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.winner).toBe("route-parley-with-ilya");
    expect(resolved.counts).toEqual([1, 2]);
    // The ballot box never touches paid history.
    expect(engine.world.totalPaidEvents).toBe(0);
    expect(engine.world.paidLedger).toEqual([]);
  });

  // ---- §5/§6 paid + retraction visibility (data the console/overlay render) ----

  it("paid catalysts surface as named story events with no platform internals", () => {
    const { engine, drain, feed } = harness();
    engine.ingest(paidEv("ELITE-1", 75000));
    drain();
    const catalyst = engine.recentResults.find((r) => r.action === "paid_elite")!;
    expect(catalyst.summary).toContain("Herald's Attention");
    for (const leak of ["yt:", "platformEventId", "paid_retraction", "applied", "compensated", "ledger"]) {
      expect(catalyst.summary).not.toContain(leak);
    }
    // The viewer feed carries the catalyst as a story event.
    const texts = feed.list().map((e) => e.text);
    expect(texts.some((t) => t.includes("Herald's Attention"))).toBe(true);
    // The creator moment line carries it too (beats may unshift above it).
    expect(engine.storyLog.some((l) => l.includes("Herald's Attention"))).toBe(true);
  });

  it("compensation surfaces in story history, never as feed/accounting noise", () => {
    const { engine, drain, feed } = harness();
    engine.ingest(paidEv("BELL-1", 150000));
    drain();
    const feedBefore = feed.list().length;
    engine.ingest(retractionEv("BELL-1"));
    const results = drain();
    expect(results[0].summary).toContain("echo fades");
    // Compensation is a silent result (rejected/world): no feed entry, no vote clock.
    expect(results[0].action).toBe("rejected");
    expect(results[0].actorName).toBe("world");
    expect(results[0].storyMessages).toEqual([]);
    expect(feed.list()).toHaveLength(feedBefore);
    // …but the world remembers it in story history and persistent deeds.
    expect(engine.storyLog[0]).toContain("echo fades");
    expect(engine.world.deeds[engine.world.deeds.length - 1]).toContain("echo fades");
    // No jargon, amounts, payers, or platform references in the visible text.
    for (const leak of ["retraction", "applied", "compensated", "ledger", "platformEventId", "yt:", "INR", "Donor"]) {
      expect(results[0].summary).not.toContain(leak);
    }
  });

  it("exact vs narrative compensation is distinguishable by fixed game-native copy", () => {
    const pairs: Array<[number, string, string]> = [
      [5000, "gale-exact-reversal", "The Gale's fury ebbs — the wound it dealt closes."],
      [15000, "supply-narrative-compensation", "recalled beyond the Pale"],
      [75000, "herald-narrative-compensation", "The Herald's claim falters, but Vex has seen Cinderholm."],
      [150000, "bell-narrative-compensation", "echo fades"],
    ];
    for (const [amount, note, text] of pairs) {
      const { engine, drain } = harness();
      engine.ingest(paidEv(`P-${amount}`, amount));
      drain();
      const stored = engine.world.paidLedger.find((e) => e.eventId === `yt:P-${amount}`)!;
      if (stored.status !== "applied") throw new Error("expected applied");
      const r = compensatePaid(engine.world, stored, new Date(9_000_000).toISOString());
      if (!r.ok) throw new Error("expected ok");
      expect(r.note).toBe(note);
      expect(r.summary).toContain(text);
      expect(r.summary).not.toContain("Refund");
      expect(r.summary).not.toContain("refund");
    }
  });

  // ---- §8 viewer overlay: fiction only (rendered HTML, no DOM library needed) ----

  it("viewer overlay shows story, never ledger internals or diagnostics", () => {
    const { engine, drain, feed } = harness();
    engine.ingest(paidEv("ELITE-1", 75000));
    drain();
    engine.ingest(retractionEv("ELITE-1"));
    drain();
    const opened = openStream(engine.world);
    if (!opened.ok) throw new Error("expected open");
    const root = { innerHTML: "" } as unknown as HTMLElement;
    renderOverlay(root, {
      world: engine.world,
      session: opened.session,
      storyLog: engine.storyLog,
      feed: feed.list(),
      recent: engine.recentResults,
      paused: false,
    });
    const html = (root as unknown as { innerHTML: string }).innerHTML;
    expect(html).toContain("Herald's Attention");
    expect(html).toContain("claim falters");
    expect(html).toContain("Tidebound live overlay");
    for (const leak of ["yt:", "platformEventId", "paid_retraction", "retraction-noted", "applied", "compensated", "ledger", "cc-ledger", "Paid history"]) {
      expect(html).not.toContain(leak);
    }
    expect(html).toContain('role="status"');
    expect(html).toContain('role="progressbar"');
  });

  it("viewer overlay paused state and command guide render without diagnostics", () => {
    const { engine } = harness();
    const opened = openStream(engine.world);
    if (!opened.ok) throw new Error("expected open");
    const root = { innerHTML: "" } as unknown as HTMLElement;
    renderOverlay(root, {
      world: engine.world,
      session: opened.session,
      storyLog: [],
      feed: [],
      recent: [],
      paused: true,
    });
    const html = (root as unknown as { innerHTML: string }).innerHTML;
    expect(html).toContain("PAUSED");
    expect(html).toContain("!strike");
    expect(html).toContain("Previously, in Tidebound");
  });
});
