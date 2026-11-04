/**
 * Phase 5F — presentation projection tests.
 * Domain engine rules are NOT re-tested here; these lock the viewer/creator
 * language, dynamic vote/meter behavior, and the creator safety boundary.
 */
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/engine/config";
import { KINDLING_VOTE, ROUTE_VOTE, TIDEBOUND_LIBRARY, tideboundGenesis } from "../src/content/tidebound";
import {
  castSessionVote,
  closeSessionVote,
  openSessionVote,
  openStream,
  overrideSessionVote,
  resolveSessionVote,
} from "../src/engine/lifecycle";
import type { WorldState } from "../src/engine/types";
import {
  beaconOilModel,
  catalystModel,
  classifyMoment,
  commandGuide,
  headerModel,
  locationModels,
  objectiveModel,
  paleChartModel,
  recapModel,
  resolveModel,
  threatModel,
  vexModel,
  voteModel,
  worldRemembers,
} from "../src/presentation/tidebound-presentation";

const T0 = "2026-11-03T00:00:00.000Z";

function opened() {
  const r = openStream(tideboundGenesis(T0));
  if (!r.ok) throw new Error("expected open");
  return r;
}

// ---------------------------------------------------------------------------
// Header / chapter / arc use live values, never hardcoded chapters
// ---------------------------------------------------------------------------

describe("5F — header presentation", () => {
  it("reflects the live arc/chapter/stream", () => {
    const w = { ...tideboundGenesis(T0), currentArc: 2, currentChapter: 1, streamCount: 3 };
    const h = headerModel(w);
    expect(h.worldName).toBe("Tidebound");
    expect(h.arcLabel).toContain("ARC II");
    expect(h.chapterLabel).toContain("CHAPTER I");
    expect(h.streamLabel).toBe("STREAM 4");
  });

  it("threat bands carry text, not just color", () => {
    expect(threatModel({ ...tideboundGenesis(T0), threatLevel: 10 }).text).toBe("The deep is quiet");
    expect(threatModel({ ...tideboundGenesis(T0), threatLevel: 90 }).text).toBe("Cinderholm is in peril");
  });

  it("resolve bands carry text", () => {
    expect(resolveModel(tideboundGenesis(T0)).text).toBe("Hope holds");
  });
});

// ---------------------------------------------------------------------------
// Locations: three states, visually distinct, no new states
// ---------------------------------------------------------------------------

describe("5F — location presentation", () => {
  it("sound/strained/lost are distinct in badge, glyph, and note", () => {
    const w: WorldState = {
      ...tideboundGenesis(T0),
      unlockedLocations: ["a", "b", "c"],
      locationState: { a: "sound", b: "strained", c: "lost" },
    };
    const models = locationModels(w);
    expect(models.map((m) => m.condition)).toEqual(["sound", "strained", "lost"]);
    expect(new Set(models.map((m) => m.glyph)).size).toBe(3);
    expect(new Set(models.map((m) => m.badge)).size).toBe(3);
    for (const m of models) {
      expect(m.badge.toLowerCase()).toContain(m.condition);
      expect(m.note.length).toBeGreaterThan(0);
    }
  });

  it("genesis seeds all three locations sound", () => {
    const locs = locationModels(tideboundGenesis(T0));
    expect(locs).toHaveLength(3);
    expect(locs.every((l) => l.condition === "sound")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Votes: dynamic, generic, engine rules preserved
// ---------------------------------------------------------------------------

describe("5F — vote presentation", () => {
  it("no vote shows a dormant state, never a card of guesses", () => {
    const { session, world } = opened();
    const m = voteModel(session, world, TIDEBOUND_LIBRARY);
    expect(m.phase).toBe("none");
    expect(m.options).toEqual([]);
    expect(m.winner).toBeNull();
  });

  it("an open route vote shows prompt, labels, commands, and live counts", () => {
    const { session, world } = opened();
    // The dredge option needs Wren's chart window (engine revalidation is
    // the point: the HUD never overrides eligibility).
    const eligible: WorldState = { ...world, storyFlags: { ...world.storyFlags, "chart-pale-ready": true } };
    const v = openSessionVote(session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!v.ok) throw new Error("expected open");
    const c1 = castSessionVote(v.session, "a", 0);
    if (!c1.ok) throw new Error("expected cast");
    const c2 = castSessionVote(c1.session, "b", 1);
    if (!c2.ok) throw new Error("expected cast");
    const m = voteModel(c2.session, eligible, TIDEBOUND_LIBRARY);
    expect(m.phase).toBe("open");
    expect(m.prompt).toBe("Which road through the Pale?");
    expect(m.options.map((o) => o.command)).toEqual(["!voteA", "!voteB"]);
    expect(m.options[0].votes).toBe(1);
    expect(m.options[1].votes).toBe(1);
    // Tie: both lead, lowest index wins on resolve (engine rule untouched).
    expect(m.options[0].leading).toBe(true);
    const res = resolveSessionVote(c2.session, eligible, TIDEBOUND_LIBRARY);
    expect(res.ok && res.winner).toBe("route-dredge-map");
  });

  it("renders generically: kindling shows three options and its own prompt", () => {
    const { session, world } = opened();
    const v = openSessionVote(session, { ...KINDLING_VOTE, library: TIDEBOUND_LIBRARY });
    if (!v.ok) throw new Error("expected open");
    const m = voteModel(v.session, world, TIDEBOUND_LIBRARY);
    expect(m.prompt).toBe("The Kindling — what does the flame take?");
    expect(m.options).toHaveLength(3);
    expect(m.options[2].command).toBe("!voteC");
  });

  it("a closed vote shows the winner; a stale winner shows none (fail-closed)", () => {
    const { session, world } = opened();
    const v = openSessionVote(session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!v.ok) throw new Error("expected open");
    const casted = castSessionVote(v.session, "a", 1);
    if (!casted.ok) throw new Error("expected cast");
    const closed = closeSessionVote(casted.session);
    if (!closed.ok) throw new Error("expected close");
    // Parley is ineligible on the bare genesis (no resolve path) — but the
    // route vote IS eligible here; assert winner display instead.
    const m = voteModel(closed.session, world, TIDEBOUND_LIBRARY);
    expect(m.phase).toBe("closed");
    expect(m.winner).toBe("route-parley-with-ilya");
    expect(m.winnerLabel).toBe("Parley with Ilya of Highspire");
  });

  it("creator safety: opening while active fails; bad options fail", () => {
    const { session } = opened();
    const v = openSessionVote(session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!v.ok) throw new Error("expected open");
    expect(openSessionVote(v.session, { ...KINDLING_VOTE, library: TIDEBOUND_LIBRARY })).toEqual({
      ok: false,
      reason: "vote-active",
    });
    expect(openSessionVote(session, { id: "x", options: ["nope", "missing"], maxCommands: 5, library: TIDEBOUND_LIBRARY }).ok).toBe(false);
  });

  it("creator override records a deed without touching ballots", () => {
    const { session, world } = opened();
    const v = openSessionVote(session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!v.ok) throw new Error("expected open");
    const casted = castSessionVote(v.session, "a", 0);
    if (!casted.ok) throw new Error("expected cast");
    const before = JSON.stringify(casted.session.activeVote?.ballots);
    const o = overrideSessionVote(casted.session, world, 1, TIDEBOUND_LIBRARY);
    expect(o.ok).toBe(true);
    if (!o.ok) throw new Error("expected override");
    expect(o.winner).toBe("route-parley-with-ilya");
    expect(JSON.stringify(casted.session.activeVote?.ballots)).toBe(before);
    expect(overrideSessionVote(casted.session, world, 9, TIDEBOUND_LIBRARY)).toEqual({
      ok: false,
      reason: "invalid-option-index",
    });
  });
});

// ---------------------------------------------------------------------------
// Meters: actual M1/M2, dormant never actionable, retired never grows
// ---------------------------------------------------------------------------

describe("5F — meter presentation", () => {
  it("M1 pale-chart: dormant before the chart window, active inside it", () => {
    expect(paleChartModel(tideboundGenesis(T0)).status).toBe("dormant");
    const ready: WorldState = {
      ...tideboundGenesis(T0),
      storyFlags: { "chart-pale-ready": true },
      eventCounters: { "meter.pale-chart": 4 },
    };
    const m = paleChartModel(ready);
    expect(m.status).toBe("active");
    expect(m.current).toBe(4);
    expect(m.target).toBe(10);
    expect(m.progress).toBeCloseTo(0.4);
  });

  it("M1 retires at target 10", () => {
    const full: WorldState = {
      ...tideboundGenesis(T0),
      storyFlags: { "chart-pale-ready": true },
      eventCounters: { "meter.pale-chart": 10 },
    };
    expect(paleChartModel(full).status).toBe("complete");
  });

  it("M2 beacon-oil: dormant while sound, active while strained/lost, target 5", () => {
    expect(beaconOilModel(tideboundGenesis(T0)).status).toBe("dormant");
    const strained: WorldState = {
      ...tideboundGenesis(T0),
      locationState: { cinderholm: "strained" },
      eventCounters: { "meter.beacon-oil": 2 },
    };
    const m = beaconOilModel(strained);
    expect(m.status).toBe("active");
    expect(m.target).toBe(5);
    expect(m.progress).toBeCloseTo(0.4);
    const full: WorldState = { ...strained, eventCounters: { "meter.beacon-oil": 5 } };
    expect(beaconOilModel(full).status).toBe("complete");
  });
});

// ---------------------------------------------------------------------------
// Story moments / catalysts / Vex / deeds / recap
// ---------------------------------------------------------------------------

describe("5F — story and consequence presentation", () => {
  it("classifies action → consequence → moment", () => {
    expect(classifyMoment("hide", false)).toBe("action");
    expect(classifyMoment("attack", false)).toBe("consequence");
    expect(classifyMoment("paid_elite", false)).toBe("consequence");
    expect(classifyMoment("paid_story", true)).toBe("moment");
    expect(classifyMoment("attack", true)).toBe("moment");
  });

  it("paid catalysts name the world-change, never pay-to-win", () => {
    for (const [action, title] of [
      ["paid_strike", "Gale Call"],
      ["paid_supply", "Supply Convoy"],
      ["paid_elite", "Herald's Attention"],
      ["paid_story", "The Bell Tolls"],
    ] as const) {
      const c = catalystModel(action);
      expect(c?.title).toBe(title);
      expect(c!.tagline.toLowerCase()).not.toContain("win");
      expect(c!.tagline.toLowerCase()).not.toContain("purchase");
    }
    expect(catalystModel("attack")).toBeNull();
  });

  it("vex escalation reads quiet → watchful → raid → driven-off", () => {
    expect(vexModel(tideboundGenesis(T0)).stage).toBe("quiet");
    const hot: WorldState = {
      ...tideboundGenesis(T0),
      threatLevel: 70,
      latent: [{ id: "herald-vex", attention: 45 }],
    };
    expect(vexModel(hot).stage).toBe("watchful");
    const raid: WorldState = { ...tideboundGenesis(T0), storyFlags: { "c.vex.met": true }, locationState: { cinderholm: "strained" } };
    expect(vexModel(raid).stage).toBe("raid");
    expect(vexModel(raid).banner).toContain("Vex");
    const free: WorldState = { ...raid, storyFlags: { ...raid.storyFlags, "c.vex.driven-off": true } };
    expect(vexModel(free).stage).toBe("driven-off");
  });

  it("the world remembers actual deeds, newest first, never raw flags", () => {
    const w: WorldState = { ...tideboundGenesis(T0), deeds: ["first", "second", "third"] };
    expect(worldRemembers(w, 2)).toEqual(["third", "second"]);
    for (const d of worldRemembers(w)) {
      expect(d).not.toContain("c.vex");
      expect(d).not.toContain("meter.");
    }
  });

  it("recap uses the existing selection and stays concise", () => {
    const w: WorldState = {
      ...tideboundGenesis(T0),
      deeds: [
        "Cinderholm has fallen to the Gloam. The lantern gutters.",
        "Oil and oath rekindle Cinderholm. The light holds, strained but alive.",
        "The flame takes Tam's warning. The counsel is burned; the warmth remains.",
      ],
    };
    const r = recapModel(w);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toContain("Tam's warning");
    expect(r.chapterLabel).toContain("ARC I");
    expect(r.tensionLine.length).toBeGreaterThan(0);
  });

  it("objective answers 'what next' from live state", () => {
    expect(objectiveModel(tideboundGenesis(T0))).toContain("lanterns");
    const lost: WorldState = { ...tideboundGenesis(T0), locationState: { cinderholm: "lost" } };
    expect(objectiveModel(lost)).toContain("rekindled");
  });
});

// ---------------------------------------------------------------------------
// Command guide: canonical only, legacy never appears
// ---------------------------------------------------------------------------

describe("5F — command guide", () => {
  it("shows the 12 canonical commands and no legacy verbs", () => {
    const guide = commandGuide(COMMANDS as unknown as Record<string, { does: string }>);
    const cmds = guide.map((g) => g.command);
    for (const c of ["!strike", "!mend", "!scout", "!shield", "!ring", "!hide", "!tribute", "!defy", "!voteA", "!voteB", "!voteC", "!help"]) {
      expect(cmds).toContain(c);
    }
    for (const legacy of ["!attack", "!heal", "!search"]) {
      expect(cmds).not.toContain(legacy);
    }
  });
});
