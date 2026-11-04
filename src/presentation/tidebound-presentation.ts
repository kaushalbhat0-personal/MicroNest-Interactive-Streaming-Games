/**
 * Phase 5F — Tidebound presentation projections (PURE, no DOM).
 *
 * The engine is the source of truth. Everything here is a read-only
 * projection of WorldState + StreamSession into viewer/creator language.
 * No gameplay rules, no vote/meter logic, no template firing, no mutation.
 * Internal ids (flags, counters, opcodes, template repeat state) never leak:
 * every model carries human Tidebound wording plus the numeric state the
 * HUD needs to render progress.
 */

import type { StreamSession } from "../engine/lifecycle";
import { resolveVote, tallyVote } from "../engine/vote";
import { selectRecapDeeds } from "../engine/lifecycle";
import { KINDLING_VOTE, ROUTE_VOTE, TIDEBOUND_ARC_1, TIDEBOUND_CHAPTERS, TIDEBOUND_SAGA } from "../content/tidebound";
import type { WorldState } from "../engine/types";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
export function roman(n: number): string {
  if (Number.isInteger(n) && n >= 1 && n <= ROMAN.length) return ROMAN[n - 1];
  return String(n);
}

function humanize(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim() || id;
}

function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Header: saga / arc / chapter / stream (never hardcoded chapters)
// ---------------------------------------------------------------------------

export interface HeaderModel {
  worldName: string;
  saga: string;
  arcLabel: string;
  chapterLabel: string;
  streamLabel: string;
}

export function headerModel(world: WorldState): HeaderModel {
  const arcName = world.currentArc === 1 ? TIDEBOUND_ARC_1 : `Arc ${world.currentArc}`;
  const chapterName =
    world.currentArc === 1 ? (TIDEBOUND_CHAPTERS[world.currentChapter] ?? `Chapter ${world.currentChapter}`) : `Chapter ${world.currentChapter}`;
  return {
    worldName: "Tidebound",
    saga: TIDEBOUND_SAGA,
    arcLabel: `ARC ${roman(world.currentArc)} · ${arcName}`,
    chapterLabel: `CHAPTER ${roman(world.currentChapter)} · ${chapterName}`,
    streamLabel: `STREAM ${world.streamCount + 1}`,
  };
}

// ---------------------------------------------------------------------------
// Threat / Resolve / Supplies
// ---------------------------------------------------------------------------

export type ThreatTone = "calm" | "stirring" | "pressing" | "dire";

export interface ThreatModel {
  level: number;
  tone: ThreatTone;
  text: string;
}

export function threatModel(world: WorldState): ThreatModel {
  const level = world.threatLevel;
  if (level >= 85) return { level, tone: "dire", text: "Cinderholm is in peril" };
  if (level >= 60) return { level, tone: "pressing", text: "The Gloam presses" };
  if (level >= 34) return { level, tone: "stirring", text: "The Gloam stirs" };
  return { level, tone: "calm", text: "The deep is quiet" };
}

export interface ResolveModel {
  value: number;
  text: string;
}

export function resolveModel(world: WorldState): ResolveModel {
  const v = world.resolve;
  if (v >= 70) return { value: v, text: "Hope burns high" };
  if (v >= 40) return { value: v, text: "Hope holds" };
  if (v >= 20) return { value: v, text: "Hope falters" };
  return { value: v, text: "Hope gutters" };
}

// ---------------------------------------------------------------------------
// Locations (the three states only; engine semantics untouched)
// ---------------------------------------------------------------------------

export type LocationCondition = "sound" | "strained" | "lost";

export interface LocationModel {
  id: string;
  name: string;
  condition: LocationCondition;
  /** Text + glyph so state never depends on color alone. */
  badge: string;
  glyph: "●" | "◐" | "○";
  note: string;
}

const LOCATION_NAMES: Record<string, string> = {
  cinderholm: "Cinderholm · the beacon",
  "pale-reaches": "The Pale Reaches",
  "chapel-steps": "Chapel Steps",
};

const LOCATION_NOTES: Record<LocationCondition, string> = {
  sound: "the light holds",
  strained: "the Gloam presses",
  lost: "the light is out",
};

const LOCATION_GLYPHS: Record<LocationCondition, "●" | "◐" | "○"> = {
  sound: "●",
  strained: "◐",
  lost: "○",
};

export function locationModels(world: WorldState): LocationModel[] {
  return world.unlockedLocations.map((id) => {
    const raw = world.locationState[id];
    const condition: LocationCondition = raw === "strained" || raw === "lost" ? raw : "sound";
    return {
      id,
      name: LOCATION_NAMES[id] ?? cap(humanize(id)),
      condition,
      badge: `${cap(condition)} — ${LOCATION_NOTES[condition]}`,
      glyph: LOCATION_GLYPHS[condition],
      note: LOCATION_NOTES[condition],
    };
  });
}

// ---------------------------------------------------------------------------
// Objective / current story moment (priority order, command-agnostic)
// ---------------------------------------------------------------------------

export function objectiveModel(world: WorldState): string {
  if (world.locationState["cinderholm"] === "lost") {
    return "Cinderholm has fallen — the light must be rekindled.";
  }
  if (world.storyFlags["c.vex.met"] === true && world.storyFlags["c.vex.driven-off"] !== true) {
    return "Herald Vex has come — drive the vessel back (!strike).";
  }
  if (
    world.storyFlags["chart-pale-ready"] === true &&
    (world.eventCounters["meter.pale-chart"] ?? 0) < 10 &&
    world.storyFlags["pale-bell-found"] !== true
  ) {
    return "Chart the Pale — the assembly's scouts light the way.";
  }
  if (world.uniqueSearchers.length < 5) {
    return `Light the five lanterns — scout the Pale (!scout): ${world.uniqueSearchers.length}/5.`;
  }
  return "Hold the light — every act shapes the story.";
}

// ---------------------------------------------------------------------------
// Votes → generic presentation (never assumes V1 = route, V2 = kindling)
// ---------------------------------------------------------------------------

export interface VoteOptionModel {
  templateId: string;
  label: string;
  /** Display form (!voteA). The engine accepts lowercase. */
  command: string;
  votes: number;
  leading: boolean;
}

export interface VoteModel {
  phase: "none" | "open" | "closed";
  id: string | null;
  prompt: string;
  options: VoteOptionModel[];
  totalBallots: number;
  commandsProcessed: number;
  maxCommands: number;
  /** 0..1 command-clock progress. */
  clockProgress: number;
  closingSoon: boolean;
  winner: string | null;
  winnerLabel: string | null;
  winnerReason: string | null;
}

const TEMPLATE_LABELS: Record<string, string> = {
  "route-dredge-map": "Dredge the sunken channel",
  "route-parley-with-ilya": "Parley with Ilya of Highspire",
  "burn-tams-warning": "Burn Tam's warning",
  "burn-wrens-first-chart": "Burn Wren's first chart",
  "burn-rhos-first-peal": "Burn Rho's first peal",
};

export function templateLabel(id: string): string {
  return TEMPLATE_LABELS[id] ?? cap(humanize(id));
}

const VOTE_COMMANDS = ["!voteA", "!voteB", "!voteC"] as const;

function votePrompt(options: string[]): string {
  const isRoute =
    options.length === ROUTE_VOTE.options.length && ROUTE_VOTE.options.every((o) => options.includes(o));
  if (isRoute) return "Which road through the Pale?";
  const isKindling =
    options.length === KINDLING_VOTE.options.length && KINDLING_VOTE.options.every((o) => options.includes(o));
  if (isKindling) return "The Kindling — what does the flame take?";
  return "The assembly is called — choose.";
}

export function voteModel(session: StreamSession, world: WorldState, library: unknown): VoteModel {
  const v = session.activeVote;
  if (v === null) {
    return {
      phase: "none",
      id: null,
      prompt: "",
      options: [],
      totalBallots: 0,
      commandsProcessed: 0,
      maxCommands: 0,
      clockProgress: 0,
      closingSoon: false,
      winner: null,
      winnerLabel: null,
      winnerReason: null,
    };
  }
  const tally = tallyVote(v);
  const counts = tally.ok ? tally.counts : v.options.map(() => 0);
  const best = counts.length > 0 ? Math.max(...counts) : 0;
  const totalBallots = counts.reduce((a, b) => a + b, 0);
  const resolved = resolveVote(v, world, library);
  const winner = resolved.ok ? resolved.winner : null;
  const winnerReason = resolved.ok ? (resolved.reason ?? null) : null;
  const closed = v.closed || v.commandsProcessed >= v.maxCommands;
  return {
    phase: closed ? "closed" : "open",
    id: v.id,
    prompt: votePrompt(v.options),
    options: v.options.map((id, i) => ({
      templateId: id,
      label: templateLabel(id),
      command: VOTE_COMMANDS[i] ?? `!vote${i + 1}`,
      votes: counts[i] ?? 0,
      leading: (counts[i] ?? 0) === best && best > 0,
    })),
    totalBallots,
    commandsProcessed: v.commandsProcessed,
    maxCommands: v.maxCommands,
    clockProgress: v.maxCommands > 0 ? Math.min(1, v.commandsProcessed / v.maxCommands) : 0,
    closingSoon: !closed && v.maxCommands - v.commandsProcessed <= 5,
    winner,
    winnerLabel: winner ? templateLabel(winner) : null,
    winnerReason,
  };
}

// ---------------------------------------------------------------------------
// Meters → presentation (gating mirrors the tidebound wiring, read-only)
// ---------------------------------------------------------------------------

export type MeterStatus = "active" | "dormant" | "complete";

export interface MeterModel {
  id: string;
  title: string;
  unitText: string;
  current: number;
  target: number;
  progress: number;
  status: MeterStatus;
  hint: string;
}

export function paleChartModel(world: WorldState): MeterModel {
  const target = 10;
  const current = world.eventCounters["meter.pale-chart"] ?? 0;
  const ready = world.storyFlags["chart-pale-ready"] === true;
  const founded = world.storyFlags["pale-bell-found"] === true;
  const status: MeterStatus = current >= target || founded ? "complete" : ready ? "active" : "dormant";
  return {
    id: "pale-chart",
    title: "Charting the Pale",
    unitText: "charts",
    current: Math.min(current, target),
    target,
    progress: Math.min(1, current / target),
    status,
    hint:
      status === "complete"
        ? "The Pale Bell is founded — the chart endures."
        : status === "active"
          ? "The chart-room is open — scouts light the way."
          : "Wren's chart is not yet ready.",
  };
}

export function beaconOilModel(world: WorldState): MeterModel {
  const target = 5;
  const current = world.eventCounters["meter.beacon-oil"] ?? 0;
  const state = world.locationState["cinderholm"];
  const needed = state === "strained" || state === "lost";
  const status: MeterStatus = current >= target ? "complete" : needed ? "active" : "dormant";
  return {
    id: "beacon-oil",
    title: "Beacon Oil",
    unitText: "measures",
    current: Math.min(current, target),
    target,
    progress: Math.min(1, current / target),
    status,
    hint:
      status === "complete"
        ? "Oil enough to rekindle — the rite waits."
        : status === "active"
          ? "Cinderholm falters — every ward counts."
          : "Cinderholm stands sound.",
  };
}

// ---------------------------------------------------------------------------
// Story moments: action → consequence → moment
// ---------------------------------------------------------------------------

export type MomentKind = "action" | "consequence" | "moment";

export function classifyMoment(action: string, majorStory: boolean): MomentKind {
  if (majorStory || action === "paid_story") return "moment";
  if (
    action === "paid_elite" ||
    action === "paid_strike" ||
    action === "paid_supply" ||
    action === "attack" ||
    action === "search" ||
    action === "shield"
  ) {
    // Engine-level kills/elites/discoveries surface as consequences via the
    // feed text; plain viewer acts stay actions. The visual flag is the
    // tie-breaker the HUD can trust without duplicating engine rules.
    return majorStory ? "moment" : "consequence";
  }
  return "action";
}

export function momentLabel(kind: MomentKind): string {
  if (kind === "moment") return "STORY MOMENT";
  if (kind === "consequence") return "CONSEQUENCE";
  return "ACTION";
}

// ---------------------------------------------------------------------------
// Paid catalysts (payment is a catalyst, never a win purchase)
// ---------------------------------------------------------------------------

export interface CatalystModel {
  title: string;
  tagline: string;
}

const CATALYSTS: Record<string, CatalystModel> = {
  paid_strike: { title: "Gale Call", tagline: "Someone called the storm — the Gloam reels." },
  paid_supply: { title: "Supply Convoy", tagline: "Someone sent a convoy — the keep breathes." },
  paid_elite: { title: "Herald's Attention", tagline: "Someone drew the Herald's gaze — Vex stirs." },
  paid_story: { title: "The Bell Tolls", tagline: "Someone tolled the Bell — the world holds its breath." },
};

export function catalystModel(action: string): CatalystModel | null {
  return CATALYSTS[action] ?? null;
}

// ---------------------------------------------------------------------------
// Herald Vex escalation (flags/deeds/state only)
// ---------------------------------------------------------------------------

export type VexStage = "quiet" | "watchful" | "raid" | "escalated" | "driven-off";

export interface VexModel {
  stage: VexStage;
  banner: string | null;
  attention: number;
}

export function vexModel(world: WorldState): VexModel {
  const attention = world.latent.find((l) => l.id === "herald-vex")?.attention ?? 0;
  if (world.storyFlags["c.vex.driven-off"] === true) {
    return { stage: "driven-off", banner: "Vex driven off — Cinderholm breathes.", attention };
  }
  if (world.storyFlags["c.vex.met"] === true) {
    return { stage: "raid", banner: "Herald Vex raids — Cinderholm strains.", attention };
  }
  if (world.enemy.isElite) {
    return { stage: "escalated", banner: "An elite herald sails for Cinderholm.", attention };
  }
  if (attention >= 30 || world.threatLevel >= 60) {
    return { stage: "watchful", banner: "Vex watches — the deep grows bold.", attention };
  }
  return { stage: "quiet", banner: null, attention };
}

// ---------------------------------------------------------------------------
// Deeds / recap (existing selection, never a second algorithm)
// ---------------------------------------------------------------------------

export function worldRemembers(world: WorldState, limit = 4): string[] {
  return world.deeds.slice(-limit).reverse();
}

export interface RecapModel {
  lines: string[];
  chapterLabel: string;
  placeLine: string;
  tensionLine: string;
}

export function recapModel(world: WorldState): RecapModel {
  const lines = selectRecapDeeds(world, 3);
  const header = headerModel(world);
  const strained = Object.entries(world.locationState)
    .filter(([, s]) => s !== "sound")
    .map(([id, s]) => `${LOCATION_NAMES[id] ?? cap(humanize(id))} (${s})`);
  const placeLine = strained.length > 0 ? strained.join(" · ") : "Cinderholm stands sound";
  let tensionLine = "The Gloam gathers beyond the light.";
  if (world.locationState["cinderholm"] === "lost") {
    tensionLine = "Cinderholm is lost — the rekindling waits.";
  } else if (world.storyFlags["c.vex.met"] === true && world.storyFlags["c.vex.driven-off"] !== true) {
    tensionLine = "Herald Vex has not yet been driven off.";
  } else if (strained.length > 0) {
    tensionLine = "Strained ground must be held before it falls.";
  }
  return { lines, chapterLabel: `${header.arcLabel} — ${header.chapterLabel}`, placeLine, tensionLine };
}

// ---------------------------------------------------------------------------
// Runtime vs input-source status (5G-8B: creator-UX only, read-only).
//
// The console must never conflate "the game is processing events" with
// "YouTube chat is connected". Both projections below are pure functions
// of already-existing state (the runtime paused flag, the selected input
// source, the sidecar's own YtStatus) — no new domain state, no behavior.
// ---------------------------------------------------------------------------

/** Which chat source the creator selected in the console (radio state). */
export type InputSource = "simulation" | "youtube";

export interface RuntimeStatusModel {
  paused: boolean;
  /** "Runtime · Running" or "Runtime · Paused — events held". Never "LIVE". */
  label: string;
}

export function runtimeStatusModel(paused: boolean): RuntimeStatusModel {
  return paused
    ? { paused: true, label: "Runtime · Paused — events held" }
    : { paused: false, label: "Runtime · Running" };
}

/** Wire shape of the YouTube sidecar status (see src/youtube/client.ts). */
export interface YouTubeStatusLike {
  status: string;
  error?: string | null;
  broadcastTitle?: string | null;
  reconnects?: number;
}

export interface YouTubeDisplayModel {
  /** Short state: Not connected / Connecting… / Connected / Receiving chat … */
  state: string;
  /** One human sentence: what it means and what to do next, if anything. */
  note: string;
}

/**
 * Fail-closed display mapping. Stronger claims require stronger states:
 * authorization alone never reads as connected, and only the sidecar's own
 * STREAMING state (chat messages actually fetched) reads as receiving.
 * Platform ids (liveChatId, cursors) never appear in state or note.
 */
export function youtubeDisplayModel(source: InputSource, s: YouTubeStatusLike): YouTubeDisplayModel {
  if (source === "simulation") {
    return {
      state: "Not connected",
      note: "Simulation is driving the world. Select YouTube Live above to connect chat.",
    };
  }
  switch (s.status) {
    case "off":
      return { state: "Not connected", note: "YouTube Live selected — starting the connection…" };
    case "DISCONNECTED":
      return s.error === "sidecar-unreachable"
        ? { state: "Disconnected", note: "Sidecar unreachable — start the youtube sidecar, then connect." }
        : { state: "Disconnected", note: "Not connected to the sidecar." };
    case "AUTH_REQUIRED":
      return { state: "Needs authorization", note: "Authorize with Google first (step 1), then connect to live chat." };
    case "CONNECTING":
      return { state: "Connecting…", note: "Reaching the sidecar…" };
    case "RECONNECTING":
      return {
        state: "Reconnecting…",
        note:
          typeof s.reconnects === "number"
            ? `Attempt ${s.reconnects} — holding the last position.`
            : "Holding the last position.",
      };
    case "CONNECTED":
      return {
        state: "Connected",
        note: "Sidecar connected — no live chat found yet. Start the broadcast, then connect.",
      };
    case "LIVE_CHAT_FOUND":
      return {
        state: "Live chat found",
        note: s.broadcastTitle
          ? `Chat located for "${s.broadcastTitle}". Waiting for messages…`
          : "Chat located. Waiting for messages…",
      };
    case "STREAMING":
      return {
        state: "Receiving chat",
        note: s.broadcastTitle
          ? `Live: "${s.broadcastTitle}". Chat commands are reaching the world.`
          : "Chat commands are reaching the world.",
      };
    case "STREAM_ENDED":
      return { state: "Stream ended", note: "The broadcast ended. Disconnect, or wait for the next live chat." };
    case "ERROR":
      return { state: "Error", note: s.error ? `Sidecar reports: ${s.error}.` : "Sidecar reports an error." };
    default:
      return { state: "Not connected", note: "Unknown connection state — treating as disconnected." };
  }
}

// ---------------------------------------------------------------------------
// Command guide (canonical vocabulary only; legacy verbs never appear)
// ---------------------------------------------------------------------------

export interface CommandModel {
  command: string;
  does: string;
}

export function commandGuide(commands: Record<string, { does: string }>): CommandModel[] {
  const order = [
    "!strike",
    "!mend",
    "!scout",
    "!shield",
    "!ring",
    "!hide",
    "!tribute",
    "!defy",
    "!votea",
    "!voteb",
    "!votec",
    "!help",
  ];
  const out: CommandModel[] = [];
  for (const key of order) {
    const entry = commands[key];
    if (!entry) continue;
    const display = key === "!votea" ? "!voteA" : key === "!voteb" ? "!voteB" : key === "!votec" ? "!voteC" : key;
    const does =
      key === "!votea"
        ? "Vote for the first path (when the assembly is called)"
        : key === "!voteb"
          ? "Vote for the second path (when the assembly is called)"
          : key === "!votec"
            ? "Vote for the third path (when the assembly is called)"
            : entry.does;
    out.push({ command: display, does });
  }
  return out;
}
