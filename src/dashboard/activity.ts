/**
 * UX-005 — Activity workspace models (PURE, no DOM, no imports).
 *
 * Read-only normalization over existing in-memory sources. app.ts assembles
 * plain structs; nothing here touches engine, YouTube, persistence, or DOM.
 *
 * Source capabilities (verified against src/engine/engine.ts):
 * - recentResults: last 30 PROCESSED GameResults, newest-first. Full objects
 *   (eventId/action/actorName/summary) but NO timestamps.
 * - queue.peekAll(): WAITING CanonicalEvents only (dequeued on pump), each
 *   with a real receivedAt ISO timestamp. Bound QUEUE.maxSize.
 * - storyLog: last 40 story lines, newest-first, `[Arc N·Ch M]`-tagged, NO
 *   timestamps, cleared on reload.
 * - world.deeds: persisted append-only strings, oldest-first, NO timestamps.
 *   Deeds adopted into the story also appear in storyLog (deduped here).
 * - paidLedger: persisted entries (applied/compensated/retraction-noted)
 *   with real appliedAtIso/notedAtIso timestamps. Amounts/actors exist on
 *   entries but are deliberately NOT surfaced (prior-phase convention).
 * - session.activeVote: live vote state only — no vote history exists, so
 *   past votes surface as text mentions, honestly labelled as such.
 *
 * Ordering rule: newest-first WITHIN each stream, streams in fixed order
 * (vote-live → processed → story → deeds → ledger). Cross-stream chronology
 * is NOT claimed — sources share no common clock.
 */

export type ActivityFilter = "all" | "commands" | "paid" | "votes" | "warnings";

export const ACTIVITY_FILTERS: readonly ActivityFilter[] = ["all", "commands", "paid", "votes", "warnings"] as const;

export type ActivityCategory =
  | "command"
  | "paid"
  | "ledger-note"
  | "ledger-applied"
  | "ledger-compensated"
  | "ledger-noted"
  | "story"
  | "deed"
  | "vote-live"
  | "vote-mention"
  | "other";

export type ActivityStream = "processed" | "story" | "deed" | "ledger" | "vote";

export interface TimelineItem {
  /** Stable across polls (eventId / ledger eventId+status / index-derived). */
  id: string;
  category: ActivityCategory;
  stream: ActivityStream;
  /** Headline (engine summary / deed / story text, unmodified). */
  title: string;
  /** Actor display name where the source carries one. */
  actor: string | null;
  /** Small meta chips: stream tag, outcome, arc/chapter, stream number. */
  meta: string[];
  /** Real timestamp only where the source records one; else null (never faked). */
  timeMs: number | null;
  /** True for rejected/cooldown/duplicate outcomes and pending notes. */
  warning: boolean;
  /** True for vote-related content (live vote or text mention). */
  voteRelated: boolean;
}

/** Presentation caps (engine retention is authoritative and smaller-or-equal). */
export const TIMELINE_DEED_CAP = 15;
export const TIMELINE_LEDGER_CAP = 15;

/** Engine retention caps, surfaced honestly in empty/retention notes. */
export const RETENTION = { results: 30, story: 40, feed: 12 } as const;

const COMMAND_ACTIONS: ReadonlySet<string> = new Set([
  "attack",
  "heal",
  "search",
  "shield",
  "ring",
  "hide",
  "tribute",
  "defy",
  "help",
]);

const PAID_ACTIONS: ReadonlySet<string> = new Set(["paid_strike", "paid_supply", "paid_elite", "paid_story"]);

const VOTE_WORDS: readonly string[] = ["vote", "ballot", "assembly", "kindling", "leaned"] as const;

/** Case-insensitive vote-mention sniff over creator-facing prose the system wrote. */
export function voteMentioned(text: string): boolean {
  const t = text.toLowerCase();
  return VOTE_WORDS.some((w) => t.includes(w));
}

export interface ResultLike {
  eventId: string;
  action: string;
  actorName: string;
  summary: string;
}

/**
 * Classify one processed GameResult. Vote ballots (!voteA/B) process as
 * action "rejected" with an "assembly" summary — they are vote notes, NOT
 * warnings. World-actor "rejected" results are paid-lifecycle notes
 * (duplicates, retractions, compensations), never command failures.
 */
export function classifyResult(r: ResultLike): {
  category: ActivityCategory;
  warning: boolean;
  voteRelated: boolean;
  outcome: string;
} {
  if (PAID_ACTIONS.has(r.action)) {
    return { category: "paid", warning: false, voteRelated: false, outcome: "applied" };
  }
  if (COMMAND_ACTIONS.has(r.action)) {
    return { category: "command", warning: false, voteRelated: false, outcome: "processed" };
  }
  if (r.action === "cooldown" || r.action === "duplicate") {
    return { category: "command", warning: true, voteRelated: false, outcome: r.action };
  }
  if (r.action === "rejected" && r.actorName !== "world") {
    if (voteMentioned(r.summary)) {
      return { category: "vote-mention", warning: false, voteRelated: true, outcome: "ballot-note" };
    }
    return { category: "command", warning: true, voteRelated: false, outcome: "rejected" };
  }
  if (r.action === "rejected") {
    return { category: "ledger-note", warning: false, voteRelated: false, outcome: "ledger-note" };
  }
  return { category: "other", warning: false, voteRelated: false, outcome: r.action || "unknown" };
}

/** Split the engine `[Arc N·Ch M] text` prefix; null when absent (honest). */
export function stripStoryPrefix(line: string): { arc: number; chapter: number; text: string } | null {
  const m = /^\[Arc (\d+)·Ch (\d+)\] ([\s\S]*)$/.exec(line);
  if (!m) return null;
  return { arc: Number(m[1]), chapter: Number(m[2]), text: m[3] };
}

export interface LedgerLike {
  eventId: string;
  status: string;
  tierKey?: string;
  appliedAtIso?: string;
  compensatedAtIso?: string;
  notedAtIso?: string;
  appliedAtStream?: number;
  notedAtStream?: number;
  compensationNote?: string;
}

const TIER_TITLES: Record<string, string> = {
  paid_strike: "Gale Call",
  paid_supply: "Supply Convoy",
  paid_elite: "Herald's Attention",
  paid_story: "The Bell Tolls",
};

function timeOf(iso: string | undefined): number | null {
  if (typeof iso !== "string" || iso.length === 0) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** HH:MM:SS local time for real timestamps; empty string when unknown. */
export function formatTime(timeMs: number | null): string {
  if (timeMs === null) return "";
  const d = new Date(timeMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface TimelineInput {
  results: ResultLike[];
  storyLog: string[];
  deeds: string[];
  ledger: LedgerLike[];
  voteLive: {
    phase: string;
    prompt: string;
    totalBallots: number;
    commandsProcessed: number;
    maxCommands: number;
    closingSoon: boolean;
    winnerLabel: string | null;
  } | null;
  expandDeeds: boolean;
  expandLedger: boolean;
}

export interface BuiltTimeline {
  items: TimelineItem[];
  deedsTruncated: boolean;
  deedsTotal: number;
  ledgerTruncated: boolean;
  ledgerTotal: number;
}

/** Assemble the timeline. Pure; never mutates its input. */
export function buildTimeline(input: TimelineInput): BuiltTimeline {
  const items: TimelineItem[] = [];
  const v = input.voteLive;
  if (v && (v.phase === "open" || v.phase === "closed")) {
    const state =
      v.phase === "open"
        ? `Open — ${v.totalBallots} voice(s) · ${v.commandsProcessed}/${v.maxCommands} commands${v.closingSoon ? " · closing soon" : ""}`
        : v.winnerLabel
          ? `Decided — ${v.winnerLabel}.`
          : "Decided — no winner.";
    items.push({
      id: "vote-live",
      category: "vote-live",
      stream: "vote",
      title: v.prompt || "Assembly vote",
      actor: null,
      meta: ["live vote", state],
      timeMs: null,
      warning: false,
      voteRelated: true,
    });
  }
  for (const r of input.results) {
    const c = classifyResult(r);
    const meta = c.outcome === "processed" || c.outcome === "applied" ? ["processed"] : [c.outcome];
    items.push({
      id: `result:${r.eventId}`,
      category: c.category,
      stream: "processed",
      title: r.summary,
      actor: r.actorName && r.actorName !== "world" ? r.actorName : null,
      meta,
      timeMs: null,
      warning: c.warning,
      voteRelated: c.voteRelated,
    });
  }
  const storyTexts = new Set<string>();
  for (let si = 0; si < input.storyLog.length; si += 1) {
    const line = input.storyLog[si];
    const stripped = stripStoryPrefix(line);
    const text = stripped ? stripped.text : line;
    storyTexts.add(text);
    items.push({
      id: `story:${si}:${text.length}:${text.slice(0, 24)}`,
      category: voteMentioned(text) ? "vote-mention" : "story",
      stream: "story",
      title: text,
      actor: null,
      meta: stripped ? [`Arc ${stripped.arc}·Ch ${stripped.chapter}`] : ["archive"],
      timeMs: null,
      warning: false,
      voteRelated: voteMentioned(text),
    });
  }
  // Deeds adopted into the story already appear above — skip those, keep
  // persisted-only history (e.g. after a reload cleared the story log).
  const freshDeeds = input.deeds.filter((d) => !storyTexts.has(d));
  const deedCap = input.expandDeeds ? freshDeeds.length : TIMELINE_DEED_CAP;
  const shownDeeds = freshDeeds.slice(-deedCap).reverse();
  for (const d of shownDeeds) {
    items.push({
      id: `deed:${d.length}:${d.slice(0, 24)}`,
      category: voteMentioned(d) ? "vote-mention" : "deed",
      stream: "deed",
      title: d,
      actor: null,
      meta: ["deed · persisted"],
      timeMs: null,
      warning: false,
      voteRelated: voteMentioned(d),
    });
  }
  const byTime = [...input.ledger].sort((a, b) => {
    const ta = timeOf(a.compensatedAtIso ?? a.appliedAtIso ?? a.notedAtIso) ?? 0;
    const tb = timeOf(b.compensatedAtIso ?? b.appliedAtIso ?? b.notedAtIso) ?? 0;
    return tb - ta;
  });
  const ledgerCap = input.expandLedger ? byTime.length : TIMELINE_LEDGER_CAP;
  const shownLedger = byTime.slice(0, ledgerCap);
  for (const e of shownLedger) {
    if (e.status === "applied" || e.status === "compensated") {
      const comp = e.status === "compensated";
      items.push({
        id: `ledger:${e.eventId}:${e.status}`,
        category: comp ? "ledger-compensated" : "ledger-applied",
        stream: "ledger",
        title: comp
          ? `Compensated — ${TIER_TITLES[e.tierKey ?? ""] ?? "paid catalyst"}${e.compensationNote ? ` (${e.compensationNote})` : ""}`
          : `Applied — ${TIER_TITLES[e.tierKey ?? ""] ?? "paid catalyst"}`,
        actor: null,
        meta: [
          comp ? "compensated" : "applied · shaped the world",
          ...(typeof e.appliedAtStream === "number" ? [`stream ${e.appliedAtStream}`] : []),
        ],
        timeMs: timeOf(e.compensatedAtIso ?? e.appliedAtIso),
        warning: false,
        voteRelated: false,
      });
    } else if (e.status === "retraction-noted") {
      items.push({
        id: `ledger:${e.eventId}:${e.status}`,
        category: "ledger-noted",
        stream: "ledger",
        title: "Retraction noted — awaiting its original (recorded only, nothing applied).",
        actor: null,
        meta: ["recorded · pending"],
        timeMs: timeOf(e.notedAtIso),
        warning: true,
        voteRelated: false,
      });
    } else {
      items.push({
        id: `ledger:${e.eventId}:other`,
        category: "other",
        stream: "ledger",
        title: `Ledger entry (${e.status || "unknown status"}) — retained for audit.`,
        actor: null,
        meta: ["other activity"],
        timeMs: timeOf(e.notedAtIso ?? e.appliedAtIso),
        warning: false,
        voteRelated: false,
      });
    }
  }
  return {
    items,
    deedsTruncated: freshDeeds.length > shownDeeds.length,
    deedsTotal: freshDeeds.length,
    ledgerTruncated: byTime.length > shownLedger.length,
    ledgerTotal: byTime.length,
  };
}

/** Filter a built timeline. Pure; items may match several filters honestly. */
export function filterTimeline(items: readonly TimelineItem[], filter: ActivityFilter): TimelineItem[] {
  switch (filter) {
    case "all":
      return [...items];
    case "commands":
      // Ballot notes ride the processed stream (they ARE commands); story
      // and deed vote mentions belong to the Votes view only.
      return items.filter(
        (i) => i.category === "command" || (i.category === "vote-mention" && i.stream === "processed"),
      );
    case "paid":
      return items.filter(
        (i) =>
          i.category === "paid" ||
          i.category === "ledger-note" ||
          i.category === "ledger-applied" ||
          i.category === "ledger-compensated" ||
          i.category === "ledger-noted",
      );
    case "votes":
      return items.filter((i) => i.voteRelated);
    case "warnings":
      return items.filter((i) => i.warning || i.category === "ledger-noted");
    default:
      return [...items];
  }
}

export const FILTER_LABELS: Record<ActivityFilter, string> = {
  all: "All",
  commands: "Commands",
  paid: "Paid & compensation",
  votes: "Votes",
  warnings: "Warnings & errors",
};

/** Text badges (never color-alone) for timeline categories. */
export const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  command: "Command",
  paid: "Paid catalyst",
  "ledger-note": "Ledger note",
  "ledger-applied": "Ledger · applied",
  "ledger-compensated": "Ledger · compensated",
  "ledger-noted": "Ledger · noted",
  story: "Story",
  deed: "Deed",
  "vote-live": "Vote · live",
  "vote-mention": "Vote mention",
  other: "Other activity",
};

/**
 * Defensive projection of a ledger entry to the fields Activity may show.
 * Amounts, actor ids, currency, and platform ids are dropped here by
 * construction (prior-phase convention) — never forwarded to the UI.
 */
export function pickLedgerFields(v: unknown): LedgerLike | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  if (typeof e.eventId !== "string" || e.eventId.length === 0) return null;
  if (typeof e.status !== "string" || e.status.length === 0) return null;
  const str = (k: string): string | undefined => (typeof e[k] === "string" ? (e[k] as string) : undefined);
  const num = (k: string): number | undefined =>
    typeof e[k] === "number" && Number.isFinite(e[k]) ? (e[k] as number) : undefined;
  return {
    eventId: e.eventId as string,
    status: e.status as string,
    tierKey: str("tierKey"),
    appliedAtIso: str("appliedAtIso"),
    compensatedAtIso: str("compensatedAtIso"),
    notedAtIso: str("notedAtIso"),
    appliedAtStream: num("appliedAtStream"),
    notedAtStream: num("notedAtStream"),
    compensationNote: str("compensationNote"),
  };
}

export const FILTER_EMPTY: Record<ActivityFilter, string> = {
  all: "No activity yet — processed commands, story moments, and ledger entries will appear here.",
  commands: "No command activity in retained history.",
  paid: "No paid catalysts, compensation, or ledger entries in retained history.",
  votes: "No live vote and no vote mentions in retained history.",
  warnings: "No warnings or errors in retained history. Current diagnostics are below.",
};

// ---------------------------------------------------------------------------
// Queue + ledger summaries (precise meanings only).
// ---------------------------------------------------------------------------

export interface QueueSummary {
  size: number;
  max: number;
  full: boolean;
  line: string;
}

export function queueSummary(size: number, max: number): QueueSummary {
  const s = Number.isFinite(size) && size > 0 ? Math.floor(size) : 0;
  const m = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  const full = m > 0 && s >= m;
  return {
    size: s,
    max: m,
    full,
    line:
      s === 0
        ? "Queue empty — the world is caught up."
        : full
          ? `${s}/${m} waiting — queue full, new events are being dropped.`
          : m > 0
            ? `${s}/${m} waiting — queued, not yet processed.`
            : `${s} waiting — queued, not yet processed.`,
  };
}

export interface LedgerSummary {
  applied: number;
  compensated: number;
  noted: number;
  total: number;
  overflow: boolean;
  line: string;
}

export function ledgerSummary(
  applied: number,
  compensated: number,
  noted: number,
  total: number,
  overflow: boolean,
): LedgerSummary {
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const a = n(applied);
  const c = n(compensated);
  const t = n(noted);
  const tot = n(total);
  return {
    applied: a,
    compensated: c,
    noted: t,
    total: tot,
    overflow,
    line:
      tot === 0
        ? "Ledger empty — no paid events recorded."
        : `${a} applied · ${c} compensated · ${t} noted — applied entries shaped the world; noted entries are recorded only.` +
          (overflow ? ` OVERFLOW (${tot} entries — causality preserved).` : ""),
  };
}
