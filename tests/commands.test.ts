import { describe, expect, it } from "vitest";
import { COMMANDS, QUEUE } from "../src/engine/config";
import { GameEngine } from "../src/engine/engine";
import { FeedAggregator } from "../src/engine/feed";

/** Controllable clock so cooldowns / rates are exact. */
function harness() {
  let t = 1_000_000;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  const engine = new GameEngine({ now });
  const drain = () => {
    const out = [];
    for (let i = 0; i < 500 && engine.queue.size > 0; i++) {
      advance(QUEUE.minGapMs + 50);
      out.push(...engine.pump());
    }
    return out;
  };
  return { engine, now, advance, drain };
}

describe("Phase 5B — canonical Tidebound vocabulary", () => {
  it("COMMANDS lists exactly the 12 canonical verbs", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(
      ["!defy", "!help", "!hide", "!mend", "!ring", "!scout", "!shield", "!strike", "!tribute", "!votea", "!voteb", "!votec"].sort(),
    );
    expect("!attack" in COMMANDS).toBe(false);
    expect("!heal" in COMMANDS).toBe(false);
    expect("!search" in COMMANDS).toBe(false);
  });

  it("!help auto-reflects COMMANDS (no second list)", () => {
    const { engine, drain } = harness();
    engine.ingestCommand("u1", "A", "!help");
    const [r] = drain();
    for (const cmd of Object.keys(COMMANDS)) expect(r.summary).toContain(cmd);
    expect(r.summary).toContain("!strike");
    expect(r.summary).toContain("!votea"); // canonical keys are lowercase
  });

  it("unknown verbs are still rejected at the whitelist", () => {
    const { engine } = harness();
    expect(engine.ingestCommand("u1", "A", "!dance")).toBe("rejected-invalid");
    expect(engine.ingestCommand("u1", "A", "!attack")).toBe("rejected-invalid");
    expect(engine.queue.size).toBe(0);
  });
});

describe("Phase 5B — renamed verbs preserve engine behavior", () => {
  it("!strike damages, lowers threat, and rewards kills (action key stable)", () => {
    const { engine, drain } = harness();
    const hp = engine.world.enemy.hp;
    const threat = engine.world.threatLevel;
    engine.ingestCommand("u1", "A", "!strike");
    const [r] = drain();
    expect(r.action).toBe("attack"); // stable engine identifier, not fiction
    expect(engine.world.enemy.hp).toBe(hp - 7);
    expect(engine.world.threatLevel).toBe(threat - 1);
    expect(engine.world.eventCounters["attacks"]).toBe(1);
  });

  it("!mend restores HP up to the cap", () => {
    const { engine, drain } = harness();
    engine.world.heroHp = 50;
    engine.ingestCommand("u1", "A", "!mend");
    const [r] = drain();
    expect(r.action).toBe("heal");
    expect(engine.world.heroHp).toBe(62);
    engine.world.heroHp = 96;
    engine.ingestCommand("u2", "B", "!mend");
    drain();
    expect(engine.world.heroHp).toBe(100);
  });

  it("!scout tracks unique scouts and advances progress", () => {
    const { engine, drain } = harness();
    engine.ingestCommand("same", "A", "!scout");
    engine.ingestCommand("same", "A", "!scout");
    const [first] = drain();
    expect(first.action).toBe("search");
    expect(engine.world.uniqueSearchers).toEqual(["same"]);
    expect(engine.world.searchProgress).toBe(20); // second blocked by cooldown
  });

  it("!shield raises the ward", () => {
    const { engine, drain, now } = harness();
    engine.ingestCommand("u1", "A", "!shield");
    const [r] = drain();
    expect(r.action).toBe("shield");
    expect(engine.world.keepShieldUntil).toBe(now() + 12000);
  });

  it("verbs have independent per-viewer cooldowns", () => {
    const { engine, drain } = harness();
    expect(engine.ingestCommand("u1", "A", "!strike")).toBe("queued");
    expect(engine.ingestCommand("u1", "A", "!ring")).toBe("queued"); // different key, no clash
    const results = drain();
    expect(results.map((r) => r.action)).toEqual(["attack", "ring"]);
  });
});

describe("Phase 5B — new verbs", () => {
  it("!ring stirs the Gloam: +8 threat, clamped at 100", () => {
    const { engine, drain } = harness();
    engine.world.threatLevel = 10;
    engine.ingestCommand("u1", "A", "!ring");
    const [r] = drain();
    expect(r.action).toBe("ring");
    expect(engine.world.threatLevel).toBe(18);
    expect(engine.world.eventCounters["rings"]).toBe(1);
    engine.world.threatLevel = 96;
    engine.ingestCommand("u2", "B", "!ring");
    drain();
    expect(engine.world.threatLevel).toBe(100);
  });

  it("!hide lowers danger at a resolve cost, both floored at zero", () => {
    const { engine, drain } = harness();
    engine.world.threatLevel = 30;
    engine.world.resolve = 50;
    engine.ingestCommand("u1", "A", "!hide");
    const [r] = drain();
    expect(r.action).toBe("hide");
    expect(engine.world.threatLevel).toBe(24);
    expect(engine.world.resolve).toBe(45);
    engine.world.threatLevel = 3;
    engine.world.resolve = 2;
    engine.ingestCommand("u2", "B", "!hide");
    drain();
    expect(engine.world.threatLevel).toBe(0);
    expect(engine.world.resolve).toBe(0);
  });

  it("!tribute spends 5 supplies for +5 standing with the faced faction", () => {
    const { engine, drain } = harness();
    engine.world.resources = 20;
    engine.world.factionState["goblins"] = 30;
    engine.ingestCommand("u1", "A", "!tribute");
    const [r] = drain();
    expect(r.action).toBe("tribute");
    expect(engine.world.resources).toBe(15);
    expect(engine.world.factionState["goblins"]).toBe(35);
  });

  it("!tribute fails safely without supplies and clamps standing", () => {
    const { engine, drain } = harness();
    engine.world.resources = 3;
    engine.ingestCommand("u1", "A", "!tribute");
    const [r] = drain();
    expect(r.action).toBe("rejected");
    expect(engine.world.resources).toBe(3); // untouched
    expect(engine.world.eventCounters["tributes"]).toBeUndefined();
    engine.world.resources = 99;
    engine.world.factionState["goblins"] = 98;
    engine.ingestCommand("u2", "B", "!tribute");
    drain();
    expect(engine.world.factionState["goblins"]).toBe(100);
    expect(engine.world.resources).toBe(94);
  });

  it("!tribute with no faced faction fails closed", () => {
    const { engine, drain } = harness();
    engine.world.resources = 20;
    engine.world.enemy.faction = "";
    engine.ingestCommand("u1", "A", "!tribute");
    const [r] = drain();
    expect(r.action).toBe("rejected");
    expect(engine.world.resources).toBe(20);
  });

  it("!defy damages standing and raises threat, both clamped", () => {
    const { engine, drain } = harness();
    engine.world.factionState["goblins"] = 30;
    engine.world.threatLevel = 10;
    engine.ingestCommand("u1", "A", "!defy");
    const [r] = drain();
    expect(r.action).toBe("defy");
    expect(engine.world.factionState["goblins"]).toBe(25);
    expect(engine.world.threatLevel).toBe(14);
    engine.world.factionState["goblins"] = 2;
    engine.world.threatLevel = 99;
    engine.world.storyFlags["threat_rising"] = true; // suppress beat: this test measures clamps, not story
    engine.ingestCommand("u2", "B", "!defy");
    drain();
    expect(engine.world.factionState["goblins"]).toBe(0);
    expect(engine.world.threatLevel).toBe(100);
  });

  it("feed batches the new verbs readably", () => {
    const feed = new FeedAggregator(() => 1_000_000);
    feed.push({ eventId: "a", action: "ring", summary: "x", actorName: "A", storyMessages: [], visual: {} });
    const entries = feed.push({ eventId: "b", action: "ring", summary: "x", actorName: "B", storyMessages: [], visual: {} });
    expect(entries[0].text).toBe("2 viewers rang the drowned bell!");
  });
});

describe("Phase 5B — reserved vote commands are inert", () => {
  it("!voteA/!voteB/!voteC queue through the whitelist but change nothing", () => {
    const { engine, drain } = harness();
    const before = JSON.parse(JSON.stringify(engine.world)) as typeof engine.world;
    expect(engine.ingestCommand("u1", "A", "!voteA")).toBe("queued");
    expect(engine.ingestCommand("u2", "B", "!voteB")).toBe("queued");
    expect(engine.ingestCommand("u3", "C", "!voteC")).toBe("queued");
    const results = drain();
    expect(results.map((r) => r.action)).toEqual(["rejected", "rejected", "rejected"]);
    // Processed (not dropped): the engine counted the actions…
    expect(engine.world.totalViewerActions).toBe(before.totalViewerActions + 3);
    // …but no gameplay, story, or template-visible state changed.
    const strip = (w: unknown) => {
      const c = JSON.parse(JSON.stringify(w)) as Record<string, unknown>;
      delete c.totalViewerActions;
      delete c.lastUpdated;
      return c;
    };
    expect(strip(engine.world)).toEqual(strip(before));
    expect(engine.world.eventCounters).toEqual({});
    expect(engine.world.storyFlags).toEqual({});
    expect(engine.world.deeds).toEqual([]);
  });
});
