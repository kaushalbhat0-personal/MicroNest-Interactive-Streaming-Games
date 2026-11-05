/**
 * P1D — Lighthouse Keeper atlas integration helpers (pure, headless-safe).
 *
 * Frame names follow the validated P1C atlas (`tidebound_chars`):
 * `keeper_<pose>_side_<nn>` (zero-padded to 2) for the six animation
 * families and `keeper_expr_<name>` for the four portraits. All Phaser
 * API calls stay in `GameScene`; everything here is unit-testable.
 */
import { ART_MANIFEST } from "./assets";

export const KEEPER_ATLAS_KEY = "tb-chars";
export const KEEPER_PNG_URL = "/assets/tidebound/atlases/tidebound_chars.png";
export const KEEPER_JSON_URL = "/assets/tidebound/atlases/tidebound_chars.json";

export type KeeperPose = "idle" | "walk" | "strike" | "shield" | "mend" | "interact";
export type KeeperExpr = "neutral" | "determined" | "concerned" | "hopeful";

export interface KeeperPoseDef {
  frames: number;
  frameRate: number;
  /** -1 loops (idle/walk/shield-hold), 0 plays once then returns to idle. */
  repeat: number;
  oneShot: boolean;
}

export const KEEPER_POSES: Record<KeeperPose, KeeperPoseDef> = {
  // Four approved frames span a calm three-second idle breath cycle.
  idle: { frames: 4, frameRate: 4 / 3, repeat: -1, oneShot: false },
  walk: { frames: 6, frameRate: 6, repeat: -1, oneShot: false },
  strike: { frames: 4, frameRate: 9, repeat: 0, oneShot: true },
  shield: { frames: 3, frameRate: 3, repeat: -1, oneShot: false },
  mend: { frames: 4, frameRate: 5, repeat: 0, oneShot: true },
  interact: { frames: 3, frameRate: 5, repeat: 0, oneShot: true },
};

export const KEEPER_EXPRS: KeeperExpr[] = ["neutral", "determined", "concerned", "hopeful"];

/** Scene-level animation key (distinct from atlas frame names). */
export function keeperAnimKey(pose: KeeperPose): string {
  return `keeper-${pose}`;
}

/** Atlas frame name, e.g. `keeper_idle_side_00`. Throws on bad index. */
export function keeperFrame(pose: KeeperPose, i: number): string {
  const def = KEEPER_POSES[pose];
  if (!Number.isInteger(i) || i < 0 || i >= def.frames) {
    throw new RangeError(`keeperFrame(${pose}, ${i}): 0..${def.frames - 1} only`);
  }
  return `keeper_${pose}_side_${String(i).padStart(2, "0")}`;
}

/** All 24 animation frame names in atlas order (for existence checks). */
export function allKeeperFrames(): string[] {
  const out: string[] = [];
  for (const pose of Object.keys(KEEPER_POSES) as KeeperPose[]) {
    for (let i = 0; i < KEEPER_POSES[pose].frames; i++) out.push(keeperFrame(pose, i));
  }
  return out;
}

export function keeperExprFrame(name: KeeperExpr): string {
  return `keeper_expr_${name}`;
}

/**
 * Persistent pose from authoritative state. Only the shield ward has a
 * state signal (`keepShieldUntil`); there is no movement or bell-ring
 * state in the engine, so walk/interact have no trigger and idle stays
 * the default (reported gap, not inferred).
 */
export function resolveKeeperPose(shieldOn: boolean): KeeperPose {
  return shieldOn ? "shield" : "idle";
}

export interface KeeperResultVisual {
  hitEnemy?: boolean;
  healHero?: boolean;
  shieldKeep?: boolean;
}

/**
 * One-shot pose for a processed game result, or null when the result
 * carries no keeper action. Priority is fixed and documented:
 * strike > mend > shield (one trigger per result).
 */
export function resolveKeeperOneShot(
  visual: KeeperResultVisual | null | undefined,
): KeeperPose | null {
  if (!visual) return null;
  if (visual.hitEnemy) return "strike";
  if (visual.healHero) return "mend";
  if (visual.shieldKeep) return "shield";
  return null;
}

/** True when the scene should switch animations (avoids per-tick restarts). */
export function shouldSwitchAnim(current: string | null, next: string): boolean {
  return current !== next;
}

/**
 * Dev-only animation preview lock (`?keeperPreview=<pose>`).
 * Returns the locked pose, or null in normal play (unknown/empty values
 * also yield null). Pure string logic so it stays unit-testable; the
 * scene only consults it when the flag is present, leaving production
 * priority and state resolution untouched.
 */
export function resolveKeeperPreview(search: string | null | undefined): KeeperPose | null {
  if (!search) return null;
  let v: string | null = null;
  try {
    v = new URLSearchParams(search).get("keeperPreview");
  } catch {
    return null;
  }
  return v !== null && (Object.keys(KEEPER_POSES) as KeeperPose[]).includes(v as KeeperPose)
    ? (v as KeeperPose)
    : null;
}

/** Manifest cross-check: the tb-chars entry must serve our JSON URL. */
export function keeperManifestUrl(): string | null {
  const entry = ART_MANIFEST.atlases.find((a) => a.key === KEEPER_ATLAS_KEY);
  return entry ? entry.jsonUrl : null;
}
