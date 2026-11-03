import { describe, expect, it } from "vitest";
import { QUEUE } from "../src/engine/config";
import { GameEngine } from "../src/engine/engine";
import {
  TIDEBOUND_CHAPTERS,
  TIDEBOUND_LIBRARY,
  KINDLING_VOTE,
  ROUTE_VOTE,
  contributeScouts,
  contributeShields,
  tideboundGenesis,
} from "../src/content/tidebound";
import {
  castSessionVote,
  closeSessionVote,
  closeStream,
  noteSessionCommand,
  openSessionVote,
  openStream,
  resolveSessionVote,
  selectRecapDeeds,
  supplyThresholdContext,
  type StreamSession,
} from "../src/engine/lifecycle";
import {
  collectCandidates,
  fireTemplate,
  isRepeatEligible,
  validateEventTemplate,
  type EventTemplate,
} from "../src/engine/templates";
import { deserialize, serialize } from "../src/persistence/store";
import { initialWorld, type WorldState } from "../src/engine/types";
import { validateTrigger } from "../src/engine/triggers";
import { validatePredicate } from "../src/engine/predicates";
import { validateEffect } from "../src/engine/effects";

const T0 = "2026-11-03T00:00:00.000Z";

/** Controllable clock; engine boots the Tidebound genesis by default. */
function harness(seed?: WorldState) {
  let t = 1_000_000;
  const now = () => t;
  const advance = (ms: number) => {
    t += ms;
  };
  const engine = new GameEngine({ now }, seed ?? tideboundGenesis(new Date(t).toISOString()));
  const drain = () => {
    const out = [];
    for (let i = 0; i < 500 && engine.queue.size > 0; i++) {
      advance(QUEUE.minGapMs + 50);
      out.push(...engine.pump());
    }
    return out;
  };
  return { engine, advance, drain };
}

function mustFire(id: string, ctx: unknown, w: WorldState, lib: EventTemplate[] = TIDEBOUND_LIBRARY): WorldState {
  const sel = collectCandidates(ctx, lib, w);
  expect(sel.ok).toBe(true);
  if (!sel.ok || !sel.template || sel.template.id !== id) {
    throw new Error(`expected ${id}, got ${JSON.stringify(sel)}`);
  }
  const fired = fireTemplate(sel.template, w);
  expect(fired.ok).toBe(true);
  if (!fired.ok) throw new Error(`expected fire, got ${JSON.stringify(fired)}`);
  return fired.world;
}

const only = (id: string): EventTemplate[] => TIDEBOUND_LIBRARY.filter((t) => t.id === id);

function thresholdCtx(w: WorldState, counters: string[]) {
  const r = supplyThresholdContext(w, counters);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(`expected context: ${JSON.stringify(r)}`);
  return r.context;
}

const STREAM_OPEN = { kind: "streamOpen" } as const;
const STREAM_CLOSE = { kind: "streamClose" } as const;

// ---------------------------------------------------------------------------
// Content validity
// ---------------------------------------------------------------------------

describe("Phase 5E — 18-template content library validity", () => {
  it("all 18 templates validate, ids are unique, JSON round-trips", () => {
    expect(TIDEBOUND_LIBRARY).toHaveLength(18);
    expect(new Set(TIDEBOUND_LIBRARY.map((t) => t.id)).size).toBe(18);
    for (const t of TIDEBOUND_LIBRARY) expect(validateEventTemplate(t)).toBe(true);
    const revived = JSON.parse(JSON.stringify(TIDEBOUND_LIBRARY)) as unknown;
    expect(
      Array.isArray(revived) && (revived as unknown[]).every(validateEventTemplate),
    ).toBe(true);
  });

  it("every trigger / predicate / effect in the library is valid", () => {
    for (const t of TIDEBOUND_LIBRARY) {
      expect(validateTrigger(t.trigger)).toBe(true);
      expect(validatePredicate(t.condition)).toBe(true);
      for (const e of t.effects) expect(validateEffect(e)).toBe(true);
    }
  });

  it("trigger and repeat coverage matches the approved distribution", () => {
    const triggers = new Set(TIDEBOUND_LIBRARY.map((t) => t.trigger.kind));
    expect(triggers).toEqual(new Set(["streamOpen", "streamClose", "threshold", "manual"]));
    const repeats = new Set(
      TIDEBOUND_LIBRARY.map((t) => (t.repeat.kind === "cooldownStreams" ? "cooldownStreams" : t.repeat.kind)),
    );
    expect(repeats).toEqual(new Set(["once", "perChapter", "endless", "cooldownStreams"]));
    const ops = new Set(TIDEBOUND_LIBRARY.flatMap((t) => t.effects.map((e) => e.op)));
    for (const op of ["setFlag", "clearFlag", "addStanding", "setLocation", "addSupplies", "addResolve", "addAttention", "appendDeed", "advanceChapter"] as const) {
      expect(ops.has(op)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// World seed
// ---------------------------------------------------------------------------

describe("Phase 5E — Tidebound genesis seed", () => {
  it("genesis is deterministic and carries the Tidebound identity", () => {
    expect(tideboundGenesis(T0)).toEqual(tideboundGenesis(T0));
    const w = tideboundGenesis(T0);
    expect(w.worldName).toBe("Tidebound");
    expect(TIDEBOUND_CHAPTERS).toEqual({ 1: "The Drowned Bell", 2: "Charting the Pale", 3: "The Kindling" });
    // worldId is the stable save identifier, not player fiction.
    expect(w.worldId).toBe("emberkeep-prototype");
    expect(w.currentArc).toBe(1);
    expect(w.currentChapter).toBe(1);
  });

  it("approved factions only — no Emberkeep keys remain", () => {
    const w = tideboundGenesis(T0);
    expect(w.factionState).toEqual({ keepers: 60, gloam: 30, sable: 50, wren: 50, rho: 30, ilya: 30 });
    expect("goblins" in w.factionState).toBe(false);
    expect("villagers" in w.factionState).toBe(false);
  });

  it("enemy, locations, latent, and seed flags match the spec", () => {
    const w = tideboundGenesis(T0);
    expect(w.enemy).toEqual({ name: "Gloam Vessel", hp: 60, maxHp: 60, isElite: false, difficulty: 1, faction: "gloam" });
    expect(w.unlockedLocations).toEqual(["cinderholm", "pale-reaches", "chapel-steps"]);
    expect(w.locationState).toEqual({ cinderholm: "sound", "pale-reaches": "sound", "chapel-steps": "sound" });
    expect(w.latent).toEqual([{ id: "herald-vex", attention: 15 }]);
    for (const f of ["c.tam.fate.unnamed", "c.tam.met", "c.sable.met", "c.ilya.fate.enemy", "c.vex.fate.enemy"]) {
      expect(w.storyFlags[f]).toBe(true);
    }
    expect(deserialize(serialize(w))).toEqual(w);
  });
});

// ---------------------------------------------------------------------------
// Commands on the Tidebound seed
// ---------------------------------------------------------------------------

describe("Phase 5E — canonical command vocabulary", () => {
  it("all 11 verbs ingest; legacy verbs are rejected", () => {
    const { engine } = harness();
    for (const cmd of ["!strike", "!mend", "!scout", "!shield", "!ring", "!hide", "!tribute", "!defy", "!voteA", "!voteb", "!help"]) {
      expect(engine.ingestCommand("u", "U", cmd, `e-${cmd}`)).toBe("queued");
    }
    expect(engine.queue.size).toBe(11);
    for (const cmd of ["!attack", "!heal", "!search", "!dance"]) {
      expect(engine.ingestCommand("u", "U", cmd)).toBe("rejected-invalid");
    }
  });

  it("!tribute and !defy move Gloam standing on the Tidebound seed", () => {
    const { engine, drain } = harness();
    engine.ingestCommand("u1", "A", "!tribute");
    drain();
    expect(engine.world.factionState["gloam"]).toBe(35); // 30 + 5
    expect(engine.world.resources).toBe(15); // 20 - 5
    engine.ingestCommand("u2", "B", "!defy");
    drain();
    expect(engine.world.factionState["gloam"]).toBe(30); // 35 - 5
    expect(engine.world.threatLevel).toBe(10 + 4); // tribute is quiet; defy stirs the Gloam
  });
});

// ---------------------------------------------------------------------------
// Chapter 1: matins + Wren chart
// ---------------------------------------------------------------------------

describe("Phase 5E — Chapter 1: matins and the chart-room", () => {
  it("stream opens, matins fires, Tam's warning enters play", () => {
    const w = tideboundGenesis(T0);
    const opened = openStream(w);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected open");
    const after = mustFire("bellkeeper-matins", opened.context, opened.world);
    expect(after.storyFlags["c.rho.met"]).toBe(true);
    expect(after.storyFlags["tam.warning-given"]).toBe(true); // Kindling candidate reachable
    expect(after.latent.find((l) => l.id === "herald-vex")!.attention).toBe(20); // 15 + 5
    expect(after.resolve).toBe(55); // 50 + 5
  });

  it("five unique scouts light the lanterns and unlock Wren's chart-room", () => {
    const { engine, drain } = harness();
    let w = mustFire("bellkeeper-matins", STREAM_OPEN, engine.world);
    engine.loadWorld(w);
    ["a", "b", "c", "d", "e"].forEach((u, i) => engine.ingestCommand(u, `V${i}`, "!scout", `s-${u}`));
    drain();
    expect(engine.world.uniqueSearchers).toHaveLength(5);
    // Engine beat recognizes the lanterns (supplies, no location unlock).
    expect(engine.world.storyFlags["five_lanterns_lit"]).toBe(true);
    expect(engine.world.resources).toBe(30); // 20 + 10
    // Template carries Wren's scene and the Chapter 1 gate.
    w = mustFire("wren-chart-room", thresholdCtx(engine.world, ["scouts"]), engine.world);
    expect(w.currentArc).toBe(1);
    expect(w.currentChapter).toBe(2);
    expect(w.storyFlags["c.wren.met"]).toBe(true);
    expect(w.storyFlags["chart-pale-ready"]).toBe(true);
    expect(w.factionState["wren"]).toBe(60); // 50 + 10
  });

  it("sable-mending-rite converts supplies into standing and resolve", () => {
    const w = mustFire("bellkeeper-matins", STREAM_OPEN, tideboundGenesis(T0));
    // Narrowed library: the creator chooses the rite; the full-library manual
    // moment would rank the unopened parley route (weight 5) above it.
    const after = mustFire("sable-mending-rite", { kind: "manual" }, w, only("sable-mending-rite"));
    expect(after.resources).toBe(15); // 20 - 5
    expect(after.resolve).toBe(63); // 55 + 8
    expect(after.factionState["sable"]).toBe(55); // 50 + 5
    expect(after.factionState["rho"]).toBe(40); // 30 + 10 (tuning correction)
  });
});

// ---------------------------------------------------------------------------
// Vote 1: the route
// ---------------------------------------------------------------------------

describe("Phase 5E — Vote 1: which road through the Pale", () => {
  function ch2(): { w: WorldState; s: StreamSession } {
    let w = mustFire("bellkeeper-matins", STREAM_OPEN, tideboundGenesis(T0));
    w = { ...w, uniqueSearchers: ["a", "b", "c", "d", "e"] };
    w = mustFire("wren-chart-room", thresholdCtx(w, ["scouts"]), w);
    const opened = openStream(w);
    if (!opened.ok) throw new Error("expected open");
    return { w: opened.world, s: opened.session };
  }

  it("V1 opens with both options validating; maxCommands is 25", () => {
    const { s } = ch2();
    expect(ROUTE_VOTE.maxCommands).toBe(25);
    const v = openSessionVote(s, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    expect(v.ok).toBe(true);
  });

  it("a 2–2 tie resolves to the dredge (lowest option index)", () => {
    const { w, s } = ch2();
    let cur = openSessionVote(s, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!cur.ok) throw new Error("expected vote");
    for (const [actor, idx] of [["a", 0], ["b", 1], ["c", 0], ["d", 1]] as Array<[string, number]>) {
      const r = castSessionVote(cur.session, actor, idx);
      if (!r.ok) throw new Error("expected cast");
      cur = r;
    }
    const res = resolveSessionVote(cur.session, w, TIDEBOUND_LIBRARY);
    expect(res.ok && res.winner).toBe("route-dredge-map");
  });

  it("the winner fires through fireTemplate; the loser never fires; chapter advances once", () => {
    const { w, s } = ch2();
    let cur = openSessionVote(s, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!cur.ok) throw new Error("expected vote");
    for (const [actor, idx] of [["a", 0], ["b", 0], ["c", 1]] as Array<[string, number]>) {
      const r = castSessionVote(cur.session, actor, idx);
      if (!r.ok) throw new Error("expected cast");
      cur = r;
    }
    const closed = closeSessionVote(cur.session);
    if (!closed.ok) throw new Error("expected close");
    const res = resolveSessionVote(closed.session, w, TIDEBOUND_LIBRARY);
    expect(res.ok && res.winner).toBe("route-dredge-map");
    if (!res.ok || !res.winner) throw new Error("expected winner");
    const tmpl = TIDEBOUND_LIBRARY.find((t) => t.id === res.winner)!;
    const before = w.resources;
    const fired = fireTemplate(tmpl, w);
    expect(fired.ok).toBe(true);
    if (!fired.ok) throw new Error("expected fire");
    // Route consequence: Sable sworn, map found, supplies funded, exactly one chapter turn.
    expect(fired.world.currentChapter).toBe(3);
    expect(fired.world.currentArc).toBe(1);
    expect(fired.world.storyFlags["dredge-map-found"]).toBe(true);
    expect(fired.world.storyFlags["c.sable.fate.ally"]).toBe(true);
    expect(fired.world.resources).toBe(before - 10 + 15);
    // Loser never fired: no parley flags, no parley record.
    expect(fired.world.storyFlags["ilya.parleyed"]).toBeUndefined();
    expect(fired.world.repeatState.onceFired).not.toContain("route-parley-with-ilya");
  });

  it("the parley path advances the chapter exactly once when it wins", () => {
    const { w, s } = ch2();
    let cur = openSessionVote(s, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!cur.ok) throw new Error("expected vote");
    for (const [actor, idx] of [["a", 1], ["b", 1]] as Array<[string, number]>) {
      const r = castSessionVote(cur.session, actor, idx);
      if (!r.ok) throw new Error("expected cast");
      cur = r;
    }
    const res = resolveSessionVote(cur.session, w, TIDEBOUND_LIBRARY);
    expect(res.ok && res.winner).toBe("route-parley-with-ilya");
    const tmpl = TIDEBOUND_LIBRARY.find((t) => t.id === "route-parley-with-ilya")!;
    const fired = fireTemplate(tmpl, w);
    expect(fired.ok).toBe(true);
    if (!fired.ok) throw new Error("expected fire");
    expect(fired.world.currentChapter).toBe(3);
    expect(fired.world.storyFlags["ilya.parleyed"]).toBe(true);
    expect(fired.world.storyFlags["c.ilya.met"]).toBe(true);
    expect(fired.world.factionState["ilya"]).toBe(40); // 30 + 10
  });
});

// ---------------------------------------------------------------------------
// Storm
// ---------------------------------------------------------------------------

describe("Phase 5E — Pale Reaches storm", () => {
  function stormReady(): WorldState {
    let w = tideboundGenesis(T0);
    w = mustFire("bellkeeper-matins", STREAM_OPEN, w);
    w = { ...w, uniqueSearchers: ["a", "b", "c", "d", "e"] };
    w = mustFire("wren-chart-room", thresholdCtx(w, ["scouts"]), w);
    const out: WorldState = { ...w, threatLevel: 60 };
    return out;
  }

  it("threat 60 with the chart ready strains the reaches", () => {
    const w = stormReady();
    const after = mustFire("pale-reaches-storm", thresholdCtx(w, ["threatLevel"]), w);
    expect(after.locationState["pale-reaches"]).toBe("strained");
    expect(after.latent.find((l) => l.id === "herald-vex")!.attention).toBe(30); // 20 + 10
  });

  it("an appeased Gloam stays the storm; cooldown blocks the next stream", () => {
    const ready = stormReady();
    const friendly: WorldState = { ...ready, factionState: { ...ready.factionState, gloam: 60 } };
    expect(collectCandidates(thresholdCtx(friendly, ["threatLevel"]), TIDEBOUND_LIBRARY, friendly)).toEqual({
      ok: true,
      template: null,
    });
    // Cooldown policy: repeat-ineligible on the next stream, eligible at the boundary.
    let w = stormReady();
    w = mustFire("pale-reaches-storm", thresholdCtx(w, ["threatLevel"]), w);
    expect(w.repeatState.cooldownUntilStream["pale-reaches-storm"]).toBe(w.streamCount + 2);
    const next: WorldState = { ...w, streamCount: w.streamCount + 1, locationState: { "pale-reaches": "sound" } };
    expect(isRepeatEligible(TIDEBOUND_LIBRARY.find((t) => t.id === "pale-reaches-storm")!, next)).toEqual({
      ok: true,
      eligible: false,
    });
    const boundary: WorldState = { ...w, streamCount: w.streamCount + 2, locationState: { "pale-reaches": "sound" } };
    expect(isRepeatEligible(TIDEBOUND_LIBRARY.find((t) => t.id === "pale-reaches-storm")!, boundary)).toEqual({
      ok: true,
      eligible: true,
    });
    expect(collectCandidates(thresholdCtx(boundary, ["threatLevel"]), TIDEBOUND_LIBRARY, boundary).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Vex: raid -> kill -> driven off
// ---------------------------------------------------------------------------

describe("Phase 5E — Herald Vex pressure and release", () => {
  it("a paid elite brings the raid; killing the vessel drives Vex off; Cinderholm recovers", () => {
    const { engine, drain } = harness();
    engine.ingestPaid("donor", "Donor", 500 * 100, "INR", "paid-1");
    drain();
    expect(engine.world.enemy.isElite).toBe(true);
    expect(engine.world.enemy.name).toBe("Elite Herald of the Gloam");
    expect(engine.world.enemy.faction).toBe("gloam");
    expect(engine.world.threatLevel).toBe(10 + 25 + 10); // spawn + elite-threat beat
    let w = engine.world;
    w = mustFire("vex-raid", thresholdCtx(w, ["elite_arrivals"]), w);
    expect(w.storyFlags["c.vex.met"]).toBe(true);
    expect(w.locationState["cinderholm"]).toBe("strained");
    engine.loadWorld(w);
    // Kill the vessel with 16 distinct strikers (110 HP at wave 1: 16 × 7 = 112).
    for (let i = 0; i < 16; i++) engine.ingestCommand(`k${i}`, `K${i}`, "!strike", `kill-${i}`);
    drain();
    expect(engine.world.eventCounters["elites_defeated"]).toBe(1);
    expect(engine.world.eventCounters["kills"]).toBe(1);
    w = mustFire("vex-driven-off", thresholdCtx(engine.world, ["elites_defeated"]), engine.world);
    expect(w.storyFlags["c.vex.driven-off"]).toBe(true);
    expect(w.locationState["cinderholm"]).toBe("sound"); // recovered, not lost
    expect(w.resolve).toBe(50 + 10); // driven-off rallies the keep (no matins on this path)
  });
});

// ---------------------------------------------------------------------------
// Loss and rekindle
// ---------------------------------------------------------------------------

describe("Phase 5E — Cinderholm loss and rekindling", () => {
  function strained(threat: number): WorldState {
    const out: WorldState = { ...tideboundGenesis(T0), threatLevel: threat, locationState: { cinderholm: "strained" } };
    return out;
  }

  it("strained Cinderholm at threat 85 falls; resolve drops", () => {
    const w = strained(85);
    const after = mustFire("cinderholm-loss", thresholdCtx(w, ["threatLevel"]), w);
    expect(after.locationState["cinderholm"]).toBe("lost");
    expect(after.resolve).toBe(40); // 50 - 10
  });

  it("oil is dormant while Cinderholm stands; five shields while lost enable the rekindle", () => {
    const opened = openStream(tideboundGenesis(T0));
    if (!opened.ok) throw new Error("expected open");
    const s = opened.session;
    const sound = tideboundGenesis(T0);
    expect(contributeShields(s, sound, ["a"])).toEqual({ ok: false, reason: "beacon-oil-dormant" });
    const lost = strained(90);
    const lostWorld = { ...lost, locationState: { cinderholm: "lost" as const } };
    // Duplicate shield actors in one stream are skipped, not double-counted.
    const dup = contributeShields(s, lostWorld, ["a", "a", "b", "c", "d", "e"]);
    expect(dup.ok).toBe(true);
    if (!dup.ok) throw new Error("expected ok");
    expect(dup.accepted).toEqual(["a", "b", "c", "d", "e"]);
    expect(dup.skipped).toEqual([{ actor: "a", reason: "duplicate-contributor" }]);
    expect(dup.world.eventCounters["meter.beacon-oil"]).toBe(5);
    // Rekindle costs exactly 25 and restores strained only.
    const rich = { ...dup.world, resources: 30 };
    const rekindled = mustFire("cinderholm-rekindle", { kind: "manual" }, rich);
    expect(rekindled.locationState["cinderholm"]).toBe("strained");
    expect(rekindled.resources).toBe(5); // 30 - 25
    expect(isRepeatEligible(TIDEBOUND_LIBRARY.find((t) => t.id === "cinderholm-rekindle")!, strained(90)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rho reachability (tuning-correction proof) + Vote 2
// ---------------------------------------------------------------------------

describe("Phase 5E — Rho's trust arc is reachable within the arc", () => {
  it("three chapters of mending rites reach friendly 60; speech and the peal follow", () => {
    const RITE = only("sable-mending-rite");
    let w = mustFire("bellkeeper-matins", STREAM_OPEN, tideboundGenesis(T0));
    w = mustFire("sable-mending-rite", { kind: "manual" }, w, RITE); // Ch1: rho 30 -> 40
    expect(w.factionState["rho"]).toBe(40);
    w = { ...w, uniqueSearchers: ["a", "b", "c", "d", "e"] };
    w = mustFire("wren-chart-room", thresholdCtx(w, ["scouts"]), w); // Ch1 -> Ch2
    w = mustFire("sable-mending-rite", { kind: "manual" }, w, RITE); // Ch2: rho 40 -> 50
    expect(w.factionState["rho"]).toBe(50);
    w = mustFire("route-dredge-map", { kind: "manual" }, w); // Ch2 -> Ch3 (supplies: 20-5-5-10+15=15)
    w = mustFire("sable-mending-rite", { kind: "manual" }, w, RITE); // Ch3: rho 50 -> 60
    expect(w.factionState["rho"]).toBe(60);
    w = mustFire("rho-plain-speech", { kind: "manual" }, w);
    expect(w.storyFlags["rho.plain-speech"]).toBe(true);
    expect(w.storyFlags["rho.first-peal"]).toBe(true);
    // The peal is now a valid Kindling candidate.
    const burn = TIDEBOUND_LIBRARY.find((t) => t.id === "burn-rhos-first-peal")!;
    const sel = collectCandidates({ kind: "manual" }, [burn], w);
    expect(sel.ok && sel.template && sel.template.id).toBe("burn-rhos-first-peal");
    const fired = fireTemplate(burn, w);
    expect(fired.ok).toBe(true);
    if (!fired.ok) throw new Error("expected fire");
    expect(fired.world.storyFlags["rho.first-peal"]).toBeUndefined();
    expect(fired.world.storyFlags["rho.plain-speech"]).toBeUndefined();
    expect(fired.world.storyFlags["burned.rho-peal"]).toBe(true);
    expect(fired.world.factionState["rho"]).toBe(50); // 60 - 10
  });
});

describe("Phase 5E — Vote 2: the Kindling", () => {
  function ch3(): { w: WorldState; s: StreamSession } {
    let w = mustFire("bellkeeper-matins", STREAM_OPEN, tideboundGenesis(T0));
    w = { ...w, uniqueSearchers: ["a", "b", "c", "d", "e"] };
    w = mustFire("wren-chart-room", thresholdCtx(w, ["scouts"]), w);
    w = mustFire("route-dredge-map", { kind: "manual" }, w);
    const opened = openStream(w);
    if (!opened.ok) throw new Error("expected open");
    return { w: opened.world, s: opened.session };
  }

  it("V2 opens with all three sacrifice options validating; maxCommands is 30", () => {
    const { s } = ch3();
    expect(KINDLING_VOTE.maxCommands).toBe(30);
    const v = openSessionVote(s, { ...KINDLING_VOTE, library: TIDEBOUND_LIBRARY });
    expect(v.ok).toBe(true);
  });

  it("the winning memory is cleared and burned; victim consequence lands; Arc 2 opens", () => {
    const { w, s } = ch3();
    let cur = openSessionVote(s, { ...KINDLING_VOTE, library: TIDEBOUND_LIBRARY });
    if (!cur.ok) throw new Error("expected vote");
    for (const [actor, idx] of [["a", 0], ["b", 0], ["c", 1]] as Array<[string, number]>) {
      const r = castSessionVote(cur.session, actor, idx);
      if (!r.ok) throw new Error("expected cast");
      cur = r;
    }
    const closed = closeSessionVote(cur.session);
    if (!closed.ok) throw new Error("expected close");
    const res = resolveSessionVote(closed.session, w, TIDEBOUND_LIBRARY);
    expect(res.ok && res.winner).toBe("burn-tams-warning");
    if (!res.ok || !res.winner) throw new Error("expected winner");
    const before = w.resolve;
    const fired = fireTemplate(TIDEBOUND_LIBRARY.find((t) => t.id === res.winner)!, w);
    expect(fired.ok).toBe(true);
    if (!fired.ok) throw new Error("expected fire");
    expect(fired.world.storyFlags["tam.warning-given"]).toBeUndefined(); // memory gone
    expect(fired.world.storyFlags["burned.tam-warning"]).toBe(true); // burn recorded
    expect(fired.world.resolve).toBe(before - 5 + 15); // cost then flame
    expect(fired.world.currentArc).toBe(2); // Chapter 3 -> Arc 2 boundary
    expect(fired.world.currentChapter).toBe(1);
    // Rivals untouched: the other memories survive.
    expect(fired.world.storyFlags["chart-pale-ready"]).toBe(true);
    expect(fired.world.storyFlags["burned.wren-chart"]).toBeUndefined();
  });

  it("burning the chart darkens the reaches and wounds Wren", () => {
    const { w } = ch3();
    const world = { ...w, threatLevel: 10, locationState: { "pale-reaches": "sound" as const } };
    const fired = fireTemplate(TIDEBOUND_LIBRARY.find((t) => t.id === "burn-wrens-first-chart")!, world);
    expect(fired.ok).toBe(true);
    if (!fired.ok) throw new Error("expected fire");
    expect(fired.world.storyFlags["chart-pale-ready"]).toBeUndefined();
    expect(fired.world.storyFlags["burned.wren-chart"]).toBe(true);
    expect(fired.world.locationState["pale-reaches"]).toBe("strained");
    expect(fired.world.factionState["wren"]).toBe(65 - 10); // chart 60 + dredge 5, then -10
  });

  it("a stale burn option fails closed instead of executing", () => {
    const { w, s } = ch3();
    const v = openSessionVote(s, { ...KINDLING_VOTE, library: TIDEBOUND_LIBRARY });
    if (!v.ok) throw new Error("expected vote");
    const casted = castSessionVote(v.session, "a", 1); // vote the chart-burn
    if (!casted.ok) throw new Error("expected cast");
    // …but the chart is already gone when the vote resolves.
    const moved = { ...w, storyFlags: { ...w.storyFlags } };
    delete (moved.storyFlags as Record<string, boolean>)["chart-pale-ready"];
    const res = resolveSessionVote(casted.session, moved, TIDEBOUND_LIBRARY);
    expect(res).toEqual({ ok: true, winner: null, counts: [0, 1, 0], reason: "winner-ineligible" });
  });

  it("paid events cannot bypass the sacrifice", () => {
    const { engine, drain } = harness();
    engine.loadWorld(mustFire("bellkeeper-matins", STREAM_OPEN, engine.world));
    expect(engine.world.storyFlags["tam.warning-given"]).toBe(true);
    engine.ingestPaid("donor", "Donor", 1000 * 100, "INR", "paid-bell");
    drain();
    expect(engine.world.eventCounters["major_story_events"]).toBe(1);
    // No memory burned, no burn recorded, warning intact.
    expect(engine.world.storyFlags["tam.warning-given"]).toBe(true);
    expect(engine.world.storyFlags["burned.tam-warning"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pale bell founding (M1 completion)
// ---------------------------------------------------------------------------

describe("Phase 5E — M1 completion founds the Pale Bell", () => {
  it("ten chart contributions across one stream make the founding eligible", () => {
    const opened = openStream(tideboundGenesis(T0));
    if (!opened.ok) throw new Error("expected open");
    let w = mustFire("bellkeeper-matins", STREAM_OPEN, opened.world);
    w = { ...w, uniqueSearchers: ["a", "b", "c", "d", "e"] };
    w = mustFire("wren-chart-room", thresholdCtx(w, ["scouts"]), w);
    let s = ((): StreamSession => {
      const r = openStream(w);
      if (!r.ok) throw new Error("expected open");
      return r.session;
    })();
    // Window rule: scouts before the chart is ready are rejected.
    expect(contributeScouts(s, tideboundGenesis(T0), ["x"])).toEqual({ ok: false, reason: "chart-not-ready" });
    const actors = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const r = contributeScouts(s, w, actors);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.accepted).toHaveLength(10);
    expect(r.world.eventCounters["meter.pale-chart"]).toBe(10);
    // The reaches must be strained for the founding's calm to land (transition discipline).
    const strainedWorld = { ...r.world, threatLevel: 60 };
    const stormed = mustFire("pale-reaches-storm", thresholdCtx(strainedWorld, ["threatLevel"]), strainedWorld);
    expect(stormed.locationState["pale-reaches"]).toBe("strained");
    const founded = mustFire("pale-bell-founding", thresholdCtx(stormed, ["meter.pale-chart"]), stormed);
    expect(founded.storyFlags["pale-bell-found"]).toBe(true);
    expect(founded.storyFlags["c.wren.fate.ally"]).toBe(true);
    expect(founded.storyFlags["c.wren.at.cinderholm"]).toBeUndefined();
    expect(founded.storyFlags["c.wren.at.pale-reaches"]).toBe(true);
    expect(founded.locationState["pale-reaches"]).toBe("sound");
    s = r.session;
    expect(s.meterContributors["pale-chart"]).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// Persistence: persistent facts survive, session ephemera does not
// ---------------------------------------------------------------------------

describe("Phase 5E — persistence boundary", () => {
  it("Tidebound persistent facts survive save/reload", () => {
    let w = mustFire("bellkeeper-matins", STREAM_OPEN, tideboundGenesis(T0));
    w = { ...w, uniqueSearchers: ["a", "b", "c", "d", "e"] };
    w = mustFire("wren-chart-room", thresholdCtx(w, ["scouts"]), w);
    w = { ...w, eventCounters: { ...w.eventCounters, "meter.beacon-oil": 5 }, threatLevel: 60 };
    w = mustFire("pale-reaches-storm", thresholdCtx(w, ["threatLevel"]), w);
    const loaded = deserialize(serialize(w));
    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(w);
    expect(loaded!.factionState["wren"]).toBe(60);
    expect(loaded!.locationState["pale-reaches"]).toBe("strained");
    expect(loaded!.eventCounters["meter.beacon-oil"]).toBe(5);
    expect(loaded!.latent).toEqual([{ id: "herald-vex", attention: 30 }]); // 15 + 5 + 10
    const fresh = harness();
    fresh.engine.loadWorld(loaded!);
    expect(fresh.engine.world).toEqual(w);
  });

  it("session vote/ballots/contributors never persist; old saves still load", () => {
    const opened = openStream(tideboundGenesis(T0));
    if (!opened.ok) throw new Error("expected open");
    const v = openSessionVote(opened.session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!v.ok) throw new Error("expected vote");
    const casted = castSessionVote(v.session, "a", 0);
    if (!casted.ok) throw new Error("expected cast");
    const parsed = JSON.parse(serialize(opened.world)) as Record<string, unknown>;
    expect("activeVote" in parsed).toBe(false);
    expect("ballots" in parsed).toBe(false);
    expect("meterContributors" in parsed).toBe(false);
    // Old Emberkeep-shaped saves load; Tidebound content fails closed on them.
    expect(deserialize(serialize(initialWorld(T0)))).not.toBeNull();
    const dredge = TIDEBOUND_LIBRARY.find((t) => t.id === "route-dredge-map")!;
    expect(fireTemplate(dredge, initialWorld(T0))?.ok ?? false).toBe(false); // chart-pale-ready unset
    const rite = TIDEBOUND_LIBRARY.find((t) => t.id === "sable-mending-rite")!;
    expect(fireTemplate(rite, initialWorld(T0))).toEqual({ ok: false, reason: "template-ineligible" }); // c.sable.met unset
  });
});

// ---------------------------------------------------------------------------
// Template invariants (§17)
// ---------------------------------------------------------------------------

describe("Phase 5E — content invariants", () => {
  it("once templates never double-fire; deeds never duplicate", () => {
    let w = mustFire("bellkeeper-matins", STREAM_OPEN, tideboundGenesis(T0));
    const deeds = w.deeds.length;
    // Matins' condition stays true all chapter: the repeat policy is the gate.
    expect(
      fireTemplate(TIDEBOUND_LIBRARY.find((t) => t.id === "bellkeeper-matins")!, w),
    ).toEqual({ ok: false, reason: "template-repeat-ineligible" });
    // Chart-room is single-use by condition (met flag) as well as policy.
    w = { ...w, uniqueSearchers: ["a", "b", "c", "d", "e"] };
    w = mustFire("wren-chart-room", thresholdCtx(w, ["scouts"]), w);
    expect(
      fireTemplate(TIDEBOUND_LIBRARY.find((t) => t.id === "wren-chart-room")!, w),
    ).toEqual({ ok: false, reason: "template-ineligible" });
    expect(w.deeds).toHaveLength(deeds + 1);
  });

  it("perChapter templates reopen only after a chapter transition", () => {
    let w = mustFire("bellkeeper-matins", STREAM_OPEN, tideboundGenesis(T0));
    // Same chapter: matins is spent.
    expect(collectCandidates(STREAM_OPEN, TIDEBOUND_LIBRARY, w)).toEqual({ ok: true, template: null });
    // Next chapter (via the chart gate): matins is available again.
    w = { ...w, uniqueSearchers: ["a", "b", "c", "d", "e"] };
    w = mustFire("wren-chart-room", thresholdCtx(w, ["scouts"]), w);
    const sel = collectCandidates(STREAM_OPEN, TIDEBOUND_LIBRARY, w);
    expect(sel.ok && sel.template && sel.template.id).toBe("bellkeeper-matins");
  });

  it("failed firing rolls back cost and effects atomically", () => {
    const poor = { ...tideboundGenesis(T0), resources: 24, locationState: { cinderholm: "lost" as const }, eventCounters: { "meter.beacon-oil": 5 } };
    const before = JSON.stringify(poor);
    expect(fireTemplate(TIDEBOUND_LIBRARY.find((t) => t.id === "cinderholm-rekindle")!, poor)).toEqual({
      ok: false,
      reason: "insufficient-supplies",
    });
    expect(JSON.stringify(poor)).toBe(before);
  });

  it("meter wiring contributions are atomic per actor", () => {
    const opened = openStream(tideboundGenesis(T0));
    if (!opened.ok) throw new Error("expected open");
    const w = mustFire("bellkeeper-matins", STREAM_OPEN, opened.world);
    const ready: WorldState = { ...w, storyFlags: { ...w.storyFlags, "chart-pale-ready": true } };
    const bad = contributeScouts(opened.session, ready, ["a", ""]);
    expect(bad).toEqual({ ok: false, reason: "invalid-actors" });
    expect(ready.eventCounters["meter.pale-chart"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Full closed loop: S1 matins/chart -> S2 vote/route/storm/raid -> S3 loss/oil/rekindle/kindling -> Arc 2
// ---------------------------------------------------------------------------

describe("Phase 5E — full closed loop: stream to Arc 2", () => {
  it("proves the locked Tidebound sequence end to end", () => {
    const { engine, drain } = harness();
    expect(TIDEBOUND_LIBRARY.every(validateEventTemplate)).toBe(true);

    // ---- Stream 1: lighting, chart, Chapter 2 gate ----
    let opened = openStream(engine.world);
    if (!opened.ok) throw new Error("expected open S1");
    let session = opened.session;
    let w = mustFire("bellkeeper-matins", opened.context, opened.world);
    expect(w.resolve).toBe(55);
    expect(w.storyFlags["tam.warning-given"]).toBe(true);
    engine.loadWorld(w);
    ["a", "b", "c", "d", "e"].forEach((u, i) => engine.ingestCommand(u, `V${i}`, "!scout", `s1-${u}`));
    drain();
    expect(engine.world.eventCounters["secrets_found"]).toBe(1);
    expect(engine.world.resources).toBe(30); // 20 + 10 lanterns
    w = mustFire("wren-chart-room", thresholdCtx(engine.world, ["scouts"]), engine.world);
    expect(w.currentChapter).toBe(2); // Chapter 1 gate
    // Chart-window meter takes two contributions in S1.
    const m1 = contributeScouts(session, w, ["a", "b"]);
    expect(m1.ok && m1.world.eventCounters["meter.pale-chart"]).toBe(2);
    if (!m1.ok) throw new Error("expected meter");
    w = m1.world;
    session = m1.session;
    w = mustFire("tidebound-reckoning", STREAM_CLOSE, w);
    expect(w.resolve).toBe(60); // 55 + 5
    const closed1 = closeStream(w, session);
    expect(closed1.ok && closed1.world.streamCount).toBe(1);
    if (!closed1.ok) throw new Error("expected close S1");

    // ---- Stream 2: route vote, storm, raid ----
    opened = openStream(closed1.world);
    if (!opened.ok) throw new Error("expected open S2");
    session = opened.session;
    w = opened.world;
    let vote = openSessionVote(session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    expect(vote.ok).toBe(true);
    if (!vote.ok) throw new Error("expected V1");
    session = vote.session;
    for (const [actor, idx] of [["a", 0], ["b", 0], ["c", 1]] as Array<[string, number]>) {
      const r = castSessionVote(session, actor, idx);
      if (!r.ok) throw new Error("expected cast");
      session = r.session;
    }
    for (let i = 0; i < 3; i++) {
      const n = noteSessionCommand(session);
      if (!n.ok) throw new Error("expected note");
      session = n.session;
    }
    expect(session.activeVote?.commandsProcessed).toBe(3);
    const manual = closeSessionVote(session);
    if (!manual.ok) throw new Error("expected manual close");
    session = manual.session;
    const res = resolveSessionVote(session, w, TIDEBOUND_LIBRARY);
    expect(res.ok && res.winner).toBe("route-dredge-map");
    if (!res.ok || !res.winner) throw new Error("expected winner");
    const routeFired = fireTemplate(TIDEBOUND_LIBRARY.find((t) => t.id === res.winner)!, w);
    expect(routeFired.ok).toBe(true);
    if (!routeFired.ok) throw new Error("expected fire");
    w = routeFired.world;
    expect(w.currentChapter).toBe(3); // Chapter 2 gate
    expect(w.storyFlags["c.sable.fate.ally"]).toBe(true);
    expect(w.resources).toBe(35); // 30 - 10 + 15
    // Storm at threat 60, then a paid elite brings the raid.
    w = { ...w, threatLevel: 60 };
    w = mustFire("pale-reaches-storm", thresholdCtx(w, ["threatLevel"]), w);
    expect(w.locationState["pale-reaches"]).toBe("strained");
    engine.loadWorld(w);
    engine.ingestPaid("donor", "Donor", 500 * 100, "INR", "paid-vex");
    drain();
    expect(engine.world.enemy.name).toBe("Elite Herald of the Gloam");
    expect(engine.world.threatLevel).toBe(95); // 60 + 25 spawn + 10 threat beat
    w = mustFire("vex-raid", thresholdCtx(engine.world, ["elite_arrivals"]), engine.world);
    expect(w.locationState["cinderholm"]).toBe("strained");
    expect(w.storyFlags["c.vex.met"]).toBe(true);
    w = mustFire("tidebound-reckoning", STREAM_CLOSE, w);
    const closed2 = closeStream(w, session);
    expect(closed2.ok && closed2.world.streamCount).toBe(2);
    if (!closed2.ok) throw new Error("expected close S2");

    // ---- Stream 3: loss, oil, rekindle, kindling, Arc 2 ----
    opened = openStream(closed2.world);
    if (!opened.ok) throw new Error("expected open S3");
    session = opened.session;
    w = opened.world;
    w = mustFire("cinderholm-loss", thresholdCtx(w, ["threatLevel"]), w);
    expect(w.locationState["cinderholm"]).toBe("lost");
    engine.loadWorld(w);
    ["s1", "s2", "s3", "s4", "s5"].forEach((u, i) => engine.ingestCommand(u, `W${i}`, "!shield", `sh-${u}`));
    drain();
    const oil = contributeShields(session, engine.world, ["s1", "s2", "s3", "s4", "s5"]);
    expect(oil.ok && oil.world.eventCounters["meter.beacon-oil"]).toBe(5);
    if (!oil.ok) throw new Error("expected oil");
    w = oil.world;
    session = oil.session;
    const suppliesBefore = w.resources;
    w = mustFire("cinderholm-rekindle", { kind: "manual" }, w);
    expect(w.locationState["cinderholm"]).toBe("strained"); // lost -> strained only
    expect(w.resources).toBe(suppliesBefore - 25);
    // Kindling: a 1–1–1 tie falls to the lowest index — Tam's warning.
    vote = openSessionVote(session, { ...KINDLING_VOTE, library: TIDEBOUND_LIBRARY });
    expect(vote.ok).toBe(true);
    if (!vote.ok) throw new Error("expected V2");
    session = vote.session;
    for (const [actor, idx] of [["a", 0], ["b", 1], ["c", 2]] as Array<[string, number]>) {
      const r = castSessionVote(session, actor, idx);
      if (!r.ok) throw new Error("expected cast");
      session = r.session;
    }
    const kindling = closeSessionVote(session);
    if (!kindling.ok) throw new Error("expected kindling close");
    const kres = resolveSessionVote(kindling.session, w, TIDEBOUND_LIBRARY);
    expect(kres.ok && kres.winner).toBe("burn-tams-warning");
    if (!kres.ok || !kres.winner) throw new Error("expected burn winner");
    const burned = fireTemplate(TIDEBOUND_LIBRARY.find((t) => t.id === kres.winner)!, w);
    expect(burned.ok).toBe(true);
    if (!burned.ok) throw new Error("expected burn");
    w = burned.world;
    expect(w.storyFlags["tam.warning-given"]).toBeUndefined();
    expect(w.storyFlags["burned.tam-warning"]).toBe(true);
    expect(w.storyFlags["chart-pale-ready"]).toBe(true); // rivals survive
    expect(w.currentArc).toBe(2); // Arc 2 boundary
    expect(w.currentChapter).toBe(1);
    // Recap serves the returning viewer: burn, rekindle, loss — consequence-first.
    expect(selectRecapDeeds(w)).toEqual([
      "The flame takes Tam's warning. The counsel is burned; the warmth remains.",
      "Oil and oath rekindle Cinderholm. The light holds, strained but alive.",
      "Cinderholm has fallen to the Gloam. The lantern gutters.",
    ]);
    const closed3 = closeStream(w, kindling.session);
    expect(closed3.ok && closed3.world.streamCount).toBe(3);
    if (!closed3.ok) throw new Error("expected close S3");
    expect(deserialize(serialize(closed3.world))).toEqual(closed3.world);
  });
});
