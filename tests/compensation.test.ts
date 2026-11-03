import { describe, expect, it } from "vitest";
import { compensatePaid } from "../src/engine/compensate";
import { GameEngine } from "../src/engine/engine";
import { QUEUE } from "../src/engine/config";
import type { CanonicalEvent, PaidLedgerAppliedEntry } from "../src/engine/types";
import { deserialize, serialize } from "../src/persistence/store";

function harness(seedNow = 1_000_000) {
  let t = seedNow;
  const now = () => t;
  const engine = new GameEngine({ now });
  const drain = () => {
    const out = [];
    for (let i = 0; i < 500 && engine.queue.size > 0; i++) {
      t += QUEUE.minGapMs + 50;
      out.push(...engine.pump());
    }
    return out;
  };
  return { engine, drain, now: () => t };
}

function paidEv(over: Partial<Extract<CanonicalEvent, { kind: "paid_event" }>> & { eventId?: string }): CanonicalEvent {
  return {
    kind: "paid_event",
    eventId: "yt:SC-1",
    actorId: "yt:UC-DONOR",
    actorName: "Donor",
    amount: 50000,
    currency: "INR",
    receivedAt: new Date(1_000_000).toISOString(),
    source: "youtube",
    platformEventId: "SC-1",
    ...over,
  } as CanonicalEvent;
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

function appliedEntryOf(engine: GameEngine): PaidLedgerAppliedEntry {
  const e = engine.world.paidLedger.find((x) => x.status === "applied");
  if (!e || e.status !== "applied") throw new Error("expected one applied entry");
  return e;
}

describe("Phase 5G-3 — safe paid catalyst compensation", () => {
  // ---- General (§20.1–7) ----

  it("1–4. applied entry compensates once; history immutable", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000 }));
    drain();
    const stored = appliedEntryOf(engine);
    const historical = { ...stored };
    const r = compensatePaid(engine.world, stored, new Date(9_000_000).toISOString());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.entry.status).toBe("compensated");
    expect(r.entry.compensationNote).toBe("supply-narrative-compensation");
    expect(typeof r.entry.compensatedAtIso).toBe("string");
    // Historical fields immutable (checkpoint included).
    expect(r.entry.eventId).toBe(historical.eventId);
    expect(r.entry.platformEventId).toBe(historical.platformEventId);
    expect(r.entry.actorId).toBe(historical.actorId);
    expect(r.entry.amount).toBe(historical.amount);
    expect(r.entry.currency).toBe(historical.currency);
    expect(r.entry.tierKey).toBe(historical.tierKey);
    expect(r.entry.appliedAtIso).toBe(historical.appliedAtIso);
    expect(r.entry.appliedAtStream).toBe(historical.appliedAtStream);
    expect(r.entry.appliedCheckpoint).toEqual(historical.appliedCheckpoint);
    // Input world untouched (purity); output world carries both changes.
    expect(stored.status).toBe("applied");
    expect(r.world.paidLedger.find((e) => e.eventId === "yt:SC-1")!.status).toBe("compensated");
  });

  it("5+7. duplicate compensation is a no-op (direct + engine paths)", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000 }));
    drain();
    engine.ingest(retractionEv("SC-1"));
    drain();
    expect(appliedEntryOfSafe(engine)).toBeNull();
    const deedsAfterFirst = [...engine.world.deeds];
    // Direct second call fails closed.
    const stored = engine.world.paidLedger.find((e) => e.eventId === "yt:SC-1")!;
    if (stored.status !== "compensated") throw new Error("expected compensated");
    expect(compensatePaid(engine.world, stored, new Date(9_000_001).toISOString())).toEqual({
      ok: false,
      reason: "already-resolved",
    });
    // Engine second signal: already resolved, no second deed.
    // Same-process redelivery is absorbed by queue dedup (deterministic);
    // post-restart redelivery reaches the engine and resolves identically.
    expect(engine.ingest(retractionEv("SC-1"))).toBe("duplicate");
    const fresh = new GameEngine({ now: () => 9_000_000 }, structuredClone(engine.world));
    fresh.ingest(retractionEv("SC-1"));
    const out = [];
    for (let i = 0; i < 10 && fresh.queue.size > 0; i++) out.push(...fresh.pump());
    expect(out[0].summary).toContain("already resolved");
    expect(fresh.world.deeds).toEqual(deedsAfterFirst);
  });

  function appliedEntryOfSafe(engine: GameEngine): PaidLedgerAppliedEntry | null {
    const e = engine.world.paidLedger.find((x) => x.status === "applied");
    return e && e.status === "applied" ? e : null;
  }

  it("6. unknown retraction is a full no-op", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000 }));
    drain();
    const before = structuredClone(engine.world);
    engine.ingest(retractionEv("NOPE"));
    drain();
    const { paidLedger: _a, ...gameBefore } = before;
    const { paidLedger: _b, ...gameAfter } = engine.world;
    expect(gameAfter).toEqual(gameBefore);
    expect(engine.world.paidLedger.filter((e) => e.status === "retraction-noted")).toHaveLength(1);
  });

  // ---- Retraction-before-original (§20.8–11) ----

  it("8+9. note + later original → one catalyst + one compensation", () => {
    const { engine, drain } = harness();
    expect(engine.ingest(retractionEv("SC-8"))).toBe("queued");
    drain();
    // The note's signal id differs from the future original's id: no blocking.
    expect(engine.ingest(paidEv({ eventId: "yt:SC-8", platformEventId: "SC-8", amount: 5000 }))).toBe("queued");
    const results = drain();
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("paid_strike");
    // recentResults holds the catalyst, its compensation, and the earlier
    // retraction-note signal — newest first.
    const [catalyst, compensation, noted, ...rest] = engine.recentResults;
    expect(rest).toHaveLength(0);
    expect(catalyst.action).toBe("paid_strike");
    expect(compensation.eventId).toBe("comp:yt:SC-8");
    expect(compensation.summary).toContain("fury ebbs");
    expect(noted.summary).toContain("noted");
    // Story shows catalyst, then the easing on top.
    expect(engine.storyLog[0]).toContain("fury ebbs");
    expect(engine.storyLog.slice(1).join("\n")).toContain("GALE CALL");
    const entry = engine.world.paidLedger.find((e) => e.eventId === "yt:SC-8")!;
    expect(entry.status).toBe("compensated");
  });

  it("10+11. duplicates around before-original stay single", () => {
    const { engine, drain } = harness();
    engine.ingest(retractionEv("SC-8"));
    drain();
    engine.ingest(paidEv({ eventId: "yt:SC-8", platformEventId: "SC-8", amount: 5000 }));
    drain();
    const deeds = [...engine.world.deeds];
    expect(engine.ingest(paidEv({ eventId: "yt:SC-8", platformEventId: "SC-8", amount: 5000 }))).toBe("duplicate");
    // Same-process signal redelivery is queue-deduped; post-restart it
    // reaches the engine and resolves without a second compensation.
    expect(engine.ingest(retractionEv("SC-8"))).toBe("duplicate");
    const fresh = new GameEngine({ now: () => 9_000_000 }, structuredClone(engine.world));
    fresh.ingest(retractionEv("SC-8"));
    const out = [];
    for (let i = 0; i < 10 && fresh.queue.size > 0; i++) out.push(...fresh.pump());
    expect(out[0].summary).toContain("already resolved");
    expect(fresh.world.deeds).toEqual(deeds);
    expect(fresh.world.paidLedger.filter((e) => e.eventId === "yt:SC-8")).toHaveLength(1);
  });

  // ---- Gale (§20.12–18) ----

  it("12. same wave, same live enemy → exact +15 reversal", () => {
    const { engine, drain } = harness();
    const hpBefore = engine.world.enemy.hp;
    engine.ingest(paidEv({ eventId: "yt:G1", platformEventId: "G1", amount: 5000 }));
    drain();
    expect(engine.world.enemy.hp).toBe(hpBefore - 15);
    engine.ingest(retractionEv("G1"));
    const results = drain();
    expect(results[0].summary).toContain("fury ebbs");
    expect(engine.world.enemy.hp).toBe(hpBefore);
    const entry = engine.world.paidLedger.find((e) => e.eventId === "yt:G1")!;
    expect(entry.status).toBe("compensated");
    if (entry.status !== "compensated") throw new Error("expected compensated");
    expect(entry.compensationNote).toBe("gale-exact-reversal");
  });

  it("13+18. killed enemy is never resurrected; no rewards exist to claw back", () => {
    const { engine, drain } = harness();
    engine.world.enemy.hp = 10;
    const resourcesBefore = engine.world.resources;
    engine.ingest(paidEv({ eventId: "yt:G1", platformEventId: "G1", amount: 5000 }));
    drain();
    expect(engine.world.enemy.hp).toBe(0); // the strike killed
    // Paid Gale grants no kill rewards by existing engine design (applyPaid
    // only reduces HP) — so there is nothing to claw back by construction.
    expect(engine.world.resources).toBe(resourcesBefore);
    engine.ingest(retractionEv("G1"));
    const results = drain();
    expect(results[0].summary).toContain("storm relents");
    expect(engine.world.enemy.hp).toBe(0); // stays dead: never resurrected
    expect(engine.world.resources).toBe(resourcesBefore); // untouched
    const entry = engine.world.paidLedger.find((e) => e.eventId === "yt:G1")!;
    if (entry.status !== "compensated") throw new Error("expected compensated");
    expect(entry.compensationNote).toBe("gale-narrative-compensation");
  });

  it("14. wave change → narrative, HP untouched", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:G1", platformEventId: "G1", amount: 5000 }));
    drain();
    // Simulate the respawn that follows later play.
    engine.world.waveNumber = 2;
    engine.world.enemy = { name: "Gloam Vessel", hp: 80, maxHp: 80, isElite: false, difficulty: 2, faction: "gloam" };
    engine.ingest(retractionEv("G1"));
    drain();
    expect(engine.world.enemy.hp).toBe(80);
    const entry = engine.world.paidLedger.find((e) => e.eventId === "yt:G1")!;
    if (entry.status !== "compensated") throw new Error("expected compensated");
    expect(entry.compensationNote).toBe("gale-narrative-compensation");
  });

  it("15. elite replacement → narrative", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:G1", platformEventId: "G1", amount: 5000 }));
    drain();
    engine.world.enemy = { name: "Elite Herald of the Gloam", hp: 110, maxHp: 110, isElite: true, difficulty: 2, faction: "gloam" };
    engine.ingest(retractionEv("G1"));
    drain();
    expect(engine.world.enemy.isElite).toBe(true);
    expect(engine.world.enemy.hp).toBe(110);
    const entry = engine.world.paidLedger.find((e) => e.eventId === "yt:G1")!;
    if (entry.status !== "compensated") throw new Error("expected compensated");
    expect(entry.compensationNote).toBe("gale-narrative-compensation");
  });

  it("16. chapter advancement → narrative", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:G1", platformEventId: "G1", amount: 5000 }));
    drain();
    engine.world.currentChapter = 2;
    engine.ingest(retractionEv("G1"));
    drain();
    const entry = engine.world.paidLedger.find((e) => e.eventId === "yt:G1")!;
    if (entry.status !== "compensated") throw new Error("expected compensated");
    expect(entry.compensationNote).toBe("gale-narrative-compensation");
    expect(engine.world.currentChapter).toBe(2);
  });

  it("17. exact reversal clamps at max HP", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:G1", platformEventId: "G1", amount: 5000 }));
    drain();
    engine.world.enemy.hp = engine.world.enemy.maxHp; // unnatural ceiling; clamp must hold
    const r = compensatePaid(engine.world, appliedEntryOf(engine), new Date(9_000_000).toISOString());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.exact).toBe(true);
    expect(r.world.enemy.hp).toBe(r.world.enemy.maxHp);
  });

  // ---- Supply (§20.19–21) ----

  it("19. later supply spend → no blind subtraction", () => {
    const { engine, drain } = harness();
    engine.world.resources = 20;
    engine.ingest(paidEv({ eventId: "yt:S1", platformEventId: "S1", amount: 15000 }));
    drain();
    expect(engine.world.resources).toBe(50);
    engine.ingestCommand("u1", "A", "!tribute", "cmd-t1");
    drain();
    expect(engine.world.resources).toBe(45);
    engine.ingest(retractionEv("S1"));
    drain();
    expect(engine.world.resources).toBe(45);
    const entry = engine.world.paidLedger.find((e) => e.eventId === "yt:S1")!;
    if (entry.status !== "compensated") throw new Error("expected compensated");
    expect(entry.compensationNote).toBe("supply-narrative-compensation");
  });

  it("20. later keep damage → no keep rollback", () => {
    const { engine, drain } = harness();
    engine.world.keepHp = 50;
    engine.ingest(paidEv({ eventId: "yt:S1", platformEventId: "S1", amount: 15000 }));
    drain();
    expect(engine.world.keepHp).toBe(60);
    engine.world.keepHp = 40; // later battle damage
    engine.ingest(retractionEv("S1"));
    drain();
    expect(engine.world.keepHp).toBe(40);
  });

  // ---- Herald (§20.22–26) ----

  function applyElite(engine: GameEngine, drain: () => unknown[], id: string, platformId: string) {
    engine.ingest(paidEv({ eventId: id, platformEventId: platformId, amount: 75000 }));
    drain();
    expect(engine.world.enemy.isElite).toBe(true);
  }

  it("22. elite remains after retraction", () => {
    const { engine, drain } = harness();
    applyElite(engine, drain, "yt:H1", "H1");
    const hp = engine.world.enemy.hp;
    const arrivals = engine.world.eventCounters["elite_arrivals"];
    engine.ingest(retractionEv("H1"));
    const results = drain();
    expect(results[0].summary).toContain("claim falters");
    expect(engine.world.enemy.isElite).toBe(true);
    expect(engine.world.enemy.hp).toBe(hp);
    expect(engine.world.eventCounters["elite_arrivals"]).toBe(arrivals); // never decrements
    const entry = engine.world.paidLedger.find((e) => e.eventId === "yt:H1")!;
    if (entry.status !== "compensated") throw new Error("expected compensated");
    expect(entry.compensationNote).toBe("herald-narrative-compensation");
  });

  it("23. elite defeat remains; rewards kept", () => {
    const { engine, drain } = harness();
    applyElite(engine, drain, "yt:H1", "H1");
    engine.world.enemy.hp = 7; // battle damage through later play
    engine.ingestCommand("slayer", "Slayer", "!strike", "cmd-kill");
    drain();
    expect(engine.world.enemy.hp).toBe(0);
    expect(engine.world.eventCounters["elites_defeated"]).toBe(1);
    // Capture the settled post-battle state (kill reward + defeat beat).
    const resourcesAfterBattle = engine.world.resources;
    const chapterAfterBattle = engine.world.currentChapter;
    engine.ingest(retractionEv("H1"));
    drain();
    expect(engine.world.enemy.hp).toBe(0); // no resurrection
    expect(engine.world.eventCounters["elites_defeated"]).toBe(1);
    expect(engine.world.resources).toBe(resourcesAfterBattle); // rewards kept
    expect(engine.world.currentChapter).toBe(chapterAfterBattle);
  });

  it("25. Vex flags, deeds, and story history are never cleared", () => {
    const { engine, drain } = harness();
    applyElite(engine, drain, "yt:H1", "H1");
    expect(engine.world.storyFlags["elite_threat_active"]).toBe(true);
    const flagsBefore = { ...engine.world.storyFlags };
    const logBefore = [...engine.storyLog];
    engine.ingest(retractionEv("H1"));
    drain();
    expect(engine.world.storyFlags).toEqual(flagsBefore);
    // Original history intact + exactly one new compensation memory.
    for (const line of logBefore) expect(engine.storyLog).toContain(line);
    expect(engine.storyLog[0]).toContain("claim falters");
  });

  // ---- Bell (§20.27–31) ----

  function applyBell(engine: GameEngine, drain: () => unknown[], id: string, platformId: string) {
    engine.ingest(paidEv({ eventId: id, platformEventId: platformId, amount: 150000 }));
    drain();
    expect(engine.world.currentChapter).toBe(2);
  }

  it("27–29. chapter, counters, and secrets stand; compensation once", () => {
    const { engine, drain } = harness();
    applyBell(engine, drain, "yt:B1", "B1");
    expect(engine.world.eventCounters["major_story_events"]).toBe(1);
    expect(engine.world.discoveredSecrets).toContain("toll-omen");
    const logBefore = [...engine.storyLog];
    engine.ingest(retractionEv("B1"));
    const results = drain();
    expect(results[0].summary).toContain("echo fades");
    expect(engine.world.currentChapter).toBe(2); // never decremented
    expect(engine.world.eventCounters["major_story_events"]).toBe(1); // never decremented
    expect(engine.world.discoveredSecrets).toContain("toll-omen"); // never removed
    for (const line of logBefore) expect(engine.storyLog).toContain(line); // history intact
    const entry = engine.world.paidLedger.find((e) => e.eventId === "yt:B1")!;
    if (entry.status !== "compensated") throw new Error("expected compensated");
    expect(entry.compensationNote).toBe("bell-narrative-compensation");
    // Exactly once.
    engine.ingest(retractionEv("B1"));
    drain();
    expect(engine.world.deeds.filter((d) => d.includes("echo fades"))).toHaveLength(1);
  });

  it("30. late compensation applies at the current state", () => {
    const { engine, drain } = harness();
    applyBell(engine, drain, "yt:B1", "B1");
    engine.world.currentChapter = 3; // story moved on through later play
    engine.ingest(retractionEv("B1"));
    drain();
    expect(engine.world.currentChapter).toBe(3); // never rewound
    const entry = engine.world.paidLedger.find((e) => e.eventId === "yt:B1")!;
    expect(entry.status).toBe("compensated");
  });

  // ---- Persistence (§20.32–35) ----

  it("32+33. applied entry survives reload; compensated state round-trips", () => {
    const h1 = harness();
    h1.engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000 }));
    h1.drain();
    const saved = serialize(h1.engine.world);
    const h2 = harness();
    h2.engine.loadWorld(deserialize(saved)!);
    // Compensation works on the reloaded world.
    h2.engine.ingest(retractionEv("SC-1"));
    h2.drain();
    expect(h2.engine.world.paidLedger.find((e) => e.eventId === "yt:SC-1")!.status).toBe("compensated");
    expect(deserialize(serialize(h2.engine.world))).toEqual(h2.engine.world);
  });

  it("35. retraction-before-original survives restart", () => {
    const h1 = harness();
    h1.engine.ingest(retractionEv("SC-9"));
    h1.drain();
    const saved = serialize(h1.engine.world);
    const h2 = harness();
    h2.engine.loadWorld(deserialize(saved)!);
    h2.engine.ingest(paidEv({ eventId: "yt:SC-9", platformEventId: "SC-9", amount: 5000 }));
    h2.drain();
    const entry = h2.engine.world.paidLedger.find((e) => e.eventId === "yt:SC-9")!;
    expect(entry.status).toBe("compensated"); // applied once, compensated immediately
    if (entry.status !== "compensated") throw new Error("expected compensated");
    expect(entry.compensationNote).toBe("gale-exact-reversal");
    expect(h2.engine.world.paidLedger.filter((e) => e.status === "retraction-noted")).toHaveLength(1);
  });

  // ---- Invariants (§21) + safety (§17–19) ----

  it("Invariant A/D/F/G: chapters, counters, entry count, checkpoint", () => {
    const { engine, drain } = harness();
    const arcBefore = engine.world.currentArc;
    const chapterBefore = engine.world.currentChapter;
    engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 150000 }));
    drain();
    const countersBefore = { ...engine.world.eventCounters };
    const checkpoint = (appliedEntryOf(engine) as PaidLedgerAppliedEntry).appliedCheckpoint;
    const ledgerLen = engine.world.paidLedger.length;
    engine.ingest(retractionEv("SC-1"));
    drain();
    expect(engine.world.currentArc).toBeGreaterThanOrEqual(arcBefore);
    expect(engine.world.currentChapter).toBeGreaterThanOrEqual(chapterBefore);
    expect(engine.world.eventCounters).toEqual(countersBefore); // D: no counter moves
    expect(engine.world.paidLedger).toHaveLength(ledgerLen); // F: no new entry
    const entry = engine.world.paidLedger.find((e) => e.eventId === "yt:SC-1")!;
    if (entry.status !== "compensated") throw new Error("expected compensated");
    expect(entry.appliedCheckpoint).toEqual(checkpoint); // G: checkpoint frozen
  });

  it("Invariant B: no committed deed is ever removed", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000 }));
    drain();
    const before = [...engine.world.deeds, "The keepers swore an oath."]; // committed history
    engine.world.deeds = before;
    engine.ingest(retractionEv("SC-1"));
    drain();
    for (const d of before) expect(engine.world.deeds).toContain(d);
  });

  it("no second catalyst chain: no beats, no vote/meter coupling", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000 }));
    drain();
    const flagsBefore = { ...engine.world.storyFlags };
    const countersBefore = { ...engine.world.eventCounters };
    engine.ingest(retractionEv("SC-1"));
    const results = drain();
    expect(results[0].storyMessages).toEqual([]); // compensation carries no beat payload
    expect(engine.world.storyFlags).toEqual(flagsBefore); // no beat fired
    expect(engine.world.eventCounters).toEqual(countersBefore); // no meter/counter coupling
  });

  it("deed cap: full log still transitions the ledger", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000 }));
    drain();
    engine.world.deeds = Array.from({ length: 50 }, (_, i) => `deed ${i}`);
    const r = compensatePaid(engine.world, appliedEntryOf(engine), new Date(9_000_000).toISOString());
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.deedApplied).toBe(false);
    expect(r.entry.status).toBe("compensated");
    expect(r.world.deeds).toHaveLength(50);
  });

  it("regression spot check: commands still work after compensation", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:S1", platformEventId: "S1", amount: 15000 }));
    drain();
    engine.ingest(retractionEv("S1"));
    drain();
    const hpBefore = engine.world.enemy.hp;
    engine.ingestCommand("u9", "U9", "!strike", "cmd-after");
    drain();
    expect(engine.world.enemy.hp).toBe(hpBefore - 7);
  });
});
