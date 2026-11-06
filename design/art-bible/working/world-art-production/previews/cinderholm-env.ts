import Phaser from "phaser";
import {
  KEEPER_ATLAS_KEY,
  KEEPER_JSON_URL,
  KEEPER_PNG_URL,
  KEEPER_POSES,
  allKeeperFrames,
  keeperAnimKey,
  keeperFrame,
  resolveKeeperPreview,
  type KeeperPose,
} from "../../../../../src/phaser/keeperAnims";
import {
  VESSEL_ATLAS_KEY,
  VESSEL_IDLE_ANIM,
  VESSEL_IDLE_FRAME_RATE,
  VESSEL_IDLE_FRAMES,
  VESSEL_IDLE_REPEAT,
  VESSEL_JSON_URL,
  VESSEL_PNG_URL,
} from "../../../../../src/phaser/vesselAnims";

/**
 * G2-A4 — Cinderholm environment assembly (experimental preview, additive only).
 *
 * Layers the supplied P1 environment art (same-canvas 2096x1184 plates) under
 * the published Keeper/Vessel atlases. No game logic, no authoritative
 * triggers, no GameScene changes: the scene only observes atlas playback.
 * Per-texture existence checks keep primitives as fallback (never blank).
 * `?keeperPreview=<pose>` locks one keeper pose (one-shots replay, mirroring
 * GameScene); default plays the idle loop for motion observation (production
 * holds idle frame 0 — see KEEPER_STATIONARY_POSES).
 */

type Format = "landscape" | "portrait";
const query = new URLSearchParams(location.search);
const format: Format = query.get("format") === "portrait" ? "portrait" : "landscape";
const reduced =
  query.get("reduced") === "1" ||
  (typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches);
const noAtlas = query.get("noatlas") === "1";

const W = format === "landscape" ? 1920 : 1080;
const H = format === "landscape" ? 1080 : 1920;

// Staging verified against measured plate geometry (PIL alpha audit):
// rocks dip to a tidal channel center (~x 780-1060, top ~y 870-900);
// castle cliff meets water right; keeper grounds on the west rock mass.
const STAGE = {
  landscape: {
    seaHorizonY: 690,
    keeper: { x: 641, y: 771, scale: 0.78 },
    vessel: { x: 1053, y: 785, scale: 0.9 },
  },
  portrait: {
    seaHorizonY: 1226,
    keeper: { x: 430, y: 1595, scale: 0.8 },
    vessel: { x: 705, y: 1346, scale: 0.76 },
  },
}[format];

const P1 = "/design/art-bible/working/p1-environment/";

class CinderholmEnvScene extends Phaser.Scene {
  private missing: string[] = [];
  private keeper: Phaser.GameObjects.Sprite | null = null;
  private keeperAnim: string | null = null;
  private keeperPreview: KeeperPose | null = null;
  private vessel: Phaser.GameObjects.Sprite | null = null;

  constructor() {
    super("g2a4-cinderholm-env");
  }

  preload(): void {
    this.load.on("loaderror", (f: { key?: string }) => {
      if (f && typeof f.key === "string") this.missing.push(f.key);
    });
    this.load.image("p1-sky", `${P1}p1-sky/tidebound-sky-1.jpg`);
    this.load.image("p1-mountains", `${P1}p1-farmountains/tidebound-farmountains-1-png.png`);
    this.load.image("p1-castle", `${P1}p1-castlewithlighhouse/tidebound-castle-lighthouse.png`);
    this.load.image("p1-sea", `${P1}p1-waves/tidebound-waves-1.jpg`);
    this.load.image("p1-rocks", `${P1}p1-frontrocks/tidebound-frontstones.png`);
    if (!noAtlas) {
      this.load.atlas(KEEPER_ATLAS_KEY, KEEPER_PNG_URL, KEEPER_JSON_URL);
      this.load.atlas(VESSEL_ATLAS_KEY, VESSEL_PNG_URL, VESSEL_JSON_URL);
    }
  }

  private layer(key: string, depth: number, alpha = 1): Phaser.GameObjects.Image | null {
    if (!this.textures.exists(key)) return null;
    const img = this.add.image(0, 0, key).setOrigin(0).setDisplaySize(W, H).setDepth(depth).setAlpha(alpha);
    return img;
  }

  private fallbackBackdrop(label: string): void {
    const g = this.add.graphics().setDepth(-1);
    g.fillGradientStyle(0x1b2a4a, 0x1b2a4a, 0x0d1b2a, 0x0d1b2a, 1);
    g.fillRect(0, 0, W, H);
    this.add
      .text(W / 2, 40, `G2-A4 fallback: ${label}`, { fontSize: "24px", color: "#ffd166" })
      .setOrigin(0.5, 0)
      .setDepth(10);
  }

  private registerKeeperAnims(): boolean {
    if (!this.textures.exists(KEEPER_ATLAS_KEY)) return false;
    const tex = this.textures.get(KEEPER_ATLAS_KEY);
    for (const f of allKeeperFrames()) {
      if (!tex.has(f)) return false; // incomplete atlas -> primitives stay
    }
    for (const pose of Object.keys(KEEPER_POSES) as KeeperPose[]) {
      const key = keeperAnimKey(pose);
      if (this.anims.exists(key)) continue; // never double-register
      const def = KEEPER_POSES[pose];
      this.anims.create({
        key,
        frames: this.anims.generateFrameNames(KEEPER_ATLAS_KEY, {
          prefix: `keeper_${pose}_side_`,
          start: 0,
          end: def.frames - 1,
          zeroPad: 2,
        }),
        frameRate: def.frameRate,
        repeat: def.repeat,
      });
    }
    return true;
  }

  private playKeeper(pose: KeeperPose): void {
    const sprite = this.keeper;
    if (!sprite) return;
    const key = keeperAnimKey(pose);
    if (!this.anims.exists(key)) return;
    if (this.keeperPreview && pose !== this.keeperPreview) return;
    if (this.keeperAnim === key && sprite.anims.isPlaying) return;
    this.keeperAnim = key;
    if (reduced) {
      sprite.stop();
      sprite.setTexture(KEEPER_ATLAS_KEY, keeperFrame(pose, 0));
      return;
    }
    sprite.play(key);
    if (KEEPER_POSES[pose].oneShot) {
      sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE_KEY, () => {
        if (this.keeperPreview) {
          this.keeperAnim = null;
          this.playKeeper(this.keeperPreview);
          return;
        }
        this.keeperAnim = null;
        this.playKeeper("idle");
      });
    }
  }

  private setupVesselSprite(): boolean {
    if (noAtlas || !this.textures.exists(VESSEL_ATLAS_KEY)) return false;
    const texture = this.textures.get(VESSEL_ATLAS_KEY);
    if (!VESSEL_IDLE_FRAMES.every((frame) => texture.has(frame))) return false;
    try {
      if (!this.anims.exists(VESSEL_IDLE_ANIM)) {
        this.anims.create({
          key: VESSEL_IDLE_ANIM,
          frames: VESSEL_IDLE_FRAMES.map((frame) => ({ key: VESSEL_ATLAS_KEY, frame })),
          frameRate: VESSEL_IDLE_FRAME_RATE,
          repeat: VESSEL_IDLE_REPEAT,
        });
      }
      const v = STAGE.vessel;
      const sprite = this.add
        .sprite(v.x, v.y, VESSEL_ATLAS_KEY, VESSEL_IDLE_FRAMES[0])
        .setOrigin(0.5, 0.86)
        .setScale(v.scale)
        .setDepth(3.5);
      if (reduced) {
        sprite.stop();
        sprite.setTexture(VESSEL_ATLAS_KEY, VESSEL_IDLE_FRAMES[0]);
      } else {
        sprite.play(VESSEL_IDLE_ANIM);
      }
      this.vessel = sprite;
      return true;
    } catch {
      this.vessel = null;
      return false;
    }
  }

  create(): void {
    const present: Record<string, boolean> = {};
    const hasAnyEnv =
      this.textures.exists("p1-sky") ||
      this.textures.exists("p1-mountains") ||
      this.textures.exists("p1-castle") ||
      this.textures.exists("p1-sea") ||
      this.textures.exists("p1-rocks");
    if (!hasAnyEnv) this.fallbackBackdrop("no P1 environment plates");

    // 0 — storm sky (full-bleed JPG; the PNG twin's keyed holes carry fringe).
    const sky = this.layer("p1-sky", 0);
    present["p1-sky"] = !!sky;

    // 1 — far mountain range (alpha band); slow drift = parallax breath.
    const mountains = this.layer("p1-mountains", 1);
    present["p1-mountains"] = !!mountains;
    if (mountains && !reduced) {
      mountains.setDisplaySize(W + 32, H).setOrigin(0.5, 0).setX(W / 2);
      this.tweens.add({ targets: mountains, x: { from: W / 2 - 12, to: W / 2 + 12 }, duration: 26000, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    }

    // 2 — castle headland + cliff landmass (static structure).
    const castle = this.layer("p1-castle", 2);
    present["p1-castle"] = !!castle;

    // 3 — tidal sea, masked to the waterline (cliff meets water below it).
    const seaImg = this.layer("p1-sea", 3);
    present["p1-sea"] = !!seaImg;
    if (seaImg) {
      const maskG = this.add.graphics().setDepth(3);
      maskG.fillRect(0, STAGE.seaHorizonY, W, H - STAGE.seaHorizonY);
      seaImg.setMask(maskG.createGeometryMask());
      // Procedural foam lip at the waterline (no art): softens the mask cut.
      const foam = this.add.graphics().setDepth(3.2);
      foam.fillStyle(0xdfe9f2, 0.35);
      foam.fillRect(0, STAGE.seaHorizonY - 2, W, 4);
      foam.fillStyle(0xdfe9f2, 0.15);
      foam.fillRect(0, STAGE.seaHorizonY + 2, W, 7);
      if (!reduced) {
        this.tweens.add({ targets: foam, alpha: { from: 0.7, to: 1 }, duration: 3200, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      }
    }

    // 4 — foreground shore rocks (in front of sea, behind the keeper).
    const rocks = this.layer("p1-rocks", 4);
    present["p1-rocks"] = !!rocks;

    // 5 — keeper on the west rock mass (contract origin/scale; idle observed).
    const keeperReady = this.registerKeeperAnims();
    if (keeperReady) {
      const k = STAGE.keeper;
      const sprite = this.add
        .sprite(k.x, k.y, KEEPER_ATLAS_KEY, keeperFrame("idle", 0))
        .setOrigin(0.5, 1)
        .setScale(k.scale)
        .setDepth(5);
      this.keeper = sprite;
      this.keeperPreview = noAtlas ? null : resolveKeeperPreview(location.search);
      this.playKeeper(this.keeperPreview ?? "idle");
    } else {
      // Primitive stand-in (never blank): hooded figure marker.
      const k = STAGE.keeper;
      const cloak = this.add.circle(k.x, k.y - 100, 34, 0x43aa8b).setDepth(5);
      const hood = this.add.circle(k.x, k.y - 130, 18, 0x2d6a4f).setDepth(5);
      void hood;
      this.add
        .text(k.x, k.y + 12, noAtlas ? "KEEPER (atlas withheld)" : "KEEPER (atlas missing)", { fontSize: "20px", color: "#ffd166" })
        .setOrigin(0.5, 0)
        .setDepth(6);
      void cloak;
    }

    // 3.5 — gloam vessel riding the inlet (contract origin/scale/loop).
    const vesselReady = this.setupVesselSprite();
    if (!vesselReady) {
      const v = STAGE.vessel;
      this.add.rectangle(v.x, v.y - 40, 210, 84, 0x9d0208).setDepth(3.5);
      this.add
        .text(v.x, v.y + 20, noAtlas ? "VESSEL (atlas withheld)" : "VESSEL (atlas missing)", { fontSize: "20px", color: "#ff8fa3" })
        .setOrigin(0.5, 0)
        .setDepth(6);
    }

    const frameEvents: { actor: string; frame: string; atMs: number }[] = [];
    const startedAt = performance.now();
    const watch = (sprite: Phaser.GameObjects.Sprite | null, actor: string) => {
      sprite?.on(Phaser.Animations.Events.ANIMATION_UPDATE, (_animation, frame) => {
        frameEvents.push({ actor, frame: frame.textureFrame, atMs: Math.round(performance.now() - startedAt) });
      });
    };
    watch(this.keeper, "keeper");
    watch(this.vessel, "vessel");

    const animState = (sprite: Phaser.GameObjects.Sprite | null) => ({
      present: !!sprite,
      key: sprite?.anims.currentAnim?.key ?? null,
      frame: sprite ? sprite.frame?.name ?? null : null,
      playing: sprite ? sprite.anims.isPlaying : false,
      x: sprite?.x ?? null,
      y: sprite?.y ?? null,
    });

    (window as unknown as { __cinderholm?: unknown }).__cinderholm = {
      format,
      reduced,
      noAtlas,
      keeperPreview: this.keeperPreview,
      keeper: animState(this.keeper),
      vessel: animState(this.vessel),
      layers: present,
      loadErrors: this.missing,
      tweens: this.tweens.getTweens().length,
      frameEvents,
    };
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "world",
  width: W,
  height: H,
  backgroundColor: "#0D0A1A",
  render: { antialias: true, pixelArt: false, roundPixels: false },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [CinderholmEnvScene],
});
