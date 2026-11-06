/**
 * G2-A6 — Cinderholm production environment integration tests.
 * Headless: pure logic, staging constants, asset table, derivative files.
 * Phaser behavior (layers, pools, SHUTDOWN) is verified by desktop captures.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BERTH_A,
  ENV_CEILINGS,
  ENV_PRESETS,
  EnvController,
  FOAM_RANGES_LANDSCAPE,
  FOAM_RANGES_PORTRAIT,
  PORTRAIT_ENV_STAGING,
  SHORE_LANDSCAPE,
  SHORE_PORTRAIT,
  envAssetDefs,
  gradeForWorld,
  parseEnvPreset,
  resolveEnvPreview,
  vesselBobOffset,
  vesselKeelY,
  waterlineAt,
} from "../src/phaser/cinderholmEnv";
import { ENV_PLATES, envPlateKeys } from "../src/phaser/assets";

describe("approved atmosphere defaults (G2-A5.1 #9)", () => {
  it("calm matches the accepted grade", () => {
    expect(ENV_PRESETS.calm.sheen).toBe(0.22);
    expect(ENV_PRESETS.calm.mist).toBe(0.28);
    expect(ENV_PRESETS.calm.beam).toBe(0.16);
  });

  it("storm respects the intensity ceilings (G2-A5.1 #10)", () => {
    expect(ENV_PRESETS.storm.rain).toBeLessThanOrEqual(ENV_CEILINGS.rain);
    expect(ENV_PRESETS.storm.overcast).toBeLessThanOrEqual(ENV_CEILINGS.dim);
    expect(ENV_PRESETS.storm.bob).toBeLessThanOrEqual(ENV_CEILINGS.bob);
    expect(ENV_PRESETS.storm.beam).toBeLessThanOrEqual(ENV_CEILINGS.beamGlobal);
    for (const p of Object.values(ENV_PRESETS)) {
      expect(p.beam).toBeLessThanOrEqual(ENV_CEILINGS.beamGlobal);
      expect(p.overcast).toBeLessThanOrEqual(ENV_CEILINGS.dim);
      expect(p.bob).toBeLessThanOrEqual(ENV_CEILINGS.bob);
    }
  });
});

describe("staging (berth A, shaped shoreline)", () => {
  it("vessel berth A is the approved staging", () => {
    expect(BERTH_A.x).toBe(1230);
    expect(BERTH_A.y).toBe(800);
    expect(BERTH_A.scale).toBe(0.9);
  });

  it("waterline interpolates along the shaped shore", () => {
    expect(waterlineAt(SHORE_LANDSCAPE, 0)).toBe(676);
    expect(waterlineAt(SHORE_LANDSCAPE, 1920)).toBe(684);
    const mid = waterlineAt(SHORE_LANDSCAPE, 1230);
    expect(mid).toBeGreaterThan(690);
    expect(mid).toBeLessThan(716);
    expect(waterlineAt(SHORE_PORTRAIT, 625)).toBeGreaterThan(1210);
    expect(waterlineAt(SHORE_PORTRAIT, 625)).toBeLessThan(1250);
  });

  it("foam ranges leave the inlet lane open", () => {
    // Landscape inlet lane is indices 5..8; portrait 4..7.
    for (const [from, to] of FOAM_RANGES_LANDSCAPE) {
      expect(to).toBeLessThanOrEqual(4 + (from >= 8 ? 6 : 0));
    }
    expect(FOAM_RANGES_PORTRAIT).toHaveLength(2);
  });

  it("portrait production staging is independent (approval 2)", () => {
    expect(PORTRAIT_ENV_STAGING.skiff).toEqual({ x: 452, y: 1661 });
    expect(PORTRAIT_ENV_STAGING.vessel).toEqual({ x: 625, y: 1385, scale: 0.76 });
    expect(PORTRAIT_ENV_STAGING.reef).toEqual({ x: 800, y: 1330 });
    expect(PORTRAIT_ENV_STAGING.chapelFlame).toEqual({ x: 195, y: 1526 });
  });

  it("keel math matches the measured content edge (row 255)", () => {
    expect(vesselKeelY(800, 0.9)).toBeCloseTo(800 + (255 - 0.86 * 288) * 0.9, 6);
  });

  it("storm bob stays within +/-4.5px and under 2 degrees", () => {
    let maxY = 0;
    let maxRot = 0;
    for (let i = 0; i < 360; i++) {
      const o = vesselBobOffset((i / 360) * 5.7, 1.8);
      maxY = Math.max(maxY, Math.abs(o.y));
      maxRot = Math.max(maxRot, Math.abs(o.rotation));
    }
    expect(maxY).toBeLessThanOrEqual(4.5);
    expect(maxRot).toBeLessThan((2 * Math.PI) / 180);
  });
});

describe("grade mapping (visual-only, no engine coupling)", () => {
  it("threat bands select calm/overcast/storm; driven-off recovers", () => {
    expect(gradeForWorld(10, false)).toBe("calm");
    expect(gradeForWorld(32, false)).toBe("calm");
    expect(gradeForWorld(33, false)).toBe("overcast");
    expect(gradeForWorld(65, false)).toBe("overcast");
    expect(gradeForWorld(66, false)).toBe("storm");
    expect(gradeForWorld(100, false)).toBe("storm");
    expect(gradeForWorld(100, true)).toBe("aftermath");
    expect(gradeForWorld(0, true)).toBe("aftermath");
  });

  it("dev override parses four presets and rejects the rest", () => {
    expect(resolveEnvPreview("?env=storm")).toBe("storm");
    expect(resolveEnvPreview("?env=CALM")).toBe("calm");
    expect(resolveEnvPreview("?env=hurricane")).toBeNull();
    expect(resolveEnvPreview(null)).toBeNull();
    expect(parseEnvPreset("aftermath")).toBe("aftermath");
  });

  it("controller holds visual state only (no gameplay fields)", () => {
    const ctl = new EnvController("calm");
    const keys = Object.keys(ctl.snapshot()).sort();
    expect(keys).toEqual(
      ["beam", "bob", "cloud", "foam", "glow", "lightning", "mist", "overcast",
       "rain", "sheen", "speed", "swell", "warmth", "wind"].sort(),
    );
    const src = readFileSync(join(__dirname, "..", "src", "phaser", "cinderholmEnv.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["'][^"']*engine\//);
    expect(src).not.toContain("WorldState");
    expect(src).not.toContain("GameResult");
  });

  it("effect gates silence output without touching targets", () => {
    const ctl = new EnvController("storm");
    ctl.setEffectEnabled("weather", false);
    expect(ctl.effectiveRain()).toBe(0);
    expect(ctl.effectiveLightning()).toBe(0);
    expect(ctl.target.rain).toBe(1);
  });
});

describe("asset table (WebP primary + fallback, one composition)", () => {
  it("defines eight per-format entries with distinct primary/fallback", () => {
    for (const format of ["landscape", "portrait"] as const) {
      const defs = envAssetDefs(format);
      expect(defs).toHaveLength(8);
      for (const d of defs) {
        expect(d.webp.endsWith(".webp")).toBe(true);
        expect(d.fallback).not.toBe(d.webp);
      }
      const overlay = defs.find((d) => d.key === "env-sheen")!;
      expect(overlay.webp).toContain(format);
    }
  });

  it("asset table keys are all registered in assets.ts", () => {
    const registered = new Set(envPlateKeys());
    expect(registered.has("env-sky")).toBe(true);
    for (const format of ["landscape", "portrait"] as const) {
      for (const d of envAssetDefs(format)) {
        expect(registered.has(d.key), d.key).toBe(true);
      }
    }
    // Five shared plates + three overlays x two formats = eleven rows.
    expect(ENV_PLATES).toHaveLength(11);
  });

  it("all production derivatives exist on disk", () => {
    const base = join(__dirname, "..", "public", "assets", "tidebound", "environment");
    const expected = [
      "cinderholm_sky.webp", "cinderholm_sky.jpg",
      "cinderholm_sea.webp", "cinderholm_sea.jpg",
      "cinderholm_mountains.webp", "cinderholm_mountains.png",
      "cinderholm_castle.webp", "cinderholm_castle.png",
      "cinderholm_frontstones.webp", "cinderholm_frontstones.png",
      "cinderholm_sheen_landscape.webp", "cinderholm_sheen_landscape.png",
      "cinderholm_sheen_portrait.webp", "cinderholm_sheen_portrait.png",
      "cinderholm_mist_landscape.webp", "cinderholm_mist_landscape.png",
      "cinderholm_mist_portrait.webp", "cinderholm_mist_portrait.png",
      "cinderholm_beam_landscape.webp", "cinderholm_beam_landscape.png",
      "cinderholm_beam_portrait.webp", "cinderholm_beam_portrait.png",
      "cinderholm_beam_soft_landscape.webp", "cinderholm_beam_soft_landscape.png",
      "cinderholm_beam_soft_portrait.webp", "cinderholm_beam_soft_portrait.png",
    ];
    for (const f of expected) {
      expect(existsSync(join(base, f)), f).toBe(true);
    }
  });
});
