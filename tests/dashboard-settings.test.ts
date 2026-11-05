/**
 * UX-006 — Settings workspace: stepper, recovery, rehearsal/persistence
 * relocation, OBS config, markup + wiring audits.
 * Static + pure logic: no Phaser, no DOM, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OBS_HEIGHT,
  OBS_ROUTE,
  OBS_WIDTH,
  connectionSteps,
  obsConfig,
  persistStateLine,
  recoverySteps,
  sourceLine,
  stepLabel,
} from "../src/dashboard/settings";

const ROOT = join(__dirname, "..");
const INDEX_HTML = readFileSync(join(ROOT, "index.html"), "utf8");
const APP_TS = readFileSync(join(ROOT, "src", "app.ts"), "utf8");
const MAIN_TS = readFileSync(join(ROOT, "src", "main.ts"), "utf8");
const SETTINGS_TS = readFileSync(join(ROOT, "src", "dashboard", "settings.ts"), "utf8");
const PACKAGE_JSON = readFileSync(join(ROOT, "package.json"), "utf8");

function countId(html: string, id: string): number {
  return html.split(`id="${id}"`).length - 1;
}

function settingsRegion(): string {
  return INDEX_HTML.slice(INDEX_HTML.indexOf('id="view-settings"'));
}

// ---------------------------------------------------------------------------
// Connection stepper: every wire status, fail-closed verify.
// ---------------------------------------------------------------------------

describe("UX-006 connection stepper", () => {
  it("simulation source leaves every step to-do", () => {
    for (const ytStatus of ["off", "DISCONNECTED", "STREAMING", "ERROR"]) {
      expect(connectionSteps({ source: "simulation", ytStatus })).toEqual({
        authorize: "todo",
        connect: "todo",
        verify: "todo",
      });
    }
  });

  it.each([
    ["AUTH_REQUIRED", { authorize: "current", connect: "todo", verify: "todo" }],
    ["LIVE_CHAT_FOUND", { authorize: "done", connect: "done", verify: "current" }],
    ["STREAMING", { authorize: "done", connect: "done", verify: "done" }],
    ["STREAM_ENDED", { authorize: "done", connect: "done", verify: "todo" }],
    ["RECONNECTING", { authorize: "done", connect: "current", verify: "todo" }],
    ["ERROR", { authorize: "current", connect: "current", verify: "todo" }],
    ["off", { authorize: "current", connect: "todo", verify: "todo" }],
    ["DISCONNECTED", { authorize: "current", connect: "todo", verify: "todo" }],
    ["CONNECTING", { authorize: "current", connect: "current", verify: "todo" }],
    ["CONNECTED", { authorize: "done", connect: "current", verify: "todo" }],
    ["SOME_FUTURE_STATE", { authorize: "current", connect: "todo", verify: "todo" }],
  ])("youtube %s maps honestly", (ytStatus, expected) => {
    expect(connectionSteps({ source: "youtube", ytStatus })).toEqual(expected);
  });

  it("explicit auth flag is honored without weakening implied states", () => {
    expect(
      connectionSteps({ source: "youtube", ytStatus: "DISCONNECTED", authenticated: true }),
    ).toEqual({ authorize: "done", connect: "current", verify: "todo" });
    expect(
      connectionSteps({ source: "youtube", ytStatus: "STREAMING", authenticated: false }),
    ).toEqual({ authorize: "done", connect: "done", verify: "done" });
  });

  it("verify is done only on actual chat reception — never otherwise", () => {
    const statuses = ["off", "DISCONNECTED", "CONNECTING", "AUTH_REQUIRED", "CONNECTED", "LIVE_CHAT_FOUND", "RECONNECTING", "STREAM_ENDED", "ERROR", "WEIRD"];
    for (const ytStatus of statuses) {
      expect(connectionSteps({ source: "youtube", ytStatus }).verify).not.toBe("done");
    }
    expect(connectionSteps({ source: "youtube", ytStatus: "STREAMING" }).verify).toBe("done");
    expect(connectionSteps({ source: "simulation", ytStatus: "STREAMING" }).verify).toBe("todo");
  });

  it("step labels are text, never color-alone", () => {
    expect(stepLabel("done")).toBe("Done");
    expect(stepLabel("current")).toBe("Current step");
    expect(stepLabel("todo")).toBe("To do");
  });
});

// ---------------------------------------------------------------------------
// Recovery guidance: grounded instructions only.
// ---------------------------------------------------------------------------

describe("UX-006 recovery guidance", () => {
  it("simulation source points at source selection", () => {
    expect(recoverySteps({ source: "simulation", ytStatus: "off" })).toEqual([
      "Select YouTube Live as the input source above to begin setup.",
    ]);
  });

  it("sidecar-unreachable names the verified npm command", () => {
    const rec = recoverySteps({ source: "youtube", ytStatus: "DISCONNECTED", ytError: "sidecar-unreachable" });
    expect(rec.join("\n")).toContain("npm run youtube-server");
    expect(rec.join("\n")).toContain("2 · Connect to live chat");
  });

  it("auth recovery matches the popup handler (incl. popup-blocker fallback)", () => {
    const rec = recoverySteps({ source: "youtube", ytStatus: "AUTH_REQUIRED" }).join("\n");
    expect(rec).toContain("1 · Authorize with Google");
    expect(rec).toContain("popup");
    expect(rec).toContain("2 · Connect to live chat");
  });

  it("streaming needs no recovery; ended/reconnecting/error guide plainly", () => {
    expect(recoverySteps({ source: "youtube", ytStatus: "STREAMING" }).join(" ")).toContain("no recovery needed");
    expect(recoverySteps({ source: "youtube", ytStatus: "STREAM_ENDED" }).join(" ")).toContain("Disconnect");
    expect(recoverySteps({ source: "youtube", ytStatus: "RECONNECTING" }).join(" ").length).toBeGreaterThan(0);
    expect(
      recoverySteps({ source: "youtube", ytStatus: "ERROR", ytError: "quota-exceeded" }).join(" "),
    ).toContain("quota-exceeded");
  });

  it("no invented commands, URLs, or thresholds in any guidance", () => {
    const statuses = ["off", "DISCONNECTED", "CONNECTING", "AUTH_REQUIRED", "CONNECTED", "LIVE_CHAT_FOUND", "STREAMING", "RECONNECTING", "STREAM_ENDED", "ERROR", "WEIRD"];
    const all = statuses
      .flatMap((ytStatus) => recoverySteps({ source: "youtube", ytStatus, ytError: "x" }))
      .join("\n")
      .toLowerCase();
    expect(all).not.toMatch(/https?:\/\//);
    expect(all).not.toContain("localhost:300");
    expect(all).not.toMatch(/npm run (?!youtube-server|persist-server)\S/);
  });

  it("recovery complements — never duplicates — the alert banner", () => {
    expect(APP_TS).toContain("recoverySteps({");
    // Banner ownership stays in shell.ts; settings renders guidance only.
    expect(SETTINGS_TS).not.toContain("computeAlerts");
    expect(SETTINGS_TS).not.toContain("role=\"alert\"");
  });
});

// ---------------------------------------------------------------------------
// Rehearsal + persistence relocation; Reset stays in Control Room.
// ---------------------------------------------------------------------------

describe("UX-006 relocation", () => {
  it("rehearsal + persistence + transport live in Settings exactly once", () => {
    const st = settingsRegion();
    for (const id of [
      "src-sim", "src-yt", "btn-yt-auth", "btn-yt-connect", "btn-yt-disconnect", "yt-note", "yt-detail",
      "viewer-name", "viewer-id", "command", "btn-command",
      "paid-preset", "paid-custom", "btn-paid", "outcome",
      "btn-save", "btn-reload", "btn-export",
    ]) {
      expect(countId(INDEX_HTML, id)).toBe(1);
      expect(st).toContain(`id="${id}"`);
    }
  });

  it("Reset stays in the Control Room danger zone (never Settings)", () => {
    const cr = INDEX_HTML.slice(INDEX_HTML.indexOf('id="view-control"'), INDEX_HTML.indexOf('id="view-activity"'));
    expect(cr).toContain('id="btn-reset"');
    expect(settingsRegion()).not.toContain('id="btn-reset"');
  });

  it("original handler payloads preserved after the move", () => {
    for (const sig of [
      "rt.yt.start()", "rt.yt.stop()", "rt.yt.authUrl()", "await rt.yt.connect()", "await rt.yt.disconnectServer()",
      "rt.sendCommand(id, name, cmd)", 'rt.sendPaid(id, name, Math.round(major * 100), "INR")',
      // T4F-C1 migration: persistence moved server-side. The dashboard no
      // longer writes saves itself (`store.save` owned by the authority);
      // it feeds the honest file/local/none mapping from the control plane
      // through setPersistFrom (server reports `persist.from`).
      "setPersistFrom(", "rt.store.exportFile(rt.engine.world)",
    ]) {
      expect(APP_TS).toContain(sig);
    }
  });

  it("source radios keep existing handlers (no new switching mechanism)", () => {
    expect(APP_TS).toContain("if (srcSim.checked) rt.yt.stop();");
    expect(APP_TS).toContain("if (srcYt.checked) useYouTube();");
    expect(APP_TS.match(/\.onchange =/g)!.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Persistence presentation.
// ---------------------------------------------------------------------------

describe("UX-006 persistence presentation", () => {
  it("file/local/none/unknown map honestly without failure claims", () => {
    expect(persistStateLine("file")).toEqual({
      line: "Saves: file · data/world-state.json via the persist server.",
      tone: "ok",
    });
    const local = persistStateLine("local");
    expect(local.tone).toBe("info");
    expect(local.line).toContain("npm run persist-server");
    expect(local.line.toLowerCase()).not.toContain("fail");
    expect(persistStateLine("none").tone).toBe("unknown");
    expect(persistStateLine("weird").tone).toBe("unknown");
  });

  it("reload/export labels describe verified behavior; export is no backup", () => {
    expect(INDEX_HTML).toContain("no in-app restore");
    expect(INDEX_HTML).toContain("unsaved changes are lost");
    expect(INDEX_HTML.toLowerCase()).not.toContain("backup");
  });
});

// ---------------------------------------------------------------------------
// OBS configuration: grounded route, dimensions, honest copy.
// ---------------------------------------------------------------------------

describe("UX-006 OBS configuration", () => {
  it("route and dimensions match the built overlay", () => {
    expect(OBS_ROUTE).toBe("/overlay.html");
    expect(OBS_WIDTH).toBe(1920);
    expect(OBS_HEIGHT).toBe(1080);
    expect(obsConfig("http://localhost:5173")).toEqual({
      url: "http://localhost:5173/overlay.html",
      width: 1920,
      height: 1080,
    });
    expect(obsConfig("https://example.com/")).toEqual({
      url: "https://example.com/overlay.html",
      width: 1920,
      height: 1080,
    });
  });

  it("unsafe origins yield no URL plus manual guidance (never invented)", () => {
    expect(obsConfig("").url).toBe("");
    expect(obsConfig("not-a-url").url).toBe("");
    expect(obsConfig("file:///x").url).toBe("");
  });

  it("no secrets, tokens, or private identifiers in OBS markup or model", () => {
    const card = INDEX_HTML.slice(INDEX_HTML.indexOf('id="st-obs-h"'), INDEX_HTML.indexOf('id="st-diag-h"'));
    expect(card).not.toMatch(/token=|secret=|client_id=|password|Bearer |private[_-]?key/i);
    expect(SETTINGS_TS).not.toMatch(/AIza|ya29|Bearer |\.pem|client_id\s*=/);
    expect(SETTINGS_TS).not.toContain("localStorage");
    expect(countId(INDEX_HTML, "st-obs-url")).toBe(1);
    expect(countId(INDEX_HTML, "st-obs-copy")).toBe(1);
    expect(countId(INDEX_HTML, "st-obs-done")).toBe(1);
    expect(INDEX_HTML).toContain('id="st-obs-url" readonly');
    expect(INDEX_HTML).toContain('id="st-obs-done" role="status"');
  });

  it("copy handler reports real outcomes only (no invented async success)", () => {
    expect(APP_TS).toContain("st-obs-copy");
    expect(APP_TS).toContain("Copied to clipboard.");
    expect(APP_TS).toContain("Copy unavailable here");
    expect(APP_TS).toContain("Copy failed");
    expect(APP_TS).toContain("clipboard");
  });
});

// ---------------------------------------------------------------------------
// Markup + architecture audits.
// ---------------------------------------------------------------------------

const ST_IDS = [
  "st-source-h", "st-source-line", "st-connect-h", "st-steps",
  "st-step-authorize", "st-step-connect", "st-step-verify",
  "st-recovery", "st-persist-h", "st-persist",
  "st-obs-h", "st-obs-url", "st-obs-copy", "st-obs-done",
  "st-diag-h",
];

describe("UX-006 settings markup audit", () => {
  it.each(ST_IDS)("settings #%s present exactly once", (id) => {
    expect(countId(INDEX_HTML, id)).toBe(1);
  });

  it("stepper is an ordered list with text states (not color-alone)", () => {
    expect(INDEX_HTML).toContain('<ol class="st-steps" id="st-steps">');
    expect(INDEX_HTML).toContain('data-step="authorize"');
    expect(INDEX_HTML).toContain('data-step="connect"');
    expect(INDEX_HTML).toContain('data-step="verify"');
  });

  it("source radios keep a labelled group; diagnostics stay advanced", () => {
    expect(INDEX_HTML).toContain('role="radiogroup" aria-label="Input source"');
    expect(INDEX_HTML).toContain("Connection diagnostics · advanced");
  });

  it("no duplicate id attributes anywhere in the dashboard", () => {
    const ids = [...INDEX_HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("mobile stacks without horizontal overflow", () => {
    expect(INDEX_HTML).toContain(".st-main, .st-side { display: contents; }");
  });
});

describe("UX-006 architecture audit", () => {
  it("settings module has zero imports and no DOM access (isolation preserved)", () => {
    const imports = [...SETTINGS_TS.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual([]);
    expect(SETTINGS_TS).not.toContain("document");
    expect(SETTINGS_TS).not.toContain("window");
    expect(SETTINGS_TS).not.toContain("fetch(");
  });

  it("no new polling loop, transport listener, or backend call", () => {
    // T4F-C1 migration: simulation pump + canvas sync left app.ts for the
    // authority server; the dashboard boot entry owns the single preview
    // game. app.ts keeps exactly the panel refresh — same audit shape.
    expect((APP_TS.match(/setInterval\(/g) ?? []).length).toBe(1);
    expect((APP_TS.match(/new Phaser\.Game\(\{/g) ?? []).length).toBe(0);
    expect((MAIN_TS.match(/new Phaser\.Game\(\{/g) ?? []).length).toBe(1);
    const pkg = JSON.parse(PACKAGE_JSON) as { dependencies?: Record<string, string> };
    // D1-C authorizes exactly one server-only dependency: pg (see activity audit).
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["pg", "phaser"]);
  });

  it("source selection text is creator-friendly, not architectural", () => {
    expect(sourceLine("simulation")).toContain("Simulation");
    expect(sourceLine("youtube")).toContain("YouTube Live");
    expect(INDEX_HTML).toContain("nothing leaves this browser");
  });
});
