/**
 * UX-002 — Creator dashboard shell: navigation + global alerts.
 *
 * Pure logic (navigation mapping, alert derivation, next-action placeholder)
 * lives here so it is unit-testable without a DOM. The thin DOM sync layer
 * at the bottom only reads primitives passed in by `src/app.ts` and never
 * touches engine, YouTube, persistence, or Phaser state.
 *
 * Non-goals (later milestones): page redesigns, connection stepper,
 * confirmation modals, rehearsal flow. This file must not import from
 * engine / youtube / persistence / phaser / server.
 */

export type SectionId = "overview" | "control" | "activity" | "settings";

export interface SectionDef {
  id: SectionId;
  /** Hash fragment (without the leading `#`). */
  hash: string;
  label: string;
  tagline: string;
}

export const SECTIONS: readonly SectionDef[] = [
  { id: "overview", hash: "overview", label: "Overview", tagline: "Session, connection and world health" },
  { id: "control", hash: "control", label: "Control Room", tagline: "Session, votes and rites" },
  { id: "activity", hash: "activity", label: "Activity", tagline: "Commands, events and diagnostics" },
  { id: "settings", hash: "settings", label: "Settings", tagline: "Connection, rehearsal and persistence" },
] as const;

const BY_HASH: ReadonlyMap<string, SectionId> = new Map(SECTIONS.map((s) => [s.hash, s.id]));

/**
 * Map a raw location hash to a section. Absent, empty, or invalid hashes
 * fall back to Overview. Case-sensitive: hashes are author-defined anchors.
 */
export function normalizeHash(raw: unknown): SectionId {
  if (typeof raw !== "string") return "overview";
  const h = raw.startsWith("#") ? raw.slice(1) : raw;
  return BY_HASH.get(h) ?? "overview";
}

// ---------------------------------------------------------------------------
// Global operational alerts (P0 from UX-001C).
// ---------------------------------------------------------------------------

export type AlertSeverity = "error" | "warning" | "info";

export type AlertHref = "#overview" | "#control" | "#activity" | "#settings";

export interface ShellAlertInput {
  /** Creator-selected input source (radio state), not the wire status. */
  source: "simulation" | "youtube";
  /** Raw sidecar wire status (see src/youtube/client.ts YtConnection). */
  ytStatus: string;
  ytError?: string | null;
  reconnects?: number;
  broadcastTitle?: string | null;
  paused: boolean;
  queueSize: number;
  /** Documented bound QUEUE.maxSize (src/engine/config.ts). */
  queueMax: number;
  /** ledgerStatus().overflow — true only past PAID_LEDGER_MAX_ENTRIES. */
  ledgerOverflow: boolean;
  ledgerTotal: number;
  /** Documented bound PAID_LEDGER_MAX_ENTRIES (src/engine/ledger.ts). */
  ledgerBound: number;
}

export interface ShellAlert {
  /** Stable across polls for the same underlying condition (dedup key). */
  id: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  href?: AlertHref;
  /** Errors are never dismissible; warnings/info may be. */
  dismissible: boolean;
}

/**
 * Derive the visible alert set from authoritative state only.
 *
 * - YouTube alerts fire ONLY when the creator selected YouTube Live, so
 *   simulation runs never show stale-connection noise.
 * - Fail-closed wording is preserved: CONNECTED / LIVE_CHAT_FOUND never
 *   claim messages are being received.
 * - Queue alert fires ONLY at the documented bound (size >= maxSize), never
 *   at an invented "looks busy" threshold.
 * - Ledger alert fires ONLY on the documented overflow flag.
 * - Persistence has no reliable failure signal (WorldStore.save() falls back
 *   silently to localStorage), so no persistence alert is derived here.
 * - Output order is stable: errors, then warnings, then info.
 */
export function computeAlerts(input: ShellAlertInput): ShellAlert[] {
  const errors: ShellAlert[] = [];
  const warnings: ShellAlert[] = [];
  const infos: ShellAlert[] = [];

  if (input.source === "youtube") {
    switch (input.ytStatus) {
      case "STREAMING":
        break;
      case "off":
        infos.push({
          id: "yt-starting",
          severity: "info",
          title: "YouTube starting",
          detail: "YouTube Live selected — starting the connection…",
          href: "#settings",
          dismissible: true,
        });
        break;
      case "DISCONNECTED":
        if (input.ytError === "sidecar-unreachable") {
          errors.push({
            id: "yt-sidecar-unreachable",
            severity: "error",
            title: "YouTube sidecar unreachable",
            detail: "Start the sidecar (npm run youtube-server), then reconnect in Settings.",
            href: "#settings",
            dismissible: false,
          });
        } else {
          warnings.push({
            id: "yt-disconnected",
            severity: "warning",
            title: "YouTube disconnected",
            detail: "Not connected to the sidecar.",
            href: "#settings",
            dismissible: true,
          });
        }
        break;
      case "AUTH_REQUIRED":
        warnings.push({
          id: "yt-auth-required",
          severity: "warning",
          title: "YouTube needs authorization",
          detail: "Authorize with Google (step 1), then connect to live chat.",
          href: "#settings",
          dismissible: true,
        });
        break;
      case "CONNECTING":
        infos.push({
          id: "yt-connecting",
          severity: "info",
          title: "Connecting to YouTube…",
          detail: "Reaching the sidecar…",
          href: "#settings",
          dismissible: true,
        });
        break;
      case "RECONNECTING":
        warnings.push({
          id: "yt-reconnecting",
          severity: "warning",
          title: "YouTube reconnecting",
          detail:
            typeof input.reconnects === "number"
              ? `Attempt ${input.reconnects} — holding the last position.`
              : "Holding the last position.",
          href: "#settings",
          dismissible: true,
        });
        break;
      case "CONNECTED":
        infos.push({
          id: "yt-no-chat",
          severity: "info",
          title: "YouTube connected — no live chat yet",
          detail: "Sidecar connected. Start the broadcast, then connect.",
          href: "#settings",
          dismissible: true,
        });
        break;
      case "LIVE_CHAT_FOUND":
        infos.push({
          id: "yt-chat-found",
          severity: "info",
          title: "Live chat found",
          detail: input.broadcastTitle
            ? `Chat located for "${input.broadcastTitle}". Waiting for messages…`
            : "Chat located. Waiting for messages…",
          href: "#settings",
          dismissible: true,
        });
        break;
      case "STREAM_ENDED":
        warnings.push({
          id: "yt-stream-ended",
          severity: "warning",
          title: "Stream ended",
          detail: "The broadcast ended. Disconnect, or wait for the next live chat.",
          href: "#settings",
          dismissible: true,
        });
        break;
      case "ERROR":
        errors.push({
          id: "yt-error",
          severity: "error",
          title: "YouTube error",
          detail: input.ytError ? `Sidecar reports: ${input.ytError}.` : "Sidecar reports an error.",
          href: "#settings",
          dismissible: false,
        });
        break;
      default:
        warnings.push({
          id: "yt-unknown",
          severity: "warning",
          title: "YouTube state unknown",
          detail: "Unknown connection state — treating as disconnected.",
          href: "#settings",
          dismissible: true,
        });
        break;
    }
  }

  if (input.paused) {
    warnings.push({
      id: "runtime-paused",
      severity: "warning",
      title: "Runtime paused",
      detail:
        input.queueSize > 0
          ? `${input.queueSize} event(s) held — resume to let them flow.`
          : "Incoming events are held — resume to let them flow.",
      href: "#control",
      dismissible: true,
    });
  }

  if (input.queueMax > 0 && input.queueSize >= input.queueMax) {
    errors.push({
      id: "queue-full",
      severity: "error",
      title: "Event queue full",
      detail: `${input.queueSize}/${input.queueMax} — new events are being dropped.`,
      href: "#activity",
      dismissible: false,
    });
  }

  if (input.ledgerOverflow) {
    warnings.push({
      id: "ledger-overflow",
      severity: "warning",
      title: "Paid ledger overflow",
      detail: `${input.ledgerTotal} entries (bound ${input.ledgerBound}) — causality preserved.`,
      href: "#activity",
      dismissible: true,
    });
  }

  return [...errors, ...warnings, ...infos];
}

/** Filter out dismissed warnings/info. Errors are never filtered. */
export function visibleAlerts(
  alerts: readonly ShellAlert[],
  dismissed: ReadonlySet<string>,
): ShellAlert[] {
  return alerts.filter((a) => a.severity === "error" || !a.dismissible || !dismissed.has(a.id));
}

/** Change-detection signature: stable when nothing user-visible changed. */
export function alertsSignature(alerts: readonly ShellAlert[]): string {
  return alerts.map((a) => `${a.severity}|${a.id}|${a.title}|${a.detail}|${a.href ?? ""}`).join("\n");
}

/** Shared escaper for dashboard HTML joins (engine text is untrusted input). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Rendered once per signature change only — never rewritten every poll. */
export function alertsHtml(alerts: readonly ShellAlert[]): string {
  return alerts
    .map((a) => {
      const role = a.severity === "error" ? "alert" : "status";
      const label = a.severity === "error" ? "Error" : a.severity === "warning" ? "Warning" : "Notice";
      const link = a.href
        ? ` <a href="${a.href}" data-alert-link>Go to ${a.href === "#settings" ? "Settings" : a.href === "#control" ? "Control Room" : a.href === "#activity" ? "Activity" : "Overview"}</a>`
        : "";
      const dismiss = a.dismissible
        ? ` <button type="button" data-dismiss="${escapeHtml(a.id)}" aria-label="Dismiss: ${escapeHtml(a.title)}">Dismiss</button>`
        : "";
      return (
        `<div class="tb-alert" data-sev="${a.severity}" data-alert="${escapeHtml(a.id)}" role="${role}">` +
        `<strong>${escapeHtml(label)}: ${escapeHtml(a.title)}</strong>` +
        `<span>${escapeHtml(a.detail)}</span>${link}${dismiss}</div>`
      );
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Next action (UX-003): the structured recommendation comes from
// `nextActionModel` in ./overview.ts (pure, tested there). This module keeps
// its zero-import rule — the structurally identical interface below is
// duplicated deliberately so shell.ts never imports engine-adjacent code.
// `src/app.ts` maps the model result onto it.
// ---------------------------------------------------------------------------

export type ShellNextSeverity = "urgent" | "attention" | "info";

export interface ShellNextAction {
  id: string;
  title: string;
  detail: string;
  severity: ShellNextSeverity;
  href: AlertHref;
}

function nextSeverityLabel(s: ShellNextSeverity): string {
  return s === "urgent" ? "Urgent" : s === "attention" ? "Attention" : "All clear";
}

function sectionName(href: AlertHref): string {
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

// ---------------------------------------------------------------------------
// Thin DOM sync layer (browser only; no-ops without DOM).
// ---------------------------------------------------------------------------

export interface ShellSyncInput extends ShellAlertInput {
  /** Structured recommendation from nextActionModel (mapped by app.ts). */
  next: ShellNextAction;
}

let shellInitDone = false;
let lastAlertsSig: string | null = null;
let lastNextAction: string | null = null;
let lastNextCardSig: string | null = null;
const dismissedIds = new Set<string>();
let lastSyncInput: ShellSyncInput | null = null;

function sectionEls(): Array<{ id: SectionId; el: HTMLElement }> {
  const doc = globalThis.document;
  const out: Array<{ id: SectionId; el: HTMLElement }> = [];
  for (const s of SECTIONS) {
    const el = doc.getElementById(`view-${s.id}`);
    if (el instanceof HTMLElement) out.push({ id: s.id, el });
  }
  return out;
}

/** Show one section, hide the rest, mark nav. Never destroys nodes. */
export function applySection(section: SectionId): void {
  if (typeof globalThis.document === "undefined") return;
  for (const { id, el } of sectionEls()) el.hidden = id !== section;
  const links = globalThis.document.querySelectorAll("[data-section]");
  links.forEach((a) => {
    if (a instanceof HTMLElement) {
      if (a.getAttribute("data-section") === section) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
  });
}

/**
 * One-time shell wiring: hash routing + alert-dismiss delegation.
 * Idempotent — safe to call from wirePanel on every runtime creation.
 * Uses native anchor hashes, so back/forward and direct loads work free.
 */
export function initShell(): void {
  if (shellInitDone) return;
  if (typeof globalThis.window === "undefined" || typeof globalThis.document === "undefined") return;
  shellInitDone = true;
  const apply = (initial: boolean) => {
    const section = normalizeHash(globalThis.location.hash);
    applySection(section);
    if (!initial) {
      // Tab switch behaves like a page change: reset scroll, move focus to
      // the panel. No trap — focus leaves the panel with normal Tab order.
      try {
        const el = globalThis.document.getElementById(`view-${section}`);
        if (el instanceof HTMLElement) el.focus({ preventScroll: true });
        globalThis.window.scrollTo(0, 0);
      } catch {
        /* non-browser test env */
      }
    }
  };
  globalThis.window.addEventListener("hashchange", () => apply(false));
  apply(true);
  globalThis.document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const btn = t.closest("[data-dismiss]");
    if (!(btn instanceof HTMLElement)) return;
    const id = btn.getAttribute("data-dismiss");
    if (!id) return;
    dismissedIds.add(id);
    paintAlerts();
  });
}

function paintAlerts(): void {
  if (typeof globalThis.document === "undefined") return;
  const box = globalThis.document.getElementById("tb-alerts");
  if (!(box instanceof HTMLElement) || lastSyncInput === null) return;
  const alerts = visibleAlerts(computeAlerts(lastSyncInput), dismissedIds);
  lastAlertsSig = alertsSignature(alerts);
  box.innerHTML = alertsHtml(alerts);
  box.hidden = alerts.length === 0;
}

/**
 * Sync the next-action line and alert banner. Writes to the DOM ONLY when
 * the visible signature changed, so the 1s poll never causes duplicate
 * announcements, focus loss, or layout churn.
 */
export function syncShellStatus(input: ShellSyncInput): void {
  if (typeof globalThis.document === "undefined") return;
  lastSyncInput = input;
  // Compact header line: short title only (world detail lives in cards).
  const nextEl = globalThis.document.getElementById("tb-next-action");
  if (nextEl instanceof HTMLElement) {
    const text = `Next: ${input.next.title}`;
    if (text !== lastNextAction) {
      lastNextAction = text;
      nextEl.textContent = text;
    }
  }
  // Next-action card: rewritten only when the recommendation changes, so the
  // 1s poll never steals focus from the card link or re-announces status.
  const card = globalThis.document.getElementById("ov-next-card");
  if (card instanceof HTMLElement) {
    const sig = `${input.next.severity}|${input.next.id}|${input.next.title}|${input.next.detail}|${input.next.href}`;
    if (sig !== lastNextCardSig) {
      lastNextCardSig = sig;
      card.setAttribute("data-sev", input.next.severity);
      const title = globalThis.document.getElementById("ov-next-title");
      if (title instanceof HTMLElement) {
        title.textContent = `${nextSeverityLabel(input.next.severity)} — ${input.next.title}`;
      }
      const detail = globalThis.document.getElementById("ov-next-detail");
      if (detail instanceof HTMLElement) detail.textContent = input.next.detail;
      const link = globalThis.document.getElementById("ov-next-link");
      if (link instanceof HTMLAnchorElement) {
        link.setAttribute("href", input.next.href);
        link.textContent = `Go to ${sectionName(input.next.href)} →`;
      }
    }
  }
  const box = globalThis.document.getElementById("tb-alerts");
  if (!(box instanceof HTMLElement)) return;
  const alerts = visibleAlerts(computeAlerts(input), dismissedIds);
  const ids = new Set(alerts.map((a) => a.id));
  // Clear dismissals for conditions that resolved so a recurrence re-alerts.
  for (const id of [...dismissedIds]) if (!ids.has(id)) dismissedIds.delete(id);
  const sig = alertsSignature(alerts);
  if (sig !== lastAlertsSig) {
    lastAlertsSig = sig;
    box.innerHTML = alertsHtml(alerts);
    box.hidden = alerts.length === 0;
  }
}

/** Test hook: reset module DOM caches (never used by production code). */
export function __resetShellForTests(): void {
  shellInitDone = false;
  lastAlertsSig = null;
  lastNextAction = null;
  lastNextCardSig = null;
  dismissedIds.clear();
  lastSyncInput = null;
}
