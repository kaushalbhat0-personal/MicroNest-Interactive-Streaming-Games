/**
 * T4F-B — transport core (PURE, renderer-safe).
 *
 * Sequencing, validation and status vocabulary shared by the state server,
 * the renderer transport client, and the tests. No DOM, no network, no
 * timers — safe to import from renderer bundles. The import-boundary test
 * enforces that this module (like snapshot.ts) never gains authority-only
 * imports.
 */

/** Renderer ↔ state-server protocol version (mirrors SNAPSHOT_PROTOCOL). */
export const TRANSPORT_PROTOCOL = 1;

/** Max accepted publish body (server rejects larger with 413). */
export const PUBLISH_MAX_BYTES = 512 * 1024;

/** Ring-buffer depth: replayable snapshots per server lifetime. */
export const REPLAY_BUFFER_MAX = 50;

/** Per-subscriber backlog cap: slower renderers get recovery, never block. */
export const SUBSCRIBER_BACKLOG_MAX = 50;

/** SSE heartbeat cadence (server) and stall threshold (client). */
export const HEARTBEAT_MS = 15_000;
export const STALL_AFTER_MS = 45_000;

/** Initial reconnect delay with exponential backoff (client). */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 15_000;

export type RendererConnState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export type IncomingVerdict =
  | { kind: "apply" }
  | { kind: "stale" }
  | { kind: "gap"; missingFrom: number; received: number };

/**
 * Classify one sequenced delivery against the last applied seq.
 * - next seq → apply.
 * - <= last → stale (duplicate/redelivery; ignore, stay subscribed).
 * - > last+1 → gap (events were missed; refetch authoritative snapshot,
 *   then resume from its seq).
 */
export function classifyIncoming(lastAppliedSeq: number, incomingSeq: number): IncomingVerdict {
  if (incomingSeq === lastAppliedSeq + 1) return { kind: "apply" };
  if (incomingSeq <= lastAppliedSeq) return { kind: "stale" };
  return { kind: "gap", missingFrom: lastAppliedSeq + 1, received: incomingSeq };
}

/**
 * Parse a `since` resume cursor. Anything unparseable means "no cursor":
 * the server sends the latest snapshot position (or recovery when the
 * buffer already turned over — decided server-side).
 */
export function parseSinceParam(raw: unknown): number | null {
  if (typeof raw !== "number" && typeof raw !== "string") return null;
  const n = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

/** Delay for attempt N (0-based) of client reconnect backoff. */
export function reconnectDelayMs(attempt: number): number {
  const exp = RECONNECT_BASE_MS * 2 ** Math.max(0, attempt);
  return Math.min(RECONNECT_MAX_MS, exp);
}

/** Human line for the dashboard dual-output block (text, never color-alone). */
export function dualStatusLine(kind: "rev" | "landscape" | "portrait" | "transport", detail: string): string {
  switch (kind) {
    case "rev":
      return `Authoritative revision: ${detail}`;
    case "landscape":
      return `Landscape renderer (1920×1080): ${detail}`;
    case "portrait":
      return `Portrait renderer (1080×1920): ${detail}`;
    case "transport":
      return `State transport: ${detail}`;
  }
}
