import { describe, expect, it } from "vitest";
import { initialWorld, type WorldState } from "../src/engine/types";
import {
  attitudeOf,
  isEligible,
  latentBandOf,
  validatePredicate,
  type Predicate,
} from "../src/engine/predicates";

/** Hand-built world: no engine, no I/O — pure data for the evaluator. */
function world(over: Partial<WorldState> = {}): WorldState {
  return {
    ...initialWorld("2026-11-03T00:00:00.000Z"),
    threatLevel: 45,
    resources: 30,
    resolve: 60,
    streamCount: 5,
    waveNumber: 3,
    currentArc: 1,
    currentChapter: 2,
    uniqueSearchers: ["a", "b", "c"],
    discoveredSecrets: ["forest-secret"],
    deeds: ["d1", "d2"],
    storyFlags: { forest_secret_discovered: true },
    factionState: { goblins: 10, villagers: 65, neutrals: 50 },
    locationState: { "north-road": "strained", "emberkeep-gate": "sound" },
    latent: [
      { id: "warlord", attention: 80 },
      { id: "rot", attention: 50 },
      { id: "whisper", attention: 5 },
    ],
    eventCounters: { attacks: 12, kills: 2 },
    ...over,
  };
}

function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) freeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

describe("Phase 4C — condition predicate evaluator", () => {
  it("gte/lte/eq: true and false", () => {
    const w = world();
    expect(isEligible({ op: "gte", counter: "threatLevel", value: 45 }, w)).toBe(true);
    expect(isEligible({ op: "gte", counter: "threatLevel", value: 46 }, w)).toBe(false);
    expect(isEligible({ op: "lte", counter: "resources", value: 30 }, w)).toBe(true);
    expect(isEligible({ op: "lte", counter: "resources", value: 29 }, w)).toBe(false);
    expect(isEligible({ op: "eq", counter: "waveNumber", value: 3 }, w)).toBe(true);
    expect(isEligible({ op: "eq", counter: "waveNumber", value: 4 }, w)).toBe(false);
  });

  it("between: boundaries inclusive, outside exclusive", () => {
    const w = world();
    const p = (min: number, max: number): Predicate => ({ op: "between", counter: "resolve", min, max });
    expect(isEligible(p(60, 80), w)).toBe(true); // lower boundary
    expect(isEligible(p(40, 60), w)).toBe(true); // upper boundary
    expect(isEligible(p(61, 80), w)).toBe(false); // below
    expect(isEligible(p(40, 59), w)).toBe(false); // above
  });

  it("flagSet/flagUnset against the existing storyFlags", () => {
    const w = world();
    expect(isEligible({ op: "flagSet", flag: "forest_secret_discovered" }, w)).toBe(true);
    expect(isEligible({ op: "flagSet", flag: "never_happened" }, w)).toBe(false);
    expect(isEligible({ op: "flagUnset", flag: "never_happened" }, w)).toBe(true);
    expect(isEligible({ op: "flagUnset", flag: "forest_secret_discovered" }, w)).toBe(false);
  });

  it("counterGte: equal, greater, lower; derived counts; event counters", () => {
    const w = world();
    expect(isEligible({ op: "counterGte", counter: "streamCount", gte: 5 }, w)).toBe(true);
    expect(isEligible({ op: "counterGte", counter: "scouts", gte: 3 }, w)).toBe(true);
    expect(isEligible({ op: "counterGte", counter: "secrets", gte: 1 }, w)).toBe(true);
    expect(isEligible({ op: "counterGte", counter: "attacks", gte: 12 }, w)).toBe(true);
    expect(isEligible({ op: "counterGte", counter: "attacks", gte: 13 }, w)).toBe(false);
    expect(isEligible({ op: "counterGte", counter: "streamCount", gte: 6 }, w)).toBe(false);
  });

  it("locationIs: match, mismatch, missing", () => {
    const w = world();
    expect(isEligible({ op: "locationIs", location: "north-road", state: "strained" }, w)).toBe(true);
    expect(isEligible({ op: "locationIs", location: "north-road", state: "lost" }, w)).toBe(false);
    expect(isEligible({ op: "locationIs", location: "no-such-place", state: "sound" }, w)).toBe(false);
  });

  it("attitudeIs: every category, mismatch, unknown faction", () => {
    const w = world(); // goblins 10 hostile, villagers 65 friendly, neutrals 50 neutral
    expect(isEligible({ op: "attitudeIs", faction: "goblins", attitude: "hostile" }, w)).toBe(true);
    expect(isEligible({ op: "attitudeIs", faction: "villagers", attitude: "friendly" }, w)).toBe(true);
    expect(isEligible({ op: "attitudeIs", faction: "neutrals", attitude: "neutral" }, w)).toBe(true);
    expect(isEligible({ op: "attitudeIs", faction: "goblins", attitude: "allied" }, w)).toBe(false);
    expect(isEligible({ op: "attitudeIs", faction: "strangers", attitude: "hostile" }, w)).toBe(false);
    // Derivation boundaries are deterministic quintiles.
    expect(attitudeOf(0)).toBe("hostile");
    expect(attitudeOf(19)).toBe("hostile");
    expect(attitudeOf(20)).toBe("wary");
    expect(attitudeOf(40)).toBe("neutral");
    expect(attitudeOf(60)).toBe("friendly");
    expect(attitudeOf(80)).toBe("allied");
    expect(attitudeOf(100)).toBe("allied");
  });

  it("latentBand: boundaries, missing id, multiple threats, irrelevant ids", () => {
    const w = world(); // warlord 80 high, rot 50 medium, whisper 5 low
    expect(isEligible({ op: "latentBand", id: "warlord", band: "high" }, w)).toBe(true);
    expect(isEligible({ op: "latentBand", id: "rot", band: "medium" }, w)).toBe(true);
    expect(isEligible({ op: "latentBand", id: "whisper", band: "low" }, w)).toBe(true);
    expect(isEligible({ op: "latentBand", id: "warlord", band: "low" }, w)).toBe(false);
    expect(isEligible({ op: "latentBand", id: "nobody", band: "low" }, w)).toBe(false);
    expect(latentBandOf(0)).toBe("low");
    expect(latentBandOf(33)).toBe("low");
    expect(latentBandOf(34)).toBe("medium");
    expect(latentBandOf(66)).toBe("medium");
    expect(latentBandOf(67)).toBe("high");
    expect(latentBandOf(100)).toBe("high");
  });

  it("composites: allOf/anyOf/noneOf incl. nesting", () => {
    const w = world();
    const t: Predicate = { op: "eq", counter: "waveNumber", value: 3 };
    const f: Predicate = { op: "eq", counter: "waveNumber", value: 9 };
    expect(isEligible({ op: "allOf", predicates: [t, t] }, w)).toBe(true);
    expect(isEligible({ op: "allOf", predicates: [t, f] }, w)).toBe(false);
    expect(isEligible({ op: "anyOf", predicates: [f, t] }, w)).toBe(true);
    expect(isEligible({ op: "anyOf", predicates: [f, f] }, w)).toBe(false);
    expect(isEligible({ op: "noneOf", predicates: [f, f] }, w)).toBe(true);
    expect(isEligible({ op: "noneOf", predicates: [f, t] }, w)).toBe(false);
    // Nested + mixed.
    const nested: Predicate = {
      op: "allOf",
      predicates: [t, { op: "anyOf", predicates: [f, t] }, { op: "noneOf", predicates: [f] }],
    };
    expect(isEligible(nested, w)).toBe(true);
    const nestedBad: Predicate = {
      op: "anyOf",
      predicates: [{ op: "allOf", predicates: [t, f] }, { op: "noneOf", predicates: [t] }],
    };
    expect(isEligible(nestedBad, w)).toBe(false);
  });

  it("empty composites use consistent semantics", () => {
    const w = world();
    expect(isEligible({ op: "allOf", predicates: [] }, w)).toBe(true); // vacuous truth
    expect(isEligible({ op: "anyOf", predicates: [] }, w)).toBe(false); // nothing holds
    expect(isEligible({ op: "noneOf", predicates: [] }, w)).toBe(true); // nothing violated
  });

  it("malformed predicates evaluate false, never throw", () => {
    const w = world();
    const bad = [
      null, undefined, 42, "gte", [], { op: "gt", counter: "threatLevel", value: 1 },
      { op: "gte" }, { op: "gte", counter: "threatLevel" },
      { op: "gte", counter: "threatLevel", value: NaN },
      { op: "gte", counter: "nope", value: 1 }, // unknown counter
      { op: "between", counter: "resolve", min: 80, max: 40 }, // min > max
      { op: "flagSet", flag: "" }, { op: "flagSet" },
      { op: "locationIs", location: "x", state: "cursed" },
      { op: "attitudeIs", faction: "goblins", attitude: "furious" },
      { op: "latentBand", id: "warlord", band: "extreme" },
      { op: "allOf", predicates: [{ op: "gte", counter: "x" }] },
      { op: "allOf", predicates: "nope" }, { op: "allOf" },
    ];
    for (const p of bad) expect(isEligible(p, w)).toBe(false);
    // Deeply nested input is rejected, not recursed forever.
    let deep: Record<string, unknown> = { op: "eq", counter: "waveNumber", value: 3 };
    for (let i = 0; i < 30; i++) deep = { op: "allOf", predicates: [deep] };
    expect(validatePredicate(deep)).toBe(false);
    expect(isEligible(deep, w)).toBe(false);
  });

  it("boundary: realistic eligibility composite for template selection", () => {
    const w = world();
    // "The north road can be reclaimed when it is strained, the community
    //  has scouts to spare, and the gate is not already lost."
    const eligible: Predicate = {
      op: "allOf",
      predicates: [
        { op: "locationIs", location: "north-road", state: "strained" },
        { op: "counterGte", counter: "scouts", gte: 3 },
        { op: "noneOf", predicates: [{ op: "locationIs", location: "emberkeep-gate", state: "lost" }] },
      ],
    };
    expect(isEligible(eligible, w)).toBe(true);
    expect(isEligible(eligible, world({ locationState: { "north-road": "sound" } }))).toBe(false);
    expect(isEligible(eligible, world({ uniqueSearchers: ["a"] }))).toBe(false);
    expect(
      isEligible(eligible, world({ locationState: { "emberkeep-gate": "lost" } })),
    ).toBe(false);
  });

  it("evaluation never mutates the world", () => {
    const w = freeze(world());
    const before = JSON.stringify(w);
    const queries: Predicate[] = [
      { op: "gte", counter: "threatLevel", value: 1 },
      { op: "flagSet", flag: "forest_secret_discovered" },
      { op: "locationIs", location: "north-road", state: "strained" },
      { op: "attitudeIs", faction: "goblins", attitude: "hostile" },
      { op: "latentBand", id: "warlord", band: "high" },
      { op: "allOf", predicates: [{ op: "counterGte", counter: "deeds", gte: 1 }] },
    ];
    for (const q of queries) isEligible(q, w);
    expect(JSON.stringify(w)).toBe(before);
  });

  it("same predicate + world always yields the same boolean", () => {
    const w = world();
    const p: Predicate = {
      op: "anyOf",
      predicates: [
        { op: "attitudeIs", faction: "goblins", attitude: "hostile" },
        { op: "latentBand", id: "rot", band: "high" },
      ],
    };
    expect([isEligible(p, w), isEligible(p, w), isEligible(p, structuredClone(w))]).toEqual([
      true, true, true,
    ]);
  });
});
