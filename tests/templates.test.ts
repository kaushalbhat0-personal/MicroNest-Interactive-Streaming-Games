import { describe, expect, it } from "vitest";
import {
  fireTemplate,
  isEligibleTemplate,
  isRepeatEligible,
  recordTemplateFire,
  scanTemplates,
  selectTemplate,
  validateEventTemplate,
  validateRepeatState,
  type EventTemplate,
} from "../src/engine/templates";
import { initialWorld, type WorldState } from "../src/engine/types";

function world(over: Partial<WorldState> = {}): WorldState {
  return {
    ...initialWorld("2026-11-03T00:00:00.000Z"),
    threatLevel: 45,
    resources: 30,
    resolve: 60,
    ...over,
  };
}

function tpl(over: Partial<EventTemplate> = {}): EventTemplate {
  return {
    id: "test-event",
    condition: { op: "gte", counter: "threatLevel", value: 1 },
    effects: [{ op: "addSupplies", amount: 5 }],
    repeat: { kind: "once" },
    weight: 0,
    trigger: { kind: "manual" },
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

describe("Phase 4D slice 5 — event template + read-only eligibility", () => {
  it("valid template with true predicate is eligible", () => {
    expect(isEligibleTemplate(tpl(), world())).toEqual({ ok: true, eligible: true });
  });

  it("valid template with false predicate is ineligible (not invalid)", () => {
    const t = tpl({ condition: { op: "gte", counter: "threatLevel", value: 99 } });
    expect(isEligibleTemplate(t, world())).toEqual({ ok: true, eligible: false });
  });

  it("invalid templates fail closed", () => {
    const w = world();
    const bad: unknown[] = [
      null, undefined, 42, "x", [], {},
      tpl({ id: "" }),
      tpl({ id: "x".repeat(65) }), // bounded id length
      { ...tpl(), condition: undefined },
      { ...tpl(), effects: undefined },
      { ...tpl(), repeat: undefined },
      { ...tpl(), weight: undefined },
      { ...tpl(), id: undefined },
    ];
    for (const t of bad) {
      expect(validateEventTemplate(t)).toBe(false);
      expect(isEligibleTemplate(t, w)).toEqual({ ok: false, reason: "invalid-template" });
    }
    expect(validateEventTemplate(tpl())).toBe(true);
  });

  it("invalid predicate inside template is rejected", () => {
    expect(
      isEligibleTemplate(tpl({ condition: { op: "gt", counter: "x", value: 1 } as never }), world()),
    ).toEqual({ ok: false, reason: "invalid-template" });
  });

  it("empty effects array is rejected", () => {
    expect(isEligibleTemplate(tpl({ effects: [] }), world())).toEqual({
      ok: false, reason: "invalid-template",
    });
  });

  it("malformed effect inside template is rejected", () => {
    const t = tpl({ effects: [{ op: "addSupplies", amount: 5 }, { op: "nope" } as never] });
    expect(validateEventTemplate(t)).toBe(false);
    expect(isEligibleTemplate(t, world())).toEqual({ ok: false, reason: "invalid-template" });
  });

  it("repeat/cost/weight shapes are validated, not executed", () => {
    expect(validateEventTemplate(tpl({ repeat: { kind: "sometimes" } as never }))).toBe(false);
    expect(validateEventTemplate(tpl({ repeat: { kind: "cooldownStreams" } as never }))).toBe(false);
    expect(
      validateEventTemplate(tpl({ repeat: { kind: "cooldownStreams", streams: 0 } })),
    ).toBe(false);
    expect(
      validateEventTemplate(tpl({ repeat: { kind: "cooldownStreams", streams: 3 } })),
    ).toBe(true);
    expect(validateEventTemplate(tpl({ cost: { supplies: -1 } }))).toBe(false);
    expect(validateEventTemplate(tpl({ cost: null as never }))).toBe(false);
    expect(validateEventTemplate(tpl({ cost: { supplies: 10, resolve: 5 } }))).toBe(true);
    expect(validateEventTemplate(tpl({ weight: NaN }))).toBe(false);
    expect(validateEventTemplate(tpl({ weight: Infinity }))).toBe(false);
  });

  it("empty template collection is valid and returns empty", () => {
    expect(scanTemplates([], world())).toEqual({ ok: true, eligibleIds: [] });
    expect(scanTemplates("nope", world())).toEqual({ ok: false, reason: "invalid-templates-list" });
  });

  it("scan preserves input order and excludes ineligible templates", () => {
    const w = world();
    const a = tpl({ id: "a", condition: { op: "eq", counter: "waveNumber", value: 1 } });
    const b = tpl({ id: "b", condition: { op: "eq", counter: "waveNumber", value: 99 } });
    const c = tpl({ id: "c", condition: { op: "flagUnset", flag: "anything" } });
    expect(scanTemplates([a, b, c], w)).toEqual({ ok: true, eligibleIds: ["a", "c"] });
    expect(scanTemplates([c, a, b], w)).toEqual({ ok: true, eligibleIds: ["c", "a"] });
  });

  it("malformed entry fails the whole scan closed", () => {
    const w = world();
    const good = tpl({ id: "good" });
    expect(scanTemplates([good, { op: "nope" }], w)).toEqual({
      ok: false, reason: "invalid-template-at-index:1",
    });
  });

  it("duplicate template ids reject the collection", () => {
    const w = world();
    const x1 = tpl({ id: "x" });
    const x2 = tpl({ id: "x", condition: { op: "eq", counter: "waveNumber", value: 99 } });
    expect(scanTemplates([x1, x2], w)).toEqual({ ok: false, reason: "duplicate-template-id:x" });
    // Even when the first occurrence is ineligible.
    expect(scanTemplates([x2, x1], w)).toEqual({ ok: false, reason: "duplicate-template-id:x" });
  });

  it("weight does not affect eligibility or order", () => {
    const w = world();
    const lo = tpl({ id: "lo", weight: -500 });
    const hi = tpl({ id: "hi", weight: 500 });
    expect(isEligibleTemplate(lo, w)).toEqual(isEligibleTemplate(hi, w));
    expect(scanTemplates([hi, lo], w)).toEqual({ ok: true, eligibleIds: ["hi", "lo"] });
  });

  it("repeat and cost never mutate the world", () => {
    const w = world();
    const before = JSON.stringify(w);
    const t = tpl({
      repeat: { kind: "cooldownStreams", streams: 2 },
      cost: { supplies: 10, resolve: 5 },
    });
    expect(isEligibleTemplate(t, w)).toEqual({ ok: true, eligible: true });
    expect(scanTemplates([t], w)).toEqual({ ok: true, eligibleIds: ["test-event"] });
    expect(JSON.stringify(w)).toBe(before); // nothing spent, nothing recorded
  });

  it("effects are never executed during eligibility", () => {
    const w = world({ resources: 30 });
    const t = tpl({ effects: [{ op: "addSupplies", amount: 100 }] });
    expect(isEligibleTemplate(t, w)).toEqual({ ok: true, eligible: true });
    expect(scanTemplates([t], w)).toEqual({ ok: true, eligibleIds: ["test-event"] });
    expect(w.resources).toBe(30); // +100 never applied
  });

  it("frozen world survives eligibility and scanning unchanged", () => {
    const w = freeze(world());
    const before = JSON.stringify(w);
    const t = tpl({ effects: [{ op: "appendDeed", deed: "would write" }] });
    expect(isEligibleTemplate(t, w)).toEqual({ ok: true, eligible: true });
    expect(scanTemplates([t, tpl({ id: "b" })], w)).toEqual({
      ok: true, eligibleIds: ["test-event", "b"],
    });
    expect(JSON.stringify(w)).toBe(before);
  });

  it("repeated scans are deterministic", () => {
    const w = world();
    const lib = [
      tpl({ id: "a" }),
      tpl({ id: "b", condition: { op: "eq", counter: "waveNumber", value: 99 } }),
    ];
    const first = scanTemplates(lib, w);
    expect([scanTemplates(lib, w), scanTemplates(lib, structuredClone(w))]).toEqual([first, first]);
    expect(first).toEqual({ ok: true, eligibleIds: ["a"] });
  });
});

describe("Phase 4D slice 6 — selection-free template firing", () => {
  it("valid no-cost template fires successfully", () => {
    const w = world({ resources: 30, resolve: 60 });
    const r = fireTemplate(tpl({ effects: [{ op: "addStanding", faction: "goblins", amount: 5 }] }), w);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.world.factionState["goblins"]).toBe(35); // initial 30 + 5
    expect({ ...w, factionState: { ...w.factionState, goblins: 35 }, repeatState: r.world.repeatState }).toEqual(r.world);
    expect(r.world.repeatState.onceFired).toEqual(["test-event"]); // Slice 8B: successful firing records
  });

  it("ineligible and malformed templates are rejected distinctly", () => {
    const w = world();
    expect(fireTemplate(tpl({ condition: { op: "eq", counter: "waveNumber", value: 99 } }), w)).toEqual({
      ok: false, reason: "template-ineligible",
    });
    expect(fireTemplate({ op: "nope" }, w)).toEqual({ ok: false, reason: "invalid-template" });
    expect(fireTemplate(tpl({ effects: [] }), w)).toEqual({ ok: false, reason: "invalid-template" });
  });

  it("no-cost firing mutates neither resources nor resolve", () => {
    const w = world({ resources: 30, resolve: 60 });
    const r = fireTemplate(tpl({ effects: [{ op: "setFlag", flag: "f" }] }), w);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.world.resources).toBe(30);
    expect(r.world.resolve).toBe(60);
  });

  it("supplies, resolve, and combined costs are deducted", () => {
    const s = fireTemplate(tpl({ cost: { supplies: 10 }, effects: [{ op: "setFlag", flag: "f" }] }), world());
    expect(s.ok && s.world.resources).toBe(20); // 30 - 10
    const r = fireTemplate(tpl({ cost: { resolve: 15 }, effects: [{ op: "setFlag", flag: "f" }] }), world());
    expect(r.ok && r.world.resolve).toBe(45); // 60 - 15
    const both = fireTemplate(
      tpl({ cost: { supplies: 10, resolve: 15 }, effects: [{ op: "setFlag", flag: "f" }] }),
      world(),
    );
    expect(both.ok).toBe(true);
    if (!both.ok) throw new Error("expected ok");
    expect(both.world.resources).toBe(20);
    expect(both.world.resolve).toBe(45);
    expect(both.world.storyFlags["f"]).toBe(true);
  });

  it("insufficient supplies rejected; supplies take precedence", () => {
    const w = world({ resources: 5, resolve: 0 });
    expect(fireTemplate(tpl({ cost: { supplies: 10 }, effects: [{ op: "setFlag", flag: "f" }] }), w)).toEqual({
      ok: false, reason: "insufficient-supplies",
    });
    expect(fireTemplate(tpl({ cost: { resolve: 5 }, effects: [{ op: "setFlag", flag: "f" }] }), world({ resolve: 0 }))).toEqual({
      ok: false, reason: "insufficient-resolve",
    });
    // Both insufficient -> supplies first (deterministic precedence).
    expect(
      fireTemplate(tpl({ cost: { supplies: 999, resolve: 999 }, effects: [{ op: "setFlag", flag: "f" }] }), w),
    ).toEqual({ ok: false, reason: "insufficient-supplies" });
    expect(JSON.stringify(w)).toBe(JSON.stringify(world({ resources: 5, resolve: 0 }))); // no effects ran
  });

  it("effects execute after cost deduction and compose with it", () => {
    const w = world({ resources: 100 });
    // cost 20 deducted first, then +10 effect observes the deducted state: 100 - 20 + 10 = 90.
    const r = fireTemplate(
      tpl({ cost: { supplies: 20 }, effects: [{ op: "addSupplies", amount: 10 }] }),
      w,
    );
    expect(r.ok && r.world.resources).toBe(90);
    // Same for resolve: 60 - 15 + 5 = 50.
    const q = fireTemplate(
      tpl({ cost: { resolve: 15 }, effects: [{ op: "addResolve", amount: 5 }] }),
      world(),
    );
    expect(q.ok && q.world.resolve).toBe(50);
  });

  it("effect failure rolls back cost and earlier effects atomically", () => {
    const w = world({ resources: 100, resolve: 60 });
    const before = JSON.stringify(w);
    const late = fireTemplate(
      tpl({
        cost: { supplies: 20 },
        effects: [
          { op: "addResolve", amount: 5 },
          { op: "setLocation", location: "unknown", state: "strained" },
        ],
      }),
      w,
    );
    expect(late).toEqual({
      ok: false,
      reason: "template-effects-failed:effect-failed-at-index:1:unknown-location",
    });
    expect(JSON.stringify(w)).toBe(before); // cost 20 AND +5 resolve rolled back
    expect(w.resources).toBe(100);

    const first = fireTemplate(
      tpl({
        cost: { supplies: 20 },
        effects: [{ op: "setLocation", location: "unknown", state: "strained" }],
      }),
      w,
    );
    expect(first).toEqual({
      ok: false, reason: "template-effects-failed:effect-failed-at-index:0:unknown-location",
    });
    expect(JSON.stringify(w)).toBe(before);
  });

  it("weight is inert during firing; repeat recording is the only bookkeeping", () => {
    const w = world();
    const before = JSON.stringify(w);
    const a = fireTemplate(
      tpl({ repeat: { kind: "cooldownStreams", streams: 2 }, weight: 999, effects: [{ op: "setFlag", flag: "f" }] }),
      w,
    );
    const b = fireTemplate(
      tpl({ repeat: { kind: "once" }, weight: -999, effects: [{ op: "setFlag", flag: "f" }] }),
      world(),
    );
    // Outcomes differ ONLY in repeat bookkeeping: weight never affects results.
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.world.storyFlags).toEqual(b.world.storyFlags);
    expect(a.world.repeatState.cooldownUntilStream).toEqual({ "test-event": 2 }); // 0 + 2
    expect(b.world.repeatState.onceFired).toEqual(["test-event"]);
    expect(b.world.repeatState.cooldownUntilStream).toEqual({});
    // No firing counts, stream-count changes, or chapter changes recorded.
    expect(JSON.stringify(w)).toBe(before);
    if (a.ok) {
      expect(a.world.streamCount).toBe(w.streamCount);
      expect(a.world.currentChapter).toBe(w.currentChapter);
    }
  });

  it("frozen world survives every firing path unchanged", () => {
    const mk = () => freeze(world({ resources: 100, resolve: 60 }));
    const paths: Array<[string, EventTemplate]> = [
      ["success", tpl({ cost: { supplies: 10 }, effects: [{ op: "addSupplies", amount: 1 }] })],
      ["ineligible", tpl({ condition: { op: "eq", counter: "waveNumber", value: 99 } })],
      ["unaffordable", tpl({ cost: { supplies: 999 }, effects: [{ op: "setFlag", flag: "f" }] })],
      [
        "effects-fail",
        tpl({ cost: { supplies: 1 }, effects: [{ op: "setLocation", location: "nope", state: "lost" }] }),
      ],
    ];
    for (const [name, t] of paths) {
      const w = mk();
      const before = JSON.stringify(w);
      const r = fireTemplate(t, w);
      expect(JSON.stringify(w)).toBe(before); // would throw if mutated (frozen, strict mode)
      if (name === "success") {
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.world).not.toBe(w);
          expect(r.world.resources).toBe(91); // 100 - 10 + 1, distinct object
        }
      } else {
        expect(r.ok).toBe(false);
      }
    }
  });

  it("failure reasons are deterministic", () => {
    const t = tpl({ cost: { supplies: 999 }, effects: [{ op: "setFlag", flag: "f" }] });
    expect([fireTemplate(t, world()), fireTemplate(t, world())]).toEqual([
      { ok: false, reason: "insufficient-supplies" },
      { ok: false, reason: "insufficient-supplies" },
    ]);
  });
});

describe("Phase 4D slice 7 — deterministic template selection", () => {
  it("empty collection selects nothing", () => {
    expect(selectTemplate([], world())).toEqual({ ok: true, template: null });
  });

  it("non-array input is invalid", () => {
    for (const bad of [null, undefined, 42, "x", { id: "a" }]) {
      expect(selectTemplate(bad, world())).toEqual({ ok: false, reason: "invalid-templates-list" });
    }
  });

  it("malformed template fails closed with index", () => {
    expect(selectTemplate([tpl({ id: "ok" }), { op: "nope" }], world())).toEqual({
      ok: false, reason: "invalid-template-at-index:1",
    });
  });

  it("duplicate ids rejected", () => {
    expect(selectTemplate([tpl({ id: "x" }), tpl({ id: "x" })], world())).toEqual({
      ok: false, reason: "duplicate-template-id:x",
    });
  });

  it("ineligible templates are excluded", () => {
    const t = tpl({ condition: { op: "eq", counter: "waveNumber", value: 99 } });
    expect(selectTemplate([t], world())).toEqual({ ok: true, template: null });
  });

  it("unaffordable templates are excluded without failing selection", () => {
    const poor = world({ resources: 5 });
    const pricey = tpl({ id: "pricey", cost: { supplies: 100 }, effects: [{ op: "setFlag", flag: "f" }] });
    expect(selectTemplate([pricey], poor)).toEqual({ ok: true, template: null });
    const cheap = tpl({ id: "cheap", cost: { supplies: 5 }, effects: [{ op: "setFlag", flag: "g" }] });
    const r = selectTemplate([pricey, cheap], poor);
    expect(r.ok).toBe(true);
    if (!r.ok || !r.template) throw new Error("expected candidate");
    expect(r.template.id).toBe("cheap");
  });

  it("highest weight wins; input order breaks ties", () => {
    const w = world();
    const a = tpl({ id: "a", weight: 10 });
    const b = tpl({ id: "b", weight: 50 });
    const c = tpl({ id: "c", weight: 50 });
    const first = selectTemplate([a, b, c], w);
    expect(first.ok && first.template && first.template.id).toBe("b");
    const swapped = selectTemplate([a, c, b], w);
    expect(swapped.ok && swapped.template && swapped.template.id).toBe("c");
  });

  it("negative finite weights compare numerically without normalization", () => {
    const w = world();
    const neg = tpl({ id: "neg", weight: -5 });
    const neg2 = tpl({ id: "neg2", weight: -1 });
    const r = selectTemplate([neg, neg2], w);
    expect(r.ok && r.template && r.template.id).toBe("neg2"); // -1 > -5
    const solo = selectTemplate([neg], w);
    expect(solo.ok && solo.template && solo.template.id).toBe("neg"); // lone negative still selectable
  });

  it("selection is read-only: frozen world, no deductions, no effects", () => {
    const w = freeze(world({ resources: 30, resolve: 60 }));
    const before = JSON.stringify(w);
    const t = tpl({
      id: "candidate",
      cost: { supplies: 10, resolve: 5 },
      repeat: { kind: "cooldownStreams", streams: 2 },
      weight: 7,
      effects: [{ op: "addSupplies", amount: 100 }, { op: "appendDeed", deed: "x" }],
    });
    const r = selectTemplate([t], w);
    expect(r.ok).toBe(true);
    if (!r.ok || !r.template) throw new Error("expected candidate");
    expect(r.template).toEqual(t); // decoupled clone, equal content
    expect(r.template).not.toBe(t);
    expect(JSON.stringify(w)).toBe(before); // pools, deeds, everything intact
  });

  it("repeated selection is deterministic", () => {
    const lib = [tpl({ id: "a", weight: 1 }), tpl({ id: "b", weight: 9 })];
    const w = world();
    const first = selectTemplate(lib, w);
    expect([selectTemplate(lib, w), selectTemplate(lib, structuredClone(w))]).toEqual([first, first]);
    expect(first.ok && first.template && first.template.id).toBe("b");
  });

  it("no candidate is a normal ok result", () => {
    const lib = [
      tpl({ id: "poor", cost: { supplies: 9999 }, effects: [{ op: "setFlag", flag: "f" }] }),
      tpl({ id: "off", condition: { op: "eq", counter: "waveNumber", value: 99 } }),
    ];
    expect(selectTemplate(lib, world())).toEqual({ ok: true, template: null });
  });
});

describe("Phase 4D slice 8A — repeat state model + pure repeat eligibility", () => {
  const onceTpl = (id: string, over: Partial<EventTemplate> = {}) =>
    tpl({ id, repeat: { kind: "once" }, ...over });
  const withRepeat = (w: WorldState, rs: Partial<WorldState["repeatState"]>): WorldState => ({
    ...w,
    repeatState: {
      onceFired: [],
      chapterFired: [],
      cooldownUntilStream: {},
      ...rs,
    },
  });

  it("once: never fired eligible, fired blocked, recording flips it", () => {
    const w = world();
    const t = onceTpl("one-shot");
    expect(isRepeatEligible(t, w)).toEqual({ ok: true, eligible: true });
    const recorded = recordTemplateFire(t, w);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) throw new Error("expected ok");
    expect(recorded.world.repeatState.onceFired).toEqual(["one-shot"]);
    expect(isRepeatEligible(t, recorded.world)).toEqual({ ok: true, eligible: false });
    // Recording again is idempotent, not duplicated.
    const twice = recordTemplateFire(t, recorded.world);
    expect(twice.ok && twice.world.repeatState.onceFired).toEqual(["one-shot"]);
  });

  it("selection alone never marks a template as fired", () => {
    const w = world();
    const t = onceTpl("picked");
    const sel = selectTemplate([t], w);
    expect(sel.ok && sel.template && sel.template.id).toBe("picked");
    expect(isRepeatEligible(t, w)).toEqual({ ok: true, eligible: true });
    expect(w.repeatState).toEqual({ onceFired: [], chapterFired: [], cooldownUntilStream: {} });
  });

  it("endless: always eligible, recording writes no bookkeeping", () => {
    const t = tpl({ id: "forever", repeat: { kind: "endless" } });
    const w = withRepeat(world(), {
      onceFired: ["other"],
      chapterFired: [{ id: "forever", arc: 1, chapter: 1 }],
      cooldownUntilStream: { forever: 999 },
    });
    expect(isRepeatEligible(t, w)).toEqual({ ok: true, eligible: true });
    const r = recordTemplateFire(t, w);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.world.repeatState).toEqual(w.repeatState); // untouched
  });

  it("perChapter: blocked in chapter, open in another, recording keeps chapter", () => {
    const t = tpl({ id: "rite", repeat: { kind: "perChapter" } });
    const w = world({ currentArc: 1, currentChapter: 2 });
    expect(isRepeatEligible(t, w)).toEqual({ ok: true, eligible: true });
    const r = recordTemplateFire(t, w);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.world.currentArc).toBe(1); // recording alters no chapter
    expect(r.world.currentChapter).toBe(2);
    expect(r.world.repeatState.chapterFired).toEqual([{ id: "rite", arc: 1, chapter: 2 }]);
    expect(isRepeatEligible(t, r.world)).toEqual({ ok: true, eligible: false });
    // Same chapter number in another arc is a different chapter.
    expect(isRepeatEligible(t, world({ currentArc: 2, currentChapter: 2, repeatState: r.world.repeatState }))).toEqual({
      ok: true, eligible: true,
    });
    // Next chapter in the same arc reopens.
    expect(isRepeatEligible(t, world({ currentArc: 1, currentChapter: 3, repeatState: r.world.repeatState }))).toEqual({
      ok: true, eligible: true,
    });
  });

  it("cooldownStreams: exact S+N boundary semantics for N=1,2,3", () => {
    for (const n of [1, 2, 3]) {
      const t = tpl({ id: `cool${n}`, repeat: { kind: "cooldownStreams", streams: n } });
      const fired = recordTemplateFire(t, world({ streamCount: 7 }));
      expect(fired.ok).toBe(true);
      if (!fired.ok) throw new Error("expected ok");
      expect(fired.world.repeatState.cooldownUntilStream[`cool${n}`]).toBe(7 + n);
      // Same stream blocked; intervening streams blocked; boundary open.
      expect(isRepeatEligible(t, world({ streamCount: 7, repeatState: fired.world.repeatState }))).toEqual({
        ok: true, eligible: false,
      });
      for (let s = 8; s < 7 + n; s++) {
        expect(
          isRepeatEligible(t, world({ streamCount: s, repeatState: fired.world.repeatState })),
        ).toEqual({ ok: true, eligible: false });
      }
      expect(
        isRepeatEligible(t, world({ streamCount: 7 + n, repeatState: fired.world.repeatState })),
      ).toEqual({ ok: true, eligible: true });
      // Never fired: no entry means eligible at any stream.
      expect(isRepeatEligible(t, world({ streamCount: 0 }))).toEqual({ ok: true, eligible: true });
    }
  });

  it("malformed repeat state and policies fail closed", () => {
    const t = onceTpl("x");
    const w = world();
    for (const rs of [
      null, "x", [],
      { onceFired: "nope", chapterFired: [], cooldownUntilStream: {} },
      { onceFired: [42], chapterFired: [], cooldownUntilStream: {} },
      { onceFired: [], chapterFired: [{ id: "x" }], cooldownUntilStream: {} },
      { onceFired: [], chapterFired: [], cooldownUntilStream: { x: -1 } },
      { onceFired: [], chapterFired: [], cooldownUntilStream: { x: 1.5 } },
    ]) {
      expect(validateRepeatState(rs)).toBe(false);
      const bad = { ...w, repeatState: rs } as unknown as WorldState;
      expect(isRepeatEligible(t, bad)).toEqual({ ok: false, reason: "invalid-repeat-state" });
      expect(recordTemplateFire(t, bad)).toEqual({ ok: false, reason: "invalid-repeat-state" });
    }
    expect(validateRepeatState(w.repeatState)).toBe(true);
    expect(isRepeatEligible({ ...t, repeat: { kind: "sometimes" } }, w)).toEqual({
      ok: false, reason: "invalid-template",
    });
    expect(recordTemplateFire({ ...t, repeat: { kind: "sometimes" } }, w)).toEqual({
      ok: false, reason: "invalid-template",
    });
  });

  it("frozen world and template survive repeat reads and writes", () => {
    const t = freeze(tpl({ id: "f", repeat: { kind: "cooldownStreams", streams: 2 } }));
    const w = freeze(world({ streamCount: 4 }));
    const beforeW = JSON.stringify(w);
    const beforeT = JSON.stringify(t);
    expect(isRepeatEligible(t, w)).toEqual({ ok: true, eligible: true });
    const r = recordTemplateFire(t, w);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(JSON.stringify(w)).toBe(beforeW);
    expect(JSON.stringify(t)).toBe(beforeT);
    expect("cooldownUntilStream" in r.world).toBe(false); // no such top-level field
    expect(r.world.repeatState.cooldownUntilStream["f"]).toBe(6);
    expect(isRepeatEligible(t, r.world)).toEqual({ ok: true, eligible: false });
  });

  it("repeat reads and writes are deterministic", () => {
    const t = tpl({ id: "d", repeat: { kind: "perChapter" } });
    const w = world({ currentArc: 3, currentChapter: 2 });
    expect([isRepeatEligible(t, w), isRepeatEligible(t, structuredClone(w))]).toEqual([
      { ok: true, eligible: true },
      { ok: true, eligible: true },
    ]);
    const a = recordTemplateFire(t, w);
    const b = recordTemplateFire(t, world({ currentArc: 3, currentChapter: 2 }));
    expect(a).toEqual(b);
  });

  it("repeat helpers are isolated: no effects, costs, or clock changes", () => {
    const t = tpl({
      id: "iso",
      repeat: { kind: "once" },
      cost: { supplies: 10, resolve: 5 },
      effects: [
        { op: "addSupplies", amount: 100 },
        { op: "addResolve", amount: 100 },
        { op: "setFlag", flag: "iso-fired" },
        { op: "appendDeed", deed: "iso" },
        { op: "advanceChapter" },
      ],
    });
    const w = world({ resources: 40, resolve: 40, streamCount: 9, currentArc: 2, currentChapter: 3 });
    const before = JSON.stringify(w);
    expect(isRepeatEligible(t, w)).toEqual({ ok: true, eligible: true });
    expect(JSON.stringify(w)).toBe(before);
    const r = recordTemplateFire(t, w);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    // ONLY repeat bookkeeping changed.
    expect({ ...w, repeatState: r.world.repeatState }).toEqual(r.world);
    expect(r.world.repeatState.onceFired).toEqual(["iso"]);
    expect(r.world.resources).toBe(40); // cost not deducted
    expect(r.world.resolve).toBe(40);
    expect(r.world.currentArc).toBe(2); // chapter untouched
    expect(r.world.currentChapter).toBe(3);
    expect(r.world.streamCount).toBe(9); // stream untouched
    expect(r.world.storyFlags["iso-fired"]).toBeUndefined();
  });
});

describe("Phase 4D slice 8B — repeat integration (wiring only)", () => {
  it("selection: fresh once template selectable, fired once skipped without abort", () => {
    const fresh = tpl({ id: "fresh", repeat: { kind: "once" }, weight: 1 });
    const done = tpl({ id: "done", repeat: { kind: "once" }, weight: 99 });
    const w = world({ repeatState: { onceFired: ["done"], chapterFired: [], cooldownUntilStream: {} } });
    // High-weight "done" is repeat-exhausted: skipped, selection continues to "fresh".
    const r = selectTemplate([done, fresh], w);
    expect(r.ok).toBe(true);
    if (!r.ok || !r.template) throw new Error("expected candidate");
    expect(r.template.id).toBe("fresh");
    // Only exhausted candidates: normal null, not an error.
    expect(selectTemplate([done], w)).toEqual({ ok: true, template: null });
  });

  it("selection: endless stays selectable after records; perChapter follows chapter", () => {
    const ever = tpl({ id: "ever", repeat: { kind: "endless" }, weight: 1 });
    let w = world({ currentArc: 1, currentChapter: 1 });
    const fired = recordTemplateFire(ever, w);
    expect(fired.ok).toBe(true);
    if (!fired.ok) throw new Error("expected ok");
    w = fired.world;
    const sel = selectTemplate([ever], w);
    expect(sel.ok && sel.template && sel.template.id).toBe("ever");

    const rite = tpl({ id: "rite", repeat: { kind: "perChapter" }, weight: 5 });
    expect(selectTemplate([rite], w).ok).toBe(true);
    const rw = recordTemplateFire(rite, w);
    expect(rw.ok).toBe(true);
    if (!rw.ok) throw new Error("expected ok");
    expect(selectTemplate([rite], rw.world)).toEqual({ ok: true, template: null }); // same chapter: blocked
    const next = { ...rw.world, currentChapter: 2 };
    const reopened = selectTemplate([rite], next);
    expect(reopened.ok && reopened.template && reopened.template.id).toBe("rite"); // new chapter: open
  });

  it("selection: cooldown blocked before boundary, open exactly at boundary", () => {
    const patrol = tpl({ id: "patrol", repeat: { kind: "cooldownStreams", streams: 2 }, weight: 3 });
    const fired = recordTemplateFire(patrol, world({ streamCount: 5 }));
    expect(fired.ok).toBe(true);
    if (!fired.ok) throw new Error("expected ok");
    const rs = fired.world.repeatState;
    expect(selectTemplate([patrol], world({ streamCount: 5, repeatState: rs }))).toEqual({
      ok: true, template: null,
    });
    expect(selectTemplate([patrol], world({ streamCount: 6, repeatState: rs }))).toEqual({
      ok: true, template: null,
    });
    const open = selectTemplate([patrol], world({ streamCount: 7, repeatState: rs }));
    expect(open.ok && open.template && open.template.id).toBe("patrol");
  });

  it("selection: malformed repeat state fails closed; ranking rules unchanged", () => {
    const bad = { ...world(), repeatState: { onceFired: "x", chapterFired: [], cooldownUntilStream: {} } } as unknown as WorldState;
    expect(selectTemplate([tpl({ id: "a" })], bad)).toEqual({ ok: false, reason: "invalid-repeat-state" });
    // Weight ranking and input-order ties behave exactly as before among eligible candidates.
    const w = world();
    const lo = tpl({ id: "lo", weight: 1 });
    const hi = tpl({ id: "hi", weight: 9 });
    const r = selectTemplate([lo, hi], w);
    expect(r.ok && r.template && r.template.id).toBe("hi");
    const blocked = tpl({ id: "blocked", weight: 99, repeat: { kind: "once" } });
    const wb = world({ repeatState: { onceFired: ["blocked"], chapterFired: [], cooldownUntilStream: {} } });
    const r2 = selectTemplate([blocked, lo, hi], wb);
    expect(r2.ok && r2.template && r2.template.id).toBe("hi"); // exhausted 99 skipped, ranking intact
  });

  it("firing records once/perChapter/cooldown; endless writes nothing", () => {
    const w = world({ streamCount: 4, currentArc: 2, currentChapter: 3 });
    const once = fireTemplate(tpl({ id: "o", effects: [{ op: "setFlag", flag: "o" }] }), w);
    expect(once.ok).toBe(true);
    if (!once.ok) throw new Error("expected ok");
    expect(once.world.repeatState.onceFired).toEqual(["o"]);

    const per = fireTemplate(tpl({ id: "p", repeat: { kind: "perChapter" }, effects: [{ op: "setFlag", flag: "p" }] }), w);
    expect(per.ok).toBe(true);
    if (!per.ok) throw new Error("expected ok");
    expect(per.world.repeatState.chapterFired).toEqual([{ id: "p", arc: 2, chapter: 3 }]);

    const cd = fireTemplate(
      tpl({ id: "c", repeat: { kind: "cooldownStreams", streams: 2 }, effects: [{ op: "setFlag", flag: "c" }] }),
      w,
    );
    expect(cd.ok).toBe(true);
    if (!cd.ok) throw new Error("expected ok");
    expect(cd.world.repeatState.cooldownUntilStream).toEqual({ c: 6 }); // 4 + 2

    const endless = fireTemplate(tpl({ id: "e", repeat: { kind: "endless" }, effects: [{ op: "setFlag", flag: "e" }] }), w);
    expect(endless.ok).toBe(true);
    if (!endless.ok) throw new Error("expected ok");
    expect(endless.world.repeatState).toEqual(w.repeatState);
  });

  it("second firing of exhausted templates is rejected", () => {
    const one = tpl({ id: "one", effects: [{ op: "setFlag", flag: "f" }] });
    const first = fireTemplate(one, world());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected ok");
    expect(fireTemplate(one, first.world)).toEqual({ ok: false, reason: "template-repeat-ineligible" });

    const rite = tpl({ id: "rite", repeat: { kind: "perChapter" }, effects: [{ op: "setFlag", flag: "g" }] });
    const r1 = fireTemplate(rite, world({ currentArc: 1, currentChapter: 1 }));
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error("expected ok");
    expect(fireTemplate(rite, r1.world)).toEqual({ ok: false, reason: "template-repeat-ineligible" });
    const next = { ...r1.world, currentChapter: 2 }; // chapter change reopens
    const r2 = fireTemplate(rite, next);
    expect(r2.ok).toBe(true);

    const patrol = tpl({ id: "patrol", repeat: { kind: "cooldownStreams", streams: 2 }, effects: [{ op: "setFlag", flag: "h" }] });
    const c1 = fireTemplate(patrol, world({ streamCount: 5 }));
    expect(c1.ok).toBe(true);
    if (!c1.ok) throw new Error("expected ok");
    expect(fireTemplate(patrol, c1.world)).toEqual({ ok: false, reason: "template-repeat-ineligible" });
    const atBoundary = { ...c1.world, streamCount: 7 };
    expect(fireTemplate(patrol, atBoundary).ok).toBe(true);
  });

  it("failed firing records nothing and rolls back cost and effects", () => {
    const base = world({
      resources: 100, resolve: 60,
      repeatState: { onceFired: ["old"], chapterFired: [], cooldownUntilStream: {} },
    });
    const before = JSON.stringify(base);
    const bad = tpl({
      id: "bad",
      cost: { supplies: 20 },
      effects: [
        { op: "addResolve", amount: 5 },
        { op: "setLocation", location: "unknown", state: "strained" },
      ],
    });
    const r = fireTemplate(bad, base);
    expect(r).toEqual({ ok: false, reason: "template-effects-failed:effect-failed-at-index:1:unknown-location" });
    expect(JSON.stringify(base)).toBe(before);
    expect(base.resources).toBe(100);
    expect(base.repeatState.onceFired).toEqual(["old"]); // pre-existing records preserved, nothing added
  });

  it("malformed repeat state fails firing closed with no partial state", () => {
    const bad = { ...world(), repeatState: "corrupt" } as unknown as WorldState;
    const before = JSON.stringify(bad);
    const r = fireTemplate(tpl({ effects: [{ op: "setFlag", flag: "f" }] }), bad);
    expect(r).toEqual({ ok: false, reason: "invalid-repeat-state" });
    expect(JSON.stringify(bad)).toBe(before);
  });

  it("firing still composes cost, effects, and bookkeeping atomically", () => {
    // cost 20 deducted, +10 effect applied, once recorded — all or nothing.
    const w = world({ resources: 100 });
    const t = tpl({
      id: "full",
      cost: { supplies: 20 },
      effects: [{ op: "addSupplies", amount: 10 }, { op: "setFlag", flag: "f" }],
    });
    const r = fireTemplate(t, w);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.world.resources).toBe(90); // 100 - 20 + 10
    expect(r.world.storyFlags["f"]).toBe(true);
    expect(r.world.repeatState.onceFired).toEqual(["full"]);
    expect(JSON.stringify(w)).toBe(JSON.stringify(world({ resources: 100 }))); // input untouched
  });
});
