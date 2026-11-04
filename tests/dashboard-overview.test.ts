/**
 * UX-003 — Overview redesign: nextActionModel, summary helpers, markup audit.
 * Static + pure logic: no Phaser, no DOM, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeAlerts, type ShellAlertInput } from "../src/dashboard/shell";
import {
  meterAria,
  nextActionModel,
  paidLine,
  persistLine,
  queueLine,
  sectionLabel,
  severityLabel,
  voteLine,
  type NextActionInput,
} from "../src/dashboard/overview";

const ROOT = join(__dirname, "..");
const INDEX_HTML = readFileSync(join(ROOT, "index.html"), "utf8");
const APP_TS = readFileSync(join(ROOT, "src", "app.ts"), "utf8");
const MAIN_TS = readFileSync(join(ROOT, "src", "main.ts"), "utf8");
const OVERVIEW_TS = readFileSync(join(ROOT, "src", "dashboard", "overview.ts"), "utf8");

function countId(html: string, id: string): number {
  return html.split(`id="${id}"`).length - 1;
}

function baseModel(over: Partial<NextActionInput> = {}): NextActionInput {
  return {
    paused: false,
    votePhase: "none",
    voteClosingSoon: false,
    source: "simulation",
    ytStatus: "off",
    ytError: null,
    queueSize: 0,
    queueMax: 100,
    ledgerOverflow: false,
    threatTone: "calm",
    cinderholmLost: false,
    persistFrom: "file",
    ...over,
  };
}

const YT = { source: "youtube" as const };

// ---------------------------------------------------------------------------
// nextActionModel: every priority branch.
// ---------------------------------------------------------------------------

describe("UX-003 nextActionModel branches", () => {
  it.each([
    [{ queueSize: 100 }, "queue-full", "urgent", "#activity"],
    [{ ...YT, ytStatus: "DISCONNECTED", ytError: "sidecar-unreachable" }, "yt-sidecar-unreachable", "urgent", "#settings"],
    [{ ...YT, ytStatus: "ERROR" }, "yt-error", "urgent", "#settings"],
    [{ paused: true }, "runtime-paused", "attention", "#control"],
    [{ votePhase: "open", voteClosingSoon: true }, "vote-closing", "attention", "#overview"],
    [{ votePhase: "open" }, "vote-open", "info", "#overview"],
    [{ ...YT, ytStatus: "AUTH_REQUIRED" }, "yt-auth-required", "attention", "#settings"],
    [{ ...YT, ytStatus: "RECONNECTING" }, "yt-reconnecting", "attention", "#settings"],
    [{ ...YT, ytStatus: "DISCONNECTED" }, "yt-disconnected", "attention", "#settings"],
    [{ ...YT, ytStatus: "STREAM_ENDED" }, "yt-stream-ended", "attention", "#settings"],
    [{ ...YT, ytStatus: "SOME_FUTURE_STATE" }, "yt-unknown-status", "attention", "#settings"],
    [{ ledgerOverflow: true }, "ledger-overflow", "attention", "#activity"],
    [{ cinderholmLost: true }, "world-lost", "attention", "#overview"],
    [{ threatTone: "dire" }, "world-dire", "attention", "#overview"],
    [{ ...YT, ytStatus: "CONNECTED" }, "yt-setup", "info", "#settings"],
    [{ ...YT, ytStatus: "off" }, "yt-setup", "info", "#settings"],
    [{ ...YT, ytStatus: "LIVE_CHAT_FOUND" }, "yt-setup", "info", "#settings"],
    [{ persistFrom: "local" as const }, "persist-local", "info", "#overview"],
    [{}, "healthy-simulation", "info", "#overview"],
    [{ ...YT, ytStatus: "STREAMING" }, "healthy-streaming", "info", "#overview"],
  ])("recommends %s", (over, id, severity, href) => {
    const a = nextActionModel(baseModel(over));
    expect(a.id).toBe(id);
    expect(a.severity).toBe(severity);
    expect(a.href).toBe(href);
    expect(a.title.length).toBeGreaterThan(0);
    expect(a.detail.length).toBeGreaterThan(0);
  });

  it("paused detail carries the held-event count", () => {
    expect(nextActionModel(baseModel({ paused: true, queueSize: 7 })).detail).toContain("7");
    expect(nextActionModel(baseModel({ paused: true, queueSize: 0 })).detail).toContain("held");
  });
});

describe("UX-003 nextActionModel conflicts (deterministic priority)", () => {
  it.each([
    [{ paused: true, queueSize: 100 }, "queue-full"],
    [{ ...YT, ytStatus: "ERROR", paused: true }, "yt-error"],
    [{ paused: true, votePhase: "open" }, "runtime-paused"],
    [{ votePhase: "open", ...YT, ytStatus: "DISCONNECTED" }, "vote-open"],
    [{ votePhase: "open", voteClosingSoon: true, paused: true }, "runtime-paused"],
    [{ ledgerOverflow: true, cinderholmLost: true }, "ledger-overflow"],
    [{ cinderholmLost: true, threatTone: "dire" }, "world-lost"],
    [{ cinderholmLost: true, ...YT, ytStatus: "CONNECTED" }, "world-lost"],
    [{ threatTone: "dire", ...YT, ytStatus: "CONNECTED" }, "world-dire"],
    [{ persistFrom: "local" as const, threatTone: "pressing" }, "persist-local"],
    [{ ...YT, ytStatus: "STREAMING", persistFrom: "local" as const }, "persist-local"],
  ])("resolves %j to %s", (over, id) => {
    expect(nextActionModel(baseModel(over)).id).toBe(id);
  });
});

describe("UX-003 nextActionModel unknown/missing inputs", () => {
  it("unknown vote phase reads as no vote", () => {
    expect(nextActionModel(baseModel({ votePhase: "bogus" })).id).toBe("healthy-simulation");
  });
  it("unknown threat tone triggers nothing", () => {
    expect(nextActionModel(baseModel({ threatTone: "" })).id).toBe("healthy-simulation");
  });
  it("non-positive queueMax disables the queue check", () => {
    expect(nextActionModel(baseModel({ queueSize: 9999, queueMax: 0 })).id).toBe("healthy-simulation");
  });
  it("simulation ignores stale/errored wire status", () => {
    expect(nextActionModel(baseModel({ ytStatus: "ERROR" })).id).toBe("healthy-simulation");
  });
  it("closing-soon without an open vote is ignored", () => {
    expect(nextActionModel(baseModel({ votePhase: "closed", voteClosingSoon: true })).id).toBe(
      "healthy-simulation",
    );
  });
  it("none persist state claims nothing about saves", () => {
    const a = nextActionModel(baseModel({ persistFrom: "none" }));
    expect(a.id).toBe("healthy-simulation");
    expect(`${a.title} ${a.detail}`.toLowerCase()).not.toContain("browser");
  });
});

describe("UX-003 no false YouTube receiving status", () => {
  const probes: NextActionInput[] = [
    baseModel(),
    baseModel({ source: "youtube", ytStatus: "off" }),
    baseModel({ source: "youtube", ytStatus: "CONNECTING" }),
    baseModel({ source: "youtube", ytStatus: "CONNECTED" }),
    baseModel({ source: "youtube", ytStatus: "LIVE_CHAT_FOUND" }),
    baseModel({ source: "youtube", ytStatus: "DISCONNECTED" }),
    baseModel({ source: "youtube", ytStatus: "RECONNECTING" }),
    baseModel({ source: "youtube", ytStatus: "ERROR" }),
    baseModel({ source: "youtube", ytStatus: "STREAM_ENDED" }),
    baseModel({ source: "youtube", ytStatus: "AUTH_REQUIRED" }),
    baseModel({ source: "youtube", ytStatus: "WEIRD" }),
    baseModel({ paused: true, source: "youtube", ytStatus: "STREAMING" }),
  ];
  it.each(probes.map((p, n) => [n, p] as const))("probe %i never claims receiving", (_n, p) => {
    const a = nextActionModel(p);
    expect(`${a.title} ${a.detail}`.toLowerCase()).not.toContain("receiv");
  });
  it("STREAMING healthy is the only receiving claim, grounded in wire state", () => {
    const a = nextActionModel(baseModel({ source: "youtube", ytStatus: "STREAMING" }));
    expect(a.id).toBe("healthy-streaming");
  });
});

describe("UX-003 alert/next-action consistency", () => {
  it("shared conditions share stable ids and destinations", () => {
    const pairs: Array<[Partial<NextActionInput>, Partial<ShellAlertInput>, string]> = [
      [{ paused: true, queueSize: 100 }, { queueSize: 100, queueMax: 100 }, "queue-full"],
      [{ source: "youtube", ytStatus: "DISCONNECTED", ytError: "sidecar-unreachable" }, { source: "youtube", ytStatus: "DISCONNECTED", ytError: "sidecar-unreachable" }, "yt-sidecar-unreachable"],
      [{ source: "youtube", ytStatus: "ERROR" }, { source: "youtube", ytStatus: "ERROR", ytError: "x" }, "yt-error"],
      [{ paused: true }, { paused: true }, "runtime-paused"],
      [{ source: "youtube", ytStatus: "AUTH_REQUIRED" }, { source: "youtube", ytStatus: "AUTH_REQUIRED" }, "yt-auth-required"],
      [{ source: "youtube", ytStatus: "RECONNECTING" }, { source: "youtube", ytStatus: "RECONNECTING", reconnects: 2 }, "yt-reconnecting"],
      [{ source: "youtube", ytStatus: "DISCONNECTED" }, { source: "youtube", ytStatus: "DISCONNECTED" }, "yt-disconnected"],
      [{ source: "youtube", ytStatus: "STREAM_ENDED" }, { source: "youtube", ytStatus: "STREAM_ENDED" }, "yt-stream-ended"],
      [{ ledgerOverflow: true }, { ledgerOverflow: true, ledgerTotal: 250, ledgerBound: 200 }, "ledger-overflow"],
    ];
    for (const [modelOver, alertOver, id] of pairs) {
      const a = nextActionModel(baseModel(modelOver));
      const alerts = computeAlerts({
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
        ...alertOver,
      });
      const match = alerts.find((x) => x.id === id);
      expect(a.id).toBe(id);
      expect(match).toBeDefined();
      expect(a.href).toBe(match!.href);
    }
  });
});

// ---------------------------------------------------------------------------
// Summary-line helpers.
// ---------------------------------------------------------------------------

describe("UX-003 summary helpers", () => {
  it("queueLine distinguishes queued from processed", () => {
    expect(queueLine(0, 100)).toContain("empty");
    expect(queueLine(3, 100)).toContain("3/100");
    expect(queueLine(3, 100)).toContain("not yet");
    expect(queueLine(3, 0)).toContain("awaiting processing");
  });
  it("paidLine mirrors the ledger census without implying queued work", () => {
    expect(paidLine(0, 0, 0)).toContain("No paid events");
    expect(paidLine(2, 1, 1)).toContain("2 applied");
    expect(paidLine(2, 1, 1)).toContain("shaped the world");
  });
  it("voteLine covers absent/open/closing/closed/winner/invalid", () => {
    const v = { prompt: "Which road?", totalBallots: 4, commandsProcessed: 6, maxCommands: 10, closingSoon: false, winnerLabel: null };
    expect(voteLine({ ...v, phase: "none" })).toBe("No vote running.");
    expect(voteLine({ ...v, phase: "bogus" })).toBe("No vote running.");
    expect(voteLine({ ...v, phase: "open" })).toContain("Open");
    expect(voteLine({ ...v, phase: "open" })).toContain("4 voice(s)");
    expect(voteLine({ ...v, phase: "open", closingSoon: true })).toContain("closing soon");
    expect(voteLine({ ...v, phase: "closed", winnerLabel: "Parley" })).toContain("Parley");
    expect(voteLine({ ...v, phase: "closed", winnerLabel: null })).toContain("no winner");
  });
  it("persistLine never reports failure (file/browser-only/unknown only)", () => {
    expect(persistLine("file")).toContain("data/world-state.json");
    expect(persistLine("local")).toContain("browser only");
    expect(persistLine("local").toLowerCase()).not.toContain("fail");
    expect(persistLine("local").toLowerCase()).not.toContain("error");
    expect(persistLine("none")).toContain("nothing saved");
    expect(persistLine("weird")).toContain("nothing saved");
  });
  it("meterAria maps ranges and clamps bad input", () => {
    expect(meterAria(4, 10)).toEqual({ min: 0, max: 10, now: 4 });
    expect(meterAria(99, 10)).toEqual({ min: 0, max: 10, now: 10 });
    expect(meterAria(-3, 10).now).toBe(0);
    expect(meterAria(NaN, 10).now).toBe(0);
    expect(meterAria(3, 0)).toEqual({ min: 0, max: 0, now: 0 });
  });
  it("section/severity labels are text (never color-alone)", () => {
    expect(sectionLabel("#control")).toBe("Control Room");
    expect(sectionLabel("#activity")).toBe("Activity");
    expect(sectionLabel("#settings")).toBe("Settings");
    expect(sectionLabel("#overview")).toBe("Overview");
    expect(severityLabel("urgent")).toBe("Urgent");
    expect(severityLabel("attention")).toBe("Attention");
    expect(severityLabel("info")).toBe("All clear");
  });
});

// ---------------------------------------------------------------------------
// Markup audit: new Overview nodes, moved legacy nodes, no new live regions.
// ---------------------------------------------------------------------------

const OV_IDS = [
  "ov-next-card", "ov-next-title", "ov-next-detail", "ov-next-link",
  "ov-persist", "ov-yt-state", "ov-yt-note", "ov-vote-line",
  "ov-queue-line", "ov-paid-line", "ov-deeds-preview", "ov-feed-preview",
  "ov-act-h", "ov-next-h", "ov-session-h", "ov-yt-h", "ov-world-h", "ov-vote-h",
  "cc-m1-bar", "cc-m2-bar", "cc-vote-card",
];

describe("UX-003 overview markup audit", () => {
  it.each(OV_IDS)("overview #%s present exactly once", (id) => {
    expect(countId(INDEX_HTML, id)).toBe(1);
  });

  it("moved legacy nodes now live inside #view-overview", () => {
    const start = INDEX_HTML.indexOf('id="view-overview"');
    const end = INDEX_HTML.indexOf('id="view-control"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    for (const id of ["game", "cc-moment", "cc-objective", "cc-vex", "cc-arc", "cc-chapter", "cc-threat", "cc-resolve", "cc-supplies", "cc-location", "cc-standing", "cc-m1", "cc-m2"]) {
      const at = INDEX_HTML.indexOf(`id="${id}"`);
      expect(at).toBeGreaterThan(start);
      expect(at).toBeLessThan(end);
    }
  });

  it("no duplicate id attributes anywhere in the dashboard", () => {
    const ids = [...INDEX_HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only pre-existing live regions remain (no 1s announcer added)", () => {
    const region = INDEX_HTML.slice(
      INDEX_HTML.indexOf('id="view-overview"'),
      INDEX_HTML.indexOf('id="view-control"'),
    );
    // Pre-existing survivors: story hero and world card (vote/rites cards
    // moved to the Control Room with their live regions). Nothing new may
    // announce every poll.
    expect(region.match(/aria-live=/g)).toHaveLength(2);
    for (const card of ["ov-next-card", "ov-act-h", "ov-session-h", "ov-yt-h", "ov-vote-h"]) {
      const at = region.indexOf(`id="${card}"`);
      const window = region.slice(Math.max(0, at - 200), at);
      expect(window).not.toContain("aria-live");
    }
  });

  it("meter bars carry accessible ranges; vote clock keeps valuemin", () => {
    expect(INDEX_HTML).toContain('id="cc-m1-bar" role="progressbar"');
    expect(INDEX_HTML).toContain('aria-valuemax="10"');
    expect(INDEX_HTML).toContain('aria-valuemax="5"');
    expect(APP_TS).toContain('aria-valuemin="0" aria-valuenow=');
  });

  it("overview cross-links resolve to real anchors", () => {
    expect(INDEX_HTML).toContain('href="#activity"');
    expect(INDEX_HTML).toContain('href="#settings"');
    expect(INDEX_HTML).toContain('href="#control"');
    expect(countId(INDEX_HTML, "cc-vote-card")).toBe(1);
  });

  it("mobile keeps next-action + preview on top without horizontal overflow", () => {
    expect(INDEX_HTML).toContain(".ov-primary, .ov-secondary { display: contents; }");
    expect(INDEX_HTML).toContain(".ov-next { order: -3; }");
    expect(INDEX_HTML).toContain("minmax(0, 1fr)");
  });
});

// ---------------------------------------------------------------------------
// Regression: controls intact, module isolation, persistence threading.
// ---------------------------------------------------------------------------

const CONTROL_IDS = [
  "btn-pause", "btn-resume", "btn-open-v1", "btn-open-v2", "btn-close-vote",
  "btn-override-0", "btn-override-1", "btn-override-2",
  "btn-rite-sable", "btn-rite-tide", "btn-rite-ilya", "btn-rite-rekindle", "btn-rite-rho",
  "btn-command", "btn-paid", "btn-end-stream", "btn-save", "btn-reload", "btn-export", "btn-reset",
  "btn-yt-auth", "btn-yt-connect", "btn-yt-disconnect",
  "viewer-name", "viewer-id", "command", "paid-preset", "paid-custom", "src-sim", "src-yt",
];

describe("UX-003 regression audit", () => {
  it.each(CONTROL_IDS)("control #%s still wired in app.ts", (id) => {
    expect(APP_TS).toContain(`$("${id}")`);
  });

  it("overview module has zero imports (isolation preserved)", () => {
    const imports = [...OVERVIEW_TS.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual([]);
    expect(OVERVIEW_TS).not.toContain("document");
    expect(OVERVIEW_TS).not.toContain("window");
  });

  it("persistence signal threaded without changing save semantics", () => {
    // T4F-C1 migration: saves are written by the authority server (file
    // only); the dashboard feeds the same honest file/local/none mapping
    // from the control plane (`persist.from`) through setPersistFrom.
    // The presentation mapping itself is untouched.
    expect(APP_TS).toContain("setPersistFrom(");
    expect(APP_TS).toContain("persistLine(persistFrom)");
    expect(APP_TS).not.toContain("localStorage.setItem");
  });

  it("exactly one Phaser initialization; overlay entry untouched", () => {
    // T4F-C1 migration: the single console-preview game lives in the
    // dashboard boot entry (src/main.ts). Still exactly one.
    expect((APP_TS.match(/new Phaser\.Game\(\{/g) ?? []).length).toBe(0);
    expect((MAIN_TS.match(/new Phaser\.Game\(\{/g) ?? []).length).toBe(1);
    expect(APP_TS).toContain("persistFrom");
  });

  it("operating controls live in Control Room or Settings (Overview read-only)", () => {
    const ovStart = INDEX_HTML.indexOf('id="view-overview"');
    const crStart = INDEX_HTML.indexOf('id="view-control"');
    const crEnd = INDEX_HTML.indexOf('id="view-activity"');
    const stStart = INDEX_HTML.indexOf('id="view-settings"');
    // Readout nodes stay in Overview (cc-vote moved with its card)…
    for (const id of ["cc-moment", "cc-arc", "cc-threat", "ov-vote-line", "story-log", "queue-list"]) {
      const at = INDEX_HTML.indexOf(`id="${id}"`);
      expect(at).toBeGreaterThan(ovStart);
      expect(at).toBeLessThan(crStart);
    }
    // …session/vote/rite/stream controls moved into the Control Room region.
    for (const id of [
      "btn-pause", "btn-resume", "btn-open-v1", "btn-open-v2", "btn-close-vote",
      "btn-override-0", "btn-override-1", "btn-override-2",
      "btn-rite-sable", "btn-rite-tide", "btn-rite-ilya", "btn-rite-rekindle", "btn-rite-rho",
      "btn-end-stream", "btn-reset",
    ]) {
      const at = INDEX_HTML.indexOf(`id="${id}"`);
      expect(at).toBeGreaterThan(crStart);
      expect(at).toBeLessThan(crEnd);
    }
    // …and rehearsal/persistence/transport controls into Settings (UX-006).
    for (const id of [
      "viewer-name", "viewer-id", "command", "btn-command",
      "paid-preset", "paid-custom", "btn-paid", "outcome",
      "btn-save", "btn-reload", "btn-export",
      "btn-yt-auth", "btn-yt-connect", "btn-yt-disconnect", "src-sim", "src-yt",
      "yt-note", "yt-detail",
    ]) {
      const at = INDEX_HTML.indexOf(`id="${id}"`);
      expect(at).toBeGreaterThan(stStart);
    }
    // Activity section holds no operating buttons.
    {
      const at = INDEX_HTML.indexOf('id="view-activity"');
      const region = INDEX_HTML.slice(at, at + 2000);
      expect(region).not.toContain('id="btn-');
    }
  });
});
