import { describe, expect, it } from "vitest";
import {
  classifyDeed,
  closeStream,
  openStream,
  selectRecapDeeds,
  supplyThresholdContext,
} from "../src/engine/lifecycle";
import { initialWorld, type WorldState } from "../src/engine/types";

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

describe("Phase 5B — stream lifecycle", () => {
  it("openStream opens stream 1 deterministically without touching the world", () => {
    const w = freeze(world());
    const before = JSON.stringify(w);
    const r = openStream(w);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.session).toEqual({
      sessionId: "stream-1",
      streamNumber: 1,
      phase: "open",
      activeVote: null,
      meterContributors: {},
    });
    expect(r.context).toEqual({ kind: "streamOpen" });
    expect(JSON.stringify(w)).toBe(before); // untouched
    expect(r.world).toBe(w); // same reference: nothing changed
    expect(openStream(world())).toEqual(r); // deterministic
  });

  it("openStream rejects malformed worlds", () => {
    for (const bad of [null, undefined, 42, "x", {}, { streamCount: -1 }, { streamCount: 1.5 }]) {
      expect(openStream(bad as never)).toEqual({ ok: false, reason: "invalid-world" });
    }
  });

  it("closeStream advances exactly one stream and closes the session", () => {
    const w = world();
    const opened = openStream(w);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected ok");
    const before = JSON.stringify(w);
    const closed = closeStream(opened.world, opened.session);
    expect(closed.ok).toBe(true);
    if (!closed.ok) throw new Error("expected ok");
    expect(closed.world.streamCount).toBe(1);
    expect(closed.session).toEqual({
      sessionId: "stream-1",
      streamNumber: 1,
      phase: "closed",
      activeVote: null,
      meterContributors: {},
    });
    expect(closed.context).toEqual({ kind: "streamClose" });
    expect(JSON.stringify(w)).toBe(before); // input world untouched
    expect(opened.session.phase).toBe("open"); // input session untouched
    // Next open continues the numbering on the closed world.
    const again = openStream(closed.world);
    expect(again.ok && again.session).toEqual({
      sessionId: "stream-2",
      streamNumber: 2,
      phase: "open",
      activeVote: null,
      meterContributors: {},
    });
  });

  it("closeStream rejects double-close, cross-world, and malformed sessions", () => {
    const w = world();
    const opened = openStream(w);
    if (!opened.ok) throw new Error("expected ok");
    const closed = closeStream(opened.world, opened.session);
    if (!closed.ok) throw new Error("expected ok");
    // Double close with the now-closed session.
    expect(closeStream(closed.world, closed.session)).toEqual({ ok: false, reason: "invalid-session" });
    // Session bound to a different stream number.
    expect(
      closeStream(w, { sessionId: "stream-5", streamNumber: 5, phase: "open" } as never),
    ).toEqual({ ok: false, reason: "invalid-session" });
    // Malformed sessions and worlds.
    for (const bad of [null, {}, { sessionId: "stream-1", streamNumber: 1 }]) {
      expect(closeStream(w, bad as never)).toEqual({ ok: false, reason: "invalid-session" });
    }
    expect(closeStream(null as never, opened.session)).toEqual({ ok: false, reason: "invalid-world" });
  });

  it("frozen worlds survive open and close unchanged", () => {
    const w = freeze(world({ streamCount: 4 }));
    const before = JSON.stringify(w);
    const opened = openStream(w);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected ok");
    const closed = closeStream(opened.world, freeze({ ...opened.session }));
    expect(closed.ok).toBe(true);
    if (!closed.ok) throw new Error("expected ok");
    expect(JSON.stringify(w)).toBe(before);
    expect(closed.world.streamCount).toBe(5);
  });
});

describe("Phase 5B — threshold counter suppliers", () => {
  it("supplies live values from the shared counter vocabulary", () => {
    const w = world({ resources: 42, threatLevel: 17 });
    const r = supplyThresholdContext(w, ["resources", "threatLevel"]);
    expect(r).toEqual({
      ok: true,
      context: { kind: "threshold", counterValues: { resources: 42, threatLevel: 17 } },
    });
  });

  it("rejects unknown counters, non-arrays, and bad worlds without guessing", () => {
    const w = world();
    expect(supplyThresholdContext(w, ["nope"])).toEqual({ ok: false, reason: "invalid-counter" });
    expect(supplyThresholdContext(w, ["resources", "nope"])).toEqual({
      ok: false,
      reason: "invalid-counter",
    });
    expect(supplyThresholdContext(w, "resources")).toEqual({ ok: false, reason: "invalid-counters-list" });
    expect(supplyThresholdContext(w, null)).toEqual({ ok: false, reason: "invalid-counters-list" });
    expect(supplyThresholdContext(null as never, ["resources"])).toEqual({
      ok: false,
      reason: "invalid-world",
    });
    // Empty list is valid (matches nothing, surprises no one).
    expect(supplyThresholdContext(w, [])).toEqual({ ok: true, context: { kind: "threshold", counterValues: {} } });
  });
});

describe("Phase 5B — recap selection", () => {
  const deeds = [
    "The watch kept the roads safe.", // routine
    "Kaushal dealt the killing blow to Goblin Raider! (+resources)", // kill
    "The granary overflows; the keep will eat well.", // routine
    "The Ancient Gate has AWAKENED. ARC 2 DAWNS.", // consequence
    "Someone scouted again.", // routine
    "The elite has fallen! Emberkeep rejoices.", // kill-flavored consequence (priority wins)
  ];

  it("orders consequence > kill > routine, newest-first within each", () => {
    const w = world({ deeds });
    expect(selectRecapDeeds(w)).toEqual([deeds[5], deeds[3], deeds[1]]);
  });

  it("respects explicit limits and clamps to the 1..5 window", () => {
    const w = world({ deeds });
    expect(selectRecapDeeds(w, 5)).toEqual([deeds[5], deeds[3], deeds[1], deeds[4], deeds[2]]);
    expect(selectRecapDeeds(w, 99)).toHaveLength(5);
    expect(selectRecapDeeds(w, 1)).toEqual([deeds[5]]);
    expect(selectRecapDeeds(w, 0)).toHaveLength(3); // invalid -> default
    expect(selectRecapDeeds(w, NaN)).toHaveLength(3);
    expect(selectRecapDeeds(w, "x" as never)).toHaveLength(3);
  });

  it("handles empty and malformed deed logs safely", () => {
    expect(selectRecapDeeds(world({ deeds: [] }))).toEqual([]);
    expect(selectRecapDeeds({} as WorldState)).toEqual([]);
    expect(classifyDeed(null)).toBe("routine");
    expect(classifyDeed(42)).toBe("routine");
  });

  it("is deterministic, pure, and frozen-safe", () => {
    const w = freeze(world({ deeds }));
    const before = JSON.stringify(w);
    const a = selectRecapDeeds(w);
    const b = selectRecapDeeds(structuredClone(w), 5);
    expect(a).toEqual(selectRecapDeeds(w));
    expect(b).toHaveLength(5);
    expect(JSON.stringify(w)).toBe(before);
  });
});
