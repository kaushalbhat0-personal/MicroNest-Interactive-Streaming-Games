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
}

/** Atlases with no fallback coverage — must stay empty (stream safety). */
export function atlasesWithoutFallback(manifest: ArtManifest = ART_MANIFEST): string[] {
  return manifest.atlases.filter((a) => a.fallbacks.length === 0).map((a) => a.key);
}
