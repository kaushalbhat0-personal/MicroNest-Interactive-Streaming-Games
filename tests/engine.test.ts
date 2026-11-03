import { describe, expect, it } from "vitest";
import { QUEUE } from "../src/engine/config";
import { GameEngine } from "../src/engine/engine";
import { FeedAggregator } from "../src/engine/feed";
import { deserialize, serialize } from "../src/persistence/store";

/** Controllable clock so cooldowns / rates are exact. */
function harness() {
  let t = 1_000_000;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  const engine = new GameEngine({ now });
  /** Pump until the queue drains (respecting the global min gap). */
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

describe("Tidebound engine — deterministic domain rules", () => {
  it("1. !strike reduces enemy HP", () => {
    const { engine, drain } = harness();
    const before = engine.world.enemy.hp;
    engine.ingestCommand("u1", "A", "!strike");
    drain();
    expect(engine.world.enemy.hp).toBe(before - 7);
  });

  it("2. !mend restores hero HP", () => {
    const { engine, drain } = harness();
    engine.world.heroHp = 50;
    engine.ingestCommand("u1", "A", "!mend");
    drain();
    expect(engine.world.heroHp).toBe(62);
  });

  it("3. per-viewer cooldown blocks spam but not other viewers", () => {
    const { engine, drain } = harness();
    engine.ingestCommand("u1", "A", "!strike", "e1");
    engine.ingestCommand("u1", "A", "!strike", "e2"); // same viewer, within 3s
    engine.ingestCommand("u2", "B", "!strike", "e3");
    const results = drain();
    const byId = Object.fromEntries(results.map((r) => [r.eventId, r.action]));
    expect(byId["e1"]).toBe("attack");
    expect(byId["e2"]).toBe("cooldown");
    expect(byId["e3"]).toBe("attack");
  });

  it("4. duplicate event IDs are ignored", () => {
    const { engine, drain } = harness();
    expect(engine.ingestCommand("u1", "A", "!strike", "same-id")).toBe("queued");
    expect(engine.ingestCommand("u1", "A", "!strike", "same-id")).toBe("duplicate");
    drain();
    // Only one attack's worth of damage (7), not two.
    expect(engine.world.enemy.hp).toBe(engine.world.enemy.maxHp - 7);
  });

  it("5. paid events jump ahead of normal commands", () => {
    const { engine, advance } = harness();    engine.ingestCommand("u1", "A", "!strike", "normal-1");
    engine.ingestPaid("u9", "Donor", 5000, "INR", "paid-1");
    advance(QUEUE.minGapMs + 50);
    const first = engine.pump();
    expect(first).toHaveLength(1);
    expect(first[0].eventId).toBe("paid-1");
  });

  it("6. a ₹500 paid event spawns an elite encounter", () => {
    const { engine, drain } = harness();
    const threatBefore = engine.world.threatLevel;
    engine.ingestPaid("u9", "Donor", 500 * 100, "INR");
    drain();
    expect(engine.world.enemy.isElite).toBe(true);
    expect(engine.world.enemy.name).toContain("Elite");
    expect(engine.world.threatLevel).toBeGreaterThan(threatBefore);
    expect(engine.world.storyFlags["elite_threat_active"]).toBe(true);
  });

  it("7. search counts UNIQUE viewers only", () => {
    const { engine, drain } = harness();
    for (let i = 0; i < 5; i++) engine.ingestCommand("same-user", "A", "!scout", `s${i}`);
    drain();
    // Same viewer searching 5x: only the first passes cooldown → 1 unique.
    expect(engine.world.uniqueSearchers).toEqual(["same-user"]);
    expect(engine.world.storyFlags["five_lanterns_lit"]).toBeUndefined();
  });

  it("8. five unique searchers light the five lanterns", () => {
    const { engine, drain } = harness();
    ["a", "b", "c", "d", "e"].forEach((u, i) =>
      engine.ingestCommand(u, `Viewer${i}`, "!scout", `s-${u}`),
    );
    drain();
    expect(engine.world.uniqueSearchers).toHaveLength(5);
    expect(engine.world.storyFlags["five_lanterns_lit"]).toBe(true);
    expect(engine.world.discoveredSecrets).toContain("five-lanterns");
    expect(engine.world.eventCounters["secrets_found"]).toBe(1);
    expect(engine.world.resources).toBe(20 + 10); // the lanterns yield supplies
    expect(engine.storyLog.some((m) => m.includes("lanterns"))).toBe(true);
  });

  it("9+10. world state saves and restores exactly", () => {
    const { engine, drain } = harness();
    engine.ingestCommand("u1", "A", "!strike");
    engine.ingestCommand("u2", "B", "!mend");
    engine.ingestPaid("u9", "Donor", 100 * 100, "INR");
    drain();
    const raw = serialize(engine.world);
    const restored = deserialize(raw);
    expect(restored).not.toBeNull();
    expect(restored).toEqual(engine.world);
  });

  it("11. restart restores state instead of resetting it", () => {
    const h1 = harness();
    h1.engine.ingestCommand("u1", "A", "!strike");
    h1.engine.ingestPaid("u9", "Donor", 500 * 100, "INR");
    h1.drain();
    h1.engine.world.keepHp = 72;
    h1.engine.world.threatLevel = 34;
    h1.engine.world.resources = 81;

    // Simulate stop → start: serialize, build a fresh engine, load.
    const saved = serialize(h1.engine.world);
    const h2 = harness();
    const loaded = deserialize(saved);
    expect(loaded).not.toBeNull();
    h2.engine.loadWorld(loaded!);
    expect(h2.engine.world.keepHp).toBe(72);
    expect(h2.engine.world.threatLevel).toBe(34);
    expect(h2.engine.world.resources).toBe(81);
    expect(h2.engine.world.enemy.isElite).toBe(true);
    expect(h2.engine.world.worldId).toBe("emberkeep-prototype");
  });

  it("12. invalid events are rejected safely (never executed)", () => {
    const { engine, drain } = harness();
    const hpBefore = engine.world.enemy.hp;
    expect(engine.ingestCommand("u1", "A", "!fly-to-the-moon")).toBe("rejected-invalid");
    expect(engine.ingestCommand("u1", "A", "hello everyone")).toBe("rejected-invalid");
    expect(engine.ingestPaid("u1", "A", -500, "INR")).toBe("rejected-invalid");
    expect(engine.ingestPaid("u1", "A", NaN, "INR")).toBe("rejected-invalid");
    expect(
      engine.ingest({ kind: "chat_command", eventId: "", actorId: "", actorName: "", command: "", receivedAt: "" }),
    ).toBe("rejected-invalid");
    drain();
    expect(engine.world.enemy.hp).toBe(hpBefore);
    expect(engine.queue.size).toBe(0);
  });

  it("batching: repeated attacks merge into one readable feed line", () => {
    const { engine, advance } = harness();
    const feed = new FeedAggregator();
    const viewers = ["v1", "v2", "v3", "v4"];
    viewers.forEach((v, i) => engine.ingestCommand(v, v, "!strike", `b${i}`));
    // Process one per pump so each result lands inside the batch window.
    for (let i = 0; i < 4; i++) {
      advance(QUEUE.minGapMs + 10);
      for (const r of engine.pump()) feed.push(r);
    }
    const top = feed.list()[0];
    expect(top.count).toBe(4);
    expect(top.text).toBe("4 viewers struck the Gloam!");
    // …while every strike still dealt damage individually.
    expect(engine.world.enemy.hp).toBe(engine.world.enemy.maxHp - 4 * 7);
  });

  it("defeating the elite advances the world story (no final ending)", () => {
    const { engine, drain, advance } = harness();
    engine.ingestPaid("u9", "Donor", 500 * 100, "INR", "elite-1");
    drain();
    const chapterBefore = engine.world.currentChapter;
    // Kill the elite with distinct viewers (7 dmg each, ~110+ hp).
    for (let i = 0; i < 24; i++) {
      engine.ingestCommand(`k${i}`, `K${i}`, "!strike", `kill-${i}`);
      advance(QUEUE.minGapMs + 10);
      engine.pump();
      if (!engine.world.enemy.isElite) break;
    }
    drain();
    expect(engine.world.eventCounters["elites_defeated"]).toBe(1);
    expect(engine.world.storyFlags["elite_defeated"]).toBe(true);
    const advanced =
      engine.world.currentChapter !== chapterBefore || engine.world.currentArc !== 1;
    expect(advanced).toBe(true);
  });
});
