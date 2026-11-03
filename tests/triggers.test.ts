import { describe, expect, it } from "vitest";
import { isKnownCounter } from "../src/engine/predicates";
import {
  matchesTrigger,
  validateTrigger,
  validateTriggerContext,
  type Trigger,
  type TriggerContext,
} from "../src/engine/triggers";
import { collectCandidates } from "../src/engine/templates";
import { initialWorld, type WorldState } from "../src/engine/types";
import type { EventTemplate } from "../src/engine/templates";

function world(over: Partial<WorldState> = {}): WorldState {
  return {
    ...initialWorld("2026-11-03T00:00:00.000Z"),
    threatLevel: 45,
    resources: 30,
    resolve: 60,
    ...over,
  };
}

function tpl(id: string, trigger: Trigger, over: Partial<EventTemplate> = {}): EventTemplate {
  return {
    id,
    condition: { op: "gte", counter: "threatLevel", value: 1 },
    effects: [{ op: "setFlag", flag: `${id}-fired` }],
    repeat: { kind: "once" },
    weight: 0,
    trigger,
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

describe("Phase 4D slice 9 — trigger validation", () => {
  it("accepts all four valid kinds", () => {
    expect(validateTrigger({ kind: "streamOpen" })).toBe(true);
    expect(validateTrigger({ kind: "streamClose" })).toBe(true);
    expect(validateTrigger({ kind: "manual" })).toBe(true);
    expect(validateTrigger({ kind: "threshold", counter: "resources", value: 100 })).toBe(true);
    // Threshold reuses the shared predicate counter vocabulary (core + event names).
    expect(validateTrigger({ kind: "threshold", counter: "attacks", value: 3 })).toBe(true);
    expect(isKnownCounter("resources")).toBe(true);
    expect(isKnownCounter("attacks")).toBe(true);
    expect(isKnownCounter("constructor")).toBe(false);
  });

  it("rejects malformed triggers", () => {
    const bad: unknown[] = [
      null, undefined, 42, "streamOpen", [], {},
      { kind: "chat" }, { kind: "timer" }, { kind: "paid" }, { kind: "random" },
      { kind: "threshold" }, // missing counter + value
      { kind: "threshold", counter: "resources" },
      { kind: "threshold", value: 100 },
      { kind: "threshold", counter: "nope", value: 100 }, // unknown counter
      { kind: "threshold", counter: "constructor", value: 1 }, // prototype names rejected
      { kind: "threshold", counter: "resources", value: NaN },
      { kind: "threshold", counter: "resources", value: Infinity },
      { kind: "threshold", counter: "resources", value: "100" },
      { kind: "streamOpen", extra: "ignored-shape-still-valid" }, // extras inert, still valid
    ];
    for (const t of bad.slice(0, bad.length - 1)) expect(validateTrigger(t)).toBe(false);
    expect(validateTrigger(bad[bad.length - 1])).toBe(true);
    expect(validateTriggerContext({ kind: "streamOpen" })).toBe(true);
    expect(validateTriggerContext({ kind: "nope" })).toBe(false);
    expect(validateTriggerContext({ kind: "threshold", counterValues: { resources: NaN } })).toBe(false);
  });
});

describe("Phase 4D slice 9 — trigger matching", () => {
  const open: TriggerContext = { kind: "streamOpen" };
  const close: TriggerContext = { kind: "streamClose" };
  const manual: TriggerContext = { kind: "manual" };

  it("named moments match only their own context kind", () => {
    expect(matchesTrigger({ kind: "streamOpen" }, open)).toBe(true);
    expect(matchesTrigger({ kind: "streamOpen" }, close)).toBe(false);
    expect(matchesTrigger({ kind: "streamOpen" }, manual)).toBe(false);
    expect(matchesTrigger({ kind: "streamClose" }, close)).toBe(true);
    expect(matchesTrigger({ kind: "streamClose" }, open)).toBe(false);
    expect(matchesTrigger({ kind: "manual" }, manual)).toBe(true);
    expect(matchesTrigger({ kind: "manual" }, open)).toBe(false);
  });

  it("threshold is inclusive with no history semantics", () => {
    const t: Trigger = { kind: "threshold", counter: "resources", value: 100 };
    const at = (v: number | undefined): TriggerContext =>
      v === undefined
        ? { kind: "threshold" }
        : { kind: "threshold", counterValues: { resources: v } };
    expect(matchesTrigger(t, at(99))).toBe(false); // below boundary
    expect(matchesTrigger(t, at(100))).toBe(true); // exactly at boundary
    expect(matchesTrigger(t, at(101))).toBe(true); // above boundary
    expect(matchesTrigger(t, at(undefined))).toBe(false); // missing counter value
    expect(matchesTrigger(t, open)).toBe(false); // wrong context kind
    // Same reading twice gives the same answer: level, not crossing.
    expect(matchesTrigger(t, at(150))).toBe(matchesTrigger(t, at(150)));
  });

  it("malformed inputs match nothing and mutate nothing", () => {
    const t = freeze({ kind: "threshold", counter: "resources", value: 100 } as Trigger);
    const c = freeze({ kind: "threshold", counterValues: { resources: 150 } } as TriggerContext);
    const beforeT = JSON.stringify(t);
    const beforeC = JSON.stringify(c);
    expect(matchesTrigger(t, c)).toBe(true);
    expect(matchesTrigger(null, c)).toBe(false);
    expect(matchesTrigger(t, null)).toBe(false);
    expect(matchesTrigger({ kind: "nope" }, c)).toBe(false);
    expect(JSON.stringify(t)).toBe(beforeT);
    expect(JSON.stringify(c)).toBe(beforeC);
  });
});

describe("Phase 4D slice 9 — collectCandidates", () => {
  const open: TriggerContext = { kind: "streamOpen" };
  const manual: TriggerContext = { kind: "manual" };

  it("matching trigger selects the eligible template", () => {
    const lib = [tpl("a", { kind: "streamOpen" }), tpl("b", { kind: "manual" })];
    const r = collectCandidates(open, lib, world());
    expect(r.ok).toBe(true);
    if (!r.ok || !r.template) throw new Error("expected candidate");
    expect(r.template.id).toBe("a");
  });

  it("non-matching triggers are excluded before selection", () => {
    const lib = [tpl("a", { kind: "manual", } as Trigger, { weight: 999 }), tpl("b", { kind: "streamOpen" })];
    // "a" outweighs "b" but its trigger does not match: only "b" is visible.
    const r = collectCandidates(open, lib, world());
    expect(r.ok && r.template && r.template.id).toBe("b");
  });

  it("weight ranking and input-order ties survive trigger filtering", () => {
    const lib = [
      tpl("low", { kind: "streamOpen" }, { weight: 1 }),
      tpl("high", { kind: "streamOpen" }, { weight: 9 }),
    ];
    expect(collectCandidates(open, lib, world()).ok).toBe(true);
    const r = collectCandidates(open, lib, world());
    if (!r.ok || !r.template) throw new Error("expected candidate");
    expect(r.template.id).toBe("high");
    const tied = [
      tpl("first", { kind: "streamOpen" }, { weight: 5 }),
      tpl("second", { kind: "streamOpen" }, { weight: 5 }),
    ];
    const rt = collectCandidates(open, tied, world());
    expect(rt.ok && rt.template && rt.template.id).toBe("first");
  });

  it("condition, repeat, and affordability filtering still apply", () => {
    const w = world({ resources: 5 });
    const lib = [
      tpl("cond-off", { kind: "streamOpen" }, { condition: { op: "eq", counter: "waveNumber", value: 99 } }),
      tpl("repeat-off", { kind: "streamOpen" }, { repeat: { kind: "once" } }),
      tpl("poor", { kind: "streamOpen" }, { cost: { supplies: 9999 } }),
      tpl("good", { kind: "streamOpen" }),
    ];
    const fired = {
      ...w,
      repeatState: { onceFired: ["repeat-off"], chapterFired: [], cooldownUntilStream: {} },
    };
    const r = collectCandidates(open, lib, fired);
    expect(r.ok && r.template && r.template.id).toBe("good");
    // Each filter alone yields null, not an error.
    expect(collectCandidates(open, [lib[0]], w)).toEqual({ ok: true, template: null });
    expect(collectCandidates(open, [lib[2]], w)).toEqual({ ok: true, template: null });
  });

  it("duplicates and malformed templates abort even when triggers differ", () => {
    const w = world();
    expect(collectCandidates(open, [tpl("x", { kind: "manual" }), tpl("x", { kind: "streamOpen" })], w)).toEqual({
      ok: false, reason: "duplicate-template-id:x",
    });
    // Malformed entry aborts even though "good" matches and would be selected.
    const lib = [tpl("good", { kind: "streamOpen" }), { kind: "broken" }];
    expect(collectCandidates(open, lib, w)).toEqual({ ok: false, reason: "invalid-template-at-index:1" });
    // A template missing its trigger is malformed — never defaulted.
    const noTrigger = { ...tpl("t", { kind: "manual" }), trigger: undefined };
    expect(collectCandidates(manual, [noTrigger], w).ok).toBe(false);
  });

  it("empty and unmatched collections return null", () => {
    const w = world();
    expect(collectCandidates(open, [], w)).toEqual({ ok: true, template: null });
    expect(collectCandidates("nope", [], w)).toEqual({ ok: false, reason: "invalid-trigger-context" });
    expect(collectCandidates("nope", [tpl("a", { kind: "manual" })], w)).toEqual({
      ok: false, reason: "invalid-trigger-context",
    });
    expect(collectCandidates("manual", [tpl("a", { kind: "manual" })], w)).toEqual({
      ok: false, reason: "invalid-trigger-context",
    });
    expect(collectCandidates(manual, [tpl("a", { kind: "streamOpen" })], w)).toEqual({
      ok: true, template: null,
    });
    expect(collectCandidates(open, "nope", w)).toEqual({ ok: false, reason: "invalid-templates-list" });
  });

  it("threshold context collects by supplied counter level", () => {
    const lib = [tpl("rich", { kind: "threshold", counter: "resources", value: 100 })];
    const low = { kind: "threshold", counterValues: { resources: 20 } } as TriggerContext;
    const high = { kind: "threshold", counterValues: { resources: 150 } } as TriggerContext;
    expect(collectCandidates(low, lib, world())).toEqual({ ok: true, template: null });
    const r = collectCandidates(high, lib, world());
    expect(r.ok && r.template && r.template.id).toBe("rich");
  });

  it("selected template is isolated and the world is untouched", () => {
    const w = freeze(world({ resources: 200 }));
    const before = JSON.stringify(w);
    const lib = [tpl("a", { kind: "manual" }, { cost: { supplies: 50 }, weight: 3 })];
    const r = collectCandidates(manual, lib, w);
    expect(r.ok).toBe(true);
    if (!r.ok || !r.template) throw new Error("expected candidate");
    expect(r.template).toEqual(lib[0]);
    expect(r.template).not.toBe(lib[0]); // decoupled clone per selectTemplate contract
    expect(JSON.stringify(w)).toBe(before); // no deduction, no effects, no records
    expect(w.resources).toBe(200);
    // Deterministic across repeats.
    expect([collectCandidates(manual, lib, w), collectCandidates(manual, structuredClone(lib), w)]).toEqual([r, r]);
  });
});
