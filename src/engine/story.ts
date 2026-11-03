import { SIM } from "./config";
import type { WorldState } from "./types";

export interface BeatContext {
  now: number;
  keepLowThreshold: number;
  threatHighThreshold: number;
}

export interface BeatDefinition {
  id: string;
  condition: (w: WorldState, ctx: BeatContext) => boolean;
  consequence: (w: WorldState) => string;
}

export function advanceChapter(w: WorldState): string {
  if (w.currentChapter < SIM.chaptersPerArc) {
    w.currentChapter += 1;
    return `Chapter ${w.currentChapter} begins — the world turns, but the lantern holds.`;
  }
  w.currentArc += 1;
  w.currentChapter = 1;
  return `ARC ${w.currentArc} DAWNS — the Cantor's siege turns to a new chapter.`;
}

/**
 * Deterministic story beats. Each fires once (guarded by storyFlags).
 * Tidebound canon: five lanterns, the Herald's vessels, the keep, the
 * rising Gloam, the tolled Bell, and the keepers' hope. Mechanics are
 * unchanged from the prototype; only the fiction was reskinned.
 */
export const STORY_BEATS: BeatDefinition[] = [
  {
    id: "five_lanterns_lit",
    condition: (w) => w.uniqueSearchers.length >= SIM.uniqueSearchersForSecret,
    consequence: (w) => {
      if (!w.discoveredSecrets.includes("five-lanterns")) {
        w.discoveredSecrets.push("five-lanterns");
      }
      w.resources += 10;
      w.eventCounters["secrets_found"] = (w.eventCounters["secrets_found"] ?? 0) + 1;
      return "Five lanterns burn beyond the Pale. (+10 supplies, the lanterns are marked)";
    },
  },
  {
    id: "elite_threat_active",
    condition: (w) => w.enemy.isElite && w.enemy.hp > 0,
    consequence: (w) => {
      w.threatLevel = Math.min(100, w.threatLevel + 10);
      w.factionState["gloam"] = Math.min(100, (w.factionState["gloam"] ?? 0) + 15);
      return "The Gloam answers the call. An ELITE herald sails for Cinderholm!";
    },
  },
  {
    id: "elite_defeated",
    // elites_defeated only increments on a killing blow, so this fires
    // in the same event that slays the elite (before the next wave spawns).
    condition: (w, _ctx) =>
      (w.storyFlags["elite_threat_active"] ?? false) &&
      (w.eventCounters["elites_defeated"] ?? 0) > 0 &&
      !(w.storyFlags["elite_defeated"] ?? false),
    consequence: (w) => {
      w.threatLevel = Math.max(0, w.threatLevel - 20);
      w.resources += 25;
      w.factionState["keepers"] = Math.min(100, (w.factionState["keepers"] ?? 0) + 10);
      return `The herald's vessel is broken! Cinderholm rejoices. ${advanceChapter(w)}`;
    },
  },
  {
    id: "keep_bloodied",
    condition: (w, ctx) => w.keepHp <= w.maxKeepHp * ctx.keepLowThreshold,
    consequence: () =>
      "The beacon walls are cracking! The keepers cry out for shields and menders.",
  },
  {
    id: "threat_rising",
    condition: (w, ctx) => w.threatLevel >= ctx.threatHighThreshold,
    consequence: (w) => {
      w.factionState["gloam"] = Math.min(100, (w.factionState["gloam"] ?? 0) + 5);
      return "The Gloam looms over Cinderholm — the deep grows bold.";
    },
  },
  {
    id: "bell_tolls_omen",
    condition: (w) => (w.eventCounters["major_story_events"] ?? 0) > 0,
    consequence: (w) => {
      if (!w.discoveredSecrets.includes("toll-omen")) {
        w.discoveredSecrets.push("toll-omen");
      }
      w.threatLevel = Math.min(100, w.threatLevel + 15);
      return `The Bell has tolled. ${advanceChapter(w)} New omens stir beyond the Pale…`;
    },
  },
  {
    id: "keepers_hopeful",
    condition: (w) => (w.eventCounters["heals"] ?? 0) >= 10,
    consequence: (w) => {
      w.factionState["keepers"] = Math.min(100, (w.factionState["keepers"] ?? 0) + 10);
      return "The keepers sing the lantern's song. Hope spreads through Cinderholm.";
    },
  },
];

/** Apply every beat whose condition holds and which hasn't fired yet. */
export function evaluateBeats(w: WorldState, ctx: BeatContext): string[] {
  const messages: string[] = [];
  for (const beat of STORY_BEATS) {
    if (w.storyFlags[beat.id]) continue;
    let holds = false;
    try {
      holds = beat.condition(w, ctx);
    } catch {
      holds = false;
    }
    if (holds) {
      w.storyFlags[beat.id] = true;
      messages.push(beat.consequence(w));
    }
  }
  return messages;
}
