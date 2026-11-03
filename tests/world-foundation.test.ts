import { describe, expect, it } from "vitest";
import { initialWorld } from "../src/engine/types";
import { deserialize, serialize } from "../src/persistence/store";

function stripNewFields(w: ReturnType<typeof initialWorld>): Record<string, unknown> {
  const o = JSON.parse(serialize(w)) as Record<string, unknown>;
  for (const k of ["schemaVersion", "streamCount", "deeds", "resolve", "locationState", "latent", "repeatState", "paidLedger"]) {
    delete o[k];
  }
  return o;
}

describe("Phase 4B slice 1 — persistent world foundation", () => {
  it("TEST 1: fresh world contains the new foundation fields", () => {
    const w = initialWorld("2026-11-03T00:00:00.000Z");
    expect(w.schemaVersion).toBe(2);
    expect(w.streamCount).toBe(0);
    expect(w.deeds).toEqual([]);
    expect(w.resolve).toBe(50);
    expect(w.locationState).toEqual({});
    expect(w.latent).toEqual([]);
    expect(w.paidLedger).toEqual([]);
    // resources IS the supplies pool: no parallel `supplies` field may exist.
    expect("supplies" in w).toBe(false);
    expect(typeof w.resources).toBe("number");
  });

  it("TEST 2: old-style save without new fields loads with defaults", () => {
    const fresh = initialWorld();
    const loaded = deserialize(JSON.stringify(stripNewFields(fresh)));
    expect(loaded).not.toBeNull();
    expect(loaded!.schemaVersion).toBe(2);
    expect(loaded!.streamCount).toBe(0);
    expect(loaded!.deeds).toEqual([]);
    expect(loaded!.resolve).toBe(50);
    expect(loaded!.locationState).toEqual({});
    expect(loaded!.latent).toEqual([]);
    expect(loaded!.paidLedger).toEqual([]);
    expect(loaded!.repeatState).toEqual({ onceFired: [], chapterFired: [], cooldownUntilStream: {} });
    // Existing values are preserved, never overwritten.
    expect(loaded!.worldId).toBe("emberkeep-prototype");
    expect(loaded!.resources).toBe(fresh.resources);
    expect(loaded!.heroHp).toBe(fresh.heroHp);
    expect(loaded!.currentArc).toBe(fresh.currentArc);
  });

  it("TEST 3: round-trip preserves all new fields", () => {
    const w = initialWorld();
    w.streamCount = 7;
    w.deeds = ["The north road burned while we held the gate."];
    w.resolve = 62;
    w.locationState = { "north-road": "strained", "emberkeep-gate": "sound" };
    w.latent = [{ id: "warlord-ghash", attention: 8 }];
    w.repeatState = {
      onceFired: ["founding-oath"],
      chapterFired: [{ id: "night-rite", arc: 1, chapter: 2 }],
      cooldownUntilStream: { patrol: 9 },
    };
    const loaded = deserialize(serialize(w));
    expect(loaded).toEqual(w);
  });

  it("validation: malformed new fields reject the save (existing invalid-save rule)", () => {
    const base = initialWorld();
    const bad = (mut: (o: Record<string, unknown>) => void) => {
      const o = JSON.parse(serialize(base)) as Record<string, unknown>;
      mut(o);
      return deserialize(JSON.stringify(o));
    };
    expect(bad((o) => void (o.schemaVersion = "1"))).toBeNull();
    expect(bad((o) => void (o.streamCount = -1))).toBeNull();
    expect(bad((o) => void (o.streamCount = 1.5))).toBeNull();
    expect(bad((o) => void (o.deeds = "not-an-array"))).toBeNull();
    expect(bad((o) => void (o.deeds = [42]))).toBeNull();
    expect(bad((o) => void (o.resolve = -5))).toBeNull();
    expect(bad((o) => void (o.resolve = "lots"))).toBeNull();
    expect(bad((o) => void (o.locationState = "sound"))).toBeNull();
    expect(bad((o) => void (o.locationState = { x: "cursed" }))).toBeNull();
    expect(bad((o) => void (o.latent = [{ id: "", attention: 5 }]))).toBeNull();
    expect(bad((o) => void (o.latent = [{ id: "x", attention: 101 }]))).toBeNull();
    expect(bad((o) => void (o.latent = [{ id: "x", attention: "high" }]))).toBeNull();
    // Phase 4D slice 8A: malformed repeat state rejects the save; absence fills defaults.
    expect(deserialize(JSON.stringify(stripNewFields(initialWorld())))).not.toBeNull();
    expect(bad((o) => void (o.repeatState = "nope"))).toBeNull();
    expect(
      bad((o) => void (o.repeatState = { onceFired: [42], chapterFired: [], cooldownUntilStream: {} })),
    ).toBeNull();
    expect(
      bad((o) => void (o.repeatState = { onceFired: [], chapterFired: [{ id: "x" }], cooldownUntilStream: {} })),
    ).toBeNull();
    expect(
      bad((o) => void (o.repeatState = { onceFired: [], chapterFired: [], cooldownUntilStream: { x: -1 } })),
    ).toBeNull();
    // Pre-existing rule still holds.
    expect(bad((o) => void (o.worldId = "other"))).toBeNull();
    expect(deserialize("not json")).toBeNull();
  });
});
