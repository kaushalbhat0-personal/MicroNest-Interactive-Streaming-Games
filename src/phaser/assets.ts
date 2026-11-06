/**
 * P0 — Tidebound art asset manifest (scaffold only).
 *
 * Central registry of every texture atlas the Phaser scene may load in
 * P1–P4. PURE DATA: no Phaser import, no loading, no runtime behavior —
 * `GameScene` draws primitives until P1D wires the tb-chars key into
 * `preload()`, keeping per-atlas primitive fallbacks.
 *
 * Conventions: locked in `design/art-bible/PROVENANCE.md` §9–§10.
 * Atlas files live under `public/assets/tidebound/atlases/`
 * (served at `/assets/tidebound/atlases/` by Vite).
 */

export type AssetClass = "env" | "chars" | "vessel" | "fx";

/** Primitive builder that renders while its atlas is absent (never blank). */
export type PrimitiveFallback =
  | "sky-sea" // buildSky + buildSea + waves
  | "cinderholm" // buildCinderholm + buildChapelBrazier
  | "skiff-reef" // buildSkiff + buildReef
  | "vessel" // buildVessel
  | "bursts"; // burst() dot particles

export interface AtlasEntry {
  /** Phaser texture key, e.g. "tb-chars". */
  key: string;
  /** Atlas class. */
  class: AssetClass;
  /** Absolute-from-root URL of the atlas JSON (PNG sibling). */
  jsonUrl: string;
  /** P1–P4 production batch that provides it; "p0" = scaffold only. */
  batch: "p0" | "p1" | "p2" | "p3" | "p4" | "p5";
  /** Loader must NOT block/fail the scene when files are missing. */
  required: false;
  /** Primitive builders that stay authoritative until approved art lands. */
  fallbacks: PrimitiveFallback[];
}

export interface ArtManifest {
  version: 0;
  base: "/assets/tidebound/atlases";
  atlases: AtlasEntry[];
}

/** The full P1–P5 atlas plan. No files exist yet in P0 — entries are
 *  `required: false` with primitive fallbacks, so the scene is
 *  pixel-identical until approved art lands per batch. */
export const ART_MANIFEST: ArtManifest = {
  version: 0,
  base: "/assets/tidebound/atlases",
  atlases: [
    {
      key: "tb-env",
      class: "env",
      jsonUrl: "/assets/tidebound/atlases/tidebound_env.json",
      batch: "p3",
      required: false,
      fallbacks: ["sky-sea", "cinderholm", "skiff-reef"],
    },
    {
      key: "tb-chars",
      class: "chars",
      jsonUrl: "/assets/tidebound/atlases/tidebound_chars.json",
      batch: "p1",
      required: false,
      fallbacks: ["skiff-reef"],
    },
    {
      key: "tb-vessel",
      class: "vessel",
      jsonUrl: "/assets/tidebound/atlases/tidebound_vessel.json",
      batch: "p2",
      required: false,
      fallbacks: ["vessel"],
    },
    {
      key: "tb-fx",
      class: "fx",
      jsonUrl: "/assets/tidebound/atlases/tidebound_fx.json",
      batch: "p4",
      required: false,
      fallbacks: ["bursts"],
    },
  ],
};

/** All texture keys the scene may reference (uniqueness locked by test). */
export function atlasKeys(manifest: ArtManifest = ART_MANIFEST): string[] {
  return manifest.atlases.map((a) => a.key);
};
/** Atlases with no fallback coverage — must stay empty (stream safety). */
export function atlasesWithoutFallback(manifest: ArtManifest = ART_MANIFEST): string[] {
  return manifest.atlases.filter((a) => a.fallbacks.length === 0).map((a) => a.key);
}

/**
 * G2-A6 — Cinderholm production environment plates (WebP primary + fallback).
 * PURE DATA: no Phaser import, no loading. Source derivatives live under
 * `public/assets/tidebound/environment/` (served at
 * `/assets/tidebound/environment/` by Vite). Only the boot format is loaded;
 * every key has primitive-fallback coverage in GameScene (never blank).
 */
export type EnvPlateFormat = "landscape" | "portrait" | "shared";

export interface EnvPlateEntry {
  /** Phaser texture key, e.g. "env-sky". */
  key: string;
  /** "shared" plates load in both compositions; overlays are per-format. */
  format: EnvPlateFormat;
  /** Primary URL (WebP). */
  webp: string;
  /** Fallback URL (JPG for opaque, PNG for RGBA) on load error. */
  fallback: string;
}

const ENV_PLATE_BASE = "/assets/tidebound/environment";

export const ENV_PLATES: EnvPlateEntry[] = [
  { key: "env-sky", format: "shared", webp: `${ENV_PLATE_BASE}/cinderholm_sky.webp`, fallback: `${ENV_PLATE_BASE}/cinderholm_sky.jpg` },
  { key: "env-mountains", format: "shared", webp: `${ENV_PLATE_BASE}/cinderholm_mountains.webp`, fallback: `${ENV_PLATE_BASE}/cinderholm_mountains.png` },
  { key: "env-castle", format: "shared", webp: `${ENV_PLATE_BASE}/cinderholm_castle.webp`, fallback: `${ENV_PLATE_BASE}/cinderholm_castle.png` },
  { key: "env-sea", format: "shared", webp: `${ENV_PLATE_BASE}/cinderholm_sea.webp`, fallback: `${ENV_PLATE_BASE}/cinderholm_sea.jpg` },
  { key: "env-rocks", format: "shared", webp: `${ENV_PLATE_BASE}/cinderholm_frontstones.webp`, fallback: `${ENV_PLATE_BASE}/cinderholm_frontstones.png` },
  { key: "env-sheen", format: "landscape", webp: `${ENV_PLATE_BASE}/cinderholm_sheen_landscape.webp`, fallback: `${ENV_PLATE_BASE}/cinderholm_sheen_landscape.png` },
  { key: "env-sheen", format: "portrait", webp: `${ENV_PLATE_BASE}/cinderholm_sheen_portrait.webp`, fallback: `${ENV_PLATE_BASE}/cinderholm_sheen_portrait.png` },
  { key: "env-mist", format: "landscape", webp: `${ENV_PLATE_BASE}/cinderholm_mist_landscape.webp`, fallback: `${ENV_PLATE_BASE}/cinderholm_mist_landscape.png` },
  { key: "env-mist", format: "portrait", webp: `${ENV_PLATE_BASE}/cinderholm_mist_portrait.webp`, fallback: `${ENV_PLATE_BASE}/cinderholm_mist_portrait.png` },
  { key: "env-beam", format: "landscape", webp: `${ENV_PLATE_BASE}/cinderholm_beam_landscape.webp`, fallback: `${ENV_PLATE_BASE}/cinderholm_beam_landscape.png` },
  { key: "env-beam", format: "portrait", webp: `${ENV_PLATE_BASE}/cinderholm_beam_portrait.webp`, fallback: `${ENV_PLATE_BASE}/cinderholm_beam_portrait.png` },
];

/** All environment texture keys (per-format overlays deduped). */
export function envPlateKeys(): string[] {
  return [...new Set(ENV_PLATES.map((p) => p.key))];
}