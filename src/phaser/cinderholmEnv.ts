/**
 * G2-A6 — Cinderholm production environment (visual-only).
 *
 * Production port of the approved G2-A4.2 staging + G2-A4.3 animation
 * (see design/art-bible/working/world-art-production/previews/
 * cinderholm-env-controller.ts, -refined.ts, -animated.ts). The preview
 * files stay untouched; this module is the single production copy.
 *
 * Boundaries (G2-A5 binding):
 * - Visual state only. Never imports engine authority, never reads or
 *   mutates gameplay state. GameScene passes plain numbers/strings in.
 * - No new scene, clock, or authority loop. GameScene owns lifecycle and
 *   calls preload/create/update/dispose at its existing seams.
 * - Keeper/vessel animation contracts are untouched (keys, frames, rates,
 *   repeats, origins, scales). Berth A staging only moves the vessel home.
 * - Zero tweens at runtime: all motion is sine-phase in updateEnv().
 *   Pools are preallocated; update() does arithmetic + transform writes.
 * - Reduced motion: frame-0/static holds. `?fx=0`: effects off, plates stay.
 *   Missing textures: primitives stay (GameScene hides nothing then).
 */

export type EnvPresetName = "calm" | "overcast" | "storm" | "aftermath";
export type WorldFormat = "landscape" | "portrait";

import { ENV_PLATES } from "./assets";

/** Full visual parameter set. All opacities are 0..1, wind is -1..1. */
export interface EnvParams {
  speed: number;
  sheen: number;
  mist: number;
  cloud: number;
  beam: number;
  glow: number;
  foam: number;
  swell: number;
  bob: number;
  rain: number;
  wind: number;
  lightning: number;
  overcast: number;
  warmth: number;
}

export const ENV_PRESETS: Record<EnvPresetName, EnvParams> = {
  calm: {
    speed: 1.0, sheen: 0.22, mist: 0.28, cloud: 0.10, beam: 0.16, glow: 0.22,
    foam: 1.0, swell: 1.0, bob: 1.0, rain: 0, wind: 0.1,
    lightning: 0, overcast: 0, warmth: 0,
  },
  overcast: {
    speed: 1.0, sheen: 0.12, mist: 0.45, cloud: 0.22, beam: 0.10, glow: 0.16,
    foam: 1.15, swell: 1.25, bob: 1.2, rain: 0.18, wind: 0.35,
    lightning: 0.05, overcast: 0.22, warmth: 0,
  },
  storm: {
    speed: 1.6, sheen: 0.08, mist: 0.55, cloud: 0.30, beam: 0.30, glow: 0.34,
    foam: 1.5, swell: 1.8, bob: 1.8, rain: 1.0, wind: 0.8,
    lightning: 1.0, overcast: 0.38, warmth: 0,
  },
  aftermath: {
    speed: 0.9, sheen: 0.30, mist: 0.35, cloud: 0.14, beam: 0.20, glow: 0.26,
    foam: 1.1, swell: 1.1, bob: 1.0, rain: 0, wind: 0.15,
    lightning: 0, overcast: 0.06, warmth: 0.08,
  },
};

export const ENV_PRESET_NAMES = ["calm", "overcast", "storm", "aftermath"] as const;

/** Production intensity ceilings (G2-A5.1 approvals 9-10). */
export const ENV_CEILINGS = {
  beamGlobal: 0.5,
  rain: 1.0,
  dim: 0.38,
  bob: 1.8,
} as const;

export function parseEnvPreset(raw: string | null): EnvPresetName | null {
  if (!raw) return null;
  const v = raw.toLowerCase();
  return (ENV_PRESET_NAMES as readonly string[]).includes(v) ? (v as EnvPresetName) : null;
}

/** Exponential approach without allocation: advances `cur` toward `tgt`. */
export function approach(cur: number, tgt: number, dtMs: number, tauMs: number): number {
  if (dtMs <= 0 || tauMs <= 0) return tgt;
  if (cur === tgt) return tgt;
  const k = 1 - Math.exp(-dtMs / tauMs);
  const next = cur + (tgt - cur) * k;
  return Math.abs(next - tgt) < 0.0005 ? tgt : next;
}

export class EnvController {
  current: EnvParams;
  target: EnvParams;
  tauMs = 400;
  weatherIntensity = 1;
  preset: EnvPresetName;
  enabled: { atmosphere: boolean; weather: boolean; motion: boolean } = {
    atmosphere: true,
    weather: true,
    motion: true,
  };

  constructor(preset: EnvPresetName = "calm") {
    this.preset = preset;
    this.current = { ...ENV_PRESETS[preset] };
    this.target = { ...ENV_PRESETS[preset] };
  }

  applyPreset(name: EnvPresetName, transitionMs = 1200): void {
    this.preset = name;
    this.tauMs = Math.max(1, transitionMs / 3);
    this.target = {
      ...ENV_PRESETS[name],
      rain: ENV_PRESETS[name].rain * this.weatherIntensity,
      lightning: ENV_PRESETS[name].lightning * this.weatherIntensity,
    };
  }

  snapTo(params: Partial<EnvParams>): void {
    this.current = { ...this.current, ...params };
    this.target = { ...this.target, ...params };
  }

  setEffectEnabled(group: keyof EnvController["enabled"], on: boolean): void {
    this.enabled[group] = on;
  }

  update(dtMs: number): void {
    const c = this.current;
    const t = this.target;
    c.speed = approach(c.speed, t.speed, dtMs, this.tauMs);
    c.sheen = approach(c.sheen, t.sheen, dtMs, this.tauMs);
    c.mist = approach(c.mist, t.mist, dtMs, this.tauMs);
    c.cloud = approach(c.cloud, t.cloud, dtMs, this.tauMs);
    c.beam = approach(c.beam, t.beam, dtMs, this.tauMs);
    c.glow = approach(c.glow, t.glow, dtMs, this.tauMs);
    c.foam = approach(c.foam, t.foam, dtMs, this.tauMs);
    c.swell = approach(c.swell, t.swell, dtMs, this.tauMs);
    c.bob = approach(c.bob, t.bob, dtMs, this.tauMs);
    c.rain = approach(c.rain, t.rain, dtMs, this.tauMs);
    c.wind = approach(c.wind, t.wind, dtMs, this.tauMs);
    c.lightning = approach(c.lightning, t.lightning, dtMs, this.tauMs);
    c.overcast = approach(c.overcast, t.overcast, dtMs, this.tauMs);
    c.warmth = approach(c.warmth, t.warmth, dtMs, this.tauMs);
  }

  effectiveRain(): number {
    return this.enabled.weather ? this.current.rain : 0;
  }

  effectiveLightning(): number {
    return this.enabled.weather ? this.current.lightning : 0;
  }

  snapshot(): EnvParams {
    return { ...this.current };
  }
}

// ---------------------------------------------------------------------------
// Staging (approved G2-A4.2 values, berth A only).
// Landscape canvas (1920x1080) matches the preview 1:1. Portrait preview
// coordinates are cover-fit-plate-specific and do NOT transfer to the
// GameScene portrait composition, so the portrait vessel keeps the
// GameScene home; plates still apply via runtime cover-fit.
// ---------------------------------------------------------------------------

export interface ShorePoint { x: number; y: number }

export const SHORE_LANDSCAPE: ShorePoint[] = [
  { x: 0, y: 676 }, { x: 300, y: 682 }, { x: 450, y: 702 },
  { x: 560, y: 716 }, { x: 700, y: 708 }, { x: 820, y: 698 },
  { x: 960, y: 694 }, { x: 1080, y: 696 }, { x: 1200, y: 706 },
  { x: 1320, y: 714 }, { x: 1450, y: 704 }, { x: 1600, y: 688 },
  { x: 1920, y: 684 },
];

export const SHORE_PORTRAIT: ShorePoint[] = [
  { x: 0, y: 1200 }, { x: 170, y: 1208 }, { x: 260, y: 1230 },
  { x: 340, y: 1242 }, { x: 430, y: 1234 }, { x: 540, y: 1224 },
  { x: 650, y: 1226 }, { x: 760, y: 1236 }, { x: 860, y: 1242 },
  { x: 950, y: 1230 }, { x: 1080, y: 1220 },
];

export const FOAM_RANGES_LANDSCAPE: Array<[number, number]> = [[2, 4], [8, 10]];
export const FOAM_RANGES_PORTRAIT: Array<[number, number]> = [[2, 3], [7, 8]];

/** Approved berth A (landscape). Portrait keeps the GameScene home. */
export const BERTH_A = { x: 1230, y: 800, scale: 0.9 } as const;

/**
 * Portrait production staging against the cover-fit plates. The GameScene
 * portrait composition is independent (approval 2): these coordinates put
 * the embarked keeper, the vessel, the reef lanterns and the chapel
 * brazier onto open water/rock in the portrait plate, clear of the
 * painted tower. Landscape keeps the GameScene homes + berth A.
 */
export const PORTRAIT_ENV_STAGING = {
  skiff: { x: 452, y: 1661 },
  vessel: { x: 625, y: 1385, scale: 0.76 },
  reef: { x: 800, y: 1330 },
  chapelFlame: { x: 195, y: 1526 },
} as const;

/** P1 lantern anchors in plate pixels (landscape 1920x1080 / portrait cover-fit). */
export const LANTERN_LANDSCAPE = { x: 1075, y: 190 } as const;
export const LANTERN_PORTRAIT = { x: 545, y: 330 } as const;

/** Beam asset lamp fractions (origin = lamp position in beam texture). */
export const BEAM_LAMP_LANDSCAPE = { x: 425 / 1920, y: 150 / 1080 } as const;
export const BEAM_LAMP_PORTRAIT = { x: 305 / 1080, y: 360 / 1920 } as const;

export function waterlineAt(shore: ShorePoint[], x: number): number {
  if (x <= shore[0].x) return shore[0].y;
  for (let i = 1; i < shore.length; i++) {
    if (x <= shore[i].x) {
      const a = shore[i - 1];
      const b = shore[i];
      const t = (x - a.x) / Math.max(1, b.x - a.x);
      return a.y + (b.y - a.y) * t;
    }
  }
  return shore[shore.length - 1].y;
}

/** Vessel keel Y for a sprite with origin (0.5, 0.86) on 512x288 frames. */
export function vesselKeelY(vesselY: number, scale: number): number {
  return vesselY + (255 - 0.86 * 288) * scale;
}

/** Pure sine-phase vessel bob (storm 1.8x = +/-4.5px ceiling). */
export function vesselBobOffset(t: number, bob: number): { x: number; y: number; rotation: number } {
  const TAU = Math.PI * 2;
  return {
    y: Math.sin((TAU * t) / 3.6) * 2.5 * bob,
    x: Math.sin((TAU * t) / 5.7 + 0.7) * 1.5 * Math.min(bob, 1.5),
    rotation: Math.sin((TAU * t) / 4.4 + 1.3) * 0.008 * bob,
  };
}

// ---------------------------------------------------------------------------
// Asset table (WebP primary + fallback). Only the boot format is loaded.
// ---------------------------------------------------------------------------

export interface EnvAssetDef {
  key: string;
  webp: string;
  fallback: string;
}

export function envAssetDefs(format: WorldFormat): EnvAssetDef[] {
  return ENV_PLATES.filter((p) => p.format === "shared" || p.format === format).map(
    ({ key, webp, fallback }) => ({ key, webp, fallback }),
  );
}

// ---------------------------------------------------------------------------
// Grade mapping (plain values in, visual preset out — no engine coupling).
// ---------------------------------------------------------------------------

/**
 * Threat bands select the grade; a driven-off Vex reads as recovery.
 * `cinder` carries the cinderholm location state for lantern behavior.
 */
export function gradeForWorld(threatLevel: number, drivenOff: boolean): EnvPresetName {
  if (drivenOff) return "aftermath";
  if (threatLevel >= 66) return "storm";
  if (threatLevel >= 33) return "overcast";
  return "calm";
}

/**
 * Dev-only grade override (`?env=<preset>`), mirroring the keeperPreview
 * precedent: null in normal play, so syncWorld mapping is byte-identical
 * unless the flag is present (deterministic captures only).
 */
export function resolveEnvPreview(search: string | null | undefined): EnvPresetName | null {
  if (!search) return null;
  let v: string | null = null;
  try {
    v = new URLSearchParams(search).get("env");
  } catch {
    return null;
  }
  return parseEnvPreset(v);
}
