/**
 * UX-003 — Overview presentation models (PURE, no DOM, no imports).
 *
 * `nextActionModel` replaces the UX-002 placeholder heuristic with a
 * deterministic, testable recommendation built only from state the app
 * already holds. All helpers consume primitives/structs assembled by
 * `src/app.ts` from existing authoritative models (threatModel tone,
 * voteModel phase, ledgerStatus, queue size, sidecar wire status, save
 * destination) — no new thresholds, no invented narrative, no game actions.
 *
 * This module has zero imports so `src/dashboard/shell.ts` (zero-import
 * rule, enforced by tests) and `src/app.ts` can both use it without new
 * coupling. Severity scale is urgent > attention > info.
 */

export type NextActionSeverity = "urgent" | "attention" | "info";

export type NextActionHref = "#overview" | "#control" | "#activity" | "#settings";

export interface NextActionInput {
  paused: boolean;
  /** voteModel phase; unknown strings are treated as "none". */
  votePhase: string;
  voteClosingSoon: boolean;
  /** Creator-selected source (radio state), not the wire status. */
  source: "simulation" | "youtube";
  /** Raw sidecar wire status; only STREAMING proves chat is received. */
  ytStatus: string;
  ytError?: string | null;
  queueSize: number;
  /** Documented bound QUEUE.maxSize. Non-positive disables the check. */
  queueMax: number;
  /** ledgerStatus().overflow — true only past PAID_LEDGER_MAX_ENTRIES. */
  ledgerOverflow: boolean;
  /** Existing threatModel tone — reused, never re-thresholded here. */
  threatTone: string;
  cinderholmLost: boolean;
  /** Last observed WorldStore.save()/load() destination. "none" = unknown. */
  persistFrom: "file" | "local" | "none" | "postgres";
}

export interface NextAction {
  /** Stable id; mirrors the UX-002 alert id where the condition coincides. */
  id: string;
  /** Short title, no "Next:" prefix (the shell adds it). Never claims chat is received. */
  title: string;
  /** One sentence: what it means and where to act. */
  detail: string;
  severity: NextActionSeverity;
  /** Where the creator can act today (controls have not moved yet). */
  href: NextActionHref;
}

/**
 * Deterministic priority, first match wins:
 * 1 queue-full · 2 yt-unreachable · 3 yt-error · 4 runtime-paused ·
 * 5 vote-closing · 6 vote-open · 7 yt-auth · 8 yt-reconnecting ·
 * 9 yt-disconnected · 10 yt-stream-ended · 11 yt-unknown-status ·
 * 12 ledger-overflow · 13 world-lost · 14 world-dire · 15 yt-setup ·
 * 16 persist-local · 17 healthy.
 * Nothing here performs or recommends an irreversible action; the worst
 * outcome is opening a section and reading a card.
 */
export function nextActionModel(i: NextActionInput): NextAction {
  const queueFull = i.queueMax > 0 && i.queueSize >= i.queueMax;
  if (queueFull) {
    return {
      id: "queue-full",
      title: "Event queue full",
      detail: `${i.queueSize}/${i.queueMax} events queued — new events are being dropped. Inspect the queue in Activity.`,
      severity: "urgent",
      href: "#activity",
    };
  }
  const yt = i.source === "youtube";
  if (yt && i.ytStatus === "DISCONNECTED" && i.ytError === "sidecar-unreachable") {
    return {
      id: "yt-sidecar-unreachable",
      title: "YouTube sidecar unreachable",
      detail: "Start the sidecar (npm run youtube-server), then reconnect in Settings.",
      severity: "urgent",
      href: "#settings",
    };
  }
  if (yt && i.ytStatus === "ERROR") {
    return {
      id: "yt-error",
      title: "YouTube error",
      detail: "The sidecar reports an error. Inspect the connection in Settings.",
      severity: "urgent",
      href: "#settings",
    };
  }
  if (i.paused) {
    return {
      id: "runtime-paused",
      title: "Resume runtime",
      detail:
        i.queueSize > 0
          ? `${i.queueSize} event(s) held while paused — resume in the Control Room to let them flow.`
          : "Incoming events are held — resume in the Control Room to let them flow.",
      severity: "attention",
      href: "#control",
    };
  }
  if (i.votePhase === "open" && i.voteClosingSoon) {
    return {
      id: "vote-closing",
      title: "Assembly vote closing soon",
      detail: "Review the tally in the vote card below and close the vote when the story calls for it.",
      severity: "attention",
      href: "#overview",
    };
  }
  if (i.votePhase === "open") {
    return {
      id: "vote-open",
      title: "Assembly vote open",
      detail: "Watch the tally in the vote card below — the assembly is deciding.",
      severity: "info",
      href: "#overview",
    };
  }
  if (yt && i.ytStatus === "AUTH_REQUIRED") {
    return {
      id: "yt-auth-required",
      title: "Authorize YouTube",
      detail: "Authorize with Google, then connect to live chat in Settings.",
      severity: "attention",
      href: "#settings",
    };
  }
  if (yt && i.ytStatus === "RECONNECTING") {
    return {
      id: "yt-reconnecting",
      title: "YouTube reconnecting",
      detail: "The sidecar is holding the last position. Watch Settings; no action needed yet.",
      severity: "attention",
      href: "#settings",
    };
  }
  if (yt && i.ytStatus === "DISCONNECTED") {
    return {
      id: "yt-disconnected",
      title: "Reconnect YouTube",
      detail: "Not connected to the sidecar. Reconnect in Settings.",
      severity: "attention",
      href: "#settings",
    };
  }
  if (yt && i.ytStatus === "STREAM_ENDED") {
    return {
      id: "yt-stream-ended",
      title: "Stream ended",
      detail: "The broadcast ended. Disconnect, or wait for the next live chat in Settings.",
      severity: "attention",
      href: "#settings",
    };
  }
  if (yt && i.ytStatus !== "STREAMING" && i.ytStatus !== "off" && i.ytStatus !== "CONNECTING" && i.ytStatus !== "CONNECTED" && i.ytStatus !== "LIVE_CHAT_FOUND") {
    return {
      id: "yt-unknown-status",
      title: "Check YouTube state",
      detail: "Unknown connection state — treating as disconnected. Inspect Settings.",
      severity: "attention",
      href: "#settings",
    };
  }
  if (i.ledgerOverflow) {
    return {
      id: "ledger-overflow",
      title: "Paid ledger overflow",
      detail: "Causality is preserved. Review paid history in Activity.",
      severity: "attention",
      href: "#activity",
    };
  }
  if (i.cinderholmLost) {
    return {
      id: "world-lost",
      title: "Cinderholm has fallen",
      detail: "The light must be rekindled — the rekindle rite waits in the Keeper rites card below.",
      severity: "attention",
      href: "#overview",
    };
  }
  if (i.threatTone === "dire") {
    return {
      id: "world-dire",
      title: "Cinderholm is in peril",
      detail: "Threat is dire. Rally the assembly — strikes and wards shape what happens next.",
      severity: "attention",
      href: "#overview",
    };
  }
  if (yt && i.ytStatus !== "STREAMING") {
    return {
      id: "yt-setup",
      title: "Finish YouTube setup",
      detail: "Chat is not reaching the world yet. Complete the connection in Settings.",
      severity: "info",
      href: "#settings",
    };
  }
  if (i.persistFrom === "local") {
    return {
      id: "persist-local",
      title: "Browser-only saves",
      detail: "The world is saving to this browser only. Start the persist server for file saves.",
      severity: "info",
      href: "#overview",
    };
  }
  if (yt) {
    return {
      id: "healthy-streaming",
      title: "Receiving live chat",
      detail: "Chat commands are reaching the world. Watch the story unfold.",
      severity: "info",
      href: "#overview",
    };
  }
  return {
    id: "healthy-simulation",
    title: "Simulation running",
    detail: "Simulation is driving the world. Open a vote or rite when the story calls for it.",
    severity: "info",
    href: "#overview",
  };
}

/** Link label for a next-action destination. */
export function sectionLabel(href: NextActionHref): string {
  switch (href) {
    case "#control":
      return "Control Room";
    case "#activity":
      return "Activity";
    case "#settings":
      return "Settings";
    default:
      return "Overview";
  }
}

/** Severity word shown as text so status never depends on color alone. */
export function severityLabel(s: NextActionSeverity): string {
  return s === "urgent" ? "Urgent" : s === "attention" ? "Attention" : "All clear";
}

// ---------------------------------------------------------------------------
// Overview summary-line helpers (pure text over existing model outputs).
// ---------------------------------------------------------------------------

/** Queued work is labelled queued — never implied processed. */
export function queueLine(queueSize: number, queueMax: number): string {
  if (!Number.isFinite(queueSize) || queueSize <= 0) return "Queue empty — the world is caught up.";
  if (Number.isFinite(queueMax) && queueMax > 0) return `${queueSize}/${queueMax} queued — awaiting processing, not yet in the world.`;
  return `${queueSize} queued — awaiting processing, not yet in the world.`;
}

/** Ledger census wording mirrors cc-ledger; applied = shaped the world. */
export function paidLine(applied: number, compensated: number, noted: number): string {
  const a = Number.isFinite(applied) ? applied : 0;
  const c = Number.isFinite(compensated) ? compensated : 0;
  const n = Number.isFinite(noted) ? noted : 0;
  if (a + c + n === 0) return "No paid events this session.";
  return `${a} applied · ${c} compensated · ${n} noted — applied entries shaped the world.`;
}

export interface VoteLineInput {
  phase: string;
  prompt: string;
  totalBallots: number;
  commandsProcessed: number;
  maxCommands: number;
  closingSoon: boolean;
  winnerLabel: string | null;
}

/** One-line vote mirror; absent/invalid phases read as no vote running. */
export function voteLine(v: VoteLineInput): string {
  if (v.phase === "open") {
    const tally = `${v.commandsProcessed}/${v.maxCommands} commands · ${v.totalBallots} voice(s)`;
    const prompt = v.prompt ? ` — ${v.prompt}` : "";
    return v.closingSoon ? `Open${prompt} · closing soon (${tally}).` : `Open${prompt} (${tally}).`;
  }
  if (v.phase === "closed") {
    return v.winnerLabel ? `Decided — ${v.winnerLabel}.` : "Decided — no winner.";
  }
  return "No vote running.";
}

/** Honest persistence reporting: file vs postgres vs browser-only vs unknown. */
export function persistLine(from: "file" | "local" | "none" | string): string {
  if (from === "file") return "Saves: file · data/world-state.json.";
  if (from === "postgres") return "Saves: durable database (postgres).";
  if (from === "db-error") return "Saves: database unavailable — running degraded (last committed world preserved).";
  if (from === "file-error") return "Saves: file write failed — running degraded.";
  if (from === "local") return "Saves: this browser only — start the persist server for file saves.";
  return "Saves: nothing saved yet this session.";
}

/** Accessible range mapping for meters; clamps and tolerates bad input. */
export function meterAria(current: number, target: number): { min: number; max: number; now: number } {
  const t = Number.isFinite(target) && target > 0 ? target : 0;
  const c = Number.isFinite(current) ? current : 0;
  return { min: 0, max: t, now: Math.min(Math.max(c, 0), t) };
}
