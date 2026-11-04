/**
 * UX-002 — dashboard shell, hash navigation, and global alerts.
 * Static + pure logic: no Phaser, no DOM, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SECTIONS,
  alertsHtml,
  alertsSignature,
  computeAlerts,
  normalizeHash,
  visibleAlerts,
  type ShellAlertInput,
} from "../src/dashboard/shell";

const ROOT = join(__dirname, "..");
const INDEX_HTML = readFileSync(join(ROOT, "index.html"), "utf8");
const SHELL_TS = readFileSync(join(ROOT, "src", "dashboard", "shell.ts"), "utf8");
const APP_TS = readFileSync(join(ROOT, "src", "app.ts"), "utf8");
const MAIN_TS = readFileSync(join(ROOT, "src", "main.ts"), "utf8");
const PACKAGE_JSON = readFileSync(join(ROOT, "package.json"), "utf8");

function countId(html: string, id: string): number {
  return html.split(`id="${id}"`).length - 1;
}

function baseInput(over: Partial<ShellAlertInput> = {}): ShellAlertInput {
  return {
    source: "simulation",
    ytStatus: "off",
    ytError: null,
    reconnects: undefined,
    broadcastTitle: null,
    paused: false,
    queueSize: 0,
    queueMax: 100,
    ledgerOverflow: false,
    ledgerTotal: 0,
    ledgerBound: 200,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Hash navigation: mapping layer (native anchors provide back/forward +
// direct loads; no routing dependency).
// ---------------------------------------------------------------------------

describe("UX-002 hash navigation mapping", () => {
  it.each([
    ["#overview", "overview"],
    ["#control", "control"],
    ["#activity", "activity"],
    ["#settings", "settings"],
    ["overview", "overview"],
    ["", "overview"],
    ["#", "overview"],
    ["#bogus", "overview"],
    ["#Control", "overview"],
    ["#overview/extra", "overview"],
  ])("normalizeHash(%j) === %j", (raw, expected) => {
    expect(normalizeHash(raw)).toBe(expected);
  });

  it("non-string input falls back to overview", () => {
    expect(normalizeHash(null)).toBe("overview");
    expect(normalizeHash(undefined)).toBe("overview");
    expect(normalizeHash(42)).toBe("overview");
  });

  it("SECTIONS defines exactly the four authorized sections", () => {
    expect(SECTIONS.map((s) => s.id)).toEqual(["overview", "control", "activity", "settings"]);
    expect(new Set(SECTIONS.map((s) => s.hash)).size).toBe(4);
  });

  it("no routing dependency introduced", () => {
    const pkg = JSON.parse(PACKAGE_JSON) as { dependencies?: Record<string, string> };
    const deps = { ...(pkg.dependencies ?? {}) };
    for (const name of Object.keys(deps)) {
      expect(name).not.toMatch(/rout|history|navigat/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Global alerts: authoritative signals only.
// ---------------------------------------------------------------------------

describe("UX-002 global alerts", () => {
  it("simulation source suppresses all YouTube noise (stale wire status)", () => {
    for (const ytStatus of ["ERROR", "RECONNECTING", "DISCONNECTED", "STREAM_ENDED", "AUTH_REQUIRED"]) {
      expect(computeAlerts(baseInput({ source: "simulation", ytStatus, ytError: "boom" }))).toEqual([]);
    }
  });

  it("healthy streaming shows no alert", () => {
    expect(computeAlerts(baseInput({ source: "youtube", ytStatus: "STREAMING" }))).toEqual([]);
  });

  it("sidecar unreachable is a non-dismissible error with recovery text", () => {
    const [a] = computeAlerts(
      baseInput({ source: "youtube", ytStatus: "DISCONNECTED", ytError: "sidecar-unreachable" }),
    );
    expect(a.severity).toBe("error");
    expect(a.dismissible).toBe(false);
    expect(a.href).toBe("#settings");
    expect(a.detail).toContain("youtube-server");
  });

  it("plain disconnect is a dismissible warning, not an error", () => {
    const [a] = computeAlerts(baseInput({ source: "youtube", ytStatus: "DISCONNECTED" }));
    expect(a.severity).toBe("warning");
    expect(a.dismissible).toBe(true);
  });

  it("auth required points at authorization first (fail-closed order)", () => {
    const [a] = computeAlerts(baseInput({ source: "youtube", ytStatus: "AUTH_REQUIRED" }));
    expect(a.title).toContain("authorization");
    expect(a.detail).toContain("Authorize");
  });

  it("reconnecting carries the attempt count without claiming health", () => {
    const [a] = computeAlerts(
      baseInput({ source: "youtube", ytStatus: "RECONNECTING", reconnects: 3 }),
    );
    expect(a.detail).toContain("3");
    expect(a.title.toLowerCase()).not.toContain("receiv");
  });

  it("CONNECTED never claims messages are being received (fail-closed)", () => {
    for (const ytStatus of ["CONNECTED", "LIVE_CHAT_FOUND"] as const) {
      const [a] = computeAlerts(baseInput({ source: "youtube", ytStatus }));
      const text = `${a.title} ${a.detail}`.toLowerCase();
      expect(text).not.toContain("receiv");
      expect(a.severity).toBe("info");
    }
  });

  it("sidecar ERROR is a non-dismissible error with the wire message", () => {
    const [a] = computeAlerts(
      baseInput({ source: "youtube", ytStatus: "ERROR", ytError: "quota-exceeded" }),
    );
    expect(a.severity).toBe("error");
    expect(a.dismissible).toBe(false);
    expect(a.detail).toContain("quota-exceeded");
  });

  it("stream ended is a dismissible warning", () => {
    const [a] = computeAlerts(baseInput({ source: "youtube", ytStatus: "STREAM_ENDED" }));
    expect(a.severity).toBe("warning");
    expect(a.dismissible).toBe(true);
    expect(a.href).toBe("#settings");
  });

  it("paused runtime surfaces as warning with held-event count, never as disconnected", () => {
    const [a] = computeAlerts(baseInput({ paused: true, queueSize: 7 }));
    expect(a.id).toBe("runtime-paused");
    expect(a.detail).toContain("7");
    expect(`${a.title} ${a.detail}`.toLowerCase()).not.toContain("disconnect");
    const [b] = computeAlerts(baseInput({ paused: true, queueSize: 0 }));
    expect(b.detail).toContain("held");
  });

  it("queue alert fires ONLY at the documented bound (no invented threshold)", () => {
    expect(computeAlerts(baseInput({ queueSize: 99, queueMax: 100 }))).toEqual([]);
    const [full] = computeAlerts(baseInput({ queueSize: 100, queueMax: 100 }));
    expect(full.id).toBe("queue-full");
    expect(full.severity).toBe("error");
    expect(full.dismissible).toBe(false);
    expect(full.detail).toContain("dropped");
  });

  it("ledger overflow alert fires ONLY on the documented overflow flag", () => {
    expect(computeAlerts(baseInput({ ledgerTotal: 200, ledgerOverflow: false }))).toEqual([]);
    const [a] = computeAlerts(baseInput({ ledgerTotal: 201, ledgerOverflow: true }));
    expect(a.id).toBe("ledger-overflow");
    expect(a.severity).toBe("warning");
    expect(a.detail).toContain("causality preserved");
  });

  it("alert ids are stable across polls (dedup key)", () => {
    const input = baseInput({
      source: "youtube",
      ytStatus: "RECONNECTING",
      reconnects: 2,
      paused: true,
      queueSize: 4,
    });
    expect(computeAlerts(input)).toEqual(computeAlerts(structuredClone(input)));
  });

  it("output order is stable: errors, warnings, info", () => {
    const alerts = computeAlerts(
      baseInput({
        source: "youtube",
        ytStatus: "ERROR",
        ytError: "x",
        paused: true,
        queueSize: 1,
        ledgerOverflow: true,
        ledgerTotal: 250,
      }),
    );
    const rank = { error: 0, warning: 1, info: 2 } as const;
    const keys = alerts.map((a) => rank[a.severity]);
    expect([...keys].sort((a, b) => a - b)).toEqual(keys);
    expect(alerts[0].severity).toBe("error");
  });
});

describe("UX-002 alert dismissal + rendering", () => {
  it("errors are never dismissed; warnings/info are", () => {
    const alerts = computeAlerts(
      baseInput({
        source: "youtube",
        ytStatus: "ERROR",
        ytError: "x",
        paused: true,
        queueSize: 0,
        ledgerOverflow: true,
        ledgerTotal: 250,
      }),
    );
    const dismissed = new Set(alerts.map((a) => a.id));
    const visible = visibleAlerts(alerts, dismissed);
    expect(visible.map((a) => a.severity)).toEqual(["error"]);
  });

  it("signature changes when user-visible text changes (reconnect attempts)", () => {
    const a = computeAlerts(baseInput({ source: "youtube", ytStatus: "RECONNECTING", reconnects: 1 }));
    const b = computeAlerts(baseInput({ source: "youtube", ytStatus: "RECONNECTING", reconnects: 2 }));
    expect(alertsSignature(a)).not.toBe(alertsSignature(b));
    expect(alertsSignature(a)).toBe(alertsSignature(computeAlerts(baseInput({ source: "youtube", ytStatus: "RECONNECTING", reconnects: 1 }))));
  });

  it("alertsHtml escapes untrusted text (broadcast titles) and marks roles", () => {
    const html = alertsHtml([
      {
        id: "yt-chat-found",
        severity: "info",
        title: 'Live chat found"><script>alert(1)</script>',
        detail: "Chat located.",
        href: "#settings",
        dismissible: true,
      },
      {
        id: "yt-sidecar-unreachable",
        severity: "error",
        title: "YouTube sidecar unreachable",
        detail: "Start the sidecar.",
        href: "#settings",
        dismissible: false,
      },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('role="alert"');
    expect(html).toContain('role="status"');
    expect(html).toContain("data-dismiss=");
    expect(html.match(/data-dismiss=/g)).toHaveLength(1);
  });
});

describe("UX-003 next action is model-driven (placeholder retired)", () => {
  it("shell owns no placeholder heuristic; app maps nextActionModel into sync", () => {
    expect(SHELL_TS).not.toContain("nextActionPlaceholder");
    expect(APP_TS).toContain("nextActionModel({");
    expect(APP_TS).toContain("next: action,");
  });
});

// ---------------------------------------------------------------------------
// Legacy preservation: every existing ID present exactly once.
// ---------------------------------------------------------------------------

const LEGACY_IDS = [
  "cc-status", "btn-pause", "btn-resume", "yt-status",
  "cc-arc", "cc-chapter", "cc-threat", "cc-resolve", "cc-supplies",
  "game", "cc-location", "cc-standing", "cc-m1", "cc-m1-fill", "cc-m2", "cc-m2-fill",
  "cc-moment", "cc-objective", "cc-vex", "story-log", "feed-list",
  "cc-vote", "btn-open-v1", "btn-open-v2", "btn-close-vote",
  "btn-override-0", "btn-override-1", "btn-override-2",
  "cc-rites-hint", "btn-rite-sable", "btn-rite-tide", "btn-rite-ilya", "btn-rite-rekindle", "btn-rite-rho",
  "desc-rite-sable", "desc-rite-tide", "desc-rite-ilya", "desc-rite-rekindle", "desc-rite-rho",
  "viewer-name", "viewer-id", "command", "btn-command",
  "paid-preset", "paid-custom", "btn-paid", "outcome", "btn-end-stream",
  "cc-commands", "cc-deeds", "cc-recap",
  "src-sim", "src-yt", "yt-note", "yt-detail", "btn-yt-auth", "btn-yt-connect", "btn-yt-disconnect",
  "queue-list", "btn-save", "btn-reload", "btn-export", "btn-reset", "cc-ledger",
];

const SHELL_IDS = [
  "tb-next-action", "tb-alerts", "tb-main",
  "view-overview", "view-control", "view-activity", "view-settings",
  "tb-h-overview", "tb-h-control", "tb-h-activity", "tb-h-settings",
];

describe("UX-002 legacy ID preservation audit", () => {
  it.each(LEGACY_IDS)("legacy #%s present exactly once", (id) => {
    expect(countId(INDEX_HTML, id)).toBe(1);
  });

  it.each(SHELL_IDS)("shell #%s present exactly once", (id) => {
    expect(countId(INDEX_HTML, id)).toBe(1);
  });

  it("no duplicate id attributes anywhere in the dashboard", () => {
    const ids = [...INDEX_HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rail + tabs expose all four hashes; sections exist with labels", () => {
    for (const s of SECTIONS) {
      expect(INDEX_HTML).toContain(`href="#${s.hash}"`);
      expect(INDEX_HTML).toContain(`id="view-${s.id}"`);
    }
    const railLinks = (INDEX_HTML.match(/data-section="/g) ?? []).length;
    expect(railLinks).toBe(8);
    expect(INDEX_HTML).toContain('aria-label="Dashboard sections"');
    expect(INDEX_HTML).toContain('role="status"');
  });
});

// ---------------------------------------------------------------------------
// Update safety: shell cannot reach engine/YT/persistence/Phaser; app wiring
// registers shell once and keeps the render loop intact.
// ---------------------------------------------------------------------------

describe("UX-002 update-safety audit", () => {
  it("shell module imports nothing from engine/youtube/phaser/persistence/server", () => {
    const imports = [...SHELL_TS.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual([]);
    const banned = ["engine", "youtube", "phaser", "persistence", "server", "hud"];
    for (const imp of imports) {
      for (const b of banned) expect(imp).not.toContain(b);
    }
    expect(SHELL_TS).not.toContain("new Phaser");
    expect(SHELL_TS).not.toContain("EventSource");
    expect(SHELL_TS).not.toMatch(/[^a-zA-Z]fetch\(/);
  });

  it("app wires initShell once and syncs shell inside renderPanelState", () => {
    expect(APP_TS.match(/initShell\(\)/g)).toHaveLength(1);
    expect(APP_TS).toContain("syncShellStatus({");
    expect(APP_TS).toContain("next: action,");
    expect(APP_TS).toContain("queueMax: QUEUE.maxSize");
    expect(APP_TS).toContain("ledgerBound: PAID_LEDGER_MAX_ENTRIES");
  });

  it("no new Phaser.Game construction and no YT reconnect path in shell wiring", () => {
    // T4F-C1 migration: the single preview game lives in src/main.ts.
    expect((APP_TS.match(/new Phaser\.Game\(\{/g) ?? []).length).toBe(0);
    expect((MAIN_TS.match(/new Phaser\.Game\(\{/g) ?? []).length).toBe(1);
    expect(SHELL_TS).not.toContain("new Phaser");
    expect(SHELL_TS).not.toContain("EventSource");
    expect(SHELL_TS).not.toMatch(/[^a-zA-Z]fetch\(/);
  });
});
