import { describe, expect, it } from "vitest";
import { QUEUE } from "../src/engine/config";
import { GameEngine } from "../src/engine/engine";
import {
  closeStream,
  openStream,
  selectRecapDeeds,
  supplyThresholdContext,
} from "../src/engine/lifecycle";
import { deserialize, serialize } from "../src/persistence/store";
import {
  collectCandidates,
  fireTemplate,
  validateEventTemplate,
  type EventTemplate,
} from "../src/engine/templates";

/** Controllable clock so cooldowns / rates are exact. */
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

/** Minimal Tidebound vocabulary library (test-only, inline). */
const LIBRARY: EventTemplate[] = [
  {
    id: "kindling-dawn",
    trigger: { kind: "streamOpen" },
    condition: { op: "lte", counter: "resolve", value: 69 },
    effects: [
      { op: "addResolve", amount: 10 },
      { op: "appendDeed", deed: "The lantern takes the morning offering." },
    ],
    repeat: { kind: "perChapter" },
    weight: 10,
  },
  {
    id: "store-room",
    trigger: { kind: "threshold", counter: "resources", value: 10 },
    condition: { op: "flagUnset", flag: "store-room-opened" },
    effects: [
      { op: "setFlag", flag: "store-room-opened" },
      { op: "appendDeed", deed: "The store-room is unsealed; supplies counted." },
    ],
    repeat: { kind: "once" },
    weight: 5,
  },
  {
    id: "night-reckoning",
    trigger: { kind: "streamClose" },
    condition: { op: "counterGte", counter: "deeds", gte: 1 },
    effects: [
      { op: "addResolve", amount: 5 },
      { op: "appendDeed", deed: "The keep sleeps. Tomorrow, the world continues." },
    ],
    repeat: { kind: "perChapter" },
    weight: 4,
  },
];

function mustFire(id: string, ctx: unknown, engine: GameEngine): void {
  const sel = collectCandidates(ctx, LIBRARY, engine.world);
  expect(sel.ok).toBe(true);
  if (!sel.ok || !sel.template || sel.template.id !== id) {
    throw new Error(`expected ${id}, got ${JSON.stringify(sel)}`);
  }
  const fired = fireTemplate(sel.template, engine.world);
  expect(fired.ok).toBe(true);
  if (!fired.ok) throw new Error(`expected fire, got ${JSON.stringify(fired)}`);
  engine.loadWorld(fired.world);
}

describe("Phase 5B — Tidebound closed loop", () => {
  it("open → command → template → threshold → command → close → persist → next stream", () => {
    const { engine, drain } = harness();
    expect(LIBRARY.every(validateEventTemplate)).toBe(true);

    // Stream 1 opens.
    const opened = openStream(engine.world);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected open");
    expect(opened.session.sessionId).toBe("stream-1");
    const openCtx = opened.context;

    // kindling-dawn: resolve 50 <= 69.
    mustFire("kindling-dawn", openCtx, engine);
    expect(engine.world.resolve).toBe(60);

    // Viewer commands act on the same world.
    engine.ingestCommand("u1", "A", "!strike");
    engine.ingestCommand("u2", "B", "!tribute");
    const actions = drain().map((r) => r.action);
    expect(actions).toEqual(["attack", "tribute"]);
    expect(engine.world.enemy.hp).toBe(60 - 7);
    expect(engine.world.resources).toBe(20 - 5);
    expect(engine.world.factionState["goblins"]).toBe(30 + 5);

    // Threshold context is supplied from live world values (resources = 15).
    const supplied = supplyThresholdContext(engine.world, ["resources"]);
    expect(supplied.ok).toBe(true);
    if (!supplied.ok) throw new Error("expected supplied");
    expect(supplied.context).toEqual({ kind: "threshold", counterValues: { resources: 15 } });
    mustFire("store-room", supplied.context, engine);
    expect(engine.world.storyFlags["store-room-opened"]).toBe(true);

    // !ring stirs the Gloam on the same world.
    engine.ingestCommand("u3", "C", "!ring");
    drain();
    expect(engine.world.threatLevel).toBe(10 - 1 + 8); // strike -1, ring +8

    // Night falls: close template fires, then the stream closes.
    mustFire("night-reckoning", { kind: "streamClose" }, engine);
    expect(engine.world.resolve).toBe(60 + 5);
    const closed = closeStream(engine.world, opened.session);
    expect(closed.ok).toBe(true);
    if (!closed.ok) throw new Error("expected close");
    expect(closed.world.streamCount).toBe(1);
    expect(closed.context).toEqual({ kind: "streamClose" });

    // Persisted world survives a restart intact.
    const loaded = deserialize(serialize(closed.world));
    expect(loaded).not.toBeNull();
    const fresh = harness();
    fresh.engine.loadWorld(loaded!);
    expect(fresh.engine.world).toEqual(closed.world);

    // Stream 2 opens on the restored world; recap reads the saga.
    const opened2 = openStream(fresh.engine.world);
    expect(opened2.ok && opened2.session.sessionId).toBe("stream-2");
    const recap = selectRecapDeeds(fresh.engine.world);
    expect(recap).toEqual([
      "The keep sleeps. Tomorrow, the world continues.",
      "The store-room is unsealed; supplies counted.",
      "The lantern takes the morning offering.",
    ]);
  });
});
