import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ART_MANIFEST } from "../src/phaser/assets";
import {
  VESSEL_ATLAS_KEY,
  VESSEL_IDLE_ANIM,
  VESSEL_IDLE_FRAME_RATE,
  VESSEL_IDLE_FRAMES,
  VESSEL_IDLE_REPEAT,
  VESSEL_JSON_URL,
  VESSEL_PNG_URL,
} from "../src/phaser/vesselAnims";

const ROOT = join(__dirname, "..");
const ATLAS_DIR = join(ROOT, "public", "assets", "tidebound", "atlases");

describe("Gloam Vessel idle atlas contract", () => {
  it("registers the optional atlas with primitive fallback", () => {
    expect(ART_MANIFEST.atlases).toContainEqual({
      key: VESSEL_ATLAS_KEY,
      class: "vessel",
      jsonUrl: VESSEL_JSON_URL,
      batch: "p2",
      required: false,
      fallbacks: ["vessel"],
    });
    expect(VESSEL_PNG_URL).toBe("/assets/tidebound/atlases/tidebound_vessel.png");
  });

  it("keeps the approved four-frame order and looping playback settings", () => {
    expect(VESSEL_IDLE_ANIM).toBe("vessel-idle-side");
    expect(VESSEL_IDLE_FRAMES).toEqual([
      "vessel_idle_side_00",
      "vessel_idle_side_01",
      "vessel_idle_side_02",
      "vessel_idle_side_03",
    ]);
    expect(VESSEL_IDLE_FRAME_RATE).toBe(4);
    expect(VESSEL_IDLE_REPEAT).toBe(-1);
  });

  it("matches each atlas frame to its 512 × 288 cell in the PNG", () => {
    const atlas = JSON.parse(
      readFileSync(join(ATLAS_DIR, "tidebound_vessel.json"), "utf8"),
    ) as {
      frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
      meta: { image: string; size: { w: number; h: number } };
    };
    const png = readFileSync(join(ATLAS_DIR, "tidebound_vessel.png"));

    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) }).toEqual({ w: 2048, h: 288 });
    expect(atlas.meta).toMatchObject({ image: "tidebound_vessel.png", size: { w: 2048, h: 288 } });
    expect(Object.keys(atlas.frames)).toEqual([...VESSEL_IDLE_FRAMES]);

    VESSEL_IDLE_FRAMES.forEach((name, index) => {
      expect(atlas.frames[name]?.frame).toEqual({ x: index * 512, y: 0, w: 512, h: 288 });
    });
  });
});
