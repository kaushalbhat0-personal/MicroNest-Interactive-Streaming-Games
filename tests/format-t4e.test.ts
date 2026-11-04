/**
 * T4E — format selection, OBS workspace, T4D-carryover fixes.
 * Pure helper tests + markup/architecture audits + HUD behavior.
 * Existing contracts (feed/banner) are spot-guarded, never altered here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMANDS, QUEUE } from "../src/engine/config";
import { GameEngine } from "../src/engine/engine";
import { tideboundGenesis, ROUTE_VOTE, TIDEBOUND_LIBRARY } from "../src/content/tidebound";
import { openSessionVote, openStream } from "../src/engine/lifecycle";
import type { GameResult } from "../src/engine/types";
import { renderOverlay } from "../src/presentation/hud";
import {
  aggregateFeedItems,
  bannerForResult,
  BANNER_PRIORITY,
  buildViewerFeedItem,
} from "../src/presentation/viewer-feed";
import {
  activeFormatLine,
  FORMAT_DIMS,
  getStoredFormat,
  overlayUrl,
  parseOverlayFormat,
  setStoredFormat,
  STORED_FORMAT_KEY,
} from "../src/dashboard/format";

const ROOT = join(__dirname, "..");
const INDEX_HTML = readFileSync(join(ROOT, "index.html"), "utf8");
const APP_TS = readFileSync(join(ROOT, "src", "app.ts"), "utf8");
const MAIN_TS = readFileSync(join(ROOT, "src", "main.ts"), "utf8");
const RENDERER_TS = readFileSync(join(ROOT, "src", "renderer", "renderer.ts"), "utf8");
const FORMAT_TS = readFileSync(join(ROOT, "src", "dashboard", "format.ts"), "utf8");
const TIDEBOUND_CSS = readFileSync(join(ROOT, "src", "presentation", "tidebound.css"), "utf8");

function countId(html: string, id: string): number {
  return html.split(`id="${id}"`).length - 1;
}

function stubStorage(initial: Record<string, string> = {}, throws = false): () => void {
  const store = new Map(Object.entries(initial));
  const ls = {
    getItem: (k: string): string | null => {
      if (throws) throw new Error("denied");
      return store.has(k) ? (store.get(k) as string) : null;
    },
    setItem: (k: string, v: string): void => {
      if (throws) throw new Error("denied");
      store.set(k, v);
    },
  };
  const g = globalThis as Record<string, unknown>;
  const prev = g.localStorage;
  g.localStorage = ls;
  return () => {
    if (prev === undefined) delete g.localStorage;
    else g.localStorage = prev;
  };
}

// ---------------------------------------------------------------------------
// Format parsing, URLs, dims, persistence
// ---------------------------------------------------------------------------

describe("T4E — format selection model", () => {
  it("defaults to landscape; only exact portrait selects portrait", () => {
    expect(parseOverlayFormat("portrait")).toBe("portrait");
    for (const raw of ["landscape", "", null, undefined, "PORTRAIT", "portrait ", "wide", 0, {}]) {
      expect(parseOverlayFormat(raw)).toBe("landscape");
    }
  });

  it("builds origin-derived URLs per format; unsafe origins yield none", () => {
    expect(overlayUrl("http://localhost:5173", "landscape")).toBe("http://localhost:5173/overlay.html");
    expect(overlayUrl("https://example.com/", "portrait")).toBe("https://example.com/overlay.html?format=portrait");
    expect(overlayUrl("", "landscape")).toBe("");
    expect(overlayUrl("not-a-url", "portrait")).toBe("");
    expect(overlayUrl("file:///x", "landscape")).toBe("");
  });

  it("locks authoritative dimensions (never invented)", () => {
    expect(FORMAT_DIMS.landscape).toEqual({ width: 1920, height: 1080, aspect: "16:9" });
    expect(FORMAT_DIMS.portrait).toEqual({ width: 1080, height: 1920, aspect: "9:16" });
  });

  it("persists the preference; fails safe without/against storage", () => {
    const restore = stubStorage();
    try {
      expect(getStoredFormat()).toBe("landscape");
      expect(setStoredFormat("portrait")).toBe(true);
      expect(getStoredFormat()).toBe("portrait");
      expect(setStoredFormat("landscape")).toBe(true);
      expect(getStoredFormat()).toBe("landscape");
      expect(setStoredFormat("sideways")).toBe(false);
      expect(getStoredFormat()).toBe("landscape");
    } finally {
      restore();
    }
    const restoreBad = stubStorage({ [STORED_FORMAT_KEY]: "ultrawide" });
    try {
      expect(getStoredFormat()).toBe("landscape");
    } finally {
      restoreBad();
    }
    const restoreThrow = stubStorage({}, true);
    try {
      expect(getStoredFormat()).toBe("landscape");
      expect(setStoredFormat("portrait")).toBe(false);
    } finally {
      restoreThrow();
    }
  });

  it("states the active format in words (never color-alone)", () => {
    expect(activeFormatLine("landscape")).toContain("Landscape");
    expect(activeFormatLine("landscape")).toContain("1920×1080");
    expect(activeFormatLine("portrait")).toContain("Portrait");
    expect(activeFormatLine("portrait")).toContain("1080×1920");
  });
});

// ---------------------------------------------------------------------------
// Creator markup: format card + OBS workspace
// ---------------------------------------------------------------------------

const NEW_IDS = [
  "st-format-h", "st-format-landscape", "st-format-portrait", "st-format-done",
  "st-format-open-landscape", "st-format-open-portrait",
  "st-obs-url-portrait", "st-obs-copy-portrait", "st-obs-done-portrait",
  "st-setup-steps",
];

describe("T4E — creator markup", () => {
  it.each(NEW_IDS)("settings #%s present exactly once", (id) => {
    expect(countId(INDEX_HTML, id)).toBe(1);
  });

  it("keeps the existing landscape URL contract (singular, readonly)", () => {
    expect(countId(INDEX_HTML, "st-obs-url")).toBe(1);
    expect(INDEX_HTML).toContain('id="st-obs-url" readonly');
    expect(INDEX_HTML).toContain('id="st-obs-url-portrait" readonly');
  });

  it("format selector is a labelled radiogroup with landscape default", () => {
    expect(INDEX_HTML).toContain('role="radiogroup" aria-label="Viewer overlay format"');
    expect(INDEX_HTML).toContain('name="overlay-format"');
    expect(INDEX_HTML).toContain("16:9");
    expect(INDEX_HTML).toContain("9:16");
    expect(INDEX_HTML).toContain("1920×1080");
    expect(INDEX_HTML).toContain("1080×1920");
  });

  it("explains overlay-vs-broadcast scope honestly", () => {
    const card = INDEX_HTML.slice(INDEX_HTML.indexOf('id="st-format-h"'), INDEX_HTML.indexOf('id="st-source-h"'));
    expect(card).toContain("never changes YouTube's broadcast resolution");
    expect(card).toContain("match the OBS canvas");
    expect(card).toContain("not a live broadcast");
    // The honest denial must be present verbatim; no affirmative
    // connection/broadcast claim may appear in this card.
    expect(card).toContain("nothing here means OBS is connected");
    expect(card).not.toMatch(/you are (now )?live|broadcast has started|successfully connected/i);
  });

  it("setup sequence has nine steps ending in explicit confirmation", () => {
    const ol = INDEX_HTML.slice(INDEX_HTML.indexOf('id="st-setup-steps"'), INDEX_HTML.indexOf('id="st-setup-steps"') + 4000);
    expect(ol.split("<li>").length - 1).toBe(9);
    expect(INDEX_HTML).toContain("Start the broadcast only after everything above checks out");
  });

  it("troubleshooting + audio + moderation boundary are stated", () => {
    expect(INDEX_HTML).toContain("shutdown source when not visible");
    expect(INDEX_HTML).toContain("Audio routing is not managed by Tidebound");
    expect(INDEX_HTML).toContain("slow mode");
    expect(INDEX_HTML).toContain("YouTube Studio");
    expect(INDEX_HTML).toContain("No extra moderation permissions were added");
  });

  it("no secrets or moderation token grants in new creator code", () => {
    expect(FORMAT_TS).not.toMatch(/token=|client_secret|password|Bearer /i);
    const obsCard = INDEX_HTML.slice(INDEX_HTML.indexOf('id="st-obs-h"'), INDEX_HTML.indexOf('id="st-diag-h"'));
    expect(obsCard).not.toMatch(/token=|secret=|client_id=|password|Bearer |private[_-]?key/i);
  });
});

// ---------------------------------------------------------------------------
// Architecture: one game, wired controls, no duplicate loops
// ---------------------------------------------------------------------------

describe("T4E — switching architecture", () => {
  it("instantiates exactly one Phaser.Game (dashboard preview in boot entry)", () => {
    // T4F-C1 migration: the single console-preview game moved with the
    // dashboard boot into src/main.ts (app.ts constructs nothing). Still
    // exactly one game for the dashboard bundle — not zero, not two.
    // "= new Phaser.Game(" matches construction only (a nearby comment
    // mentions the expression in prose).
    expect(APP_TS.split("= new Phaser.Game(").length - 1).toBe(0);
    expect(MAIN_TS.split("= new Phaser.Game(").length - 1).toBe(1);
  });

  it("shares the single format rule with the overlay (invalid → landscape)", () => {
    // T4F-C1 migration: format parsing lives with the renderer entry
    // (the dashboard no longer selects a simulation size). Same single
    // rule, same fallback, one owner.
    expect(RENDERER_TS).toContain("parseOverlayFormat");
  });

  it("wires portrait copy + both preview openers with honest fallbacks", () => {
    for (const id of ["st-obs-copy-portrait", "st-format-open-landscape", "st-format-open-portrait", "getStoredFormat", "setStoredFormat"]) {
      expect(APP_TS).toContain(id);
    }
    expect(APP_TS).toContain("Preview blocked — allow popups");
    expect(APP_TS).toContain("window.open");
  });

  it("restores the stored format without touching game state", () => {
    // Restore path reads storage + checks radios + writes the status line;
    // it never calls loadWorld/reset (display choice, not world mutation).
    const restoreIdx = APP_TS.indexOf("getStoredFormat()");
    expect(restoreIdx).toBeGreaterThan(-1);
    const restoreBlock = APP_TS.slice(restoreIdx, restoreIdx + 600);
    expect(restoreBlock).not.toContain("loadWorld");
    expect(restoreBlock).not.toContain("reset");
  });
});

// ---------------------------------------------------------------------------
// F1/F2 carryover fixes + contract preservation
// ---------------------------------------------------------------------------

function harness() {
  let t = 1_000_000;
  const now = () => t;
  const engine = new GameEngine({ now }, tideboundGenesis(new Date(t).toISOString()));
  const drain = () => {
    const out: GameResult[] = [];
    for (let i = 0; i < 500 && engine.queue.size > 0; i++) {
      t += QUEUE.minGapMs + 50;
      out.push(...engine.pump());
    }
    return out;
  };
  return { engine, drain };
}

function render(input: Parameters<typeof renderOverlay>[1]): string {
  const el = { innerHTML: "" } as unknown as HTMLElement;
  renderOverlay(el, input);
  return el.innerHTML;
}

describe("T4E-F1 — vote-open memory yields to five feed rows", () => {
  it("open vote: one deed, no recap card, five feed rows intact", () => {
    const { engine, drain } = harness();
    engine.world.deeds.push("deed one", "deed two", "deed three", "deed four");
    const acts: Array<[string, string, string]> = [
      ["a1", "A", "!strike"], ["a2", "B", "!mend"], ["a3", "C", "!shield"],
      ["a4", "D", "!ring"], ["a5", "E", "!hide"], ["a6", "F", "!help"],
    ];
    for (const [id, name, cmd] of acts) engine.ingestCommand(id, name, cmd, `e-${id}`);
    const recent = drain();
    const stream = openStream(engine.world);
    if (!stream.ok) throw new Error("open");
    const v = openSessionVote(stream.session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!v.ok) throw new Error("vote");
    const html = render({ world: engine.world, session: v.session, storyLog: [], feed: [], recent, paused: false, format: "landscape" });
    expect(html).toContain("Which road through the Pale?");
    expect(html.split("tb-feed-item").length - 1).toBe(5);
    expect(html.split('class="tb-deed"').length - 1).toBe(1);
    expect(html).not.toContain("Previously, in Tidebound");
  });

  it("dormant vote keeps full memory (three deeds + recap)", () => {
    const { engine } = harness();
    engine.world.deeds.push("deed one", "deed two", "deed three", "deed four");
    const stream = openStream(engine.world);
    if (!stream.ok) throw new Error("open");
    const html = render({ world: engine.world, session: stream.session, storyLog: [], feed: [], recent: [], paused: false, format: "landscape" });
    expect(html.split('class="tb-deed"').length - 1).toBe(3);
    expect(html).toContain("Previously, in Tidebound");
  });
});

describe("T4E-F2 — portrait banner clears HP, vote, and commands", () => {
  it("banner slot is bottom-anchored (empty-sea zone) in CSS", () => {
    const slotIdx = TIDEBOUND_CSS.indexOf(".tb-portrait .tb-banner-slot");
    expect(slotIdx).toBeGreaterThan(-1);
    const block = TIDEBOUND_CSS.slice(slotIdx, slotIdx + 500);
    expect(block).toContain("bottom:");
    expect(block).not.toContain("top: 114px");
    // tb-live-pulse, tb-feed-in, tb-banner-in — no new motion introduced.
    expect(TIDEBOUND_CSS.split("@keyframes").length - 1).toBe(3);
  });

  it("portrait renders HP chips + banner + vote + commands with no vex card", () => {
    const { engine, drain } = harness();
    engine.ingestCommand("u1", "Mender", "!mend", "e1");
    const recent = drain();
    const stream = openStream(engine.world);
    if (!stream.ok) throw new Error("open");
    const html = render({
      world: engine.world, session: stream.session, storyLog: [], feed: [], recent,
      paused: false, format: "portrait",
      banner: { id: "b1", category: "keeper-healing", title: "The crew breathes", sub: "Keeper 100/100", at: 1, priority: 50 },
    });
    expect(html).toContain("tb-banner-slot");
    expect(html.split("tb-banner-slot").length - 1).toBe(1);
    expect(html).not.toContain("tb-vexwrap");
    expect(html).toContain("Keeper 100/100");
    expect(html).toContain("The crew breathes");
    expect(html).toContain("!voteA");
  });
});

describe("T4E — feed/banner contracts unchanged", () => {
  it("ViewerFeedItem mapping, grouping, and banner priority hold", () => {
    const world = tideboundGenesis();
    const r: GameResult = { eventId: "e", action: "attack", summary: "s", actorName: "A", actorId: "u", storyMessages: [], visual: { hitEnemy: true } };
    expect(buildViewerFeedItem(r, { world, at: 1 })?.verb).toBe("struck");
    expect(buildViewerFeedItem(r, { world, at: 1 })?.delta).toContain("Vessel");
    const burst = [0, 1, 2, 3].map((i) => ({
      id: `b${i}`, actor: `V${i}`, verb: "struck", target: "T", outcome: "o",
      kind: "action" as const, action: "attack" as const, at: 1000 - i * 100, status: "applied" as const,
    }));
    const agg = aggregateFeedItems(burst, 5);
    expect(agg.rows[0].kind).toBe("group");
    expect(BANNER_PRIORITY["vote-result"]).toBeGreaterThan(BANNER_PRIORITY.repelled);
    const killWorld = { ...world, enemy: { ...world.enemy, hp: 0 } };
    const kill: GameResult = { eventId: "k", action: "attack", summary: "s", actorName: "A", storyMessages: [], visual: { hitEnemy: true, spawnWave: true } };
    expect(bannerForResult(kill, killWorld, 1)?.category).toBe("repelled");
    expect(COMMANDS["!votec"]).toBeDefined();
  });
});
