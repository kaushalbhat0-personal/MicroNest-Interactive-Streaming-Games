/**
 * UX-007A — final hardening: dead CSS, navigation, consistency, perf, copy.
 * Static audits: no Phaser, no DOM, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const INDEX_HTML = readFileSync(join(ROOT, "index.html"), "utf8");
const APP_TS = readFileSync(join(ROOT, "src", "app.ts"), "utf8");
const MAIN_TS = readFileSync(join(ROOT, "src", "main.ts"), "utf8");
const DOC = readFileSync(join(ROOT, "docs", "dashboard.md"), "utf8");

const STYLE = INDEX_HTML.slice(INDEX_HTML.indexOf("<style>"), INDEX_HTML.indexOf("</style>"));

// ---------------------------------------------------------------------------
// Dead CSS audit: every removal below was verified against static markup,
// JS-emitted markup (app.ts/shell.ts template strings), and class toggles.
// ---------------------------------------------------------------------------

describe("UX-007A dead CSS removals", () => {
  it.each([
    [".cc-ops", "operator rail aside removed in UX-004"],
    [".cc-strip", "two-card strip dissolved in UX-003"],
    [".cc-group", "keeper-actions group label removed in UX-004"],
    [".cc-chips", "header chips moved into cards in UX-003"],
    [".tb-view-note", "last placeholder card replaced in UX-006"],
    [".yt-block", "overview connection drawer removed in UX-006"],
    [".yt-label", "overview connection drawer removed in UX-006"],
    [".cc-top button", "header buttons moved to Control Room in UX-004"],
    [".cc-where .big", "arc/chapter spans moved to Session card in UX-003"],
  ])("%s is gone (%s)", (selector) => {
    expect(STYLE).not.toContain(selector);
  });

  it("live selectors survived the sweep", () => {
    for (const sel of [
      ".cc-top", ".cc-where", ".cc-layout", ".cc-stage", ".cc-logs", ".cc-second",
      ".meterbar", ".btn-row", ".vote-opt", ".rite-desc", ".needs", "pre.log",
      ".src-toggle", "#yt-note", "#yt-status", "#outcome", "#cc-commands",
      ".tb-sticky", ".tb-rail", ".tb-tabs", ".tb-alert", ".ov-detail",
      ".ov-grid", ".cr-grid", ".ac-grid", ".st-grid", "#cr-confirm",
    ]) {
      expect(STYLE).toContain(sel);
    }
  });

  it("no placeholder section or milestone scaffolding remains", () => {
    expect(INDEX_HTML).not.toContain("Upcoming in a later milestone");
    expect(INDEX_HTML).not.toContain("tb-view-note");
    expect(INDEX_HTML).not.toContain("later milestones");
  });
});

// ---------------------------------------------------------------------------
// Cross-section navigation: every static target resolves; labels are honest.
// ---------------------------------------------------------------------------

describe("UX-007A navigation audit", () => {
  it("every internal link target exists", () => {
    const hrefs = [...INDEX_HTML.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of new Set(hrefs)) {
      if (h === "overview" || h === "control" || h === "activity" || h === "settings") {
        expect(INDEX_HTML).toContain(`id="view-${h}"`);
      } else {
        expect(INDEX_HTML).toContain(`id="${h}"`);
      }
    }
  });

  it("rail, tabs, and cross-links name real destinations only", () => {
    for (const label of ["Control Room", "Full activity", "Connection settings"]) {
      expect(INDEX_HTML).toContain(label);
    }
    // Alert "Go to …" links render dynamically from the same four hashes.
    const shell = readFileSync(join(ROOT, "src", "dashboard", "shell.ts"), "utf8");
    expect(shell).toContain("Go to ${");
    expect(INDEX_HTML).not.toMatch(/href="#(cc-vote-card|overview\/)/);
  });

  it("section taglines match current contents", () => {
    expect(INDEX_HTML).toContain("Control Room<span>Session, votes, rites</span>");
    expect(INDEX_HTML).toContain("Settings<span>Connection, rehearsal, saves</span>");
    expect(INDEX_HTML).toContain("Activity<span>Commands, events, diagnostics</span>");
  });
});

// ---------------------------------------------------------------------------
// Design-system consistency: shared values, one breakpoint, one focus style.
// ---------------------------------------------------------------------------

describe("UX-007A design consistency", () => {
  it("overview/activity/settings grids share one geometry", () => {
    const grids = STYLE.match(/grid-template-columns: minmax\(0, 1fr\) 360px;/g) ?? [];
    expect(grids).toHaveLength(3);
  });

  it("single card surface, radius, and gold focus treatment", () => {
    expect(STYLE).toContain(
      ".card { background: #171228; border: 1px solid var(--tb-line); border-radius: 12px;",
    );
    expect(STYLE.match(/outline: 3px solid var\(--tb-gold\); outline-offset: 2px;/g)!.length).toBeGreaterThanOrEqual(5);
  });

  it("one responsive breakpoint (1100px) across base and sections", () => {
    expect(STYLE).not.toContain("1099px");
    expect(STYLE).not.toContain("1101px");
    expect(STYLE).toContain("@media (max-width: 1100px)");
    expect(STYLE).toContain("@media (min-width: 1100px)");
  });
});

// ---------------------------------------------------------------------------
// Render performance: cached query, unchanged lifecycle, honest costs.
// ---------------------------------------------------------------------------

describe("UX-007A render performance", () => {
  it("desktop media query is cached, not rebuilt per render", () => {
    expect(APP_TS).toContain("let desktopQuery: MediaQueryList | null = null;");
    expect((APP_TS.match(/window\.matchMedia\("\(min-width: 1100px\)"\)/g) ?? []).length).toBe(1);
    expect(APP_TS).toContain("desktopQuery?.matches");
  });

  it("sticky offset still tracks the banner with change-gated writes", () => {
    expect(APP_TS).toContain("sticky.offsetHeight + 12");
    expect(APP_TS).toContain("if (want !== lastGameTop)");
  });

  it("one panel interval, one Phaser init, no new dependencies", () => {
    // T4F-C1 migration: pump + canvas sync moved server-side; app.ts keeps
    // the single panel refresh, src/main.ts owns the single preview game.
    expect((APP_TS.match(/setInterval\(/g) ?? []).length).toBe(1);
    expect((APP_TS.match(/new Phaser\.Game\(\{/g) ?? []).length).toBe(0);
    expect((MAIN_TS.match(/new Phaser\.Game\(\{/g) ?? []).length).toBe(1);
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    // D1-C authorizes exactly one server-only dependency: pg (see activity audit).
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["pg", "phaser"]);
  });
});

// ---------------------------------------------------------------------------
// Empty-state and copy consistency.
// ---------------------------------------------------------------------------

describe("UX-007A copy audit", () => {
  it("queue empty copy is consistent across legacy and activity views", () => {
    expect(APP_TS.match(/Queue empty — the world is caught up\./g)).toHaveLength(2);
    expect(APP_TS).not.toContain('"Queue empty"');
    expect(INDEX_HTML).not.toContain("(empty)");
  });

  it("no receiving claims, backups, or healthy-unknowns in static copy", () => {
    expect(INDEX_HTML).not.toMatch(/receiving/i);
    expect(INDEX_HTML.toLowerCase()).not.toContain("backup");
    expect(INDEX_HTML).not.toContain("(empty)");
  });

  it("documentation covers the required architecture topics", () => {
    for (const heading of [
      "Information architecture",
      "Dashboard modules",
      "State and data flow",
      "Polling lifecycle",
      "Isolation boundaries",
      "Legacy ID preservation",
      "Known limitations",
      "Browser verification remaining",
    ]) {
      expect(DOC).toContain(heading);
    }
    expect(DOC).not.toMatch(/verified in a browser|tested in Chrome|manual browser (test|pass) complete/i);
  });
});
