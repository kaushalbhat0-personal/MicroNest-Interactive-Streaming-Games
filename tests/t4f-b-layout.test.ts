/**
 * T4F-B — presentation/layout tests.
 * Renderer dimensions, overlay markup, dashboard dual-output block, and
 * reduced-motion preservation. Existing T4D/T4E visual contracts are
 * spot-guarded here, never altered.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rendererDims } from "../src/renderer/apply-snapshot";
import { FORMAT_DIMS, parseOverlayFormat } from "../src/dashboard/format";

const ROOT = join(__dirname, "..");
const INDEX_HTML = readFileSync(join(ROOT, "index.html"), "utf8");
const OVERLAY_HTML = readFileSync(join(ROOT, "overlay.html"), "utf8");
const GAMESCENE_TS = readFileSync(join(ROOT, "src", "phaser", "GameScene.ts"), "utf8");
const OVERLAY_TS = readFileSync(join(ROOT, "src", "overlay.ts"), "utf8");

function countId(html: string, id: string): number {
  return html.split(`id="${id}"`).length - 1;
}

describe("T4F-B — renderer resolutions", () => {
  it("landscape is 1920×1080 and portrait is 1080×1920", () => {
    expect(rendererDims("landscape")).toEqual({ width: 1920, height: 1080 });
    expect(rendererDims("portrait")).toEqual({ width: 1080, height: 1920 });
    expect(rendererDims("landscape")).toEqual({ width: FORMAT_DIMS.landscape.width, height: FORMAT_DIMS.landscape.height });
    expect(rendererDims("portrait")).toEqual({ width: FORMAT_DIMS.portrait.width, height: FORMAT_DIMS.portrait.height });
  });

  it("unknown formats fall back to the landscape renderer", () => {
    expect(parseOverlayFormat("sideways")).toBe("landscape");
    expect(parseOverlayFormat(null)).toBe("landscape");
  });
});

describe("T4F-B — overlay markup (both renderer URLs, one page)", () => {
  it("overlay keeps the game + HUD stage plus the connection notice", () => {
    for (const id of ["game", "hud", "renderer-status"]) {
      expect(countId(OVERLAY_HTML, id)).toBe(1);
    }
    expect(OVERLAY_HTML).toContain('role="status"');
  });

  it("portrait stage rules are intact (1080×1920)", () => {
    expect(OVERLAY_HTML).toContain("tb-portrait-page");
    expect(OVERLAY_HTML).toContain("1080px");
    expect(OVERLAY_HTML).toContain("1920px");
  });

  it("the live notice hides while live (clean broadcast frame), waiting/down stay visible", () => {
    expect(OVERLAY_HTML).toContain('#renderer-status[data-s="live"]');
    expect(OVERLAY_HTML).toContain("display: none");
    expect(OVERLAY_HTML).toContain("?debug=1");
  });

  it("overlay entry boots the renderer, not the authority", () => {
    expect(OVERLAY_TS).toContain("bootRenderer");
    expect(OVERLAY_TS).not.toContain("createRuntime");
  });
});

describe("T4F-B — reduced motion intact", () => {
  it("GameScene still honors prefers-reduced-motion (both renderers share it)", () => {
    expect(GAMESCENE_TS).toContain("prefers-reduced-motion");
    expect(GAMESCENE_TS).toContain("reducedMotion");
  });
});

describe("T4F-B — dashboard dual-output block", () => {
  it("dual-output status nodes exist exactly once", () => {
    for (const id of ["st-dual-rev", "st-dual-landscape", "st-dual-portrait", "st-dual-transport"]) {
      expect(countId(INDEX_HTML, id)).toBe(1);
    }
  });

  it("dual-output copy never implies OBS/encoder auto-configuration", () => {
    const block = INDEX_HTML.slice(INDEX_HTML.indexOf('id="st-dual-rev"') - 2000, INDEX_HTML.indexOf('id="st-dual-transport"') + 500);
    expect(block).toContain("never configures OBS");
    expect(block).toMatch(/separate encoder step|not part of this prototype/i);
    expect(block).not.toMatch(/automatically configur|already connected|successfully connected|broadcast has started/i);
  });

  it("format selector is reframed as preview preference (both URLs live at once)", () => {
    const card = INDEX_HTML.slice(INDEX_HTML.indexOf('id="st-format-h"'), INDEX_HTML.indexOf('id="st-source-h"'));
    expect(card).toContain("Preview preference");
    expect(card).toContain("never restarts the stream session");
    // Honesty denials preserved.
    expect(card).toContain("never changes YouTube's broadcast resolution");
    expect(card).toContain("nothing here means OBS is connected");
  });
});
