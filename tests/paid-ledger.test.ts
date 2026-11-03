import { describe, expect, it } from "vitest";
import { GameEngine } from "../src/engine/engine";
import { PAID_TIERS, QUEUE, type PaidTier } from "../src/engine/config";
import {
  addRetractionNoteEntry,
  appendPaidLedgerEntry,
  findLedgerEntriesByPlatformId,
  findLedgerEntryByEventId,
  makeRetractionNoteEntry,
  PAID_LEDGER_MAX_ENTRIES,
  validatePaidLedger,
} from "../src/engine/ledger";
import { initialWorld, type CanonicalEvent, type PaidLedgerAppliedEntry } from "../src/engine/types";
import { deserialize, serialize } from "../src/persistence/store";

function harness(seedNow = 1_000_000) {
  let t = seedNow;
  const now = () => t;
  const engine = new GameEngine({ now });
  const advance = (ms: number) => {
    t += ms;
  };
  const drain = () => {
    const out = [];
    for (let i = 0; i < 500 && engine.queue.size > 0; i++) {
      t += QUEUE.minGapMs + 50;
      out.push(...engine.pump());
    }
    return out;
  };
  return { engine, drain, advance, now: () => t };
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

describe("Phase 5G-2 — persistent paid ledger", () => {
  // ---- Serialization (§16.1–5) ----

  it("1. empty ledger survives round-trip", () => {
    const w = initialWorld("2026-11-03T00:00:00.000Z");
    expect(deserialize(serialize(w))).toEqual(w);
  });

  it("2. one applied entry survives round-trip", () => {
    const { engine, drain } = harness();
    expect(engine.ingest(paidEv({}))).toBe("queued");
    drain();
    expect(engine.world.paidLedger).toHaveLength(1);
    expect(deserialize(serialize(engine.world))).toEqual(engine.world);
  });

  it("3. optional compensation fields survive round-trip", () => {
    const entry: PaidLedgerAppliedEntry = {
      status: "compensated",
      eventId: "yt:SC-9",
      platformEventId: "SC-9",
      actorId: "yt:UC-X",
      amount: 50000,
      currency: "INR",
      tierKey: "paid_elite",
      appliedAtIso: new Date(1_000_000).toISOString(),
      appliedAtStream: 1,
      appliedCheckpoint: { arc: 1, chapter: 1, wave: 1 },
      compensatedAtIso: new Date(2_000_000).toISOString(),
      compensationNote: "5G-3 fixture",
    };
    const w = { ...initialWorld("2026-11-03T00:00:00.000Z"), paidLedger: [entry] };
    expect(deserialize(serialize(w))).toEqual(w);
  });

  it("4. schema migration: v1 save without paidLedger loads with defaults", () => {
    const w = initialWorld("2026-11-03T00:00:00.000Z");
    const old = JSON.parse(serialize(w)) as Record<string, unknown>;
    old.schemaVersion = 1;
    delete old.paidLedger;
    const loaded = deserialize(JSON.stringify(old));
    expect(loaded).not.toBeNull();
    expect(loaded!.paidLedger).toEqual([]);
    expect(loaded!.resources).toBe(w.resources);
    expect(loaded!.currentArc).toBe(w.currentArc);
  });

  it("4b. malformed ledger rejects the save (existing invalid-save rule)", () => {
    const w = initialWorld("2026-11-03T00:00:00.000Z");
    const bad = (ledger: unknown) => {
      const o = JSON.parse(serialize(w)) as Record<string, unknown>;
      o.paidLedger = ledger;
      return deserialize(JSON.stringify(o));
    };
    expect(bad("nope")).toBeNull();
    expect(bad([{ status: "applied" }])).toBeNull();
    expect(
      bad([{ status: "applied", eventId: "x", platformEventId: "x", actorId: "a", amount: 1, currency: "INR", tierKey: "nope", appliedAtIso: "t", appliedAtStream: 1, appliedCheckpoint: { arc: 1, chapter: 1, wave: 1 } }]),
    ).toBeNull();
  });

  it("5. existing world shape still round-trips (no gameplay drift on load)", () => {
    const { engine, drain } = harness();
    engine.ingestCommand("u1", "A", "!strike", "cmd-1");
    drain();
    const loaded = deserialize(serialize(engine.world));
    expect(loaded).toEqual(engine.world);
  });

  // ---- Paid application (§16.6–11) ----

  it("6+8+9. paid event creates exactly one ledger entry with exact context", () => {
    const { engine, drain } = harness();
    engine.world.streamCount = 3;
    engine.world.currentArc = 2;
    engine.world.currentChapter = 2;
    engine.world.waveNumber = 5;
    expect(engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000, currency: "INR" }))).toBe("queued");
    const results = drain();
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("paid_supply");
    expect(engine.world.paidLedger).toHaveLength(1);
    expect(engine.world.paidLedger[0]).toEqual({
      status: "applied",
      eventId: "yt:SC-1",
      platformEventId: "SC-1",
      actorId: "yt:UC-DONOR",
      amount: 15000,
      currency: "INR",
      tierKey: "paid_supply",
      appliedAtIso: new Date(1_000_000 + QUEUE.minGapMs + 50).toISOString(),
      appliedAtStream: 4,
      appliedCheckpoint: { arc: 2, chapter: 2, wave: 5 },
    });
  });

  it("7. correct tier is persisted per amount", () => {
    const cases = [
      { amount: 5000, tier: "paid_strike" },
      { amount: 15000, tier: "paid_supply" },
      { amount: 75000, tier: "paid_elite" },
      { amount: 150000, tier: "paid_story" },
    ] as const;
    for (const c of cases) {
      const { engine, drain } = harness();
      engine.ingest(paidEv({ eventId: `yt:SC-${c.amount}`, platformEventId: `SC-${c.amount}`, amount: c.amount }));
      const results = drain();
      expect(results[0].action).toBe(c.tier);
      expect(engine.world.paidLedger[0]).toMatchObject({ tierKey: c.tier, amount: c.amount });
    }
  });

  it("11. applied timestamp uses deterministic engine time", () => {
    const { engine, drain } = harness(5_000_000);
    engine.ingest(paidEv({}));
    drain();
    expect(engine.world.paidLedger[0]).toMatchObject({
      appliedAtIso: new Date(5_000_000 + QUEUE.minGapMs + 50).toISOString(),
    });
  });

  it("checkpoint captures settled post-beat state (Bell advances chapter first)", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:BELL", platformEventId: "BELL", amount: 150000 }));
    drain();
    const entry = engine.world.paidLedger[0];
    expect(entry.status).toBe("applied");
    if (entry.status !== "applied") throw new Error("expected applied");
    // The Bell's story beat advanced the chapter; the checkpoint records the
    // settled position 5G-3 must compare against, not the pre-beat moment.
    expect(entry.appliedCheckpoint.chapter).toBe(engine.world.currentChapter);
    expect(entry.appliedCheckpoint.chapter).toBe(2);
  });

  // ---- Idempotency (§16.12–15) ----

  it("12. same paid event in the same process applies exactly once", () => {
    const { engine, drain } = harness();
    const ev = paidEv({});
    expect(engine.ingest(ev)).toBe("queued");
    expect(engine.ingest(structuredClone(ev))).toBe("duplicate");
    drain();
    expect(engine.world.paidLedger).toHaveLength(1);
    expect(engine.world.totalPaidEvents).toBe(1);
    expect(engine.world.eventCounters["paid_events"]).toBe(1);
  });

  it("13. same paid event after serialize/reload does not apply twice", () => {
    const h1 = harness();
    const ev = paidEv({});
    h1.engine.ingest(ev);
    h1.drain();
    const saved = serialize(h1.engine.world);
    // Fresh process via loadWorld: the queue `seen` set is re-primed from
    // the ledger, so redelivery is a duplicate at ingest.
    const h2 = harness();
    h2.engine.loadWorld(deserialize(saved)!);
    expect(h2.engine.ingest(structuredClone(ev))).toBe("duplicate");
    expect(h2.engine.world.paidLedger).toHaveLength(1);
    // Process-level guarantee: a world carrying the entry never re-applies,
    // even when the queue has no memory of it (constructor-seed path).
    const world = deserialize(saved)!;
    const fresh = new GameEngine({ now: () => 9_000_000 }, world);
    expect(fresh.ingest(structuredClone(ev))).toBe("queued");
    const before = structuredClone(fresh.world);
    for (let i = 0; i < 10 && fresh.queue.size > 0; i++) fresh.pump();
    const { paidLedger: _a, ...gameBefore } = before;
    const { paidLedger: _b, ...gameAfter } = fresh.world;
    expect(gameAfter).toEqual(gameBefore);
    expect(fresh.world.paidLedger).toHaveLength(1);
    expect(fresh.world.totalPaidEvents).toBe(1);
  });

  it("14. compensated fixture does not re-apply", () => {
    const entry: PaidLedgerAppliedEntry = {
      status: "compensated",
      eventId: "yt:SC-9",
      platformEventId: "SC-9",
      actorId: "yt:UC-X",
      amount: 75000,
      currency: "INR",
      tierKey: "paid_elite",
      appliedAtIso: new Date(1_000_000).toISOString(),
      appliedAtStream: 1,
      appliedCheckpoint: { arc: 1, chapter: 1, wave: 1 },
      compensatedAtIso: new Date(2_000_000).toISOString(),
      compensationNote: "5G-3 fixture",
    };
    const world = { ...initialWorld("2026-11-03T00:00:00.000Z"), paidLedger: [entry] };
    const fresh = new GameEngine({ now: () => 9_000_000 }, structuredClone(world));
    const ev = paidEv({ eventId: "yt:SC-9", platformEventId: "SC-9", amount: 75000 });
    expect(fresh.ingest(ev)).toBe("queued");
    for (let i = 0; i < 10 && fresh.queue.size > 0; i++) fresh.pump();
    const { paidLedger: _a, ...gameBefore } = world;
    const { paidLedger: _b, ...gameAfter } = fresh.world;
    expect(gameAfter).toEqual(gameBefore);
    expect(fresh.world.paidLedger).toHaveLength(1);
    expect(fresh.world.paidLedger[0].status).toBe("compensated");
  });

  // ---- Retraction lookup (§16.16–20) ----

  it("16. retraction referencing an applied entry compensates exactly once", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000 }));
    drain();
    const resourcesAfterCatalyst = engine.world.resources;
    const beforeDeeds = [...engine.world.deeds];
    engine.ingest(retractionEv("SC-1"));
    const results = drain();
    expect(results).toHaveLength(1);
    expect(results[0].summary).toContain("recalled beyond the Pale");
    const entry = engine.world.paidLedger[0];
    expect(entry.status).toBe("compensated");
    if (entry.status !== "compensated") throw new Error("expected compensated");
    expect(entry.compensationNote).toBe("supply-narrative-compensation");
    expect(typeof entry.compensatedAtIso).toBe("string");
    // No clawback: the convoy's supplies stand; history grows by one deed.
    expect(engine.world.resources).toBe(resourcesAfterCatalyst);
    expect(engine.world.paidLedger).toHaveLength(1);
    expect(engine.world.deeds.length).toBe(beforeDeeds.length + 1);
    expect(engine.world.deeds[engine.world.deeds.length - 1]).toContain("recalled beyond the Pale");
  });

  it("17. retraction referencing a compensated entry is already resolved", () => {
    const entry: PaidLedgerAppliedEntry = {
      status: "compensated",
      eventId: "yt:SC-9",
      platformEventId: "SC-9",
      actorId: "yt:UC-X",
      amount: 75000,
      currency: "INR",
      tierKey: "paid_elite",
      appliedAtIso: new Date(1_000_000).toISOString(),
      appliedAtStream: 1,
      appliedCheckpoint: { arc: 1, chapter: 1, wave: 1 },
    };
    const { engine, drain } = harness();
    engine.loadWorld({ ...initialWorld("2026-11-03T00:00:00.000Z"), paidLedger: [entry] });
    const before = structuredClone(engine.world);
    engine.ingest(retractionEv("SC-9"));
    const results = drain();
    expect(results[0].summary).toContain("already resolved");
    expect(engine.world).toEqual(before);
  });

  it("18. unknown retraction mutates no gameplay state", () => {
    const { engine, drain } = harness();
    engine.ingest(retractionEv("NOPE-1"));
    drain();
    const { paidLedger: _ledger, ...game } = engine.world;
    const { paidLedger: _expectedLedger, ...expectedGame } = initialWorld(new Date(1_000_000).toISOString());
    expect(game).toEqual(expectedGame);
    expect(engine.world.paidLedger).toHaveLength(1);
    const note = engine.world.paidLedger[0];
    expect(note.status).toBe("retraction-noted");
    expect(note).not.toHaveProperty("actorId");
    expect(note).not.toHaveProperty("amount");
    expect(note).not.toHaveProperty("tierKey");
  });

  it("19. retraction-before-original: catalyst + compensation, note preserved", () => {
    const { engine, drain } = harness();
    engine.ingest(retractionEv("SC-77"));
    drain();
    expect(engine.world.paidLedger).toHaveLength(1);
    const hpBefore = engine.world.enemy.hp;
    engine.ingest(paidEv({ eventId: "yt:SC-77", platformEventId: "SC-77", amount: 5000 }));
    const results = drain();
    expect(results[results.length - 1].action).toBe("paid_strike");
    // Same wave, same live non-elite enemy: the Gale wound closes exactly.
    expect(engine.world.enemy.hp).toBe(hpBefore);
    // applied → compensated immediately; the note stays as evidence.
    expect(engine.world.paidLedger).toHaveLength(2);
    const applied = engine.world.paidLedger.filter((e) => e.status !== "retraction-noted");
    expect(applied).toHaveLength(1);
    expect(applied[0].status).toBe("compensated");
    if (applied[0].status !== "compensated") throw new Error("expected compensated");
    expect(applied[0].compensationNote).toBe("gale-exact-reversal");
    expect(engine.world.paidLedger.filter((e) => e.status === "retraction-noted")).toHaveLength(1);
  });

  it("20. duplicate retraction is deterministic", () => {
    const { engine, drain } = harness();
    engine.ingest(retractionEv("SC-1"));
    drain();
    expect(engine.world.paidLedger).toHaveLength(1);
    // Post-restart redelivery of the same signal: the queue has no memory,
    // but the ledger makes the outcome deterministic — no second note.
    const mkFresh = (w: typeof engine.world) =>
      new GameEngine({ now: () => 9_000_000 }, structuredClone(w));
    const b = mkFresh(engine.world);
    b.ingest(retractionEv("SC-1"));
    for (let i = 0; i < 10 && b.queue.size > 0; i++) b.pump();
    expect(b.world.paidLedger).toHaveLength(1);
    expect(b.recentResults[0].summary).toContain("already noted");
    const c = mkFresh(b.world);
    c.ingest(retractionEv("SC-1"));
    for (let i = 0; i < 10 && c.queue.size > 0; i++) c.pump();
    expect(c.world.paidLedger).toHaveLength(1);
    expect(c.recentResults[0].summary).toBe(b.recentResults[0].summary);
  });

  // ---- Bounds (§16.21–24) ----

  it("21+22. ledger evicts oldest compensated/notes first, never applied", () => {
    const mk = (i: number, status: "applied" | "compensated"): PaidLedgerAppliedEntry => ({
      status,
      eventId: `yt:SC-${i}`,
      platformEventId: `SC-${i}`,
      actorId: "yt:UC-X",
      amount: 5000,
      currency: "INR",
      tierKey: "paid_strike",
      appliedAtIso: new Date(1_000_000).toISOString(),
      appliedAtStream: 1,
      appliedCheckpoint: { arc: 1, chapter: 1, wave: 1 },
    });
    const full: PaidLedgerAppliedEntry[] = [];
    for (let i = 0; i < 199; i++) full.push(mk(i, "compensated"));
    full.push(mk(999, "applied"));
    const extra = mk(1000, "applied");
    const r = appendPaidLedgerEntry(full, extra);
    expect(r.overflowed).toBe(false);
    expect(r.ledger).toHaveLength(200);
    expect(r.ledger.map((e) => e.eventId)).not.toContain("yt:SC-0"); // oldest compensated evicted
    expect(r.ledger.map((e) => e.eventId)).toContain("yt:SC-999"); // applied preserved
    expect(r.ledger.map((e) => e.eventId)).toContain("yt:SC-1000");
    // Notes are evictable too.
    const withNote = appendPaidLedgerEntry(
      r.ledger,
      makeRetractionNoteEntry("yt:retraction:ZZ", "ZZ", new Date(1_000_000).toISOString(), 1),
    );
    expect(withNote.ledger).toHaveLength(200);
    expect(withNote.ledger.filter((e) => e.status === "applied")).toHaveLength(2);
  });

  it("23+24. full-of-applied ledger preserves causality instead of evicting", () => {
    const mk = (i: number): PaidLedgerAppliedEntry => ({
      status: "applied",
      eventId: `yt:SC-${i}`,
      platformEventId: `SC-${i}`,
      actorId: "yt:UC-X",
      amount: 5000,
      currency: "INR",
      tierKey: "paid_strike",
      appliedAtIso: new Date(1_000_000).toISOString(),
      appliedAtStream: 1,
      appliedCheckpoint: { arc: 1, chapter: 1, wave: 1 },
    });
    const full: PaidLedgerAppliedEntry[] = [];
    for (let i = 0; i < PAID_LEDGER_MAX_ENTRIES; i++) full.push(mk(i));
    const r = appendPaidLedgerEntry(full, mk(PAID_LEDGER_MAX_ENTRIES));
    expect(r.overflowed).toBe(true);
    expect(r.ledger).toHaveLength(PAID_LEDGER_MAX_ENTRIES + 1);
    expect(r.ledger.every((e) => e.status === "applied")).toBe(true);
  });

  // ---- Invariants (§17) + regression (§16.25–29 spot checks) ----

  it("Invariant A+B: every applied event has exactly one entry; reload never duplicates", () => {
    const h1 = harness();
    const ids = ["yt:A-1", "yt:A-2", "yt:A-3"];
    for (const id of ids) h1.engine.ingest(paidEv({ eventId: id, platformEventId: id.slice(3), amount: 5000 }));
    h1.drain();
    expect(h1.engine.world.paidLedger.map((e) => e.eventId).sort()).toEqual([...ids].sort());
    const saved = serialize(h1.engine.world);
    const h2 = harness();
    h2.engine.loadWorld(deserialize(saved)!);
    for (const id of ids) {
      expect(h2.engine.ingest(paidEv({ eventId: id, platformEventId: id.slice(3), amount: 5000 }))).toBe("duplicate");
    }
    expect(h2.engine.world.paidLedger).toHaveLength(3);
  });

  it("Invariant C: persisted tierKey survives creator tier reconfiguration", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000 }));
    drain();
    expect(engine.world.paidLedger[0]).toMatchObject({ tierKey: "paid_supply" });
    const saved = serialize(engine.world);
    const orig = PAID_TIERS["INR"];
    try {
      (PAID_TIERS as Record<string, PaidTier[]>).INR = [
        { minMinor: 1, key: "paid_story", does: "reconfigured" },
      ];
      const loaded = deserialize(saved)!;
      expect(loaded.paidLedger[0]).toMatchObject({ tierKey: "paid_supply", amount: 15000 });
    } finally {
      (PAID_TIERS as Record<string, PaidTier[]>).INR = orig;
    }
  });

  it("Invariant D: ledger round-trip alters no gameplay state", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 75000 }));
    drain();
    engine.ingest(retractionEv("UNKNOWN-1"));
    drain();
    expect(deserialize(serialize(engine.world))).toEqual(engine.world);
  });

  it("lookup helpers behave", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1" }));
    drain();
    expect(findLedgerEntryByEventId(engine.world.paidLedger, "yt:SC-1")?.status).toBe("applied");
    expect(findLedgerEntryByEventId(engine.world.paidLedger, "yt:NOPE")).toBeUndefined();
    expect(findLedgerEntriesByPlatformId(engine.world.paidLedger, "SC-1")).toHaveLength(1);
    expect(findLedgerEntriesByPlatformId(engine.world.paidLedger, "NOPE")).toHaveLength(0);
    expect(validatePaidLedger(engine.world.paidLedger)).toBe(true);
    expect(validatePaidLedger([{ status: "applied" }])).toBe(false);
    expect(addRetractionNoteEntry(engine.world.paidLedger, makeRetractionNoteEntry("yt:retraction:X", "X", new Date(1_000_000).toISOString(), 1)).duplicate).toBe(false);
  });
});
