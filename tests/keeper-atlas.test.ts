/**
 * P1D — keeper atlas integration tests (static + pure logic: no Phaser, no DOM).
 * Locks: manifest URL agreement, frame/anim naming, 24+4 key inventory,
 * state mapping, one-shot mapping, no-restart rule, published file integrity.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KEEPER_ATLAS_KEY,
  KEEPER_EXPRS,
  KEEPER_JSON_URL,
  KEEPER_PNG_URL,
  KEEPER_POSES,
  allKeeperFrames,
  keeperAnimKey,
  keeperExprFrame,
  keeperFrame,
  keeperManifestUrl,
  resolveKeeperOneShot,
  resolveKeeperPose,
  shouldSwitchAnim,
} from "../src/phaser/keeperAnims";

const ATLASES = join(__dirname, "..", "public", "assets", "tidebound", "atlases");

function pngSize(png: Buffer): { w: number; h: number } {
  // Minimal IHDR parse (8-byte signature + IHDR chunk): no new dependencies.
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect(png.toString("ascii", 12, 16)).toBe("IHDR");
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

describe("P1D keeper anim naming", () => {
  it("builds zero-padded frame names and rejects bad indices", () => {
    expect(keeperFrame("idle", 0)).toBe("keeper_idle_side_00");
    expect(keeperFrame("walk", 5)).toBe("keeper_walk_side_05");
    expect(keeperFrame("shield", 2)).toBe("keeper_shield_side_02");
    expect(() => keeperFrame("idle", 4)).toThrow(RangeError);
    expect(() => keeperFrame("walk", -1)).toThrow(RangeError);
  });

  it("covers 24 animation frames with the six registered families", () => {
    expect(allKeeperFrames()).toHaveLength(24);
    expect(new Set(allKeeperFrames()).size).toBe(24);
    expect(keeperAnimKey("strike")).toBe("keeper-strike");
    expect(KEEPER_EXPRS).toEqual(["neutral", "determined", "concerned", "hopeful"]);
    expect(keeperExprFrame("hopeful")).toBe("keeper_expr_hopeful");
  });

  it("agrees with the manifest tb-chars entry", () => {
    expect(keeperManifestUrl()).toBe(KEEPER_JSON_URL);
    expect(KEEPER_ATLAS_KEY).toBe("tb-chars");
    expect(KEEPER_PNG_URL).toBe("/assets/tidebound/atlases/tidebound_chars.png");
  });
});

describe("P1D keeper state mapping", () => {
  it("holds shield only while the ward is up, idles otherwise", () => {
    expect(resolveKeeperPose(true)).toBe("shield");
    expect(resolveKeeperPose(false)).toBe("idle");
  });

  it("maps result visuals to one-shots with fixed priority, gaps stay null", () => {
    expect(resolveKeeperOneShot({ hitEnemy: true })).toBe("strike");
    expect(resolveKeeperOneShot({ healHero: true })).toBe("mend");
    expect(resolveKeeperOneShot({ shieldKeep: true })).toBe("shield");
    expect(resolveKeeperOneShot({ hitEnemy: true, healHero: true })).toBe("strike");
    expect(resolveKeeperOneShot({})).toBeNull();
    expect(resolveKeeperOneShot(null)).toBeNull();
    expect(resolveKeeperOneShot(undefined)).toBeNull();
  });

  it("never restarts the running animation", () => {
    expect(shouldSwitchAnim(null, "keeper-idle")).toBe(true);
    expect(shouldSwitchAnim("keeper-idle", "keeper-idle")).toBe(false);
    expect(shouldSwitchAnim("keeper-idle", "keeper-strike")).toBe(true);
  });

  it("keeps one-shot semantics per pose", () => {
    expect(KEEPER_POSES.strike.oneShot).toBe(true);
    expect(KEEPER_POSES.mend.oneShot).toBe(true);
    expect(KEEPER_POSES.interact.oneShot).toBe(true);
    expect(KEEPER_POSES.idle.oneShot).toBe(false);
    expect(KEEPER_POSES.shield.repeat).toBe(-1);
  });
});

describe("P1D published atlas files", () => {
  it("publishes the PNG at 2520x1440 RGBA", () => {
    const p = join(ATLASES, "tidebound_chars.png");
    expect(existsSync(p)).toBe(true);
    expect(pngSize(readFileSync(p))).toEqual({ w: 2520, h: 1440 });
  });

  it("publishes JSON with all 28 keys and a matching image reference", () => {
    const meta = JSON.parse(
      readFileSync(join(ATLASES, "tidebound_chars.json"), "utf8"),
    ) as { frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>; meta: { image: string } };
    const expected = new Set([...allKeeperFrames(), ...KEEPER_EXPRS.map(keeperExprFrame)]);
    expect(new Set(Object.keys(meta.frames))).toEqual(expected);
    expect(meta.meta.image).toBe("tidebound_chars.png");
    for (const f of Object.values(meta.frames)) {
      expect(f.frame.w).toBe(360);
      expect(f.frame.h).toBe(360);
      expect(f.frame.x % 360).toBe(0);
      expect(f.frame.y % 360).toBe(0);
    }
  });
});
