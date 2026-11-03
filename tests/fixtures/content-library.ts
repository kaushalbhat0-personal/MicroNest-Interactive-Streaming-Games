import type { EventTemplate } from "../../src/engine/templates";

/**
 * Phase 4D slice 10 — FIRST CONTENT LIBRARY (test fixture only).
 *
 * Six hand-written declarative templates. Plain data: no functions, no
 * callbacks, no scripts. Never imported by production code; exercised only
 * by tests/content-library.test.ts to prove the audited primitives compose
 * into an evolving persistent world.
 */
export const CONTENT_LIBRARY: EventTemplate[] = [
  {
    id: "dawn-muster",
    trigger: { kind: "streamOpen" },
    condition: { op: "lte", counter: "resolve", value: 69 },
    cost: { supplies: 10 },
    effects: [
      { op: "addResolve", amount: 15 },
      { op: "setFlag", flag: "mustered" },
      { op: "appendDeed", deed: "The muster raised spirits over Emberkeep." },
    ],
    repeat: { kind: "perChapter" },
    weight: 10,
  },
  {
    id: "steady-watch",
    trigger: { kind: "streamOpen" },
    condition: { op: "gte", counter: "resolve", value: 70 },
    effects: [
      { op: "addSupplies", amount: 10 },
      { op: "appendDeed", deed: "The watch kept the roads safe." },
    ],
    repeat: { kind: "perChapter" },
    weight: 10,
  },
  {
    id: "granary-boon",
    trigger: { kind: "threshold", counter: "resources", value: 50 },
    condition: { op: "flagUnset", flag: "granary-boon-taken" },
    effects: [
      { op: "addSupplies", amount: 20 },
      { op: "setFlag", flag: "granary-boon-taken" },
      { op: "appendDeed", deed: "The granary overflows; the keep will eat well." },
    ],
    repeat: { kind: "once" },
    weight: 5,
  },
  {
    id: "rot-spreads",
    trigger: { kind: "threshold", counter: "threatLevel", value: 60 },
    condition: { op: "flagUnset", flag: "rot-spread" },
    effects: [
      { op: "addStanding", faction: "goblins", amount: 10 },
      { op: "setLocation", location: "north-road", state: "strained" },
      { op: "setFlag", flag: "rot-spread" },
      { op: "appendDeed", deed: "Rot spreads in the low fields; the goblins grow bold." },
    ],
    repeat: { kind: "cooldownStreams", streams: 2 },
    weight: 8,
  },
  {
    id: "forage-drive",
    trigger: { kind: "manual" },
    condition: { op: "counterGte", counter: "scouts", gte: 2 },
    cost: { resolve: 5 },
    effects: [
      { op: "addSupplies", amount: 25 },
      { op: "appendDeed", deed: "Foragers returned with full packs." },
    ],
    repeat: { kind: "endless" },
    weight: 3,
  },
  {
    id: "night-reckoning",
    trigger: { kind: "streamClose" },
    condition: { op: "counterGte", counter: "deeds", gte: 1 },
    effects: [
      { op: "addResolve", amount: 5 },
      { op: "clearFlag", flag: "mustered" },
      { op: "appendDeed", deed: "The keep sleeps. Tomorrow, the world continues." },
    ],
    repeat: { kind: "perChapter" },
    weight: 4,
  },
];
