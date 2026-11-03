import { describe, expect, it } from "vitest";
import { applyEffect, applyEffects, MAX_DEEDS, validateEffect, type Effect } from "../src/engine/effects";
import { initialWorld, type WorldState } from "../src/engine/types";

function world(over: Partial<WorldState> = {}): WorldState {
  return {
    ...initialWorld("2026-11-03T00:00:00.000Z"),
    resources: 30,
    resolve: 60,
    factionState: { goblins: 10, villagers: 65 },
    locationState: { "north-road": "strained", "emberkeep-gate": "sound" },
    unlockedLocations: ["emberkeep-gate", "north-road"],
    latent: [
      { id: "warlord", attention: 80 },
      { id: "whisper", attention: 5 },
    ],
    storyFlags: { old_flag: true },
    deeds: ["d1"],
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

/** Asserts the result world equals `before` except `key`, which equals `value`. */
function expectOnlyChanged(before: WorldState, after: WorldState, key: keyof WorldState, value: unknown) {
  expect({ ...before, [key]: value }).toEqual(after);
}

describe("Phase 4D — closed effect executor", () => {
  it("flags: set and unset", () => {
    const w = world();
    const set = applyEffect({ op: "setFlag", flag: "new_dawn" }, w);
    expect(set.ok).toBe(true);
    if (!set.ok) throw new Error("expected ok");
    expect(set.world.storyFlags["new_dawn"]).toBe(true);
    expectOnlyChanged(w, set.world, "storyFlags", { ...w.storyFlags, new_dawn: true });

    const clear = applyEffect({ op: "clearFlag", flag: "old_flag" }, w);
    expect(clear.ok).toBe(true);
    if (!clear.ok) throw new Error("expected ok");
    expect("old_flag" in clear.world.storyFlags).toBe(false);
    const { old_flag: _dropped, ...rest } = w.storyFlags;
    void _dropped;
    expectOnlyChanged(w, clear.world, "storyFlags", rest);
  });

  it("standing: deltas, clamps, unknown faction rejected", () => {
    const w = world();
    const up = applyEffect({ op: "addStanding", faction: "goblins", amount: 20 }, w);
    expect(up.ok && up.world.factionState["goblins"]).toBe(30);
    const down = applyEffect({ op: "addStanding", faction: "village-unknown", amount: 1 }, w);
    void down;
    const lo = applyEffect({ op: "addStanding", faction: "goblins", amount: -50 }, w);
    expect(lo.ok && lo.world.factionState["goblins"]).toBe(0); // lower clamp
    const hi = applyEffect({ op: "addStanding", faction: "villagers", amount: 50 }, w);
    expect(hi.ok && hi.world.factionState["villagers"]).toBe(100); // upper clamp
    const unknown = applyEffect({ op: "addStanding", faction: "strangers", amount: 10 }, w);
    expect(unknown).toEqual({ ok: false, reason: "unknown-faction" });
    if (up.ok) expectOnlyChanged(w, up.world, "factionState", { ...w.factionState, goblins: 30 });
  });

  it("location: valid transitions, illegal jumps and unknowns rejected", () => {
    const w = world();
    const ruin = applyEffect({ op: "setLocation", location: "north-road", state: "lost" }, w);
    expect(ruin.ok).toBe(true);
    if (ruin.ok) {
      expect(ruin.world.locationState["north-road"]).toBe("lost");
      expectOnlyChanged(w, ruin.world, "locationState", { ...w.locationState, "north-road": "lost" });
    }
    const repair = applyEffect({ op: "setLocation", location: "north-road", state: "sound" }, w);
    expect(repair.ok).toBe(true); // strained -> sound recovery allowed
    // Unlocked but stateless locations read as pristine "sound".
    const first = applyEffect({ op: "setLocation", location: "emberkeep-gate", state: "strained" }, w);
    expect(first.ok).toBe(true);
    expect(applyEffect({ op: "setLocation", location: "north-road", state: "strained" }, w)).toEqual({
      ok: false, reason: "invalid-transition", // same-state no-op rejected
    });
    expect(applyEffect({ op: "setLocation", location: "emberkeep-gate", state: "lost" }, w)).toEqual({
      ok: false, reason: "invalid-transition", // sound -> lost must pass through strained
    });
    expect(applyEffect({ op: "setLocation", location: "no-such-place", state: "lost" }, w)).toEqual({
      ok: false, reason: "unknown-location",
    });
  });

  it("supplies: increase, decrease, floor at zero, no second resource", () => {
    const w = world();
    const up = applyEffect({ op: "addSupplies", amount: 15 }, w);
    expect(up.ok && up.world.resources).toBe(45);
    const down = applyEffect({ op: "addSupplies", amount: -50 }, w);
    expect(down.ok && down.world.resources).toBe(0); // floor, no negative
    if (up.ok) {
      expectOnlyChanged(w, up.world, "resources", 45);
      expect("supplies" in up.world).toBe(false);
    }
  });

  it("resolve: increase, decrease, floor and 0..100 ceiling", () => {
    const w = world();
    expect(applyEffect({ op: "addResolve", amount: 10 }, w).ok).toBe(true);
    const hi = applyEffect({ op: "addResolve", amount: 50 }, w);
    expect(hi.ok && hi.world.resolve).toBe(100); // ceiling
    const lo = applyEffect({ op: "addResolve", amount: -70 }, w);
    expect(lo.ok && lo.world.resolve).toBe(0); // floor
    if (hi.ok) expectOnlyChanged(w, hi.world, "resolve", 100);
  });

  it("latent: adjust, clamps, unknown id rejected, no creation", () => {
    const w = world();
    const up = applyEffect({ op: "addAttention", id: "whisper", amount: 10 }, w);
    expect(up.ok).toBe(true);
    if (up.ok) {
      expect(up.world.latent.find((l) => l.id === "whisper")!.attention).toBe(15);
      expect(up.world.latent).toHaveLength(2); // nothing created
    }
    const hi = applyEffect({ op: "addAttention", id: "warlord", amount: 50 }, w);
    expect(hi.ok && hi.world.latent.find((l) => l.id === "warlord")!.attention).toBe(100);
    const lo = applyEffect({ op: "addAttention", id: "whisper", amount: -50 }, w);
    expect(lo.ok && lo.world.latent.find((l) => l.id === "whisper")!.attention).toBe(0);
    expect(applyEffect({ op: "addAttention", id: "new-evil", amount: 10 }, w)).toEqual({
      ok: false, reason: "unknown-latent",
    });
  });

  it("deeds: append one, order, empty/oversized/cap rejected", () => {
    const w = world();
    const r = applyEffect({ op: "appendDeed", deed: "  The road burned.  " }, w);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.world.deeds).toEqual(["d1", "The road burned."]); // trimmed, ordered
      expectOnlyChanged(w, r.world, "deeds", ["d1", "The road burned."]);
    }
    expect(applyEffect({ op: "appendDeed", deed: "" }, w).ok).toBe(false);
    expect(applyEffect({ op: "appendDeed", deed: "   " }, w).ok).toBe(false);
    expect(applyEffect({ op: "appendDeed", deed: "x".repeat(281) }, w).ok).toBe(false);
    expect(applyEffect({ op: "appendDeed", deed: "x".repeat(280) }, w).ok).toBe(true);
    const full = world({ deeds: Array.from({ length: MAX_DEEDS }, (_, i) => `d${i}`) });
    expect(applyEffect({ op: "appendDeed", deed: "one more" }, full)).toEqual({
      ok: false, reason: "deeds-full", // explicit failure, never silent truncation
    });
  });

  it("chapter: uses the existing canonical path", () => {
    const mid = applyEffect({ op: "advanceChapter" }, world({ currentArc: 1, currentChapter: 1 }));
    expect(mid.ok).toBe(true);
    if (mid.ok) {
      expect(mid.world.currentChapter).toBe(2);
      expect(mid.world.currentArc).toBe(1);
      expectOnlyChanged(
        world({ currentArc: 1, currentChapter: 1 }), mid.world, "currentChapter", 2,
      );
    }
    const turn = applyEffect({ op: "advanceChapter" }, world({ currentArc: 1, currentChapter: 3 }));
    expect(turn.ok).toBe(true);
    if (turn.ok) {
      expect(turn.world.currentArc).toBe(2); // chaptersPerArc rollover, same as story.ts
      expect(turn.world.currentChapter).toBe(1);
    }
  });

  it("malformed effects fail closed with invalid-effect", () => {
    const w = world();
    const bad = [
      null, undefined, 42, "advanceChapter", [], { op: "nope" }, { op: "setFlag" },
      { op: "setFlag", flag: "" }, { op: "addStanding", faction: "goblins" },
      { op: "addStanding", faction: "goblins", amount: NaN },
      { op: "addStanding", faction: "goblins", amount: 0 }, // zero deltas rejected
      { op: "addSupplies", amount: 0 },
      { op: "addSupplies", amount: Infinity },
      { op: "addCounter", counter: "attacks", amount: 1 }, // no generic counter op exists
      { op: "set", path: "resources", value: 999 }, // no generic set-path op exists
      { op: "setLocation", location: "x", state: "cursed" },
      { op: "attitudeIs", faction: "goblins", attitude: "hostile" }, // predicate, not effect
    ];
    for (const e of bad) {
      expect(validateEffect(e)).toBe(false);
      expect(applyEffect(e, w)).toEqual({ ok: false, reason: "invalid-effect" });
    }
    expect(validateEffect({ op: "advanceChapter" })).toBe(true);
  });

  it("atomicity: failures leave the input world untouched", () => {
    const w = world();
    const before = JSON.stringify(w);
    const failures: unknown[] = [
      { op: "addStanding", faction: "strangers", amount: 10 },
      { op: "setLocation", location: "emberkeep-gate", state: "lost" }, // sound->lost illegal
      { op: "appendDeed", deed: "" },
      { op: "addSupplies", amount: 0 },
      { op: "nope" },
    ];
    for (const e of failures) expect(applyEffect(e, w).ok).toBe(false);
    expect(JSON.stringify(w)).toBe(before);
  });

  it("immutability: input frozen, output is an independent world", () => {
    const w = freeze(world());
    const before = JSON.stringify(w);
    const r = applyEffect({ op: "addResolve", amount: 10 }, w);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(JSON.stringify(w)).toBe(before); // frozen input unchanged (would throw if written)
    expect(r.world.resolve).toBe(70);
    expect(r.world).not.toBe(w);
  });

  it("determinism: same effect + world always yields the same world", () => {
    const e: Effect = { op: "addStanding", faction: "goblins", amount: 7 };
    const a = applyEffect(e, world());
    const b = applyEffect(e, world());
    expect(a).toEqual(b);
  });
});

describe("Phase 4D slice 4 — atomic multi-effect application", () => {
  it("rejects non-array input", () => {
    const w = world();
    for (const bad of [null, undefined, 42, "x", { op: "addSupplies", amount: 1 }]) {
      expect(applyEffects(bad, w)).toEqual({ ok: false, reason: "invalid-effects-list" });
    }
  });

  it("rejects empty array as authoring error, not success", () => {
    expect(applyEffects([], world())).toEqual({ ok: false, reason: "empty-effects" });
  });

  it("rejects malformed elements with index, before application", () => {
    const w = world();
    expect(applyEffects([{ op: "nope" }], w)).toEqual({
      ok: false, reason: "invalid-effect-at-index:0",
    });
    // Element 0 is valid; the shape failure at index 1 is caught by
    // pre-validation (reason names the index, not an apply-time failure).
    const list = [{ op: "addSupplies", amount: 10 }, { op: "addSupplies" }];
    expect(applyEffects(list, w)).toEqual({ ok: false, reason: "invalid-effect-at-index:1" });
    expect(JSON.stringify(w)).toBe(JSON.stringify(world())); // nothing applied
  });

  it("applies one valid effect successfully", () => {
    const w = world();
    const r = applyEffects([{ op: "addResolve", amount: 10 }], w);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.world.resolve).toBe(70);
    expect({ ...w, resolve: 70 }).toEqual(r.world);
  });

  it("applies multiple effects sequentially; order is semantic", () => {
    const w = world();
    const r = applyEffects(
      [
        { op: "addSupplies", amount: 100 },
        { op: "addSupplies", amount: -40 },
      ],
      w,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.world.resources).toBe(90); // 30 + 100 - 40
  });

  it("later effects see earlier effects", () => {
    const w = world();
    const flags = applyEffects(
      [
        { op: "setFlag", flag: "x" },
        { op: "clearFlag", flag: "x" },
      ],
      w,
    );
    expect(flags.ok).toBe(true);
    if (!flags.ok) throw new Error("expected ok");
    expect("x" in flags.world.storyFlags).toBe(false);

    // Chained location transition through an intermediate state.
    const loc = applyEffects(
      [
        { op: "setLocation", location: "north-road", state: "lost" },
        { op: "setLocation", location: "north-road", state: "strained" },
      ],
      w,
    );
    expect(loc.ok).toBe(true);
    if (!loc.ok) throw new Error("expected ok");
    expect(loc.world.locationState["north-road"]).toBe("strained");
  });

  it("first-effect failure leaves the original unchanged", () => {
    const w = world();
    const before = JSON.stringify(w);
    const r = applyEffects(
      [
        { op: "addStanding", faction: "strangers", amount: 5 },
        { op: "addSupplies", amount: 100 },
      ],
      w,
    );
    expect(r).toEqual({ ok: false, reason: "effect-failed-at-index:0:unknown-faction" });
    expect(JSON.stringify(w)).toBe(before);
  });

  it("later-effect failure rolls back earlier successes (atomicity)", () => {
    const w = world();
    const before = JSON.stringify(w);
    const r = applyEffects(
      [
        { op: "addSupplies", amount: 100 },
        { op: "addResolve", amount: 10 },
        { op: "setLocation", location: "unknown", state: "strained" },
      ],
      w,
    );
    expect(r).toEqual({ ok: false, reason: "effect-failed-at-index:2:unknown-location" });
    // +100 supplies and +10 resolve must NOT leak.
    expect(JSON.stringify(w)).toBe(before);
    expect(w.resources).toBe(30);
    expect(w.resolve).toBe(60);
  });

  it("original unchanged after success; result is an independent object", () => {
    const w = freeze(world());
    const before = JSON.stringify(w);
    const r = applyEffects(
      [
        { op: "appendDeed", deed: "The gate held." },
        { op: "addSupplies", amount: 5 },
      ],
      w,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(JSON.stringify(w)).toBe(before);
    expect(r.world).not.toBe(w);
    expect(r.world.deeds).toEqual(["d1", "The gate held."]);
    r.world.resources = 9999; // independently mutable
    expect(w.resources).toBe(30);
  });

  it("intermediate worlds are not observable from the API", () => {
    const w = world();
    const ok = applyEffects(
      [
        { op: "addSupplies", amount: 1 },
        { op: "addSupplies", amount: 2 },
      ],
      w,
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("expected ok");
    expect(Object.keys(ok).sort()).toEqual(["ok", "world"]); // no intermediate keys
    const bad = applyEffects([{ op: "addSupplies", amount: 1 }, { op: "nope" }], w);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("expected failure");
    expect("world" in bad).toBe(false); // no partial world on failure
    expect(Object.keys(bad).sort()).toEqual(["ok", "reason"]);
  });

  it("failure reasons are deterministic and indexed", () => {
    const w = world();
    const a = applyEffects([{ op: "addSupplies", amount: 1 }, { op: "nope" }], world());
    const b = applyEffects([{ op: "addSupplies", amount: 1 }, { op: "nope" }], world());
    expect(a).toEqual(b);
    expect(a).toEqual({ ok: false, reason: "invalid-effect-at-index:1" });
    expect(JSON.stringify(w)).toBe(JSON.stringify(world()));
  });
});
