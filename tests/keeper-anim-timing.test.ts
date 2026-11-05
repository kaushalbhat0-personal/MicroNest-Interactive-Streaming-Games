/**
 * Keeper animation pacing (smoothness fix).
 * Locks per-pose frame rates and derived loop/one-shot durations so the
 * three-second idle, readable walk, snappy strike, stable shield, calm
 * mend and readable interact pacing cannot regress to the old too-fast
 * values. Pure logic: no Phaser, no DOM.
 */
import { describe, expect, it } from "vitest";
import { KEEPER_POSES, allKeeperFrames, resolveKeeperPreview } from "../src/phaser/keeperAnims";

function durationMs(pose: keyof typeof KEEPER_POSES): number {
  const d = KEEPER_POSES[pose];
  return (d.frames / d.frameRate) * 1000;
}

describe("keeper animation pacing", () => {
  it("uses tuned per-pose frame rates (no global FPS)", () => {
    expect(KEEPER_POSES.idle.frameRate).toBe(4 / 3);
    expect(KEEPER_POSES.walk.frameRate).toBe(6);
    expect(KEEPER_POSES.strike.frameRate).toBe(9);
    expect(KEEPER_POSES.shield.frameRate).toBe(3);
    expect(KEEPER_POSES.mend.frameRate).toBe(5);
    expect(KEEPER_POSES.interact.frameRate).toBe(5);
    // Six poses keep distinct pacing: not one global value.
    expect(new Set(Object.values(KEEPER_POSES).map((d) => d.frameRate)).size).toBeGreaterThan(1);
  });

  it("keeps frame inventory, keys, repeat and one-shot behaviour", () => {
    expect(allKeeperFrames()).toHaveLength(24);
    expect(KEEPER_POSES.idle).toMatchObject({ frames: 4, repeat: -1, oneShot: false });
    expect(KEEPER_POSES.walk).toMatchObject({ frames: 6, repeat: -1, oneShot: false });
    expect(KEEPER_POSES.strike).toMatchObject({ frames: 4, repeat: 0, oneShot: true });
    expect(KEEPER_POSES.shield).toMatchObject({ frames: 3, repeat: -1, oneShot: false });
    expect(KEEPER_POSES.mend).toMatchObject({ frames: 4, repeat: 0, oneShot: true });
    expect(KEEPER_POSES.interact).toMatchObject({ frames: 3, repeat: 0, oneShot: true });
  });

  it("orders durations: strike snappiest, ambient loops calm", () => {
    // Strike stays the fastest one-shot (responsive, impactful).
    expect(durationMs("strike")).toBeLessThan(500);
    expect(durationMs("strike")).toBeLessThan(durationMs("mend"));
    // Four idle drawings span a calm three-second atmospheric cycle.
    expect(durationMs("idle")).toBeCloseTo(3000, 6);
    expect(durationMs("shield")).toBeGreaterThanOrEqual(1000);
    // Walk reads at a natural ~1s stride cycle.
    expect(durationMs("walk")).toBeGreaterThanOrEqual(900);
    expect(durationMs("walk")).toBeLessThanOrEqual(1200);
  });

  it("resolves the dev-only preview lock, null in normal play", () => {
    expect(resolveKeeperPreview(null)).toBeNull();
    expect(resolveKeeperPreview("")).toBeNull();
    expect(resolveKeeperPreview("?foo=1")).toBeNull();
    expect(resolveKeeperPreview("?keeperPreview=bogus")).toBeNull();
    expect(resolveKeeperPreview("?keeperPreview=walk")).toBe("walk");
    for (const pose of ["idle", "walk", "strike", "shield", "mend", "interact"] as const) {
      expect(resolveKeeperPreview(`?keeperPreview=${pose}`)).toBe(pose);
    }
  });
});
