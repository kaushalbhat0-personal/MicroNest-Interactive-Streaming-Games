/**
 * P0 — asset manifest safety tests (static only: no Phaser, no DOM).
 * Locks: unique keys, well-formed atlas URLs, every atlas optional with
 * primitive fallback coverage (a missing file must never blank the scene).
 */
import { describe, expect, it } from "vitest";
import { ART_MANIFEST, atlasKeys, atlasesWithoutFallback } from "../src/phaser/assets";

describe("P0 art manifest", () => {
  it("declares unique atlas keys", () => {
    const keys = atlasKeys();
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThan(0);
  });

  it("points every atlas at the vite-served atlases dir", () => {
    for (const a of ART_MANIFEST.atlases) {
      expect(a.jsonUrl.startsWith(`${ART_MANIFEST.base}/`)).toBe(true);
      expect(a.jsonUrl.endsWith(".json")).toBe(true);
    }
  });

  it("keeps every atlas optional with primitive fallback coverage", () => {
    for (const a of ART_MANIFEST.atlases) {
      expect(a.required).toBe(false);
      expect(a.fallbacks.length).toBeGreaterThan(0);
    }
    expect(atlasesWithoutFallback()).toEqual([]);
  });
});
