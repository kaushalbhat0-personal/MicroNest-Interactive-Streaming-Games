/**
 * T3 — Vote announcement composer (PURE, zero imports).
 *
 * Builds the human-readable YouTube Live Chat text for dashboard-initiated
 * votes and their results. Input is an already-computed structural snapshot
 * (prompt, option labels, vote commands, winner) — never engine or session
 * objects — so composition can never alter game semantics and is trivially
 * unit-testable.
 *
 * YouTube liveChatMessages.insert accepts at most 200 characters; every
 * builder enforces that bound and reports `too-long` instead of truncating
 * silently. Option labels and the prompt come from the existing vote model
 * (TEMPLATE_LABELS / votePrompt); nothing is invented here.
 */

export const ANNOUNCE_MAX_CHARS = 200;

export interface AnnounceOption {
  label: string;
  command: string;
}

export interface VoteOpenInput {
  prompt: string;
  options: AnnounceOption[];
  /** Command-clock bound; the parenthetical is dropped when maxCommands <= 0. */
  maxCommands: number;
}

export interface VoteResultInput {
  prompt: string;
  /** Distinct voters; appended when known. */
  totalBallots?: number;
  /** Null for tie / no-ballots / ineligible winner. */
  winnerLabel: string | null;
  /** Engine reason string (e.g. "winner-ineligible"); may be null. */
  winnerReason?: string | null;
}

export type ComposeOk = { ok: true; text: string };
export type ComposeFail = { ok: false; reason: "empty-prompt" | "no-options" | "bad-option" | "too-long"; length?: number };
export type ComposeResult = ComposeOk | ComposeFail;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function charLen(s: string): number {
  return Array.from(s).length;
}

function cleanLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const t = label.trim().replace(/\s+/g, " ");
  return t.length > 0 ? t : null;
}

function cleanCommand(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const t = command.trim();
  return /^![A-Za-z0-9]{1,32}$/.test(t) ? t : null;
}

/**
 * Open-vote announcement. Full form carries the close rule; when the full
 * form exceeds the chat limit the parenthetical is dropped; anything still
 * over budget is a typed error (never a silent cut).
 */
export function composeVoteOpen(input: VoteOpenInput): ComposeResult {
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim().replace(/\s+/g, " ") : "";
  if (prompt.length === 0) return { ok: false, reason: "empty-prompt" };
  const options = Array.isArray(input?.options) ? input.options : [];
  if (options.length === 0) return { ok: false, reason: "no-options" };
  const parts: string[] = [];
  for (let i = 0; i < options.length; i++) {
    const label = cleanLabel(options[i]?.label);
    const command = cleanCommand(options[i]?.command);
    if (!label || !command) return { ok: false, reason: "bad-option" };
    const letter = LETTERS[i] ?? `O${i + 1}`;
    parts.push(`${letter}) ${label} ${command}`);
  }
  const max = typeof input?.maxCommands === "number" && Number.isFinite(input.maxCommands) ? input.maxCommands : 0;
  const tail = max > 0 ? ` (closes after ${Math.floor(max)} commands)` : "";
  const full = `TIDEBOUND VOTE: ${prompt} ${parts.join(" | ")}${tail}`;
  if (charLen(full) <= ANNOUNCE_MAX_CHARS) return { ok: true, text: full };
  const short = `TIDEBOUND VOTE: ${prompt} ${parts.join(" | ")}`;
  if (charLen(short) <= ANNOUNCE_MAX_CHARS) return { ok: true, text: short };
  return { ok: false, reason: "too-long", length: charLen(short) };
}

/** Result announcement for manual close, automatic close and override. */
export function composeVoteResult(input: VoteResultInput): ComposeResult {
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim().replace(/\s+/g, " ") : "";
  if (prompt.length === 0) return { ok: false, reason: "empty-prompt" };
  const ballots =
    typeof input?.totalBallots === "number" && Number.isFinite(input.totalBallots) && input.totalBallots >= 0
      ? ` (${Math.floor(input.totalBallots)} voices)`
      : "";
  let text: string;
  if (input?.winnerLabel && cleanLabel(input.winnerLabel)) {
    text = `TIDEBOUND RESULT: ${prompt} → ${cleanLabel(input.winnerLabel)}.${ballots}`;
  } else {
    const reason =
      typeof input?.winnerReason === "string" && input.winnerReason.trim().length > 0
        ? input.winnerReason.trim().slice(0, 40)
        : "undecided";
    text = `TIDEBOUND RESULT: ${prompt} — no winner (${reason}). The tide stays its course.${ballots}`;
  }
  if (charLen(text) > ANNOUNCE_MAX_CHARS) return { ok: false, reason: "too-long", length: charLen(text) };
  return { ok: true, text };
}

/** Safe event-identity segment (letters, digits, `_`, `-`; capped). */
function safeSegment(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  const clean = s.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return clean.length > 0 ? clean : "unknown";
}

/**
 * Stable outbound identity for one vote event. Manual close, automatic
 * close and override reuse the SAME close id, so all three converge on one
 * idempotent result announcement. Retries reuse the identity verbatim.
 */
export function openEventId(sessionId: unknown, voteId: unknown): string {
  return `vote:${safeSegment(sessionId)}:${safeSegment(voteId)}:open`;
}

export function closeEventId(sessionId: unknown, voteId: unknown): string {
  return `vote:${safeSegment(sessionId)}:${safeSegment(voteId)}:close`;
}

/** Server-side event-id gate (mirrored in the adapter; kept here for tests). */
export function isValidEventId(raw: unknown): boolean {
  return typeof raw === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(raw);
}

/**
 * Delivery states, kept separate from the engine vote phase.
 * `na-simulation` is not a failure — there is no chat to announce to.
 */
export type AnnounceStatus =
  | "na-simulation"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain"
  | "not-connected"
  | "reauth-required";

/** Operator-facing line for an announcement state (no secrets, no ids). */
export function announceStatusLine(status: AnnounceStatus, reason?: string | null): string {
  switch (status) {
    case "na-simulation":
      return "Simulation — not sent to chat.";
    case "sending":
      return "Sending to YouTube chat…";
    case "sent":
      return "Sent to YouTube chat ✓";
    case "failed":
      return reason ? `Failed — ${reason}. Retry below.` : "Failed — retry below.";
    case "uncertain":
      return "Delivery uncertain — check YouTube chat before retrying.";
    case "not-connected":
      return "Not connected — vote opened locally only.";
    case "reauth-required":
      return "Reauthorization required — press 1 · Authorize with Google again.";
  }
}
