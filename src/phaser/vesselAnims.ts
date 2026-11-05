/** Gloam Vessel atlas and animation contract (presentation-only). */
import { ART_MANIFEST } from "./assets";

export const VESSEL_ATLAS_KEY = "tb-vessel";
export const VESSEL_PNG_URL = "/assets/tidebound/atlases/tidebound_vessel.png";
export const VESSEL_JSON_URL = "/assets/tidebound/atlases/tidebound_vessel.json";
export const VESSEL_IDLE_ANIM = "vessel-idle-side";
export const VESSEL_IDLE_FRAMES = [
  "vessel_idle_side_00",
  "vessel_idle_side_01",
  "vessel_idle_side_02",
  "vessel_idle_side_03",
] as const;
export const VESSEL_IDLE_FRAME_RATE = 4;
export const VESSEL_IDLE_REPEAT = -1;

/** Manifest cross-check used by tests and diagnostics. */
export function vesselManifestUrl(): string | null {
  return ART_MANIFEST.atlases.find((entry) => entry.key === VESSEL_ATLAS_KEY)?.jsonUrl ?? null;
}
