/**
 * UX-004 — Control Room: availability models, dialog copy, markup + wiring.
 * Static + pure logic: no Phaser, no DOM, no network. DOM behaviors
 * (open/cancel/confirm/escape/focus) are asserted via markup + wiring
 * patterns; runtime verification is on the manual checklist.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  endStreamCopy,
  overrideCopy,
  rehearsalAvailability,
  resetCopy,
  riteAvailability,
  riteRequirement,
  sessionAvailability,
  voteAvailability,
} from "../src/dashboard/control";

const ROOT = join(__dirname, "..");
const INDEX_HTML = readFileSync(join(ROOT, "index.html"), "utf8");
const APP_TS = readFileSync(join(ROOT, "src", "app.ts"), "utf8");
const MAIN_TS = readFileSync(join(ROOT, "src", "main.ts"), "utf8");
const CONTROL_TS = readFileSync(join(ROOT, "src", "dashboard", "control.ts"), "utf8");
const PACKAGE_JSON = readFileSync(join(ROOT, "package.json"), "utf8");

function countId(html: string, id: string): number {
  return html.split(`id="${id}"`).length - 1;
}

function overviewRegion(): string {
  return INDEX_HTML.slice(INDEX_HTML.indexOf('id="view-overview"'), INDEX_HTML.indexOf('id="view-control"'));
}

function controlRegion(): string {
  return INDEX_HTML.slice(INDEX_HTML.indexOf('id="view-control"'), INDEX_HTML.indexOf('id="view-activity"'));
}

// ---------------------------------------------------------------------------
// Session toggle.
// ---------------------------------------------------------------------------

describe("UX-004 session toggle model", () => {
  it("running shows Pause only; paused shows Resume only (never both)", () => {
    const run = sessionAvailability(false, 0);
    expect(run.showPause).toBe(true);
    expect(run.showResume).toBe(false);
    expect(run.stateLine).toContain("flowing");
    const paused = sessionAvailability(true, 4);
    expect(paused.showPause).toBe(false);
    expect(paused.showResume).toBe(true);
    expect(paused.stateLine).toContain("4");
    expect(sessionAvailability(true, 0).stateLine).toContain("held");
  });

  it("both original buttons stay mounted; visibility toggles in render", () => {
    expect(countId(INDEX_HTML, "btn-pause")).toBe(1);
    expect(countId(INDEX_HTML, "btn-resume")).toBe(1);
    expect(APP_TS).toContain("pauseBtn.hidden = !sav.showPause");
    expect(APP_TS).toContain("resumeBtn.hidden = !sav.showResume");
    expect(APP_TS).toContain("rt.pause()");
    expect(APP_TS).toContain("rt.resume()");
  });

  it("session card lives in the Control Room with its state line", () => {
    expect(controlRegion()).toContain('id="btn-pause"');
    expect(controlRegion()).toContain('id="btn-resume"');
    expect(countId(INDEX_HTML, "cr-session-state")).toBe(1);
    expect(controlRegion()).toContain('id="cr-session-state"');
  });
});

// ---------------------------------------------------------------------------
// Vote availability: mirrors lifecycle rejection reasons.
// ---------------------------------------------------------------------------

describe("UX-004 vote availability model", () => {
  it("opens require an open session and no running vote", () => {
    expect(voteAvailability({ votePhase: "none", sessionOpen: true, optionCount: 2 }).open).toEqual({
      available: true,
      reason: null,
    });
    expect(voteAvailability({ votePhase: "closed", sessionOpen: true, optionCount: 2 }).open.available).toBe(true);
    const busy = voteAvailability({ votePhase: "open", sessionOpen: true, optionCount: 2 }).open;
    expect(busy.available).toBe(false);
    expect(busy.reason).toContain("already open");
    const shut = voteAvailability({ votePhase: "none", sessionOpen: false, optionCount: 2 }).open;
    expect(shut.available).toBe(false);
    expect(shut.reason).toContain("not open");
  });

  it("close tracks none/open/closed", () => {
    expect(voteAvailability({ votePhase: "none", sessionOpen: true, optionCount: 0 }).close.reason).toContain(
      "No vote",
    );
    expect(voteAvailability({ votePhase: "open", sessionOpen: true, optionCount: 2 }).close).toEqual({
      available: true,
      reason: null,
    });
    expect(voteAvailability({ votePhase: "closed", sessionOpen: true, optionCount: 2 }).close.reason).toContain(
      "decided",
    );
  });

  it("overrides need an open vote and a valid option index", () => {
    const none = voteAvailability({ votePhase: "none", sessionOpen: true, optionCount: 0 }).overrides;
    expect(none.every((o) => !o.available)).toBe(true);
    expect(none[0].reason).toContain("open vote");
    const shut = voteAvailability({ votePhase: "closed", sessionOpen: true, optionCount: 2 }).overrides;
    expect(shut.every((o) => !o.available)).toBe(true);
    expect(shut[0].reason).toContain("decided");
    const two = voteAvailability({ votePhase: "open", sessionOpen: true, optionCount: 2 }).overrides;
    expect(two[0].available).toBe(true);
    expect(two[1].available).toBe(true);
    expect(two[2].available).toBe(false);
    expect(two[2].reason).toContain("only 2 options");
    const three = voteAvailability({ votePhase: "open", sessionOpen: true, optionCount: 3 }).overrides;
    expect(three.every((o) => o.available)).toBe(true);
  });

  it("unknown phases and counts fail closed", () => {
    const v = voteAvailability({ votePhase: "bogus", sessionOpen: true, optionCount: NaN });
    expect(v.close.available).toBe(false);
    expect(v.overrides.every((o) => !o.available)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rite availability: mirrors fireTemplate order (condition → repeat →
// supplies → resolve) over engine reads assembled by app.ts.
// ---------------------------------------------------------------------------

function riteBase(over: Record<string, unknown> = {}) {
  return {
    templateId: "tide-prayer",
    conditionOk: true,
    repeatOk: true,
    repeatKind: "endless",
    suppliesCost: 10,
    resolveCost: 0,
    resources: 30,
    resolve: 50,
    threatLevel: 70,
    kills: 0,
    beaconOil: 0,
    ...over,
  };
}

describe("UX-004 rite availability model", () => {
  it("unknown rite ids are never available", () => {
    expect(riteAvailability({ ...riteBase(), templateId: "nope" }).available).toBe(false);
    expect(riteRequirement("nope")).toBe("Unknown rite.");
  });

  it("condition failures cite grounded state, never invented rules", () => {
    expect(riteAvailability({ ...riteBase(), conditionOk: false }).reason).toContain("now 70");
    expect(
      riteAvailability({ ...riteBase(), templateId: "ilya-duel", conditionOk: false, kills: 1 }).reason,
    ).toContain("kills now 1");
    expect(
      riteAvailability({ ...riteBase(), templateId: "cinderholm-rekindle", conditionOk: false, beaconOil: 2 })
        .reason,
    ).toContain("oil now 2/5");
    expect(riteAvailability({ ...riteBase(), templateId: "sable-mending-rite", conditionOk: false }).reason).toContain(
      "Sable met",
    );
    expect(riteAvailability({ ...riteBase(), templateId: "rho-plain-speech", conditionOk: false }).reason).toContain(
      "Rho friendly",
    );
  });

  it("repeat blocks name their scope (once vs chapter)", () => {
    expect(riteAvailability({ ...riteBase(), repeatOk: false, repeatKind: "once" }).reason).toContain("once per world");
    expect(riteAvailability({ ...riteBase(), repeatOk: false, repeatKind: "perChapter" }).reason).toContain(
      "this chapter",
    );
  });

  it("cost blocks name the shortfall with live counts", () => {
    const s = riteAvailability({ ...riteBase(), resources: 4 });
    expect(s.available).toBe(false);
    expect(s.reason).toContain("have 4");
    const r = riteAvailability({
      ...riteBase(),
      templateId: "ilya-duel",
      suppliesCost: 0,
      resolveCost: 10,
      resolve: 6,
      conditionOk: true,
    });
    expect(r.reason).toContain("have 6");
  });

  it("eligible + affordable rites are available", () => {
    expect(riteAvailability(riteBase()).available).toBe(true);
  });

  it("every manual rite has a static requirement blurb", () => {
    for (const id of ["sable-mending-rite", "tide-prayer", "ilya-duel", "cinderholm-rekindle", "rho-plain-speech"]) {
      expect(riteRequirement(id).length).toBeGreaterThan(0);
    }
  });

  it("app assembles availability from engine reads (engine authoritative)", () => {
    expect(APP_TS).toContain("isEligibleTemplate(template, w)");
    expect(APP_TS).toContain("isRepeatEligible(template, w)");
    expect(APP_TS).toContain("riteAvailability({");
    expect(APP_TS).toContain('countOf("kills")');
    expect(APP_TS).toContain('countOf("meter.beacon-oil")');
  });
});

// ---------------------------------------------------------------------------
// Rehearsal gating: simulation-only, handlers untouched.
// ---------------------------------------------------------------------------

describe("UX-004 rehearsal gating model", () => {
  it("simulation enables with an active line; youtube disables with a reason", () => {
    const sim = rehearsalAvailability("simulation");
    expect(sim.enabled).toBe(true);
    expect(sim.reason).toBe(null);
    expect(sim.sourceLine).toContain("Simulation");
    const live = rehearsalAvailability("youtube");
    expect(live.enabled).toBe(false);
    expect(live.reason).toContain("simulation-only");
    expect(live.sourceLine).toContain("YouTube Live");
  });

  it("app gates inputs without touching handlers or the engine path", () => {
    expect(APP_TS).toContain("rehearsalAvailability(");
    expect(APP_TS).toContain("el.disabled = !rav.enabled");
    // Original payloads preserved byte-for-byte.
    expect(APP_TS).toContain("rt.sendCommand(id, name, cmd)");
    expect(APP_TS).toContain('rt.sendPaid(id, name, Math.round(major * 100), "INR")');
    // Rehearsal never reaches the YouTube transport.
    expect(APP_TS).not.toMatch(/btn-command[\s\S]{0,400}yt\.(connect|start)/);
    expect(APP_TS).not.toMatch(/btn-paid[\s\S]{0,400}yt\.(connect|start)/);
  });

  it("rehearsal controls + outcome moved together into Settings (UX-006)", () => {
    const st = INDEX_HTML.slice(INDEX_HTML.indexOf('id="view-settings"'));
    for (const id of ["viewer-name", "viewer-id", "command", "btn-command", "paid-preset", "paid-custom", "btn-paid", "outcome", "cr-source-line", "cr-rehearsal-why", "cr-rehearsal-h"]) {
      expect(countId(INDEX_HTML, id)).toBe(1);
      expect(st).toContain(`id="${id}"`);
    }
    expect(controlRegion()).not.toContain('id="btn-command"');
    expect(controlRegion()).not.toContain('id="btn-save"');
  });
});

// ---------------------------------------------------------------------------
// Destructive dialog copy: verified against handler behavior, no exaggeration.
// ---------------------------------------------------------------------------

describe("UX-004 confirmation copy", () => {
  it("end-stream copy matches close-then-reopen behavior", () => {
    const c = endStreamCopy();
    expect(c.body).toContain("persists");
    expect(c.body).toContain("fresh stream opens");
    expect(c.body.toLowerCase()).not.toContain("delet");
    expect(c.confirmLabel.length).toBeGreaterThan(0);
  });

  it("reset copy states genesis + overwrite + loss plainly", () => {
    const c = resetCopy();
    expect(c.body).toContain("genesis");
    expect(c.body).toContain("overwritten");
    expect(c.body).toContain("cannot be undone");
  });

  it("override copy names the bypass honestly", () => {
    const c = overrideCopy("Parley with Ilya");
    expect(c.title).toContain("Parley with Ilya");
    expect(c.body).toContain("bypassing");
    expect(c.body).toContain("auditable");
    expect(c.body).toContain("closes");
  });
});

describe("UX-004 dialog wiring", () => {
  it("single native dialog with labelled title/body/cancel/confirm", () => {
    expect(INDEX_HTML).toContain('<dialog id="cr-confirm" aria-labelledby="cr-confirm-title">');
    for (const id of ["cr-confirm", "cr-confirm-title", "cr-confirm-body", "cr-confirm-ok", "cr-confirm-cancel"]) {
      expect(countId(INDEX_HTML, id)).toBe(1);
    }
    expect(controlRegion().length).toBeGreaterThan(0);
  });

  it("explicit confirm only: single-run, open-guard, no backdrop confirm", () => {
    expect(APP_TS).toContain("if (dlg.open) return;");
    expect(APP_TS).toContain("pendingConfirm = null;\n      dlg.close(\"ok\");");
    expect(APP_TS).toContain("if (run) run();");
    expect(APP_TS).toContain("ev.target === dlg");
    expect(APP_TS).toContain('dlg.addEventListener("cancel"');
    expect(APP_TS).toContain("restoreConfirmFocus()");
  });

  it("native confirm() survives only as the missing-dialog fallback", () => {
    expect(APP_TS).toContain("if (confirm(`${copy.title}");
    expect(APP_TS).not.toContain('confirm("Close this stream?');
    expect(APP_TS).not.toContain('confirm("Reset Tidebound to its beginning?"');
  });

  it("override/end-stream/reset route through the dialog with original calls", () => {
    expect(APP_TS).toContain("askOverride(rt, 0, ev)");
    expect(APP_TS).toContain("openConfirm(overrideCopy(label)");
    expect(APP_TS).toContain("openConfirm(endStreamCopy()");
    expect(APP_TS).toContain("openConfirm(resetCopy()");
    expect(APP_TS).toContain("rt.overrideVote(optionIndex)");
    expect(APP_TS).toContain("rt.endStream()");
    expect(APP_TS).toContain("void rt.reset();");
  });
});

// ---------------------------------------------------------------------------
// Markup + architecture audits.
// ---------------------------------------------------------------------------

const CR_IDS = [
  "cr-session-state", "cr-vote-why", "cr-override-why",
  "cr-rite-sable-why", "cr-rite-tide-why", "cr-rite-ilya-why", "cr-rite-rekindle-why", "cr-rite-rho-why",
  "cr-session-h", "cr-vote-h", "cr-rites-h", "cr-danger-h",
  "cr-confirm", "cr-confirm-title", "cr-confirm-body", "cr-confirm-ok", "cr-confirm-cancel",
];

describe("UX-004 control-room markup audit", () => {
  it.each(CR_IDS)("control-room #%s present exactly once", (id) => {
    expect(countId(INDEX_HTML, id)).toBe(1);
  });

  it("no duplicate id attributes anywhere in the dashboard", () => {
    const ids = [...INDEX_HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Overview keeps zero operating buttons (all moved out by UX-006)", () => {
    const btns = [...overviewRegion().matchAll(/id="(btn-[^"]+)"/g)].map((m) => m[1]);
    // Session/vote/rite/rehearsal/persistence/transport controls now live in
    // Control Room and Settings; Overview is read-only mirrors + links.
    expect(btns).toEqual([]);
  });

  it("override is visually and semantically distinct from ordinary voting", () => {
    expect(INDEX_HTML).toContain('class="cr-override"');
    expect(INDEX_HTML).toContain("bypasses the audience vote");
    expect(INDEX_HTML).toContain("border: 1px dashed var(--tb-gold-deep)");
  });

  it("danger zone is separated at the bottom with destructive styling", () => {
    const cr = controlRegion();
    expect(cr).toContain('cr-danger');
    expect(cr.indexOf('id="cr-danger-h"')).toBeGreaterThan(cr.indexOf('id="btn-open-v1"'));
    expect(cr.indexOf('id="btn-end-stream"')).toBeGreaterThan(cr.indexOf('id="cr-danger-h"'));
    expect(cr.indexOf('id="btn-reset"')).toBeGreaterThan(cr.indexOf('id="cr-danger-h"'));
  });

  it("disabled reasons are adjacent and discoverable (describedby + live)", () => {
    expect(INDEX_HTML).toContain('aria-describedby="cr-vote-why"');
    expect(INDEX_HTML).toContain('aria-describedby="cr-override-why"');
    expect(INDEX_HTML).toContain('id="cr-vote-why" role="status"');
    expect(INDEX_HTML).toContain("button:disabled");
  });

  it("dialog is usable at 390px without new sticky conflicts", () => {
    expect(INDEX_HTML).toContain("width: min(480px, calc(100vw - 32px))");
    expect(INDEX_HTML).toContain("#cr-confirm::backdrop");
  });
});

describe("UX-004 architecture audit", () => {
  it("control module has zero imports and no DOM access (isolation preserved)", () => {
    const imports = [...CONTROL_TS.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual([]);
    expect(CONTROL_TS).not.toContain("document");
    expect(CONTROL_TS).not.toContain("window");
  });

  it("no new polling loop; single Phaser init; no new dependencies", () => {
    // T4F-C1 migration: simulation pump + canvas sync left app.ts for the
    // authority server; the single preview game lives in src/main.ts.
    // Same audit shape: one panel refresh in app.ts, one game in boot.
    expect((APP_TS.match(/setInterval\(/g) ?? []).length).toBe(1);
    expect((APP_TS.match(/new Phaser\.Game\(\{/g) ?? []).length).toBe(0);
    expect((MAIN_TS.match(/new Phaser\.Game\(\{/g) ?? []).length).toBe(1);
    const pkg = JSON.parse(PACKAGE_JSON) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["phaser"]);
  });

  it("original handler payloads preserved (meaning unchanged)", () => {
    for (const sig of [
      "rt.openRouteVote()", "rt.openKindlingVote()", "rt.closeActiveVote()",
      'rt.fireRite("sable-mending-rite")', 'rt.fireRite("tide-prayer")', 'rt.fireRite("ilya-duel")',
      'rt.fireRite("cinderholm-rekindle")', 'rt.fireRite("rho-plain-speech")',
      "rt.save()", "rt.reload()", "rt.store.exportFile(rt.engine.world)",
      "srcSim.checked", "srcYt.checked",
    ]) {
      expect(APP_TS).toContain(sig);
    }
  });
});
