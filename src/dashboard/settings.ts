/**
 * UX-006 — Settings workspace models (PURE, no DOM, no imports).
 *
 * Presentation layer over existing behavior: connection-step derivation,
 * recovery guidance, OBS configuration. app.ts assembles inputs from the
 * same state already used by shell.ts alerts and overview.ts models
 * (source radio, sidecar wire status, persistFrom, location.origin).
 * Zero imports, like the other dashboard modules. No new thresholds,
 * no new commands beyond npm scripts verified in package.json, no URLs
 * beyond the built overlay route.
 */

export type StepState = "done" | "current" | "todo";

export interface ConnectionSteps {
  authorize: StepState;
  connect: StepState;
  verify: StepState;
}

export interface StepInput {
  /** Creator-selected source (radio state), not the wire status. */
  source: "simulation" | "youtube";
  /** Raw sidecar wire status (YtConnection). */
  ytStatus: string;
  /** Sidecar `authenticated` flag when the status carries one. */
  authenticated?: boolean | null;
}

const AUTH_IMPLIED: ReadonlySet<string> = new Set([
  "CONNECTED",
  "LIVE_CHAT_FOUND",
  "STREAMING",
  "STREAM_ENDED",
  "RECONNECTING",
]);

/**
 * Derive stepper state. A step reads "done" only on positive evidence
 * (auth flag or a status that implies past authorization; a located chat;
 * actual chat reception) — never merely because a button was clicked.
 * Only STREAMING proves chat reception (fail-closed, same rule as alerts).
 */
export function connectionSteps(i: StepInput): ConnectionSteps {
  if (i.source !== "youtube") return { authorize: "todo", connect: "todo", verify: "todo" };
  const authed = i.authenticated === true || AUTH_IMPLIED.has(i.ytStatus);
  switch (i.ytStatus) {
    case "STREAMING":
      return { authorize: "done", connect: "done", verify: "done" };
    case "LIVE_CHAT_FOUND":
      return { authorize: "done", connect: "done", verify: "current" };
    case "STREAM_ENDED":
      return { authorize: "done", connect: "done", verify: "todo" };
    case "AUTH_REQUIRED":
      return { authorize: "current", connect: "todo", verify: "todo" };
    case "CONNECTING":
    case "RECONNECTING":
    case "ERROR":
      return { authorize: authed ? "done" : "current", connect: "current", verify: "todo" };
    default:
      return { authorize: authed ? "done" : "current", connect: authed ? "current" : "todo", verify: "todo" };
  }
}

export function stepLabel(s: StepState): string {
  return s === "done" ? "Done" : s === "current" ? "Current step" : "To do";
}

export interface RecoveryInput {
  source: "simulation" | "youtube";
  ytStatus: string;
  ytError?: string | null;
  /**
   * T3 outbound capability from the sidecar status (`unknown` | `ok` |
   * `insufficient`). When the grant predates chat-posting permission, chat
   * announcements fail closed and the operator must re-consent.
   */
  outbound?: string | null;
}

/**
 * Status-specific recovery instructions. Every command/URL below is
 * verified: `npm run youtube-server` (package.json), the numbered buttons
 * below the stepper (existing handlers), automatic sidecar polling
 * (YouTubeSource statusTimer). Nothing invented.
 */
export function recoverySteps(i: RecoveryInput): string[] {
  if (i.source !== "youtube") {
    return ["Select YouTube Live as the input source above to begin setup."];
  }
  // T3: pre-outbound grants stay valid for reads; only announcements need
  // the new permission. Say so explicitly instead of a generic reconnect.
  if (i.outbound === "insufficient") {
    return [
      "Chat announcements need a new permission — press “1 · Authorize with Google” and approve the updated consent.",
      "Reading chat keeps working with the existing grant; only posting needs re-consent.",
      "Then press “2 · Connect to live chat”.",
    ];
  }
  if (i.ytError === "sidecar-unreachable" || (i.ytStatus === "DISCONNECTED" && i.ytError)) {
    return [
      "Start the sidecar: npm run youtube-server.",
      "Then press “2 · Connect to live chat” below.",
      "Status refreshes on its own every few seconds.",
    ];
  }
  switch (i.ytStatus) {
    case "STREAMING":
      return ["Chat is arriving — no recovery needed. If commands stop landing, check the broadcast is still live."];
    case "LIVE_CHAT_FOUND":
      return ["Chat located — send a test command in chat; the Verify step completes on arrival."];
    case "AUTH_REQUIRED":
      return [
        "Press “1 · Authorize with Google” and complete consent in the popup.",
        "If no popup opens, allow popups and check the sidecar is running.",
        "Then press “2 · Connect to live chat”.",
      ];
    case "CONNECTED":
      return ["Sidecar connected — start the broadcast on YouTube, then press “2 · Connect to live chat”."];
    case "CONNECTING":
      return ["Reaching the sidecar… if this persists, start the sidecar: npm run youtube-server."];
    case "RECONNECTING":
      return ["Holding the last position automatically — wait, or press Disconnect and reconnect."];
    case "STREAM_ENDED":
      return ["The broadcast ended. Disconnect, or wait for the next live chat."];
    case "ERROR":
      return [
        ...(i.ytError ? [`Sidecar reports: ${i.ytError}.`] : ["The sidecar reports an error."]),
        "Restart the sidecar and reconnect.",
      ];
    default:
      return [
        "Press “2 · Connect to live chat”.",
        "If it stays here, start the sidecar: npm run youtube-server.",
      ];
  }
}

// ---------------------------------------------------------------------------
// Source + persistence + OBS presentation.
// ---------------------------------------------------------------------------

export function sourceLine(source: "simulation" | "youtube"): string {
  return source === "youtube" ? "Input source: YouTube Live." : "Input source: Simulation.";
}

export type PersistFrom = "file" | "local" | "none";

export function persistStateLine(from: PersistFrom | string): { line: string; tone: "ok" | "info" | "unknown" } {
  if (from === "file") {
    return { line: "Saves: file · data/world-state.json via the persist server.", tone: "ok" };
  }
  if (from === "local") {
    return {
      line: "Saves: this browser only — run npm run persist-server for file saves.",
      tone: "info",
    };
  }
  return { line: "Saves: nothing saved yet this session.", tone: "unknown" };
}

export const OBS_WIDTH = 1920;
export const OBS_HEIGHT = 1080;
export const OBS_ROUTE = "/overlay.html";

export interface ObsConfig {
  /** Empty when no safe origin is available (caller shows manual guidance). */
  url: string;
  width: number;
  height: number;
}

/**
 * Overlay configuration from the actual application origin plus the built
 * overlay route (vite.config.ts inputs). No domains invented, no secrets —
 * origin plus a static path only.
 */
export function obsConfig(origin: string): ObsConfig {
  const clean = typeof origin === "string" ? origin.replace(/\/$/, "") : "";
  if (!clean || (!clean.startsWith("http://") && !clean.startsWith("https://"))) {
    return { url: "", width: OBS_WIDTH, height: OBS_HEIGHT };
  }
  return { url: `${clean}${OBS_ROUTE}`, width: OBS_WIDTH, height: OBS_HEIGHT };
}
