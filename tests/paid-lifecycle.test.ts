import { describe, expect, it } from "vitest";
import { compensatePaid } from "../src/engine/compensate";
import { GameEngine } from "../src/engine/engine";
import { QUEUE } from "../src/engine/config";
import { ledgerStatus, PAID_LEDGER_MAX_ENTRIES } from "../src/engine/ledger";
import {
  castSessionVote,
  closeStream,
  contributeToSessionMeter,
  openSessionVote,
  openStream,
  type StreamSession,
} from "../src/engine/lifecycle";
import {
  initialWorld,
  type CanonicalEvent,
  type PaidLedgerAppliedEntry,
  type WorldState,
} from "../src/engine/types";
import { deserialize, serialize } from "../src/persistence/store";
import {
  ROUTE_VOTE,
  TIDEBOUND_LIBRARY,
  TIDEBOUND_METER_CHART,
} from "../src/content/tidebound";

function harness(seedNow = 1_000_000) {
  let t = seedNow;
  const now = () => t;
  const engine = new GameEngine({ now });
  const drain = () => {
    const out = [];
    for (let i = 0; i < 2000 && engine.queue.size > 0; i++) {
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
    amount: 15000,
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

function openSession(engine: GameEngine): StreamSession {
  const opened = openStream(engine.world);
  if (!opened.ok) throw new Error(opened.reason);
  return opened.session;
}

/** closeStream → loadWorld → openStream, mirroring the creator endStream path. */
function closeAndReopen(engine: GameEngine, session: StreamSession): StreamSession {
  const closed = closeStream(engine.world, session);
  if (!closed.ok) throw new Error(closed.reason);
  engine.loadWorld(closed.world);
  const opened = openStream(engine.world);
  if (!opened.ok) throw new Error(opened.reason);
  return opened.session;
}

function gameplayOf(w: WorldState) {
  // paidLedger (causality record) and lastUpdated (wall-clock metadata) are
  // not gameplay state; everything else must converge exactly.
  const { paidLedger: _ledger, lastUpdated: _ts, ...game } = w;
  return game;
}

function mkApplied(i: number, status: "applied" | "compensated"): PaidLedgerAppliedEntry {
  return {
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
  };
}

describe("Phase 5G-4 — queue / stream / failure-matrix integration", () => {
  // ---- Queue integration (§4) ----

  it("Paid → normal: queued, processed once, one applied entry", () => {
    const { engine, drain } = harness();
    expect(engine.ingest(paidEv({}))).toBe("queued");
    const results = drain();
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("paid_supply");
    expect(engine.world.paidLedger).toHaveLength(1);
    expect(engine.world.paidLedger[0].status).toBe("applied");
  });

  it("Retraction queues without actor/amount and processes to a note", () => {
    const { engine, drain } = harness();
    expect(engine.ingest(retractionEv("ZZ"))).toBe("queued");
    const results = drain();
    expect(results).toHaveLength(1);
    expect(engine.world.paidLedger).toHaveLength(1);
    expect(engine.world.paidLedger[0].status).toBe("retraction-noted");
  });

  it("Paid lane keeps priority: later-queued paid catalyst processes first", () => {
    const { engine, drain } = harness();
    engine.ingest(retractionEv("ELITE-1"));
    engine.ingest(paidEv({ eventId: "yt:ELITE-1", platformEventId: "ELITE-1", amount: 75000 }));
    const results = drain();
    expect(results.map((r) => r.action)).toEqual(["paid_elite", "rejected"]);
    expect(engine.world.paidLedger.find((e) => e.eventId === "yt:ELITE-1")!.status).toBe("compensated");
  });

  it("original → duplicate → retraction: duplicate absorbed, compensated once", () => {
    const { engine, drain } = harness();
    const ev = paidEv({});
    expect(engine.ingest(ev)).toBe("queued");
    expect(engine.ingest(structuredClone(ev))).toBe("duplicate");
    drain();
    engine.ingest(retractionEv("SC-1"));
    drain();
    expect(engine.world.paidLedger.filter((e) => e.eventId === "yt:SC-1")).toHaveLength(1);
    expect(engine.world.paidLedger.find((e) => e.eventId === "yt:SC-1")!.status).toBe("compensated");
    expect(engine.world.deeds.filter((d) => d.includes("recalled beyond the Pale"))).toHaveLength(1);
  });

  it("retraction → duplicate retraction → original: single apply + compensate", () => {
    const { engine, drain } = harness();
    expect(engine.ingest(retractionEv("SC-1"))).toBe("queued");
    expect(engine.ingest(retractionEv("SC-1"))).toBe("duplicate");
    drain();
    engine.ingest(paidEv({}));
    drain();
    const applied = engine.world.paidLedger.filter((e) => e.status !== "retraction-noted");
    expect(applied).toHaveLength(1);
    expect(applied[0].status).toBe("compensated");
    expect(engine.world.paidLedger.filter((e) => e.status === "retraction-noted")).toHaveLength(1);
  });

  it("duplicates after compensation are no-ops at every layer", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({}));
    drain();
    engine.ingest(retractionEv("SC-1"));
    drain();
    const deeds = [...engine.world.deeds];
    const ledgerLen = engine.world.paidLedger.length;
    // Same process: queue dedup absorbs both redeliveries.
    expect(engine.ingest(paidEv({}))).toBe("duplicate");
    expect(engine.ingest(retractionEv("SC-1"))).toBe("duplicate");
    // Post-restart: the paid id is primed from the ledger (ingest duplicate);
    // the retraction signal id is new to the queue, so it queues — then the
    // engine resolves it idempotently with zero mutation.
    const fresh = new GameEngine({ now: () => 9_000_000 }, structuredClone(engine.world));
    fresh.loadWorld(structuredClone(engine.world));
    expect(fresh.ingest(paidEv({}))).toBe("duplicate");
    expect(fresh.ingest(retractionEv("SC-1"))).toBe("queued");
    const out = [];
    for (let i = 0; i < 10 && fresh.queue.size > 0; i++) out.push(...fresh.pump());
    expect(out[0].summary).toContain("already resolved");
    expect(fresh.world.paidLedger).toHaveLength(ledgerLen);
    expect(fresh.world.deeds).toEqual(deeds);
  });

  it("dropped-full: paid and retraction drop without ledger or world effects", () => {
    const { engine } = harness();
    for (let i = 0; i < 100; i++) {
      expect(engine.ingestCommand(`u${i}`, `U${i}`, "!strike", `cmd-${i}`)).toBe("queued");
    }
    expect(engine.queue.size).toBe(100);
    expect(engine.ingest(paidEv({}))).toBe("dropped-full");
    expect(engine.ingest(retractionEv("SC-1"))).toBe("dropped-full");
    expect(engine.world.paidLedger).toEqual([]);
    expect(gameplayOf(engine.world)).toEqual(gameplayOf(initialWorld(new Date(1_000_000).toISOString())));
    // Dropped events were never added to `seen`: still retriable later.
    engine.queue.clear();
    expect(engine.ingest(paidEv({}))).toBe("queued");
    expect(engine.ingest(retractionEv("SC-1"))).toBe("queued");
  });

  it("malformed events fail closed at the queue boundary", () => {
    const { engine } = harness();
    expect(engine.ingest({ kind: "paid_retraction", eventId: "x", receivedAt: "t" } as never)).toBe("rejected-invalid");
    expect(engine.ingest({ kind: "paid_retraction", eventId: "x", receivedAt: "t", refPlatformId: "" } as never)).toBe("rejected-invalid");
    expect(engine.ingest({ kind: "paid_event", eventId: "x", actorId: "a", actorName: "b", amount: -5, currency: "INR", receivedAt: "t" } as never)).toBe(
      "rejected-invalid",
    );
    expect(engine.ingest(null as never)).toBe("rejected-invalid");
    expect(engine.queue.size).toBe(0);
    expect(engine.world.paidLedger).toEqual([]);
  });

  it("failed paid applications never create ledger entries", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:GOOD-1", platformEventId: "GOOD-1" }));
    expect(engine.ingest(paidEv({ eventId: "yt:GOOD-1", platformEventId: "GOOD-1" }))).toBe("duplicate");
    expect(engine.ingest({ kind: "paid_event", eventId: "yt:BAD", actorId: "a", actorName: "b", amount: 0, currency: "INR", receivedAt: "t" } as never)).toBe(
      "rejected-invalid",
    );
    engine.ingest(paidEv({ eventId: "yt:GOOD-2", platformEventId: "GOOD-2" }));
    const results = drain();
    expect(results.filter((r) => r.action === "paid_supply")).toHaveLength(2);
    expect(engine.world.paidLedger).toHaveLength(2);
  });

  // ---- Stream lifecycle / settlement (§5) ----

  it("Case A+B: applied entry survives close/open with only streamCount changed", () => {
    const { engine, drain } = harness();
    let session = openSession(engine);
    engine.ingest(paidEv({}));
    drain();
    const before = structuredClone(engine.world);
    session = closeAndReopen(engine, session);
    expect(engine.world.paidLedger).toHaveLength(1);
    expect(engine.world.paidLedger[0].status).toBe("applied");
    expect(engine.world.streamCount).toBe(before.streamCount + 1);
    const { paidLedger: _a, streamCount: _s1, ...gameBefore } = before;
    const { paidLedger: _b, streamCount: _s2, ...gameAfter } = engine.world;
    expect(gameAfter).toEqual(gameBefore);
    expect(session.streamNumber).toBe(2);
  });

  it("Case C: applied in N, retracted in N+1 — compensated, nothing rewound", () => {
    const { engine, drain } = harness();
    let session = openSession(engine);
    engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000 }));
    drain();
    const resourcesAfterCatalyst = engine.world.resources;
    session = closeAndReopen(engine, session);
    engine.ingest(retractionEv("SC-1"));
    drain();
    const entry = engine.world.paidLedger.find((e) => e.eventId === "yt:SC-1")!;
    expect(entry.status).toBe("compensated");
    expect(engine.world.streamCount).toBe(1); // never rewound
    expect(engine.world.resources).toBe(resourcesAfterCatalyst); // no clawback
    expect(session.streamNumber).toBe(2);
  });

  it("Case D: note in N, original in N+1 — applied then compensated", () => {
    const { engine, drain } = harness();
    let session = openSession(engine);
    engine.ingest(retractionEv("SC-9"));
    drain();
    session = closeAndReopen(engine, session);
    const hpBefore = engine.world.enemy.hp;
    engine.ingest(paidEv({ eventId: "yt:SC-9", platformEventId: "SC-9", amount: 5000 }));
    drain();
    const entry = engine.world.paidLedger.find((e) => e.eventId === "yt:SC-9")!;
    expect(entry.status).toBe("compensated");
    if (entry.status !== "compensated") throw new Error("expected compensated");
    expect(entry.appliedAtStream).toBe(2);
    expect(engine.world.paidLedger.filter((e) => e.status === "retraction-noted")).toHaveLength(1);
    expect(engine.world.enemy.hp).toBe(hpBefore); // exact reversal still held
  });

  it("Case E: persisted application + restart + retraction compensates once", () => {
    const h1 = harness();
    h1.engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000 }));
    h1.drain();
    const saved = serialize(h1.engine.world);
    const h2 = harness();
    h2.engine.loadWorld(deserialize(saved)!);
    h2.engine.ingest(retractionEv("SC-1"));
    const results = h2.drain();
    expect(results[0].summary).toContain("recalled beyond the Pale");
    expect(h2.engine.world.paidLedger.find((e) => e.eventId === "yt:SC-1")!.status).toBe("compensated");
  });

  it("Gale cross-stream exact: boundary alone never forces narrative", () => {
    const { engine, drain } = harness();
    let session = openSession(engine);
    const hpBefore = engine.world.enemy.hp;
    engine.ingest(paidEv({ eventId: "yt:G1", platformEventId: "G1", amount: 5000 }));
    drain();
    expect(engine.world.enemy.hp).toBe(hpBefore - 15);
    session = closeAndReopen(engine, session);
    void session;
    engine.ingest(retractionEv("G1"));
    drain();
    const entry = engine.world.paidLedger.find((e) => e.eventId === "yt:G1")!;
    expect(entry.status).toBe("compensated");
    if (entry.status !== "compensated") throw new Error("expected compensated");
    expect(entry.compensationNote).toBe("gale-exact-reversal");
    expect(engine.world.enemy.hp).toBe(hpBefore);
  });

  // ---- Ledger boundary / overflow (§6) ----

  it("ledgerStatus: empty, mixed, and overflow census (counts only)", () => {
    expect(ledgerStatus([])).toEqual({ total: 0, applied: 0, compensated: 0, noted: 0, overflow: false });
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:A", platformEventId: "A", amount: 15000 }));
    drain();
    engine.ingest(retractionEv("A"));
    drain();
    engine.ingest(retractionEv("UNKNOWN"));
    drain();
    const s = ledgerStatus(engine.world.paidLedger);
    expect(s).toEqual({ total: 2, applied: 0, compensated: 1, noted: 1, overflow: false });
    // No payment metadata leaks through the diagnostic shape.
    expect(Object.keys(s).sort()).toEqual(["applied", "compensated", "noted", "overflow", "total"]);
  });

  it("engine-level eviction retires oldest compensated first, never applied", () => {
    const { engine, drain } = harness();
    const ledger: PaidLedgerAppliedEntry[] = [];
    for (let i = 0; i < 199; i++) ledger.push(mkApplied(i, "compensated"));
    ledger.push(mkApplied(999, "applied"));
    engine.loadWorld({ ...initialWorld(new Date(1_000_000).toISOString()), paidLedger: ledger });
    engine.ingest(paidEv({ eventId: "yt:NEW", platformEventId: "NEW", amount: 15000 }));
    drain();
    expect(engine.world.paidLedger).toHaveLength(200);
    const ids = engine.world.paidLedger.map((e) => e.eventId);
    expect(ids).not.toContain("yt:SC-0");
    expect(ids).toContain("yt:SC-999");
    expect(ids).toContain("yt:NEW");
    expect(ledgerStatus(engine.world.paidLedger).overflow).toBe(false);
  });

  it("engine-level full-applied ledger preserves causality past the bound", () => {
    const { engine, drain } = harness();
    const ledger: PaidLedgerAppliedEntry[] = [];
    for (let i = 0; i < PAID_LEDGER_MAX_ENTRIES; i++) ledger.push(mkApplied(i, "applied"));
    engine.loadWorld({ ...initialWorld(new Date(1_000_000).toISOString()), paidLedger: ledger });
    engine.ingest(paidEv({ eventId: "yt:NEW", platformEventId: "NEW", amount: 15000 }));
    drain();
    expect(engine.world.paidLedger).toHaveLength(PAID_LEDGER_MAX_ENTRIES + 1);
    expect(engine.world.paidLedger.every((e) => e.status === "applied")).toBe(true);
    expect(ledgerStatus(engine.world.paidLedger).overflow).toBe(true);
    // The new catalyst still applied in gameplay.
    expect(engine.world.eventCounters["paid_supplies"]).toBe(1);
  });

  // ---- Persistence / atomicity (§7–8, §10) ----

  it("failed compensation leaves the entry applied (all failure modes)", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({}));
    drain();
    // All three failure modes are pure no-ops: the world is bit-identical.
    const beforeFailures = structuredClone(engine.world);
    // Not in world.
    const ghost: PaidLedgerAppliedEntry = { ...(appliedOf(engine)), eventId: "yt:GHOST" };
    expect(compensatePaid(engine.world, ghost, new Date(9_000_000).toISOString())).toEqual({
      ok: false,
      reason: "entry-not-in-world",
    });
    // Invalid shape.
    expect(compensatePaid(engine.world, { status: "applied" } as never, new Date(9_000_000).toISOString()).ok).toBe(false);
    expect(engine.world).toEqual(beforeFailures);
    // Already resolved (via the engine path) is equally side-effect free.
    engine.ingest(retractionEv("SC-1"));
    drain();
    const stored = engine.world.paidLedger.find((e) => e.eventId === "yt:SC-1")!;
    if (stored.status !== "compensated") throw new Error("expected compensated");
    const beforeRepeat = structuredClone(engine.world);
    expect(compensatePaid(engine.world, stored, new Date(9_000_001).toISOString())).toEqual({
      ok: false,
      reason: "already-resolved",
    });
    expect(engine.world).toEqual(beforeRepeat);
    expect(engine.world.paidLedger.filter((e) => e.status === "compensated")).toHaveLength(1);
  });

  function appliedOf(engine: GameEngine): PaidLedgerAppliedEntry {
    const e = engine.world.paidLedger.find((x) => x.status === "applied");
    if (!e || e.status !== "applied") throw new Error("expected one applied");
    return e;
  }

  it("no false settled state: pre-compensation bytes reload as applied and recover", () => {
    const h1 = harness();
    h1.engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000 }));
    h1.drain();
    const preCompensationBytes = serialize(h1.engine.world); // "persisted" before save of compensation
    h1.engine.ingest(retractionEv("SC-1"));
    h1.drain(); // compensated only in memory — imagine the save failed here
    // Reload the last good bytes: still applied, recovery compensates once.
    const h2 = harness();
    h2.engine.loadWorld(deserialize(preCompensationBytes)!);
    expect(h2.engine.world.paidLedger.find((e) => e.eventId === "yt:SC-1")!.status).toBe("applied");
    h2.engine.ingest(retractionEv("SC-1"));
    h2.drain();
    expect(h2.engine.world.paidLedger.find((e) => e.eventId === "yt:SC-1")!.status).toBe("compensated");
    expect(h2.engine.world.deeds.filter((d) => d.includes("recalled beyond the Pale"))).toHaveLength(1);
  });

  it("world + ledger persist as one atomic unit at every lifecycle step", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 75000 }));
    drain();
    const afterApply = serialize(engine.world);
    engine.ingest(retractionEv("SC-1"));
    drain();
    const afterCompensate = serialize(engine.world);
    const loadedApply = deserialize(afterApply)!;
    const loadedCompensate = deserialize(afterCompensate)!;
    expect(loadedApply).toEqual(engine.world.paidLedger ? { ...loadedApply } : loadedApply);
    expect(loadedApply.paidLedger.find((e) => e.eventId === "yt:SC-1")!.status).toBe("applied");
    expect(loadedCompensate.paidLedger.find((e) => e.eventId === "yt:SC-1")!.status).toBe("compensated");
    // Gameplay state travels with its causality record in the same bytes.
    expect(loadedCompensate.enemy.isElite).toBe(true);
    expect(loadedCompensate.eventCounters["elite_arrivals"]).toBe(1);
  });

  // ---- Regression invariants (§15 A–J) ----

  it("INVARIANT A: replay storms create exactly one history entry", () => {
    const h1 = harness();
    const ev = paidEv({});
    expect(h1.engine.ingest(ev)).toBe("queued");
    expect(h1.engine.ingest(structuredClone(ev))).toBe("duplicate");
    h1.drain();
    const h2 = harness();
    h2.engine.loadWorld(deserialize(serialize(h1.engine.world))!);
    expect(h2.engine.ingest(structuredClone(ev))).toBe("duplicate");
    const h3 = harness();
    const fresh = new GameEngine({ now: () => 9_000_000 }, deserialize(serialize(h1.engine.world))!);
    void h3;
    expect(fresh.ingest(structuredClone(ev))).toBe("queued");
    for (let i = 0; i < 10 && fresh.queue.size > 0; i++) fresh.pump();
    expect(fresh.world.paidLedger).toHaveLength(1);
    expect(fresh.world.paidLedger[0].status).toBe("applied");
  });

  it("INVARIANT C: unknown retractions carry zero payment fields by construction", () => {
    const { engine, drain } = harness();
    engine.ingest(retractionEv("NOPE"));
    drain();
    expect(engine.world.paidLedger).toHaveLength(1);
    const note = engine.world.paidLedger[0];
    if (note.status !== "retraction-noted") throw new Error("expected note");
    expect({ ...note }).toEqual({
      status: "retraction-noted",
      eventId: "yt:retraction:NOPE",
      platformEventId: "NOPE",
      notedAtIso: note.notedAtIso,
      notedAtStream: 1,
    });
  });

  it("INVARIANT D: PAID→RETRACT converges with RETRACT→PAID (notes excepted)", () => {
    const runSeq1 = () => {
      const { engine, drain } = harness();
      engine.ingest(paidEv({}));
      drain();
      engine.ingest(retractionEv("SC-1"));
      drain();
      return engine;
    };
    const runSeq2 = () => {
      const { engine, drain } = harness();
      engine.ingest(retractionEv("SC-1"));
      drain();
      engine.ingest(paidEv({}));
      drain();
      return engine;
    };
    const e1 = runSeq1();
    const e2 = runSeq2();
    // Same gameplay facts.
    expect(gameplayOf(e1.world)).toEqual(gameplayOf(e2.world));
    // Same applied/compensation history modulo deterministic timestamps…
    const stripTimes = (w: WorldState) =>
      w.paidLedger
        .filter((e) => e.status !== "retraction-noted")
        .map((e) => ({ ...e, appliedAtIso: 0, compensatedAtIso: 0 }));
    expect(stripTimes(e1.world)).toEqual(stripTimes(e2.world));
    expect(e1.world.deeds).toEqual(e2.world.deeds);
    expect(e1.storyLog).toEqual(e2.storyLog);
    // …except the preserved arrival-order evidence: seq2 keeps its note.
    expect(e1.world.paidLedger.filter((e) => e.status === "retraction-noted")).toHaveLength(0);
    expect(e2.world.paidLedger.filter((e) => e.status === "retraction-noted")).toHaveLength(1);
    // Recent-history head order differs deterministically and is documented:
    // seq1 appends the compensation after the catalyst result, while seq2
    // computes it inside the catalyst's own processing. Same members.
    expect(e1.recentResults.slice(0, 2).map((r) => r.action)).toEqual(["rejected", "paid_supply"]);
    expect(e2.recentResults.slice(0, 2).map((r) => r.action)).toEqual(["paid_supply", "rejected"]);
    expect(e1.recentResults[0].summary).toBe(e2.recentResults[1].summary); // compensation
    expect(e1.recentResults[1].summary).toBe(e2.recentResults[0].summary); // catalyst
  });

  it("INVARIANT E+F: compensation changes no counters and never rewinds progression", () => {
    const { engine, drain } = harness();
    engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 150000 }));
    drain();
    const arc = engine.world.currentArc;
    const chapter = engine.world.currentChapter;
    const wave = engine.world.waveNumber;
    const stream = engine.world.streamCount;
    const counters = {
      viewer: engine.world.totalViewerActions,
      paid: engine.world.totalPaidEvents,
      minor: engine.world.totalPaidMinorUnits,
      counters: { ...engine.world.eventCounters },
    };
    engine.ingest(retractionEv("SC-1"));
    drain();
    expect(engine.world.totalViewerActions).toBe(counters.viewer);
    expect(engine.world.totalPaidEvents).toBe(counters.paid);
    expect(engine.world.totalPaidMinorUnits).toBe(counters.minor);
    expect(engine.world.eventCounters).toEqual(counters.counters);
    expect(engine.world.currentArc).toBeGreaterThanOrEqual(arc);
    expect(engine.world.currentChapter).toBeGreaterThanOrEqual(chapter);
    expect(engine.world.waveNumber).toBeGreaterThanOrEqual(wave);
    expect(engine.world.streamCount).toBe(stream);
  });

  it("INVARIANT G: votes and meters never advance because of compensation", () => {
    const { engine, drain } = harness();
    let session = openSession(engine);
    const opened = openSessionVote(session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!opened.ok) throw new Error(opened.reason);
    session = opened.session;
    const casted = castSessionVote(session, "voter-1", 0);
    if (!casted.ok) throw new Error(casted.reason);
    session = casted.session;
    const metered = contributeToSessionMeter(session, engine.world, TIDEBOUND_METER_CHART, "scout-1");
    if (!metered.ok) throw new Error(metered.reason);
    engine.loadWorld(metered.world);
    session = metered.session;
    const voteBefore = structuredClone(session.activeVote);
    const contributorsBefore = structuredClone(session.meterContributors);
    const meterBefore = engine.world.eventCounters["meter.pale-chart"];
    engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000 }));
    drain();
    engine.ingest(retractionEv("SC-1"));
    const results = drain();
    expect(results[0].summary).toContain("recalled beyond the Pale");
    // Compensation results are app-guard-compatible silent results.
    expect(results[0].action).toBe("rejected");
    expect(results[0].actorName).toBe("world");
    expect(session.activeVote).toEqual(voteBefore);
    expect(session.meterContributors).toEqual(contributorsBefore);
    expect(engine.world.eventCounters["meter.pale-chart"]).toBe(meterBefore);
  });

  it("INVARIANT H+J: restart around compensation preserves idempotency, failures stay applied", () => {
    const h1 = harness();
    h1.engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000 }));
    h1.drain();
    h1.engine.ingest(retractionEv("SC-1"));
    h1.drain();
    // Post-restart the paid id is primed (ingest duplicate); the retraction
    // signal queues, then resolves idempotently with zero mutation.
    const h2 = harness();
    h2.engine.loadWorld(deserialize(serialize(h1.engine.world))!);
    expect(h2.engine.ingest(paidEv({ eventId: "yt:SC-1", platformEventId: "SC-1", amount: 15000 }))).toBe("duplicate");
    expect(h2.engine.ingest(retractionEv("SC-1"))).toBe("queued"); // signal id is new to this queue
    const out2 = [];
    for (let i = 0; i < 10 && h2.engine.queue.size > 0; i++) out2.push(...h2.engine.pump());
    expect(out2[0].summary).toContain("already resolved");
    expect(h2.engine.world.paidLedger).toHaveLength(1);
    const h3 = harness();
    const fresh = new GameEngine({ now: () => 9_000_000 }, deserialize(serialize(h1.engine.world))!);
    void h3;
    fresh.ingest(retractionEv("SC-1"));
    const out = [];
    for (let i = 0; i < 10 && fresh.queue.size > 0; i++) out.push(...fresh.pump());
    expect(out[0].summary).toContain("already resolved");
    expect(fresh.world.paidLedger.filter((e) => e.status === "compensated")).toHaveLength(1);
  });

  it("regression spot: commands work normally after cross-stream compensation", () => {
    const { engine, drain } = harness();
    let session = openSession(engine);
    engine.ingest(paidEv({ eventId: "yt:S1", platformEventId: "S1", amount: 15000 }));
    drain();
    session = closeAndReopen(engine, session);
    engine.ingest(retractionEv("S1"));
    drain();
    void session;
    const hpBefore = engine.world.enemy.hp;
    engine.ingestCommand("u9", "U9", "!strike", "cmd-after");
    drain();
    expect(engine.world.enemy.hp).toBe(hpBefore - 7);
  });
});
