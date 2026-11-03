import { describe, expect, it } from "vitest";
import { validatePredicate } from "../src/engine/predicates";
import { validateEffect } from "../src/engine/effects";
import { validateTrigger } from "../src/engine/triggers";
import {
  collectCandidates,
  fireTemplate,
  validateEventTemplate,
} from "../src/engine/templates";
import { initialWorld, type WorldState } from "../src/engine/types";
import { CONTENT_LIBRARY } from "./fixtures/content-library";

const OPEN = { kind: "streamOpen" } as const;
const CLOSE = { kind: "streamClose" } as const;
const MANUAL = { kind: "manual" } as const;

function startWorld(): WorldState {
  return {
    ...initialWorld("2026-11-03T00:00:00.000Z"),
    streamCount: 0,
    currentArc: 1,
    currentChapter: 1,
    resources: 40,
    resolve: 55,
    threatLevel: 30,
    uniqueSearchers: ["a", "b", "c"],
    unlockedLocations: ["emberkeep-gate", "north-road"],
  };
}

/** Test-only wiring: a runtime would supply these levels from its own clock. */
function levelCtx(counter: string, value: number) {
  return { kind: "threshold", counterValues: { [counter]: value } } as const;
}

function mustFire(id: string, ctx: unknown, w: WorldState): WorldState {
  const sel = collectCandidates(ctx, CONTENT_LIBRARY, w);
  expect(sel.ok).toBe(true);
  if (!sel.ok || !sel.template) throw new Error(`expected selection, got ${JSON.stringify(sel)}`);
  expect(sel.template.id).toBe(id);
  const fired = fireTemplate(sel.template, w);
  expect(fired.ok).toBe(true);
  if (!fired.ok) throw new Error(`expected fire, got ${JSON.stringify(fired)}`);
  return fired.world;
}

describe("Phase 4D slice 10 — content library validity", () => {
  it("all six templates validate; ids unique; every sub-part valid", () => {
    expect(CONTENT_LIBRARY).toHaveLength(6);
    expect(new Set(CONTENT_LIBRARY.map((t) => t.id)).size).toBe(6);
    for (const t of CONTENT_LIBRARY) {
      expect(validateEventTemplate(t)).toBe(true);
      expect(validateTrigger(t.trigger)).toBe(true);
      expect(validatePredicate(t.condition)).toBe(true);
      expect(t.effects.length).toBeGreaterThan(0);
      for (const e of t.effects) expect(validateEffect(e)).toBe(true);
    }
    const kinds = new Set(CONTENT_LIBRARY.map((t) => t.trigger.kind));
    expect(kinds).toEqual(new Set(["streamOpen", "streamClose", "threshold", "manual"]));
    const repeats = new Set(CONTENT_LIBRARY.map((t) => t.repeat.kind));
    expect(repeats).toEqual(new Set(["once", "perChapter", "cooldownStreams", "endless"]));
  });

  it("content is data: JSON round-trip preserves validity", () => {
    const revived = JSON.parse(JSON.stringify(CONTENT_LIBRARY)) as unknown;
    expect(Array.isArray(revived) && (revived as unknown[]).every(validateEventTemplate)).toBe(true);
    expect(revived).toEqual(CONTENT_LIBRARY);
  });
});

describe("Phase 4D slice 10 — trigger coverage", () => {
  it("each trigger kind can collect its template", () => {
    const w = { ...startWorld(), deeds: ["earlier deed"] };
    const open = collectCandidates(OPEN, CONTENT_LIBRARY, w);
    expect(open.ok && open.template && open.template.trigger.kind).toBe("streamOpen");
    const close = collectCandidates(CLOSE, CONTENT_LIBRARY, w);
    expect(close.ok && close.template && close.template.trigger.kind).toBe("streamClose");
    const manual = collectCandidates(MANUAL, CONTENT_LIBRARY, w);
    expect(manual.ok && manual.template && manual.template.trigger.kind).toBe("manual");
    const rich = collectCandidates(levelCtx("resources", 60), CONTENT_LIBRARY, w);
    expect(rich.ok && rich.template && rich.template.id).toBe("granary-boon");
    const calm = collectCandidates(levelCtx("resources", 10), CONTENT_LIBRARY, w);
    expect(calm).toEqual({ ok: true, template: null }); // below every threshold
  });
});

describe("Phase 4D slice 10 — closed loop: one world, six moments", () => {
  it("action -> world change -> eligibility change -> next decision", () => {
    const seen: string[] = [];
    let w = startWorld();

    // Moment 1 (streamOpen): low resolve -> dawn-muster (cost 10, +15 resolve).
    w = mustFire("dawn-muster", OPEN, w);
    seen.push("dawn-muster");
    expect(w.resources).toBe(30); // 40 - 10 cost
    expect(w.resolve).toBe(70); // 55 + 15 effect AFTER cost
    expect(w.storyFlags["mustered"]).toBe(true);
    expect(w.repeatState.chapterFired).toEqual([{ id: "dawn-muster", arc: 1, chapter: 1 }]);

    // Moment 2 (streamOpen): resolve now 70 -> dawn condition false AND
    // repeat-exhausted; steady-watch becomes eligible instead.
    w = mustFire("steady-watch", OPEN, w);
    seen.push("steady-watch");
    expect(w.resources).toBe(40); // 30 + 10 effect

    // Moment 3 (streamOpen): both openers exhausted this chapter -> nothing.
    expect(collectCandidates(OPEN, CONTENT_LIBRARY, w)).toEqual({ ok: true, template: null });

    // Moment 4 (manual): forage-drive spends resolve to make supplies.
    w = mustFire("forage-drive", MANUAL, w);
    seen.push("forage-drive");
    expect(w.resolve).toBe(65); // 70 - 5 cost
    expect(w.resources).toBe(65); // 40 + 25 effect

    // Moment 5 (threshold): supplies 65 clears the granary level of 50.
    w = mustFire("granary-boon", levelCtx("resources", w.resources), w);
    seen.push("granary-boon");
    expect(w.resources).toBe(85); // 65 + 20 effect
    expect(w.storyFlags["granary-boon-taken"]).toBe(true);
    expect(w.repeatState.onceFired).toEqual(["granary-boon"]);

    // Moment 6 (threshold again): once-template gone, threat too low -> null.
    expect(collectCandidates(levelCtx("resources", w.resources), CONTENT_LIBRARY, w)).toEqual({
      ok: true, template: null,
    });

    // Moment 7 (streamClose): the day's deeds earn a reckoning.
    w = mustFire("night-reckoning", CLOSE, w);
    seen.push("night-reckoning");
    expect(w.resolve).toBe(70); // 65 + 5 effect
    expect(w.storyFlags["mustered"]).toBeUndefined(); // cleared
    expect(w.deeds).toHaveLength(5);

    expect(seen).toEqual([
      "dawn-muster", "steady-watch", "forage-drive", "granary-boon", "night-reckoning",
    ]);
  });

  it("cooldown template fires, rests, and returns at the exact boundary", () => {
    const at = (threat: number) => ({ kind: "threshold", counterValues: { threatLevel: threat } } as const);
    // Threat 30: no threshold template matches (granary needs resources, rot needs 60).
    expect(collectCandidates(at(30), CONTENT_LIBRARY, startWorld())).toEqual({
      ok: true, template: null,
    });

    // Threat 70: rot-spreads matches and fires at stream 5.
    let w = { ...startWorld(), threatLevel: 70, streamCount: 5 };
    const sel = collectCandidates(at(70), CONTENT_LIBRARY, w);
    expect(sel.ok).toBe(true);
    if (!sel.ok || !sel.template || sel.template.id !== "rot-spreads") {
      throw new Error(`expected rot-spreads, got ${JSON.stringify(sel)}`);
    }
    const fired = fireTemplate(sel.template, w);
    expect(fired.ok).toBe(true);
    if (!fired.ok) throw new Error("expected ok");
    w = fired.world;
    expect(w.factionState["goblins"]).toBe(40); // 30 + 10 effect
    expect(w.locationState["north-road"]).toBe("strained"); // sound -> strained
    expect(w.repeatState.cooldownUntilStream).toEqual({ "rot-spreads": 7 }); // 5 + 2

    // Streams 5 and 6: trigger matches but repeat blocks -> rot absent.
    for (const s of [5, 6]) {
      const r = collectCandidates(at(70), CONTENT_LIBRARY, { ...w, streamCount: s });
      expect(r.ok && (!r.template || r.template.id !== "rot-spreads")).toBe(true);
    }
    // Stream 7: eligible again (flag cleared so the condition holds too).
    const clearFlag = {
      ...w,
      streamCount: 7,
      storyFlags: {},
      repeatState: w.repeatState,
    };
    const back = collectCandidates(at(70), CONTENT_LIBRARY, clearFlag);
    expect(back.ok && back.template && back.template.id).toBe("rot-spreads");
  });

  it("perChapter reopens after a chapter change", () => {
    const w0 = startWorld(); // resolve 55 -> dawn-muster eligible
    const f1 = fireTemplate(CONTENT_LIBRARY.find((t) => t.id === "dawn-muster")!, w0);
    expect(f1.ok).toBe(true);
    if (!f1.ok) throw new Error("expected ok");
    const same = { ...f1.world, resolve: 10 };
    // dawn-muster: condition holds but repeat blocks; steady-watch: condition fails.
    expect(collectCandidates(OPEN, CONTENT_LIBRARY, same)).toEqual({ ok: true, template: null });
    // Next chapter: the same template is a candidate again.
    const next = { ...f1.world, currentChapter: 2, resolve: 10 };
    const selNext = collectCandidates(OPEN, CONTENT_LIBRARY, next);
    expect(selNext.ok && selNext.template && selNext.template.id).toBe("dawn-muster");
  });
});

describe("Phase 4D slice 10 — failure path preserves the world", () => {
  it("selected-then-unaffordable firing fails with nothing changed", () => {
    // Select dawn-muster in a world that can afford it...
    const rich = startWorld();
    const sel = collectCandidates(OPEN, CONTENT_LIBRARY, rich);
    expect(sel.ok).toBe(true);
    if (!sel.ok || !sel.template || sel.template.id !== "dawn-muster") {
      throw new Error(`expected dawn-muster, got ${JSON.stringify(sel)}`);
    }
    // ...then fire it against a poorer world (state moved between select and fire).
    const poor = { ...startWorld(), resources: 5 };
    const before = JSON.stringify(poor);
    expect(fireTemplate(sel.template, poor)).toEqual({ ok: false, reason: "insufficient-supplies" });
    expect(JSON.stringify(poor)).toBe(before);
    expect(poor.repeatState).toEqual({ onceFired: [], chapterFired: [], cooldownUntilStream: {} });
  });

  it("inapplicable effect fails after selection with full rollback", () => {
    const broken = {
      ...CONTENT_LIBRARY.find((t) => t.id === "forage-drive")!,
      id: "broken-drive",
      cost: undefined,
      effects: [{ op: "setLocation", location: "no-such-place", state: "strained" }],
    } as const;
    const w = startWorld();
    const sel = collectCandidates(MANUAL, [broken], w);
    expect(sel.ok).toBe(true);
    if (!sel.ok || !sel.template || sel.template.id !== "broken-drive") {
      throw new Error(`expected broken-drive, got ${JSON.stringify(sel)}`);
    }
    const before = JSON.stringify(w);
    expect(fireTemplate(sel.template, w)).toEqual({
      ok: false, reason: "template-effects-failed:effect-failed-at-index:0:unknown-location",
    });
    expect(JSON.stringify(w)).toBe(before);
  });
});

describe("Phase 4D slice 10 — determinism", () => {
  it("the same simulation twice yields identical worlds and selections", () => {
    const run = () => {
      const seq: string[] = [];
      let w = startWorld();
      const step = (id: string, ctx: unknown) => {
        const sel = collectCandidates(ctx, CONTENT_LIBRARY, w);
        if (!sel.ok || !sel.template || sel.template.id !== id) {
          throw new Error(`expected ${id}, got ${JSON.stringify(sel)}`);
        }
        seq.push(sel.template.id);
        const fired = fireTemplate(sel.template, w);
        if (!fired.ok) throw new Error(`fire failed: ${JSON.stringify(fired)}`);
        w = fired.world;
      };
      step("dawn-muster", OPEN);
      step("steady-watch", OPEN);
      step("forage-drive", MANUAL);
      step("granary-boon", levelCtx("resources", w.resources));
      step("night-reckoning", CLOSE);
      return { seq, world: w };
    };
    const a = run();
    const b = run();
    expect(b.seq).toEqual(a.seq);
    expect(b.world).toEqual(a.world);
  });
});
