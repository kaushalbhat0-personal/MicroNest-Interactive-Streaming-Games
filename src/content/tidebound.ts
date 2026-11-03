import type { EventTemplate } from "../engine/templates";
import type { MeterDefinition } from "../engine/meter";
import {
  contributeToSessionMeter,
  type StreamSession,
} from "../engine/lifecycle";
import { initialWorld, type WorldState } from "../engine/types";

/**
 * Phase 5E — Tidebound MVP content layer.
 *
 * Plain data + thin deterministic wiring. No engine changes live here:
 * templates use only the existing EventTemplate schema, meters and votes
 * go through the existing 5C session APIs, and genesis is a data
 * override of `initialWorld()` (which stays the engine's neutral default).
 *
 * TUNING CORRECTION (documented, content-layer only): Phase 5D specified
 * Rho seeded at 20 with `sable-mending-rite` granting Rho +2 per chapter.
 * With at most 3 perChapter firings in the MVP arc that caps at 26 —
 * `rho-plain-speech` (needs friendly ≥ 60) and therefore
 * `burn-rhos-first-peal` could never fire. Seed is 30 and the rite grants
 * Rho +10, so three chapters of devotion reach exactly 60 at the Kindling.
 * No bands, opcodes, or repeat rules were touched.
 */

// ---------------------------------------------------------------------------
// Canon names (presentation data only; arc/chapter turns are engine counters)
// ---------------------------------------------------------------------------

export const TIDEBOUND_WORLD = "Tidebound";
export const TIDEBOUND_SAGA = "The Cantor's Siege";
export const TIDEBOUND_ARC_1 = "The Lanternkeeper's Oath";
export const TIDEBOUND_CHAPTERS: Record<number, string> = {
  1: "The Drowned Bell",
  2: "Charting the Pale",
  3: "The Kindling",
};

// ---------------------------------------------------------------------------
// Genesis seed (approved Phase 5D state + Rho tuning correction 20 -> 30)
// ---------------------------------------------------------------------------

/** worldId stays `emberkeep-prototype`: the stable save identifier. */
export function tideboundGenesis(nowIso?: string): WorldState {
  const w = initialWorld(nowIso);
  return {
    ...w,
    worldName: TIDEBOUND_WORLD,
    enemy: {
      name: "Gloam Vessel",
      hp: 60,
      maxHp: 60,
      isElite: false,
      difficulty: 1,
      faction: "gloam",
    },
    unlockedLocations: ["cinderholm", "pale-reaches", "chapel-steps"],
    // Explicit starting condition: pristine locations read as absent (not
    // "sound") in predicates, so the seed states soundness outright. Gating
    // stays in flags; setLocation still moves one step at a time.
    locationState: { cinderholm: "sound", "pale-reaches": "sound", "chapel-steps": "sound" },
    factionState: {
      keepers: 60,
      gloam: 30,
      sable: 50,
      wren: 50,
      rho: 30,
      ilya: 30,
    },
    storyFlags: {
      "c.tam.fate.unnamed": true,
      "c.tam.met": true,
      "c.sable.met": true,
      "c.ilya.fate.enemy": true,
      "c.vex.fate.enemy": true,
    },
    latent: [{ id: "herald-vex", attention: 15 }],
  };
}

// ---------------------------------------------------------------------------
// The 18 canonical MVP templates (hand-written data, no functions)
// ---------------------------------------------------------------------------

export const TIDEBOUND_LIBRARY: EventTemplate[] = [
  {
    id: "bellkeeper-matins",
    trigger: { kind: "streamOpen" },
    condition: { op: "flagSet", flag: "c.tam.met" },
    effects: [
      { op: "setFlag", flag: "c.rho.met" },
      { op: "addAttention", id: "herald-vex", amount: 5 },
      { op: "addResolve", amount: 5 },
      { op: "setFlag", flag: "tam.warning-given" },
      { op: "appendDeed", deed: "The drowned bell answers matins. Old Tam's warning is given." },
    ],
    repeat: { kind: "perChapter" },
    weight: 10,
  },
  {
    id: "wren-chart-room",
    trigger: { kind: "threshold", counter: "scouts", value: 5 },
    condition: { op: "flagUnset", flag: "c.wren.met" },
    effects: [
      { op: "setFlag", flag: "c.wren.met" },
      { op: "setFlag", flag: "chart-pale-ready" },
      { op: "addStanding", faction: "wren", amount: 10 },
      { op: "advanceChapter" },
      { op: "appendDeed", deed: "Five lanterns burn beyond the Pale. Wren's chart takes shape." },
    ],
    repeat: { kind: "once" },
    weight: 5,
  },
  {
    id: "pale-reaches-storm",
    trigger: { kind: "threshold", counter: "threatLevel", value: 60 },
    condition: {
      op: "allOf",
      predicates: [
        { op: "flagSet", flag: "chart-pale-ready" },
        { op: "locationIs", location: "pale-reaches", state: "sound" },
        { op: "noneOf", predicates: [{ op: "attitudeIs", faction: "gloam", attitude: "friendly" }] },
      ],
    },
    effects: [
      { op: "setLocation", location: "pale-reaches", state: "strained" },
      { op: "addAttention", id: "herald-vex", amount: 10 },
      { op: "appendDeed", deed: "The Gloam storm takes the Pale Reaches. Wren's marks scatter." },
    ],
    repeat: { kind: "cooldownStreams", streams: 2 },
    weight: 7,
  },
  {
    id: "vex-raid",
    trigger: { kind: "threshold", counter: "elite_arrivals", value: 1 },
    condition: {
      op: "allOf",
      predicates: [
        { op: "flagUnset", flag: "c.vex.driven-off" },
        { op: "locationIs", location: "cinderholm", state: "sound" },
      ],
    },
    effects: [
      { op: "setFlag", flag: "c.vex.met" },
      { op: "setLocation", location: "cinderholm", state: "strained" },
      { op: "addAttention", id: "herald-vex", amount: 15 },
      { op: "appendDeed", deed: "Herald Vex answers the tribute of attention. Cinderholm strains." },
    ],
    repeat: { kind: "cooldownStreams", streams: 3 },
    weight: 8,
  },
  {
    id: "vex-driven-off",
    trigger: { kind: "threshold", counter: "elites_defeated", value: 1 },
    condition: {
      op: "allOf",
      predicates: [
        { op: "flagSet", flag: "c.vex.met" },
        { op: "flagUnset", flag: "c.vex.driven-off" },
        { op: "locationIs", location: "cinderholm", state: "strained" },
      ],
    },
    effects: [
      { op: "setFlag", flag: "c.vex.driven-off" },
      { op: "setLocation", location: "cinderholm", state: "sound" },
      { op: "addResolve", amount: 10 },
      { op: "appendDeed", deed: "The vessel is broken. Vex withdraws, and Cinderholm breathes." },
    ],
    repeat: { kind: "once" },
    weight: 9,
  },
  {
    id: "rho-plain-speech",
    trigger: { kind: "manual" },
    condition: {
      op: "allOf",
      predicates: [
        { op: "attitudeIs", faction: "rho", attitude: "friendly" },
        { op: "flagUnset", flag: "rho.plain-speech" },
      ],
    },
    effects: [
      { op: "setFlag", flag: "rho.plain-speech" },
      { op: "setFlag", flag: "rho.first-peal" },
      { op: "addResolve", amount: 10 },
      { op: "appendDeed", deed: "Rho speaks plainly at last. Her first peal wakes the chapel-steps." },
    ],
    repeat: { kind: "once" },
    weight: 8,
  },
  {
    id: "sable-mending-rite",
    trigger: { kind: "manual" },
    condition: { op: "flagSet", flag: "c.sable.met" },
    cost: { supplies: 5 },
    effects: [
      { op: "addStanding", faction: "sable", amount: 5 },
      { op: "addStanding", faction: "rho", amount: 10 },
      { op: "addResolve", amount: 8 },
      { op: "appendDeed", deed: "Sable tends the lantern's iron, and Rho hears every hammer-fall." },
    ],
    repeat: { kind: "perChapter" },
    weight: 4,
  },
  {
    id: "tide-prayer",
    trigger: { kind: "manual" },
    condition: { op: "gte", counter: "threatLevel", value: 50 },
    cost: { supplies: 10 },
    effects: [
      { op: "addResolve", amount: 8 },
      { op: "appendDeed", deed: "The keepers pray against the rising Gloam." },
    ],
    repeat: { kind: "endless" },
    weight: 1,
  },
  {
    id: "ilya-duel",
    trigger: { kind: "manual" },
    condition: {
      op: "allOf",
      predicates: [
        { op: "flagSet", flag: "c.ilya.met" },
        { op: "flagSet", flag: "ilya.parleyed" },
        { op: "counterGte", counter: "kills", gte: 3 },
      ],
    },
    cost: { resolve: 10 },
    effects: [
      { op: "addStanding", faction: "ilya", amount: 10 },
      { op: "setFlag", flag: "ilya.dueled" },
      { op: "clearFlag", flag: "c.ilya.fate.enemy" },
      { op: "setFlag", flag: "c.ilya.fate.ally" },
      { op: "appendDeed", deed: "Steel answers steel on the Highspire road. Ilya lowers her blade." },
    ],
    repeat: { kind: "once" },
    weight: 9,
  },
  {
    id: "cinderholm-loss",
    trigger: { kind: "threshold", counter: "threatLevel", value: 85 },
    condition: { op: "locationIs", location: "cinderholm", state: "strained" },
    effects: [
      { op: "setLocation", location: "cinderholm", state: "lost" },
      { op: "addResolve", amount: -10 },
      { op: "appendDeed", deed: "Cinderholm has fallen to the Gloam. The lantern gutters." },
    ],
    repeat: { kind: "once" },
    weight: 10,
  },
  {
    id: "cinderholm-rekindle",
    trigger: { kind: "manual" },
    condition: {
      op: "allOf",
      predicates: [
        { op: "locationIs", location: "cinderholm", state: "lost" },
        { op: "counterGte", counter: "meter.beacon-oil", gte: 5 },
      ],
    },
    cost: { supplies: 25 },
    effects: [
      { op: "setLocation", location: "cinderholm", state: "strained" },
      { op: "appendDeed", deed: "Oil and oath rekindle Cinderholm. The light holds, strained but alive." },
    ],
    repeat: { kind: "perChapter" },
    weight: 7,
  },
  {
    id: "tidebound-reckoning",
    trigger: { kind: "streamClose" },
    condition: { op: "counterGte", counter: "deeds", gte: 1 },
    effects: [
      { op: "addResolve", amount: 5 },
      { op: "appendDeed", deed: "The keep sleeps. Tomorrow, the world continues." },
    ],
    repeat: { kind: "perChapter" },
    weight: 4,
  },
  {
    id: "route-dredge-map",
    trigger: { kind: "manual" },
    condition: {
      op: "allOf",
      predicates: [
        { op: "flagSet", flag: "chart-pale-ready" },
        { op: "flagUnset", flag: "dredge-map-found" },
      ],
    },
    cost: { supplies: 10 },
    effects: [
      { op: "setFlag", flag: "dredge-map-found" },
      { op: "setFlag", flag: "c.sable.fate.ally" },
      { op: "addStanding", faction: "wren", amount: 5 },
      { op: "addSupplies", amount: 15 },
      { op: "advanceChapter" },
      { op: "appendDeed", deed: "The assembly chooses the dredge. Sable swears the keeper's oath." },
    ],
    repeat: { kind: "once" },
    weight: 5,
  },
  {
    id: "route-parley-with-ilya",
    trigger: { kind: "manual" },
    condition: { op: "flagUnset", flag: "ilya.parleyed" },
    cost: { resolve: 5 },
    effects: [
      { op: "setFlag", flag: "c.ilya.met" },
      { op: "setFlag", flag: "ilya.parleyed" },
      { op: "addStanding", faction: "ilya", amount: 10 },
      { op: "advanceChapter" },
      { op: "appendDeed", deed: "The assembly chooses parley. Ilya of Highspire hears the flame out." },
    ],
    repeat: { kind: "once" },
    weight: 5,
  },
  {
    id: "burn-tams-warning",
    trigger: { kind: "manual" },
    condition: { op: "flagSet", flag: "tam.warning-given" },
    cost: { resolve: 5 },
    effects: [
      { op: "clearFlag", flag: "tam.warning-given" },
      { op: "setFlag", flag: "burned.tam-warning" },
      { op: "addResolve", amount: 15 },
      { op: "advanceChapter" },
      { op: "appendDeed", deed: "The flame takes Tam's warning. The counsel is burned; the warmth remains." },
    ],
    repeat: { kind: "once" },
    weight: 5,
  },
  {
    id: "burn-wrens-first-chart",
    trigger: { kind: "manual" },
    condition: { op: "flagSet", flag: "chart-pale-ready" },
    cost: { resolve: 5 },
    effects: [
      { op: "clearFlag", flag: "chart-pale-ready" },
      { op: "setFlag", flag: "burned.wren-chart" },
      { op: "setLocation", location: "pale-reaches", state: "strained" },
      { op: "addStanding", faction: "wren", amount: -10 },
      { op: "addResolve", amount: 15 },
      { op: "advanceChapter" },
      { op: "appendDeed", deed: "The flame takes Wren's first chart. The Pale darkens." },
    ],
    repeat: { kind: "once" },
    weight: 5,
  },
  {
    id: "burn-rhos-first-peal",
    trigger: { kind: "manual" },
    condition: { op: "flagSet", flag: "rho.first-peal" },
    cost: { resolve: 5 },
    effects: [
      { op: "clearFlag", flag: "rho.first-peal" },
      { op: "clearFlag", flag: "rho.plain-speech" },
      { op: "setFlag", flag: "burned.rho-peal" },
      { op: "addStanding", faction: "rho", amount: -10 },
      { op: "addResolve", amount: 15 },
      { op: "advanceChapter" },
      { op: "appendDeed", deed: "The flame takes Rho's first peal. Silence returns to the chapel-steps." },
    ],
    repeat: { kind: "once" },
    weight: 5,
  },
  {
    id: "pale-bell-founding",
    trigger: { kind: "threshold", counter: "meter.pale-chart", value: 10 },
    condition: {
      op: "allOf",
      predicates: [
        { op: "flagSet", flag: "chart-pale-ready" },
        { op: "flagUnset", flag: "pale-bell-found" },
      ],
    },
    effects: [
      { op: "setFlag", flag: "pale-bell-found" },
      { op: "setFlag", flag: "c.wren.fate.ally" },
      { op: "clearFlag", flag: "c.wren.at.cinderholm" },
      { op: "setFlag", flag: "c.wren.at.pale-reaches" },
      { op: "addStanding", faction: "wren", amount: 10 },
      { op: "setLocation", location: "pale-reaches", state: "sound" },
      { op: "appendDeed", deed: "The Pale Bell is founded. Wren stands her watch." },
    ],
    repeat: { kind: "once" },
    weight: 10,
  },
];

// ---------------------------------------------------------------------------
// Meters + votes (descriptors; execution stays in the 5C session APIs)
// ---------------------------------------------------------------------------

export const TIDEBOUND_METER_CHART: MeterDefinition = {
  id: "pale-chart",
  target: 10,
  unitText: "charts",
};

export const TIDEBOUND_METER_OIL: MeterDefinition = {
  id: "beacon-oil",
  target: 5,
  unitText: "measures",
};

export const ROUTE_VOTE = {
  id: "vote-which-road",
  options: ["route-dredge-map", "route-parley-with-ilya"],
  maxCommands: 25,
} as const;

export const KINDLING_VOTE = {
  id: "vote-kindling",
  options: ["burn-tams-warning", "burn-wrens-first-chart", "burn-rhos-first-peal"],
  maxCommands: 30,
} as const;

/**
 * Manual creator rites: the ONLY non-vote templates the keeper console may
 * fire directly. Route and Kindling templates are vote-only by trigger
 * contract and never appear here — they fire exclusively through vote
 * resolution or creator override.
 */
export const MANUAL_RITES = [
  "sable-mending-rite",
  "tide-prayer",
  "ilya-duel",
  "cinderholm-rekindle",
  "rho-plain-speech",
] as const;

export type ManualRiteId = (typeof MANUAL_RITES)[number];

export type ContributionOutcome =
  | {
      ok: true;
      world: WorldState;
      session: StreamSession;
      accepted: string[];
      skipped: Array<{ actor: string; reason: string }>;
    }
  | { ok: false; reason: string };

function foldContributions(
  session: StreamSession,
  world: WorldState,
  meter: MeterDefinition,
  actorIds: unknown,
): ContributionOutcome {
  if (!Array.isArray(actorIds) || actorIds.some((a) => typeof a !== "string" || a.length === 0)) {
    return { ok: false, reason: "invalid-actors" };
  }
  let w = world;
  let s = session;
  const accepted: string[] = [];
  const skipped: Array<{ actor: string; reason: string }> = [];
  for (const actor of actorIds as string[]) {
    const r = contributeToSessionMeter(s, w, meter, actor);
    if (r.ok) {
      w = r.world;
      s = r.session;
      accepted.push(actor);
    } else if (r.reason === "duplicate-contributor") {
      skipped.push({ actor, reason: r.reason });
    } else if (r.reason === "meter-complete") {
      skipped.push({ actor, reason: r.reason });
      break; // retired: nothing further can be accepted
    } else {
      return { ok: false, reason: r.reason };
    }
  }
  return { ok: true, world: w, session: s, accepted, skipped };
}

/**
 * M1 wiring: each distinct `!scout` actor contributes one chart per stream,
 * and only while Wren's chart window is open (`chart-pale-ready` set,
 * bell not yet founded). Chapter-2 charting window, enforced.
 */
export function contributeScouts(
  session: StreamSession,
  world: WorldState,
  actorIds: unknown,
): ContributionOutcome {
  if (world.storyFlags["chart-pale-ready"] !== true) return { ok: false, reason: "chart-not-ready" };
  return foldContributions(session, world, TIDEBOUND_METER_CHART, actorIds);
}

/**
 * M2 wiring: each distinct `!shield` actor contributes one measure of oil
 * per stream, but only while Cinderholm is strained or lost (danger private).
 */
export function contributeShields(
  session: StreamSession,
  world: WorldState,
  actorIds: unknown,
): ContributionOutcome {
  const state = world.locationState["cinderholm"];
  if (state !== "strained" && state !== "lost") return { ok: false, reason: "beacon-oil-dormant" };
  return foldContributions(session, world, TIDEBOUND_METER_OIL, actorIds);
}
