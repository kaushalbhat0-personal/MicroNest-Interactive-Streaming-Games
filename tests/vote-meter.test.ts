import { describe, expect, it } from "vitest";
import { QUEUE } from "../src/engine/config";
import { GameEngine } from "../src/engine/engine";
import {
  castSessionVote,
  closeSessionVote,
  closeStream,
  contributeToSessionMeter,
  noteSessionCommand,
  openSessionVote,
  openStream,
  overrideSessionVote,
  resolveSessionVote,
  resetSessionMeterContributors,
  supplyThresholdContext,
  type StreamSession,
} from "../src/engine/lifecycle";
import {
  castVote,
  closeVote,
  isVoteClosed,
  noteCommandProcessed,
  openVote,
  resolveVote,
  tallyVote,
  validateActiveVote,
} from "../src/engine/vote";
import {
  contributeToMeter,
  freshMeterContributors,
  validateMeterContributors,
  validateMeterDefinition,
  validateMeterSet,
  type MeterDefinition,
} from "../src/engine/meter";
import { isKnownCounter, resolveCounter } from "../src/engine/predicates";
import {
  collectCandidates,
  fireTemplate,
  validateEventTemplate,
  type EventTemplate,
} from "../src/engine/templates";
import { deserialize, serialize } from "../src/persistence/store";
import { initialWorld, type WorldState } from "../src/engine/types";

// ---------------------------------------------------------------------------
// Test-only content: two vote options + a third option + one meter
// completion template. Plain data, never imported by production code.
// ---------------------------------------------------------------------------

const VOTE_A: EventTemplate = {
  id: "vote-dawn-a",
  trigger: { kind: "manual" },
  condition: { op: "gte", counter: "resources", value: 0 },
  effects: [
    { op: "addResolve", amount: 5 },
    { op: "appendDeed", deed: "The assembly chose the dawn road." },
  ],
  repeat: { kind: "endless" },
  weight: 1,
};

const VOTE_B: EventTemplate = {
  id: "vote-dawn-b",
  trigger: { kind: "manual" },
  condition: { op: "gte", counter: "resources", value: 0 },
  effects: [
    { op: "addSupplies", amount: 5 },
    { op: "appendDeed", deed: "The assembly chose the dusk road." },
  ],
  repeat: { kind: "endless" },
  weight: 1,
};

const VOTE_C: EventTemplate = {
  id: "vote-dawn-c",
  trigger: { kind: "manual" },
  condition: { op: "gte", counter: "resources", value: 0 },
  effects: [{ op: "appendDeed", deed: "The assembly chose the quiet road." }],
  repeat: { kind: "endless" },
  weight: 1,
};

const LIGHTHOUSE_LIT: EventTemplate = {
  id: "lighthouse-lit",
  trigger: { kind: "threshold", counter: "meter.lighthouse-repairs", value: 3 },
  condition: { op: "flagUnset", flag: "lighthouse-lit" },
  effects: [
    { op: "setFlag", flag: "lighthouse-lit" },
    { op: "appendDeed", deed: "The lighthouse burns again." },
  ],
  repeat: { kind: "once" },
  weight: 5,
};

const LIBRARY: EventTemplate[] = [VOTE_A, VOTE_B, VOTE_C, LIGHTHOUSE_LIT];

const METER: MeterDefinition = { id: "lighthouse-repairs", target: 3, unitText: "repairs" };

function world(over: Partial<WorldState> = {}): WorldState {
  return { ...initialWorld("2026-11-03T00:00:00.000Z"), ...over };
}

function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) freeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

function opened(): { w: WorldState; s: StreamSession } {
  const w = world();
  const r = openStream(w);
  if (!r.ok) throw new Error("expected open");
  return { w: r.world, s: r.session };
}

function sessionVote(s: StreamSession, maxCommands = 10): StreamSession {
  const r = openSessionVote(s, {
    id: "vote-1",
    options: ["vote-dawn-a", "vote-dawn-b"],
    maxCommands,
    library: LIBRARY,
  });
  if (!r.ok) throw new Error(`expected vote open: ${JSON.stringify(r)}`);
  return r.session;
}

/** Controllable clock so engine cooldowns / rates are exact. */
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
  return { engine, drain };
}

// ---------------------------------------------------------------------------
// Votes
// ---------------------------------------------------------------------------

describe("Phase 5C — vote opening", () => {
  it("1. valid vote opens with a fresh deterministic state", () => {
    const r = openVote({
      id: "vote-1",
      options: ["vote-dawn-a", "vote-dawn-b"],
      scope: "stream-1",
      maxCommands: 5,
      library: LIBRARY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.vote).toEqual({
      id: "vote-1",
      options: ["vote-dawn-a", "vote-dawn-b"],
      scope: "stream-1",
      maxCommands: 5,
      commandsProcessed: 0,
      ballots: {},
      closed: false,
    });
    expect(validateActiveVote(r.vote)).toBe(true);
  });

  it("2. invalid option counts are rejected (need 2–3)", () => {
    const base = { id: "v", scope: "s", maxCommands: 3, library: LIBRARY };
    for (const options of [[], ["vote-dawn-a"], ["a", "b", "c", "d"], "nope", null]) {
      expect(openVote({ ...base, options })).toEqual({ ok: false, reason: "invalid-option-count" });
    }
    // Three options are accepted.
    expect(
      openVote({ ...base, options: ["vote-dawn-a", "vote-dawn-b", "vote-dawn-c"] }).ok,
    ).toBe(true);
  });

  it("3. duplicate options are rejected", () => {
    expect(
      openVote({
        id: "v",
        options: ["vote-dawn-a", "vote-dawn-a"],
        scope: "s",
        maxCommands: 3,
        library: LIBRARY,
      }),
    ).toEqual({ ok: false, reason: "duplicate-option" });
  });

  it("4. unknown or malformed template options are rejected", () => {
    const base = { id: "v", scope: "s", maxCommands: 3 };
    expect(openVote({ ...base, options: ["vote-dawn-a", "no-such-template"], library: LIBRARY })).toEqual({
      ok: false,
      reason: "invalid-option-template:no-such-template",
    });
    const brokenLib = [{ ...VOTE_A }, { op: "nope" }];
    expect(openVote({ ...base, options: ["vote-dawn-a", "vote-dawn-b"], library: brokenLib })).toEqual({
      ok: false,
      reason: "invalid-option-template:vote-dawn-b",
    });
    expect(openVote({ ...base, options: ["vote-dawn-a", "vote-dawn-b"], library: "nope" })).toEqual({
      ok: false,
      reason: "invalid-templates-list",
    });
  });

  it("5. opening validates input and never mutates the session", () => {
    const { s } = opened();
    const before = JSON.stringify(s);
    expect(openVote({ id: "", options: ["a", "b"], scope: "s", maxCommands: 3, library: LIBRARY })).toEqual({
      ok: false,
      reason: "invalid-vote-id",
    });
    expect(openVote({ id: "v", options: ["vote-dawn-a", "vote-dawn-b"], scope: "", maxCommands: 3, library: LIBRARY })).toEqual({
      ok: false,
      reason: "invalid-scope",
    });
    for (const maxCommands of [0, -2, 1.5, NaN, "3"]) {
      expect(openVote({ id: "v", options: ["vote-dawn-a", "vote-dawn-b"], scope: "s", maxCommands, library: LIBRARY }).ok).toBe(false);
    }
    // A failed session open leaves the session untouched.
    const bad = openSessionVote(s, { id: "v", options: ["nope", "missing"], maxCommands: 3, library: LIBRARY });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
    // Opening while a vote runs fails closed instead of discarding ballots.
    let running = sessionVote(s);
    const casted = castSessionVote(running, "a", 0);
    if (!casted.ok) throw new Error("expected cast");
    running = casted.session;
    expect(openSessionVote(running, { id: "v2", options: ["vote-dawn-a", "vote-dawn-b"], maxCommands: 3, library: LIBRARY })).toEqual({
      ok: false,
      reason: "vote-active",
    });
  });
});

describe("Phase 5C — casting ballots", () => {
  it("6. a valid actor can vote", () => {
    const { s } = opened();
    const r = castSessionVote(sessionVote(s), "actor-a", 1);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.session.activeVote?.ballots).toEqual({ "actor-a": 1 });
  });

  it("7. repeating the same vote is idempotent", () => {
    const v = openVote({ id: "v", options: ["vote-dawn-a", "vote-dawn-b"], scope: "s", maxCommands: 5, library: LIBRARY });
    if (!v.ok) throw new Error("expected ok");
    const once = castVote(v.vote, "a", 0);
    const twice = once.ok ? castVote(once.vote, "a", 0) : null;
    expect(once.ok && twice && twice.ok).toBe(true);
    if (!once.ok || !twice || !twice.ok) throw new Error("expected ok");
    expect(twice.vote).toEqual(once.vote);
    expect(tallyVote(twice.vote)).toEqual({ ok: true, counts: [1, 0] });
  });

  it("8. latest vote wins and replaces the previous ballot", () => {
    const { s } = opened();
    let cur = sessionVote(s);
    for (const [actor, idx] of [["a", 0], ["b", 1], ["a", 1]] as const) {
      const r = castSessionVote(cur, actor, idx);
      if (!r.ok) throw new Error("expected cast");
      cur = r.session;
    }
    expect(cur.activeVote?.ballots).toEqual({ a: 1, b: 1 });
    const r = resolveSessionVote(cur, world(), LIBRARY);
    expect(r.ok && r.winner).toBe("vote-dawn-b");
  });

  it("9. actor and option validation fails closed", () => {
    const v = openVote({ id: "v", options: ["vote-dawn-a", "vote-dawn-b"], scope: "s", maxCommands: 5, library: LIBRARY });
    if (!v.ok) throw new Error("expected ok");
    expect(castVote(v.vote, "", 0)).toEqual({ ok: false, reason: "invalid-actor" });
    expect(castVote(v.vote, 42, 0)).toEqual({ ok: false, reason: "invalid-actor" });
    for (const idx of [-1, 2, 1.5, NaN, "0"]) {
      expect(castVote(v.vote, "a", idx)).toEqual({ ok: false, reason: "invalid-option-index" });
    }
    expect(castVote(null, "a", 0)).toEqual({ ok: false, reason: "invalid-vote" });
    // No active vote on the session.
    expect(castSessionVote(opened().s, "a", 0)).toEqual({ ok: false, reason: "no-active-vote" });
  });
});

describe("Phase 5C — tally and resolution", () => {
  it("10. distinct-voter counts are calculated correctly", () => {
    const v = openVote({ id: "v", options: ["vote-dawn-a", "vote-dawn-b"], scope: "s", maxCommands: 9, library: LIBRARY });
    if (!v.ok) throw new Error("expected ok");
    let cur = v.vote;
    const ballots: Array<[string, number]> = [["a", 0], ["b", 0], ["c", 1], ["a", 1]];
    for (const [actor, idx] of ballots) {
      const r = castVote(cur, actor, idx);
      if (!r.ok) throw new Error("expected cast");
      cur = r.vote;
    }
    // a moved to 1: final is a→1, b→0, c→1.
    expect(tallyVote(cur)).toEqual({ ok: true, counts: [1, 2] });
  });

  it("11. highest distinct-voter count wins", () => {
    const v = openVote({ id: "v", options: ["vote-dawn-a", "vote-dawn-b"], scope: "s", maxCommands: 9, library: LIBRARY });
    if (!v.ok) throw new Error("expected ok");
    let cur = v.vote;
    for (const [actor, idx] of [["a", 0], ["b", 1], ["c", 1]] as Array<[string, number]>) {
      const r = castVote(cur, actor, idx);
      if (!r.ok) throw new Error("expected cast");
      cur = r.vote;
    }
    const r = resolveVote(cur, world(), LIBRARY);
    expect(r).toEqual({ ok: true, winner: "vote-dawn-b", counts: [1, 2] });
  });

  it("12. persistent ties go to the lowest option index (no randomness)", () => {
    const v = openVote({
      id: "v",
      options: ["vote-dawn-a", "vote-dawn-b", "vote-dawn-c"],
      scope: "s",
      maxCommands: 9,
      library: LIBRARY,
    });
    if (!v.ok) throw new Error("expected ok");
    let cur = v.vote;
    for (const [actor, idx] of [["a", 2], ["b", 1]] as Array<[string, number]>) {
      const r = castVote(cur, actor, idx);
      if (!r.ok) throw new Error("expected cast");
      cur = r.vote;
    }
    const first = resolveVote(cur, world(), LIBRARY);
    const second = resolveVote(structuredClone(cur), world(), LIBRARY);
    expect(first).toEqual(second); // deterministic
    expect(first).toEqual({ ok: true, winner: "vote-dawn-b", counts: [0, 1, 1] });
  });

  it("13. one voter decides an election — there is no quorum", () => {
    const v = openVote({ id: "v", options: ["vote-dawn-a", "vote-dawn-b"], scope: "s", maxCommands: 5, library: LIBRARY });
    if (!v.ok) throw new Error("expected ok");
    const casted = castVote(v.vote, "only-viewer", 1);
    if (!casted.ok) throw new Error("expected cast");
    const r = resolveVote(casted.vote, world(), LIBRARY);
    expect(r).toEqual({ ok: true, winner: "vote-dawn-b", counts: [0, 1] });
  });

  it("14. no ballots means no winner — never a random pick", () => {
    const v = openVote({ id: "v", options: ["vote-dawn-a", "vote-dawn-b"], scope: "s", maxCommands: 5, library: LIBRARY });
    if (!v.ok) throw new Error("expected ok");
    expect(resolveVote(v.vote, world(), LIBRARY)).toEqual({
      ok: true,
      winner: null,
      counts: [0, 0],
      reason: "no-ballots",
    });
  });
});

describe("Phase 5C — vote closure", () => {
  it("15. the command-count bound closes the vote deterministically", () => {
    const v = openVote({ id: "v", options: ["vote-dawn-a", "vote-dawn-b"], scope: "s", maxCommands: 2, library: LIBRARY });
    if (!v.ok) throw new Error("expected ok");
    expect(isVoteClosed(v.vote)).toBe(false);
    const one = noteCommandProcessed(v.vote);
    if (!one.ok) throw new Error("expected note");
    expect(one.vote.commandsProcessed).toBe(1);
    expect(isVoteClosed(one.vote)).toBe(false);
    const two = noteCommandProcessed(one.vote);
    if (!two.ok) throw new Error("expected note");
    expect(two.vote.commandsProcessed).toBe(2);
    expect(two.vote.closed).toBe(true);
    expect(isVoteClosed(two.vote)).toBe(true);
    expect(noteCommandProcessed(two.vote)).toEqual({ ok: false, reason: "vote-closed" });
  });

  it("16. manual close works and is idempotent", () => {
    const v = openVote({ id: "v", options: ["vote-dawn-a", "vote-dawn-b"], scope: "s", maxCommands: 99, library: LIBRARY });
    if (!v.ok) throw new Error("expected ok");
    const closed = closeVote(v.vote);
    expect(closed.ok && closed.vote.closed).toBe(true);
    if (!closed.ok) throw new Error("expected ok");
    expect(closeVote(closed.vote).ok).toBe(true);
    expect(isVoteClosed(closed.vote)).toBe(true);
    // Session-level manual close.
    const s = sessionVote(opened().s);
    const sc = closeSessionVote(s);
    expect(sc.ok && sc.session.activeVote?.closed).toBe(true);
  });

  it("17. closed votes reject new ballots", () => {
    const { s } = opened();
    let cur = sessionVote(s, 1);
    const noted = noteSessionCommand(cur);
    if (!noted.ok) throw new Error("expected note");
    cur = noted.session;
    expect(cur.activeVote?.closed).toBe(true);
    expect(castSessionVote(cur, "late", 0)).toEqual({ ok: false, reason: "vote-closed" });
    // Manual close also seals the ballot box.
    const manual = closeSessionVote(sessionVote(opened().s));
    if (!manual.ok) throw new Error("expected close");
    expect(castSessionVote(manual.session, "late", 0)).toEqual({ ok: false, reason: "vote-closed" });
    expect(closeVote(null)).toEqual({ ok: false, reason: "invalid-vote" });
  });
});

describe("Phase 5C — creator override", () => {
  it("18. an explicit override selects any valid option", () => {
    const { s } = opened();
    let cur = sessionVote(s);
    for (const [actor, idx] of [["a", 0], ["b", 0]] as Array<[string, number]>) {
      const r = castSessionVote(cur, actor, idx);
      if (!r.ok) throw new Error("expected cast");
      cur = r.session;
    }
    // Community chose A 2–0; the keeper overrides to B.
    const o = overrideSessionVote(cur, world(), 1, LIBRARY);
    expect(o.ok).toBe(true);
    if (!o.ok) throw new Error("expected override");
    expect(o.winner).toBe("vote-dawn-b");
  });

  it("19. the override is recorded as a deed and never touches ballots", () => {
    const { s } = opened();
    let cur = sessionVote(s);
    const casted = castSessionVote(cur, "a", 0);
    if (!casted.ok) throw new Error("expected cast");
    cur = casted.session;
    const before = JSON.stringify(cur.activeVote?.ballots);
    const o = overrideSessionVote(cur, world(), 1, LIBRARY);
    expect(o.ok).toBe(true);
    if (!o.ok) throw new Error("expected override");
    // Auditable: the world carries the override line.
    expect(o.world.deeds.some((d) => d.includes("vote-1") && d.includes("vote-dawn-b"))).toBe(true);
    expect(o.world.deeds.some((d) => /override/i.test(d))).toBe(true);
    // Ballots untouched by the override.
    expect(JSON.stringify(cur.activeVote?.ballots)).toBe(before);
    expect(o.world).not.toBe(world()); // a working clone, input world intact
    expect(overrideSessionVote(cur, world(), 7, LIBRARY)).toEqual({
      ok: false,
      reason: "invalid-option-index",
    });
  });
});

describe("Phase 5C — vote execution and safety", () => {
  it("20. paid events process normally but never affect vote weight or the vote clock", () => {
    const { engine, drain } = harness();
    const openedR = openStream(engine.world);
    if (!openedR.ok) throw new Error("expected open");
    let session = openedR.session;
    const v = openSessionVote(session, {
      id: "vote-1",
      options: ["vote-dawn-a", "vote-dawn-b"],
      maxCommands: 5,
      library: LIBRARY,
    });
    if (!v.ok) throw new Error("expected vote");
    session = v.session;
    const c1 = castSessionVote(session, "a", 0);
    const c2 = c1.ok ? castSessionVote(c1.session, "b", 1) : c1;
    if (!c2.ok) throw new Error("expected casts");
    session = c2.session;
    const before = JSON.stringify(session.activeVote);
    // A large paid event processes through the normal engine path…
    engine.ingestPaid("donor", "Donor", 500 * 100, "INR", "paid-1");
    const results = drain();
    expect(results.some((r) => r.action === "paid_elite")).toBe(true);
    // …but the vote is byte-identical: no ballot, no count, no clock moved.
    expect(JSON.stringify(session.activeVote)).toBe(before);
    const r = resolveSessionVote(session, engine.world, LIBRARY);
    expect(r.ok && r.counts).toEqual([1, 1]);
  });

  it("21. the winner executes through the existing fireTemplate() path", () => {
    const w = world();
    let cur = sessionVote(opened().s);
    for (const [actor, idx] of [["a", 0], ["b", 0], ["c", 1]] as Array<[string, number]>) {
      const r = castSessionVote(cur, actor, idx);
      if (!r.ok) throw new Error("expected cast");
      cur = r.session;
    }
    const res = resolveSessionVote(cur, w, LIBRARY);
    expect(res.ok && res.winner).toBe("vote-dawn-a");
    if (!res.ok || !res.winner) throw new Error("expected winner");
    const tmpl = LIBRARY.find((t) => t.id === res.winner)!;
    const fired = fireTemplate(tmpl, w);
    expect(fired.ok).toBe(true);
    if (!fired.ok) throw new Error("expected fire");
    expect(fired.world.resolve).toBe(w.resolve + 5); // VOTE_A effect, via the normal path
    expect(fired.world.deeds).toContain("The assembly chose the dawn road.");
    expect(JSON.stringify(w)).toBe(JSON.stringify(world())); // input world intact (atomic)
  });

  it("22. stale or ineligible winners fail closed instead of executing", () => {
    const gate: EventTemplate = {
      id: "vote-gated",
      trigger: { kind: "manual" },
      condition: { op: "flagUnset", flag: "gate-sealed" },
      effects: [{ op: "appendDeed", deed: "The gate opened." }],
      repeat: { kind: "endless" },
      weight: 1,
    };
    const lib = [VOTE_A, gate];
    // Open while both options are valid…
    const v = openVote({ id: "v", options: ["vote-dawn-a", "vote-gated"], scope: "s", maxCommands: 5, library: lib });
    if (!v.ok) throw new Error("expected ok");
    const casted = castVote(v.vote, "a", 1);
    if (!casted.ok) throw new Error("expected cast");
    // …then the world moves: the gated option goes stale before resolution.
    const stale = { ...world(), storyFlags: { "gate-sealed": true } };
    const r = resolveVote(casted.vote, stale, lib);
    expect(r).toEqual({ ok: true, winner: null, counts: [0, 1], reason: "winner-ineligible" });
    // And a winner missing from the supplied library is equally safe.
    const missing = resolveVote(casted.vote, world(), [VOTE_A]);
    expect(missing).toEqual({ ok: true, winner: null, counts: [0, 1], reason: "winner-invalid" });
  });

  it("23. vote operations never mutate WorldState", () => {
    const w = freeze(world());
    const before = JSON.stringify(w);
    const v = openVote({ id: "v", options: ["vote-dawn-a", "vote-dawn-b"], scope: "s", maxCommands: 5, library: LIBRARY });
    if (!v.ok) throw new Error("expected ok");
    const casted = castVote(v.vote, "a", 0);
    if (!casted.ok) throw new Error("expected cast");
    expect(tallyVote(casted.vote).ok).toBe(true);
    expect(resolveVote(casted.vote, w, LIBRARY).ok).toBe(true);
    expect(noteCommandProcessed(casted.vote).ok).toBe(true);
    expect(closeVote(casted.vote).ok).toBe(true);
    expect(JSON.stringify(w)).toBe(before);
  });

  it("24. vote state is session-only and never persisted", () => {
    const { s } = opened();
    let cur = sessionVote(s);
    const casted = castSessionVote(cur, "a", 0);
    if (!casted.ok) throw new Error("expected cast");
    cur = casted.session;
    expect(cur.activeVote).not.toBeNull();
    // The world carries no vote data: a save round-trip holds no ballots.
    const w = world({ eventCounters: { "meter.lighthouse-repairs": 2 } });
    const parsed = JSON.parse(serialize(w)) as Record<string, unknown>;
    expect("activeVote" in parsed).toBe(false);
    expect("ballots" in parsed).toBe(false);
    expect("meterContributors" in parsed).toBe(false);
    expect(deserialize(serialize(w))).toEqual(w);
    // After a restart the new stream starts with no vote and empty contributors.
    const r1 = openStream(w);
    if (!r1.ok) throw new Error("expected open");
    const closed = closeStream(r1.world, r1.session);
    if (!closed.ok) throw new Error("expected close");
    const r2 = openStream(closed.world);
    if (!r2.ok) throw new Error("expected open");
    expect(r2.session.activeVote).toBeNull();
    expect(r2.session.meterContributors).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Meters
// ---------------------------------------------------------------------------

describe("Phase 5C — meter definitions", () => {
  it("1. a valid meter definition validates", () => {
    expect(validateMeterDefinition(METER)).toBe(true);
    expect(validateMeterSet([METER])).toBe(true);
    expect(validateMeterSet([METER, { id: "bell-rope", target: 5, unitText: "rings" }])).toBe(true);
  });

  it("2. invalid targets are rejected", () => {
    for (const target of [0, -1, 1.5, NaN, Infinity, "3", undefined, null]) {
      expect(validateMeterDefinition({ id: "m", target, unitText: "u" })).toBe(false);
    }
  });

  it("3. invalid ids are rejected", () => {
    for (const id of ["", "UPPER", "has space", "meter.x", "-lead", "trail-", "a/b", "x".repeat(65), 42, null]) {
      expect(validateMeterDefinition({ id, target: 3, unitText: "u" })).toBe(false);
    }
    expect(validateMeterDefinition({ id: "ok-id-2", target: 1, unitText: "" })).toBe(false);
    expect(validateMeterDefinition({ id: "ok-id-2", target: 1, unitText: "   " })).toBe(false);
    // Duplicate active meter ids are rejected as a set.
    expect(validateMeterSet([METER, { ...METER }])).toBe(false);
    expect(validateMeterSet("nope")).toBe(false);
  });
});

describe("Phase 5C — meter contributions", () => {
  it("4. a valid contribution increments the persistent counter by exactly 1", () => {
    const w = world();
    const r = contributeToMeter(w, freshMeterContributors(), METER, "actor-a");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.world.eventCounters["meter.lighthouse-repairs"]).toBe(1);
    expect(r.contributors).toEqual({ "lighthouse-repairs": ["actor-a"] });
    expect(w.eventCounters["meter.lighthouse-repairs"]).toBeUndefined(); // input untouched
  });

  it("5. the same actor contributes only once per stream", () => {
    const w = world();
    const first = contributeToMeter(w, freshMeterContributors(), METER, "a");
    if (!first.ok) throw new Error("expected ok");
    const before = JSON.stringify({ w: first.world, c: first.contributors });
    const second = contributeToMeter(first.world, first.contributors, METER, "a");
    expect(second).toEqual({ ok: false, reason: "duplicate-contributor" });
    // Atomic: neither the counter nor the contributor set moved.
    expect(JSON.stringify({ w: first.world, c: first.contributors })).toBe(before);
    expect(first.world.eventCounters["meter.lighthouse-repairs"]).toBe(1);
  });

  it("6. different actors contribute independently", () => {
    const w = world();
    const one = contributeToMeter(w, freshMeterContributors(), METER, "a");
    if (!one.ok) throw new Error("expected ok");
    const two = contributeToMeter(one.world, one.contributors, METER, "b");
    if (!two.ok) throw new Error("expected ok");
    expect(two.world.eventCounters["meter.lighthouse-repairs"]).toBe(2);
    expect(two.contributors).toEqual({ "lighthouse-repairs": ["a", "b"] });
  });

  it("7. contributor sets reset at the stream boundary", () => {
    const { w, s } = opened();
    const one = contributeToSessionMeter(s, w, METER, "a");
    if (!one.ok) throw new Error("expected ok");
    expect(one.world.eventCounters["meter.lighthouse-repairs"]).toBe(1);
    // Same stream: rejected.
    expect(contributeToSessionMeter(one.session, one.world, METER, "a")).toEqual({
      ok: false,
      reason: "duplicate-contributor",
    });
    // Close, open the next stream: the same actor may contribute again.
    const closed = closeStream(one.world, one.session);
    if (!closed.ok) throw new Error("expected close");
    const next = openStream(closed.world);
    if (!next.ok) throw new Error("expected open");
    expect(next.session.meterContributors).toEqual({});
    const again = contributeToSessionMeter(next.session, next.world, METER, "a");
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error("expected ok");
    expect(again.world.eventCounters["meter.lighthouse-repairs"]).toBe(2);
  });

  it("8. the persistent meter value survives the stream boundary", () => {
    const { w, s } = opened();
    const one = contributeToSessionMeter(s, w, METER, "a");
    if (!one.ok) throw new Error("expected ok");
    const two = contributeToSessionMeter(one.session, one.world, METER, "b");
    if (!two.ok) throw new Error("expected ok");
    expect(two.world.eventCounters["meter.lighthouse-repairs"]).toBe(2);
    const closed = closeStream(two.world, two.session);
    if (!closed.ok) throw new Error("expected close");
    // Total persists on the world, not the session.
    expect(closed.world.eventCounters["meter.lighthouse-repairs"]).toBe(2);
    expect(closed.world.streamCount).toBe(1);
  });

  it("9. persistent meter values survive normalization and reload", () => {
    const w = world({ eventCounters: { "meter.lighthouse-repairs": 2 } });
    const loaded = deserialize(serialize(w));
    expect(loaded).not.toBeNull();
    expect(loaded!.eventCounters["meter.lighthouse-repairs"]).toBe(2);
  });

  it("10. reaching target makes the completion template eligible via threshold", () => {
    expect(LIGHTHOUSE_LIT.trigger).toEqual({
      kind: "threshold",
      counter: "meter.lighthouse-repairs",
      value: 3,
    });
    expect(validateEventTemplate(LIGHTHOUSE_LIT)).toBe(true);
    const w = world({ eventCounters: { "meter.lighthouse-repairs": 3 } });
    const supplied = supplyThresholdContext(w, ["meter.lighthouse-repairs"]);
    expect(supplied).toEqual({
      ok: true,
      context: { kind: "threshold", counterValues: { "meter.lighthouse-repairs": 3 } },
    });
    if (!supplied.ok) throw new Error("expected supplied");
    // No new trigger kind: the existing threshold path selects the completion.
    const sel = collectCandidates(supplied.context, LIBRARY, w);
    expect(sel.ok && sel.template && sel.template.id).toBe("lighthouse-lit");
    const fired = sel.ok && sel.template ? fireTemplate(sel.template, w) : null;
    expect(fired && fired.ok).toBe(true);
    if (!fired || !fired.ok) throw new Error("expected fire");
    expect(fired.world.storyFlags["lighthouse-lit"]).toBe(true);
    expect(fired.world.deeds).toContain("The lighthouse burns again.");
    // Below target: not eligible, nothing selected.
    const low = world({ eventCounters: { "meter.lighthouse-repairs": 2 } });
    const lowCtx = supplyThresholdContext(low, ["meter.lighthouse-repairs"]);
    if (!lowCtx.ok) throw new Error("expected context");
    expect(collectCandidates(lowCtx.context, [LIGHTHOUSE_LIT], low)).toEqual({
      ok: true,
      template: null,
    });
  });

  it("11. a completed meter retires instead of resetting or growing", () => {
    const full = world({ eventCounters: { "meter.lighthouse-repairs": 3 } });
    const r = contributeToMeter(full, freshMeterContributors(), METER, "late");
    expect(r).toEqual({ ok: false, reason: "meter-complete" });
    expect(full.eventCounters["meter.lighthouse-repairs"]).toBe(3); // untouched, never reset
    // The value never exceeds target through the API: build to target, then stop.
    let w = world();
    let c = freshMeterContributors();
    for (const actor of ["a", "b", "c"]) {
      const step = contributeToMeter(w, c, METER, actor);
      if (!step.ok) throw new Error("expected ok");
      w = step.world;
      c = step.contributors;
    }
    expect(w.eventCounters["meter.lighthouse-repairs"]).toBe(3);
    expect(contributeToMeter(w, c, METER, "d")).toEqual({ ok: false, reason: "meter-complete" });
    // A future project gets a new id; the old meter is never reset.
    const next: MeterDefinition = { id: "bell-rope", target: 2, unitText: "rings" };
    const n1 = contributeToMeter(w, c, next, "a");
    expect(n1.ok && n1.world.eventCounters["meter.bell-rope"]).toBe(1);
    expect(n1.ok && n1.world.eventCounters["meter.lighthouse-repairs"]).toBe(3);
  });

  it("12. multiple meters remain independent", () => {
    const bell: MeterDefinition = { id: "bell-rope", target: 5, unitText: "rings" };
    const w = world();
    const one = contributeToMeter(w, freshMeterContributors(), METER, "a");
    if (!one.ok) throw new Error("expected ok");
    const two = contributeToMeter(one.world, one.contributors, bell, "a");
    if (!two.ok) throw new Error("expected ok"); // same actor, different meter: fine
    expect(two.world.eventCounters["meter.lighthouse-repairs"]).toBe(1);
    expect(two.world.eventCounters["meter.bell-rope"]).toBe(1);
    expect(two.contributors).toEqual({ "lighthouse-repairs": ["a"], "bell-rope": ["a"] });
  });

  it("13. unknown meter counters fail closed", () => {
    expect(isKnownCounter("nope")).toBe(false);
    expect(isKnownCounter("meter.")).toBe(false);
    expect(isKnownCounter("meter.BAD ID")).toBe(false);
    expect(isKnownCounter("meter.has.dot")).toBe(false);
    expect(isKnownCounter("meter.lighthouse-repairs")).toBe(true);
    expect(resolveCounter(world(), "meter.lighthouse-repairs")).toBe(0); // absent reads as 0
    expect(resolveCounter(world(), "meter.")).toBeNull();
    expect(supplyThresholdContext(world(), ["meter."])).toEqual({ ok: false, reason: "invalid-counter" });
    expect(supplyThresholdContext(world(), ["meter.lighthouse-repairs"]).ok).toBe(true);
  });

  it("14. failed contributions are atomic", () => {
    const w = freeze(world({ eventCounters: { "meter.lighthouse-repairs": 1 } }));
    const c = freeze({ "lighthouse-repairs": ["a"] });
    const beforeW = JSON.stringify(w);
    const beforeC = JSON.stringify(c);
    expect(contributeToMeter(w, c, METER, "a")).toEqual({ ok: false, reason: "duplicate-contributor" });
    expect(contributeToMeter(w, c, { ...METER, target: 0 }, "b")).toEqual({
      ok: false,
      reason: "invalid-meter-definition",
    });
    expect(contributeToMeter(w, c, METER, "")).toEqual({ ok: false, reason: "invalid-actor" });
    expect(contributeToMeter(w, "nope", METER, "b")).toEqual({ ok: false, reason: "invalid-contributors" });
    expect(JSON.stringify(w)).toBe(beforeW);
    expect(JSON.stringify(c)).toBe(beforeC);
    expect(validateMeterContributors(c)).toBe(true);
    expect(validateMeterContributors({ "BAD ID": ["a"] })).toBe(false);
  });

  it("15. meter values never go negative", () => {
    // Fresh meters start at exactly 0 and grow by +1.
    expect(resolveCounter(world(), "meter.lighthouse-repairs")).toBe(0);
    const r = contributeToMeter(world(), freshMeterContributors(), METER, "a");
    if (!r.ok) throw new Error("expected ok");
    expect(r.world.eventCounters["meter.lighthouse-repairs"]).toBe(1);
    // A corrupted negative total fails closed instead of being "continued".
    const corrupt = world({ eventCounters: { "meter.lighthouse-repairs": -3 } });
    const before = JSON.stringify(corrupt);
    expect(contributeToMeter(corrupt, freshMeterContributors(), METER, "a")).toEqual({
      ok: false,
      reason: "invalid-counter",
    });
    expect(JSON.stringify(corrupt)).toBe(before);
  });

  it("16. fractional targets are rejected", () => {
    expect(validateMeterDefinition({ id: "m", target: 2.5, unitText: "u" })).toBe(false);
    expect(contributeToMeter(world(), freshMeterContributors(), { id: "m", target: 2.5, unitText: "u" }, "a")).toEqual({
      ok: false,
      reason: "invalid-meter-definition",
    });
  });

  it("17. repeated contribution sequences are deterministic", () => {
    const run = () => {
      let w = world();
      let c = freshMeterContributors();
      for (const actor of ["a", "b", "a", "c"]) {
        const r = contributeToMeter(w, c, METER, actor);
        if (r.ok) {
          w = r.world;
          c = r.contributors;
        }
      }
      return { w, c };
    };
    const a = run();
    const b = run();
    expect(b.c).toEqual(a.c);
    expect(b.w).toEqual(a.w);
    expect(a.w.eventCounters["meter.lighthouse-repairs"]).toBe(3); // a,b,c — replay "a" ignored
  });
});

// ---------------------------------------------------------------------------
// Integration: the two locked mechanics end to end.
// ---------------------------------------------------------------------------

describe("Phase 5C — integration", () => {
  it("open stream → open vote → cast → close → resolve → fireTemplate → world changes", () => {
    const { engine, drain } = harness();
    expect(LIBRARY.every(validateEventTemplate)).toBe(true);

    // Stream opens.
    const openedR = openStream(engine.world);
    expect(openedR.ok).toBe(true);
    if (!openedR.ok) throw new Error("expected open");
    let session = openedR.session;

    // A vote opens: 2 options, closes after 3 processed commands.
    const v = openSessionVote(session, {
      id: "vote-dawn",
      options: ["vote-dawn-a", "vote-dawn-b"],
      maxCommands: 3,
      library: LIBRARY,
    });
    expect(v.ok).toBe(true);
    if (!v.ok) throw new Error("expected vote");
    session = v.session;

    // Viewers vote AND act: every processed chat command ticks the vote clock.
    const castA = castSessionVote(session, "u1", 0);
    const castB = castA.ok ? castSessionVote(castA.session, "u2", 1) : castA;
    const castC = castB.ok ? castSessionVote(castB.session, "u3", 0) : castB;
    if (!castC.ok) throw new Error("expected casts");
    session = castC.session;
    engine.ingestCommand("u1", "A", "!strike", "cmd-1");
    engine.ingestCommand("u2", "B", "!mend", "cmd-2");
    engine.ingestCommand("u3", "C", "!ring", "cmd-3");
    drain();
    for (let i = 0; i < 3; i++) {
      const n = noteSessionCommand(session);
      if (!n.ok) throw new Error("expected note");
      session = n.session;
    }
    expect(session.activeVote?.closed).toBe(true); // command bound reached

    // Resolve and execute through the existing engine path.
    const res = resolveSessionVote(session, engine.world, LIBRARY);
    expect(res.ok && res.winner).toBe("vote-dawn-a");
    if (!res.ok || !res.winner) throw new Error("expected winner");
    const tmpl = LIBRARY.find((t) => t.id === res.winner)!;
    const fired = fireTemplate(tmpl, engine.world);
    expect(fired.ok).toBe(true);
    if (!fired.ok) throw new Error("expected fire");
    engine.loadWorld(fired.world);
    expect(engine.world.resolve).toBe(55); // 50 + 5 dawn-road effect
    expect(engine.world.deeds).toContain("The assembly chose the dawn road.");

    // Closing the stream keeps the persistent world; the vote stays behind.
    const closed = closeStream(engine.world, session);
    expect(closed.ok).toBe(true);
    if (!closed.ok) throw new Error("expected close");
    expect(closed.world.streamCount).toBe(1);
    expect(closed.world.deeds.length).toBeGreaterThan(0);
  });

  it("open stream → contributions → duplicate ignored → next stream resets, total persists, threshold fires", () => {
    // Stream 1: two contributors, one duplicate ignored.
    const start = opened();
    const one = contributeToSessionMeter(start.s, start.w, METER, "a");
    if (!one.ok) throw new Error("expected ok");
    const two = contributeToSessionMeter(one.session, one.world, METER, "b");
    if (!two.ok) throw new Error("expected ok");
    expect(contributeToSessionMeter(two.session, two.world, METER, "a")).toEqual({
      ok: false,
      reason: "duplicate-contributor",
    });
    expect(two.world.eventCounters["meter.lighthouse-repairs"]).toBe(2);
    const closed = closeStream(two.world, two.session);
    if (!closed.ok) throw new Error("expected close");

    // Stream 2: contributor set is fresh, the persistent total remains.
    const next = openStream(closed.world);
    if (!next.ok) throw new Error("expected open");
    expect(next.session.meterContributors).toEqual({});
    expect(next.world.eventCounters["meter.lighthouse-repairs"]).toBe(2);
    const three = contributeToSessionMeter(next.session, next.world, METER, "a");
    expect(three.ok).toBe(true);
    if (!three.ok) throw new Error("expected ok");
    expect(three.world.eventCounters["meter.lighthouse-repairs"]).toBe(3);

    // Threshold eligibility + existing selection/fire path — no meter trigger.
    const supplied = supplyThresholdContext(three.world, ["meter.lighthouse-repairs"]);
    expect(supplied.ok).toBe(true);
    if (!supplied.ok) throw new Error("expected supplied");
    const sel = collectCandidates(supplied.context, LIBRARY, three.world);
    expect(sel.ok && sel.template && sel.template.id).toBe("lighthouse-lit");
    const fired = sel.ok && sel.template ? fireTemplate(sel.template, three.world) : null;
    expect(fired && fired.ok).toBe(true);
    if (!fired || !fired.ok) throw new Error("expected fire");
    expect(fired.world.storyFlags["lighthouse-lit"]).toBe(true);

    // Explicit session reset helper matches the automatic boundary behavior.
    const reset = resetSessionMeterContributors(three.session);
    expect(reset.ok && reset.session.meterContributors).toEqual({});
  });
});
