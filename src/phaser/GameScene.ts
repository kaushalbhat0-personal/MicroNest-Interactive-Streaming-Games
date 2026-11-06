import Phaser from "phaser";
import type { FeedEntry } from "../engine/feed";
import type { GameResult, WorldState } from "../engine/types";
import {
  KEEPER_ATLAS_KEY,
  KEEPER_JSON_URL,
  KEEPER_PNG_URL,
  KEEPER_POSES,
  allKeeperFrames,
  keeperAnimKey,
  keeperFrame,
  keeperIsStationaryPose,
  keeperStationaryFrame,
  resolveKeeperOneShot,
  resolveKeeperPose,
  resolveKeeperPreview,
  shouldSwitchAnim,
  type KeeperPose,
} from "./keeperAnims";
import {
  VESSEL_ATLAS_KEY,
  VESSEL_IDLE_ANIM,
  VESSEL_IDLE_FRAME_RATE,
  VESSEL_IDLE_FRAMES,
  VESSEL_IDLE_REPEAT,
  VESSEL_JSON_URL,
  VESSEL_PNG_URL,
} from "./vesselAnims";
import { BERTH_A, PORTRAIT_ENV_STAGING, vesselBobOffset } from "./cinderholmEnv";
import { CinderholmEnvironment } from "./cinderholmEnvRuntime";

const W = 1920;
const H = 1080;
const HORIZON = 660;

// T4C portrait reference composition (format-selected, single scene).
// Landscape stays byte-identical; portrait reframes (not crops/scales).
export type WorldFormat = "landscape" | "portrait";
const PW = 1080;
const PH = 1920;
const PHORIZON = 700;

/** Deterministic 0..1 hash for render-only scatter (stable screenshots). */
function hash01(seed: number): number {
  const v = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * 5H-B — Drowned-archipelago diorama (primitives only, no game logic).
 * The canvas carries the WORLD (sky, sea, lighthouse, reef, vessel);
 * prose (story, feed, votes, deeds) lives in the DOM HUD/panel, so the
 * scene keeps only world-anchored labels and bars. All sync/discrete
 * effects stay state-driven via syncWorld()/playResult().
 */
export class GameScene extends Phaser.Scene {
  // Note (5H-D): the canvas is a pure diorama — world-anchored entity
  // bars/labels only. Titles, threat, supplies and prose live in the DOM
  // (dashboard header/strip, overlay HUD), so nothing collides with them.
  private waves!: Phaser.GameObjects.Graphics;
  private wavePhase = 0;
  private waveDrawAccumulator = 0;
  private chop = 0.5;
  // W1 living environment: procedural drift layers (runtime canvas
  // textures, no new art assets). Created once in create(); never in
  // syncWorld/playResult, so state sync cannot duplicate them.
  private driftFar!: Phaser.GameObjects.TileSprite;
  private driftNear!: Phaser.GameObjects.TileSprite;
  private shimmer!: Phaser.GameObjects.Graphics;
  private mistBanks: Phaser.GameObjects.Ellipse[] = [];
  private beamSweep!: Phaser.GameObjects.Container;
  private beamCore!: Phaser.GameObjects.Graphics;
  private lanternFlicker!: Phaser.GameObjects.Arc;
  private foamCaps: Phaser.GameObjects.Arc[] = [];

  private skyTint!: Phaser.GameObjects.Rectangle;
  private moon!: Phaser.GameObjects.Container;
  private moonDisc!: Phaser.GameObjects.Arc;
  private clouds: Phaser.GameObjects.Ellipse[] = [];

  private lampGlow!: Phaser.GameObjects.Arc;
  private lampCore!: Phaser.GameObjects.Arc;
  private beam!: Phaser.GameObjects.Graphics | Phaser.GameObjects.Image;
  private keepBar!: Phaser.GameObjects.Graphics;
  private keepHpText!: Phaser.GameObjects.Text;
  private keepLabel!: Phaser.GameObjects.Text;
  private shieldBubble!: Phaser.GameObjects.Arc;
  private shieldText!: Phaser.GameObjects.Text;

  private hero!: Phaser.GameObjects.Container;
  private heroBar!: Phaser.GameObjects.Graphics;
  private heroHpText!: Phaser.GameObjects.Text;
  private skiffLantern!: Phaser.GameObjects.Arc;
  // P1D keeper sprite (atlas-gated; primitives stay the fallback).
  private keeperSprite: Phaser.GameObjects.Sprite | null = null;
  private keeperAnim: string | null = null;
  private keeperOneShot = false;
  private keeperShieldOn = false;
  /** Dev-only preview lock (`?keeperPreview=`); null in normal play. */
  private keeperPreview: KeeperPose | null = null;
  private keeperPrimitives: Phaser.GameObjects.Shape[] = [];
  private keeperFlashPrimitive: Phaser.GameObjects.Arc | null = null;

  private reefLanterns: Phaser.GameObjects.Arc[] = [];
  private reefLabel!: Phaser.GameObjects.Text;

  private vessel!: Phaser.GameObjects.Container;
  private vesselBody!: Phaser.GameObjects.Rectangle;
  private vesselSprite: Phaser.GameObjects.Sprite | null = null;
  private vesselLights: Phaser.GameObjects.Arc[] = [];
  private vesselBar!: Phaser.GameObjects.Graphics;
  private vesselHpText!: Phaser.GameObjects.Text;
  private vesselLabel!: Phaser.GameObjects.Text;

  private chapelFlame!: Phaser.GameObjects.Arc;
  private chapelLabel!: Phaser.GameObjects.Text;

  private reducedMotion = false;

  // G2-A6 production environment (visual-only; primitives stay the fallback).
  private cinderholmEnv: CinderholmEnvironment | null = null;
  private envReady = false;
  private envVesselBase = { x: 1420, y: 780 };
  private vesselSunk = false;
  /** Primitive fills hidden while production plates are active. */
  private envPrimitives: Array<{ setVisible(value: boolean): unknown }> = [];

  /** Stash a primitive fill hidden while production plates are active. */
  private stashEnvPrimitive(o: { setVisible(value: boolean): unknown }): void {
    this.envPrimitives.push(o);
  }

  // T4C format-selected composition (default landscape; `?format=portrait`
  // selects the 1080×1920 reframe). WorldState, textures, Keeper/Vessel
  // containers and engine projections are shared; only positions, camera
  // bounds, label sizes and burst anchors change. No second Game instance.
  private format: WorldFormat = "landscape";

  // Addendum static markers: immediate non-animated feedback in reduced
  // motion (impact + heal). Created once, toggled per result, never tweened.
  private impactMarker!: Phaser.GameObjects.Container;
  private impactGlyph!: Phaser.GameObjects.Arc;
  private impactLabel!: Phaser.GameObjects.Text;
  private healMarker!: Phaser.GameObjects.Container;
  private healGlyph!: Phaser.GameObjects.Arc;
  private healLabel!: Phaser.GameObjects.Text;

  constructor() {
    super("game");
  }

  /** T4C: format selection (URL `?format=portrait` or explicit call). */
  setFormat(f: WorldFormat): void {
    this.format = f;
  }

  getFormat(): WorldFormat {
    return this.format;
  }

  private get envPortrait(): boolean {
    return this.envReady && this.isPortrait;
  }

  private get isPortrait(): boolean {
    return this.format === "portrait";
  }

  private get WW(): number {
    return this.isPortrait ? PW : W;
  }

  private get WH(): number {
    return this.isPortrait ? PH : H;
  }

  private get HZ(): number {
    return this.isPortrait ? PHORIZON : HORIZON;
  }

  /** Burst/effect anchors follow the active composition (never clipped). */
  private hitAnchor(): { x: number; y: number } {
    if (this.envPortrait) return { x: 625, y: 1300 };
    return this.isPortrait ? { x: 820, y: 680 } : { x: 1420, y: 740 };
  }

  private healAnchor(): { x: number; y: number } {
    if (this.envPortrait) return { x: 452, y: 1600 };
    return this.isPortrait ? { x: 540, y: 880 } : { x: 720, y: 820 };
  }

  private reefAnchor(): { x: number; y: number } {
    if (this.envPortrait) {
      const lit = this.reefLanterns?.find((l) => l.fillColor !== 0xffd166);
      return lit ? { x: lit.x, y: lit.y } : { x: 800, y: 1300 };
    }
    if (this.isPortrait) {
      const lit = this.reefLanterns?.find((l) => l.fillColor !== 0xffd166);
      return lit ? { x: lit.x, y: lit.y } : { x: 540, y: 1150 };
    }
    const lit = this.reefLanterns?.find((l) => l.fillColor !== 0xffd166);
    return lit ? { x: lit.x, y: lit.y } : { x: 1050, y: 860 };
  }

  private storyAnchor(): { x: number; y: number } {
    return this.isPortrait ? { x: 540, y: 400 } : { x: 960, y: 420 };
  }

  preload(): void {
    // P1D: keeper atlas. A missing file only fails this load; create()
    // keeps primitives whenever the texture is absent (never blank).
    this.load.atlas(KEEPER_ATLAS_KEY, KEEPER_PNG_URL, KEEPER_JSON_URL);
    this.load.atlas(VESSEL_ATLAS_KEY, VESSEL_PNG_URL, VESSEL_JSON_URL);
    // Format + reduced-motion resolve here so preload can queue the
    // environment plates for the boot composition (create reuses them).
    try {
      const params = new URLSearchParams(window.location.search);
      this.format = params.get("format") === "portrait" ? "portrait" : "landscape";
    } catch {
      this.format = "landscape";
    }
    this.reducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // G2-A6: visual-only environment plates (WebP primary, fallback on
    // error). Missing textures keep the primitive diorama in create().
    let search = "";
    try {
      search = window.location.search;
    } catch {
      search = "";
    }
    this.cinderholmEnv = new CinderholmEnvironment(this.format, this.reducedMotion, search);
    this.cinderholmEnv.preload(this);
  }

  create(): void {
    // Scene restarts re-run create on the same instance: reset
    // environment staging so pools/flags can never double-drive.
    this.envPrimitives = [];
    this.vesselSunk = false;
    this.envReady = ["env-sky", "env-mountains", "env-castle", "env-sea", "env-rocks"].every((k) =>
      this.textures.exists(k),
    );
    this.envVesselBase = this.isPortrait
      ? this.envReady ? { x: PORTRAIT_ENV_STAGING.vessel.x, y: PORTRAIT_ENV_STAGING.vessel.y } : { x: 820, y: 720 }
      : { x: BERTH_A.x, y: BERTH_A.y };

    // Shared 8px dot texture for particles.
    if (!this.textures.exists("px")) {
      const px = this.textures.createCanvas("px");
      if (px) {
        const ctx = px.getContext();
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, 8, 8);
        px.refresh();
      }
    }

    this.buildSky();
    this.buildSea();
    this.buildSeaDrift();
    this.buildCinderholm();
    this.buildSkiff();
    this.buildReef();
    this.buildVessel();
    this.buildChapelBrazier();
    this.buildEyebrow();
    this.buildStaticMarkers();
    this.buildMist();

    // Ambient sea spray (behind entities; skipped under production plates).
    if (this.textures.exists("px") && !this.reducedMotion && !this.envReady) {
      const spray = this.add.particles(0, 0, "px", {
        x: { min: 0, max: this.isPortrait ? 440 : 680 },
        y: { min: this.HZ + 35, max: Math.min(this.HZ + 340, this.WH - 60) },
        lifespan: 2600,
        speedY: { min: -32, max: -10 },
        speedX: { min: -9, max: 10 },
        scale: { min: 0.12, max: 0.32 },
        alpha: { min: 0.04, max: 0.18 },
        tint: [0x90e0ef, 0xb9b3c7, 0x43aa8b],
        frequency: 850,
      });
      spray.setDepth(1);
    }

    this.cameras.main.setBounds(0, 0, this.WW, this.WH);

    // G2-A6: build production plates (no-op fallback when textures miss),
    // hide the primitive fills they replace, and arm SHUTDOWN disposal so
    // repeated scene creation/destruction can never double-drive pools.
    const envOn = this.cinderholmEnv?.create(this, this.WW, this.WH) ?? false;
    this.envReady = this.envReady && envOn;
    if (this.envReady) {
      for (const o of this.envPrimitives) o.setVisible(false);
    }
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.cinderholmEnv?.dispose();
      this.cinderholmEnv = null;
    });
  }

  update(_time: number, delta: number): void {
    if (this.reducedMotion) return;
    this.wavePhase += delta * 0.00072;
    this.waveDrawAccumulator += delta;
    if (this.waveDrawAccumulator >= 100) {
      this.waveDrawAccumulator %= 100;
      this.drawWaves();
    }
    // TileSprite offsets are the only per-frame sea mutation; clouds, mist,
    // beacon and light pulses are scene-owned Phaser tweens.
    if (this.driftFar) this.driftFar.tilePositionX += delta * 0.0024;
    if (this.driftNear) this.driftNear.tilePositionX -= delta * 0.0034;
    // G2-A6: production environment advance (zero-tween sine phase) + berth
    // bob around the approved staging. Skipped while the vessel is sunk
    // (syncWorld owns the repelled rest pose).
    if (this.cinderholmEnv && this.cinderholmEnv.active) {
      this.cinderholmEnv.update(delta);
      // The bob owns vessel position only while effect motion runs; a
      // frozen clock (fx=0) or repelled rest pose keeps the staged base.
      const bobOn = this.cinderholmEnv.ctl.enabled.motion && !this.cinderholmEnv.fxDisabled;
      if (!this.vesselSunk && bobOn) {
        const o = vesselBobOffset(this.cinderholmEnv.envTime, this.cinderholmEnv.ctl.current.bob);
        this.vessel.setPosition(this.envVesselBase.x + o.x, this.envVesselBase.y + o.y);
        this.vessel.setAngle((o.rotation * 180) / Math.PI);
      } else if (!this.vesselSunk) {
        this.vessel.setPosition(this.envVesselBase.x, this.envVesselBase.y);
        this.vessel.setAngle(0);
      }
    }
  }

  // ---------- state sync (called by app after every pump/tick) ----------

  syncWorld(w: WorldState, _storyLatest: string[], _feed: FeedEntry[]): void {
    // Sea chop + sky pressure follow the threat (state-driven weather).
    this.chop = 0.35 + (w.threatLevel / 100) * 0.9;
    const drivenOff = w.storyFlags["c.vex.driven-off"] === true;
    const vexMet = w.storyFlags["c.vex.met"] === true;
    if (drivenOff) {
      this.skyTint.setFillStyle(0xffd166, 0.07);
      this.moonDisc.setFillStyle(0xfff3d6, 0.95);
    } else if (vexMet || w.enemy.isElite) {
      this.skyTint.setFillStyle(0xe63946, 0.1 + (w.threatLevel / 100) * 0.12);
      this.moonDisc.setFillStyle(0xff8fa3, 0.95);
    } else {
      this.skyTint.setFillStyle(0xe63946, (w.threatLevel / 100) * 0.08);
      this.moonDisc.setFillStyle(0xf4efe4, 0.95);
    }

    // Cinderholm condition drives the lantern (lighthouse anchor).
    const cinder = w.locationState["cinderholm"] ?? "sound";
    if (this.cinderholmEnv && this.cinderholmEnv.active) {
      this.cinderholmEnv.applyGrade(w.threatLevel, cinder, drivenOff);
    }
    if (cinder === "lost") {
      this.lampCore.setFillStyle(0x4a4360, 1);
      this.lampGlow.setFillStyle(0x4a4360, 0.1).setVisible(true);
      this.lanternFlicker.setFillStyle(0x4a4360, 0.12).setVisible(true);
      this.beam.setVisible(false);
      this.beamCore.setVisible(false);
    } else {
      this.beam.setVisible(true);
      this.beamCore.setVisible(true);
      this.lanternFlicker.setFillStyle(0xfff3d6, 0.5).setVisible(true);
      if (cinder === "strained") {
        this.lampCore.setFillStyle(0xf4a261, 1);
        this.lampGlow.setFillStyle(0xf4a261, 0.22).setVisible(true);
        this.beam.setAlpha(0.07);
      } else {
        this.lampCore.setFillStyle(0xffd166, 1);
        this.lampGlow.setFillStyle(0xffd166, 0.28).setVisible(true);
        this.beam.setAlpha(0.13);
      }
    }

    // Keep / hero / vessel bars + labels (world-anchored, compact).
    // T4C: keep bar moved east (x205 → x340) to clear the left HUD rail
    // (x20–324); labels ride centered above the bar (cx 435).
    // Portrait reframe anchors below (isPortrait branch).
    const EP = this.envPortrait;
    const keepBarX = this.isPortrait ? 445 : 340;
    const keepBarY = this.isPortrait ? 640 : 592;
    const heroBarX = this.isPortrait ? (EP ? 362 : 448) : 628;
    const heroBarY = this.isPortrait ? (EP ? 1745 : 1026) : 926;
    const vesselBarX = this.isPortrait ? (EP ? 525 : 720) : 1280;
    const vesselBarY = EP ? 1225 : 566;
    this.drawBar(this.keepBar, keepBarX, keepBarY, 190, w.keepHp, w.maxKeepHp, 0x90be6d);
    this.keepHpText.setText(`Keep ${w.keepHp}/${w.maxKeepHp}`);
    this.keepLabel.setText(cinder === "lost" ? "CINDERHOLM · FALLEN" : "CINDERHOLM");
    this.keepLabel.setColor(cinder === "lost" ? "#ff8fa3" : cinder === "strained" ? "#ffd166" : "#edf2f4");

    this.drawBar(this.heroBar, heroBarX, heroBarY, 184, w.heroHp, w.maxHeroHp, 0x43aa8b);
    this.heroHpText.setText(`Keeper ${w.heroHp}/${w.maxHeroHp}`);

    const sunk = w.enemy.hp <= 0;
    this.vesselSunk = sunk;
    this.drawBar(this.vesselBar, vesselBarX, vesselBarY, 200, Math.max(0, w.enemy.hp), w.enemy.maxHp, 0xe63946);
    this.vesselHpText.setText(sunk ? "REPELLED" : `${w.enemy.hp}/${w.enemy.maxHp}`);
    this.vesselLabel.setText(w.enemy.isElite ? `ELITE · ${w.enemy.name}` : w.enemy.name);
    this.vesselBody.setFillStyle(w.enemy.isElite ? 0x6a040f : 0x9d0208);
    const vesselHomeY = this.isPortrait ? (this.envPortrait ? 1385 : 720) : 800;
    this.vessel.setAlpha(sunk ? 0.45 : 1).setAngle(sunk ? 9 : 0).setY(sunk ? vesselHomeY + 32 : vesselHomeY);
    for (const l of this.vesselLights) l.setVisible(!sunk);

    // Pale reef lanterns: exploration progress made visible.
    const lit = w.uniqueSearchers.length;
    for (let i = 0; i < this.reefLanterns.length; i++) {
      const on = i < lit;
      this.reefLanterns[i].setFillStyle(on ? 0xffd166 : 0x3a3454, 1);
      this.reefLanterns[i].setAlpha(on ? 1 : 0.7);
    }
    this.reefLabel.setText(`PALE REACHES · LANTERNS ${Math.min(lit, 5)}/5`);

    // Chapel brazier follows chapel-steps condition.
    const chapel = w.locationState["chapel-steps"] ?? "sound";
    this.chapelFlame.setFillStyle(chapel === "lost" ? 0x4a4360 : chapel === "strained" ? 0xf4a261 : 0xff9a3c);
    this.chapelLabel.setText(
      chapel === "lost" ? "CHAPEL STEPS · DARK" : chapel === "strained" ? "CHAPEL STEPS · FLICKERING" : "CHAPEL STEPS",
    );

    const shieldOn = Date.now() < w.keepShieldUntil;
    this.shieldBubble.setVisible(shieldOn);
    this.shieldText.setVisible(shieldOn);
    // P1D: persistent keeper pose follows the ward (idle otherwise).
    this.keeperShieldOn = shieldOn;
    this.playKeeper(resolveKeeperPose(shieldOn));
  }

  // ---------- effects (one per processed result) ----------

  playResult(r: GameResult): void {
    // Addendum: reduced motion replaces transient movement with immediate
    // static distinct states (same state changes, text + symbol, no tween /
    // shake / flash / particles). Normal motion below is unchanged.
    if (this.reducedMotion) {
      const oneShot = resolveKeeperOneShot(r.visual);
      if (oneShot) this.playKeeper(oneShot);
      if (r.visual.hitEnemy) {
        const p = this.hitAnchor();
        this.showImpactStatic(p.x, p.y, "✖ HIT");
      }
      if (r.visual.healHero) {
        const p = this.healAnchor();
        this.showHealStatic(p.x, p.y);
      }
      if (r.visual.shieldKeep) {
        // Persistent ward indicator (syncWorld owns visibility); static beam.
        this.shieldBubble.setVisible(true);
        this.shieldText.setVisible(true);
        this.beam.setVisible(true);
        this.beamCore.setVisible(true);
        this.beam.setAlpha(0.24);
      }
      if (r.visual.spawnElite || r.visual.spawnWave) {
        // Arrival: enemy appears immediately at full scale with readable
        // label (syncWorld already sets label/HP); no growth or flash.
        this.vessel.setScale(1);
      }
      if (r.visual.discovery) {
        const p = this.reefAnchor();
        this.showImpactStatic(p.x, p.y, "◆ CHARTED");
      }
      if (r.visual.majorStory) {
        const p = this.storyAnchor();
        this.showImpactStatic(p.x, p.y, "✦ STORY");
      }
      if (r.visual.hitHero) {
        const p = this.healAnchor();
        this.showImpactStatic(p.x, p.y, "✖ HIT");
      }
      return;
    }
    // P1D: one-shot keeper action for this result (no-op without atlas).
    const oneShot = resolveKeeperOneShot(r.visual);
    if (oneShot) this.playKeeper(oneShot);
    if (r.visual.shake) this.cameras.main.shake(180, 0.006);
    if (r.visual.hitEnemy) {
      if (this.vesselSprite?.visible) {
        const sprite = this.vesselSprite;
        sprite.setTintFill(0xffffff);
        this.time.delayedCall(120, () => {
          if (sprite.active) sprite.clearTint();
        });
      } else {
        this.flash(this.vesselBody, 0xffffff);
      }
      // The production bob owns vessel position; skip the shake tween there.
      if (!this.cinderholmEnv?.active) {
        this.tweens.add({ targets: this.vessel, x: "+=18", duration: 70, yoyo: true, repeat: 3 });
      }
      const p = this.hitAnchor();
      this.burst(p.x, p.y, 0xffd166);
    }
    if (r.visual.healHero) {
      const p = this.healAnchor();
      this.burst(p.x, p.y + 20, 0x43ff9a);
      // W1-R: the Keeper container holds position (no scale pulse); the
      // stern-lantern flare below carries the heal read.
      this.tweens.add({ targets: this.skiffLantern, scale: 1.8, duration: 220, yoyo: true });
    }
    if (r.visual.shieldKeep) {
      this.shieldBubble.setVisible(true);
      this.shieldText.setVisible(true);
      this.beam.setAlpha(0.24);
      this.time.delayedCall(900, () => this.beam.setAlpha(0.13));
    }
    if (r.visual.spawnElite || r.visual.spawnWave) {
      this.vessel.setScale(0.25);
      this.tweens.add({ targets: this.vessel, scale: 1, duration: 520, ease: "Back.easeOut" });
      const p = this.hitAnchor();
      this.burst(p.x, p.y, 0xff0054);
      this.cameras.main.flash(220, 230, 57, 70);
    }
    if (r.visual.discovery) {
      const p = this.reefAnchor();
      this.burst(p.x, p.y, 0x90e0ef);
    }
    if (r.visual.majorStory) {
      this.cameras.main.flash(300, 255, 209, 102);
      const p = this.storyAnchor();
      this.burst(p.x, p.y, 0xffd166);
    }
    if (r.visual.hitHero) {
      if (this.keeperSprite && this.keeperSprite.visible) {
        this.keeperSprite.setTintFill(0xff0000);
        const sprite = this.keeperSprite;
        this.time.delayedCall(120, () => sprite.clearTint());
      } else if (this.keeperFlashPrimitive) {
        this.flash(this.keeperFlashPrimitive, 0xff0000);
      }
    }
  }

  // ---------- builders ----------

  private buildSky(): void {
    const WW = this.WW;
    const HZ = this.HZ;
    const P = this.isPortrait;
    const bg = this.add.graphics().setDepth(0);
    this.stashEnvPrimitive(bg);
    bg.fillGradientStyle(0x0d0a1a, 0x0d0a1a, 0x2a1a4d, 0x16324a, 1);
    bg.fillRect(0, 0, WW, HZ + 2);
    // Storm bands.
    bg.fillStyle(0x1a1033, 0.85);
    if (P) bg.fillEllipse(300, 220, 700, 150);
    else bg.fillEllipse(420, 240, 900, 150);
    bg.fillStyle(0x241640, 0.9);
    if (P) bg.fillEllipse(700, 330, 700, 170);
    else bg.fillEllipse(1250, 330, 1100, 170);

    // Stars (deterministic scatter, upper sky only).
    for (let i = 0; i < 80; i++) {
      const x = hash01(i * 3 + 1) * WW;
      const y = hash01(i * 7 + 2) * 360;
      const a = 0.25 + hash01(i * 13 + 5) * 0.55;
      this.stashEnvPrimitive(this.add.circle(x, y, hash01(i + 9) > 0.8 ? 2.4 : 1.4, 0xf4efe4, a).setDepth(0));
    }

    // Moon + halo (portrait recentered to x~800 y180).
    this.moon = this.add.container(P ? 800 : 1560, 175).setDepth(1);
    this.stashEnvPrimitive(this.moon);
    const halo = this.add.circle(0, 0, 74, 0xf4efe4, 0.1);
    this.moonDisc = this.add.circle(0, 0, 46, 0xf4efe4, 0.95);
    const shade = this.add.circle(-14, -10, 40, 0x0d0a1a, 0.16);
    this.moon.add([halo, this.moonDisc, shade]);

    // Drifting storm clouds.
    const cloudDefs: Array<[number, number, number, number]> = P
      ? [
          [250, 180, 400, 90],
          [540, 260, 500, 110],
          [850, 340, 380, 90],
        ]
      : [
          [380, 150, 560, 110],
          [1050, 220, 700, 130],
          [1620, 300, 520, 110],
        ];
    for (const [x, y, cw, ch] of cloudDefs) {
      const c = this.add.ellipse(x, y, cw, ch, 0x141021, 0.38).setDepth(1);
      this.stashEnvPrimitive(c);
      this.clouds.push(c);
      if (!this.reducedMotion && !this.envReady) {
        this.tweens.add({ targets: c, x: x + 22, alpha: 0.44, duration: 32000 + x * 3, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      }
    }
    // W1: far cloud plane (fainter, slower) for two-plane parallax depth.
    // Kept behind the lighthouse/entities; drift only, no gameplay meaning.
    const farCloudDefs: Array<[number, number, number, number]> = P
      ? [
          [180, 120, 320, 60],
          [820, 150, 360, 70],
        ]
      : [
          [600, 90, 480, 80],
          [1400, 130, 560, 90],
        ];
    for (const [x, y, cw, ch] of farCloudDefs) {
      const c = this.add.ellipse(x, y, cw, ch, 0x1c1440, 0.26).setDepth(0);
      this.stashEnvPrimitive(c);
      this.clouds.push(c);
      if (!this.reducedMotion && !this.envReady) {
        this.tweens.add({ targets: c, x: x + 34, alpha: 0.32, duration: 48000 + x * 3, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      }
    }

    // Distant drowned silhouettes on the horizon.
    const far = this.add.graphics().setDepth(1);
    this.stashEnvPrimitive(far);
    far.fillStyle(0x1c1440, 1);
    if (P) {
      far.fillEllipse(400, HZ + 6, 500, 120);
      far.fillEllipse(800, HZ + 8, 500, 130);
      far.fillStyle(0x141021, 1);
      far.fillTriangle(340, HZ, 400, HZ - 110, 460, HZ);
      far.fillTriangle(740, HZ, 815, HZ - 130, 890, HZ);
    } else {
      far.fillEllipse(760, HORIZON + 6, 620, 120);
      far.fillEllipse(1560, HORIZON + 8, 700, 130);
      far.fillStyle(0x141021, 1);
      far.fillTriangle(700, HORIZON, 760, HORIZON - 110, 820, HORIZON);
      far.fillTriangle(1500, HORIZON, 1575, HORIZON - 130, 1650, HORIZON);
    }

    // State-driven sky pressure tint (alpha set in syncWorld).
    this.skyTint = this.add.rectangle(0, 0, WW, HZ).setOrigin(0, 0).setDepth(2);
    this.skyTint.setFillStyle(0xe63946, 0);
  }

  private buildSea(): void {
    const WW = this.WW;
    const WH = this.WH;
    const HZ = this.HZ;
    const P = this.isPortrait;
    const sea = this.add.graphics().setDepth(1);
    this.stashEnvPrimitive(sea);
    sea.fillGradientStyle(0x16324a, 0x16324a, 0x0b1626, 0x0b1626, 1);
    sea.fillRect(0, HZ, WW, WH - HZ);
    // Moon road.
    sea.fillStyle(0xf4efe4, 0.07);
    if (P) {
      sea.fillTriangle(520, HZ, 640, HZ, 740, WH);
      sea.fillTriangle(520, HZ, 740, WH, 420, WH);
    } else {
      sea.fillTriangle(1500, HORIZON, 1620, HORIZON, 1720, H);
      sea.fillTriangle(1500, HORIZON, 1720, H, 1400, H);
    }
    // Horizon glow line.
    sea.lineStyle(2, 0xffd166, 0.28);
    sea.lineBetween(0, HZ, WW, HZ);
    this.waves = this.add.graphics().setDepth(2);
    this.drawWaves();
  }

  private drawWaves(): void {
    const g = this.waves;
    if (!g) return;
    // Production plates carry their own sea motion; never redraw over them.
    if (this.envReady) return;
    const WW = this.WW;
    const HZ = this.HZ;
    g.clear();
    const rowCount = this.isPortrait ? 6 : 5;
    const strokesPerRow = this.isPortrait ? 11 : 17;
    const stepY = this.isPortrait ? 118 : 92;
    for (let row = 0; row < rowCount; row++) {
      const yBase = HZ + 36 + row * stepY;
      const alpha = Math.max(0.045, 0.13 - row * 0.014);
      const color = row % 3 === 0 ? 0x90e0ef : row % 3 === 1 ? 0xb9b3c7 : 0x68869a;
      for (let stroke = 0; stroke < strokesPerRow; stroke++) {
        const seed = row * 101 + stroke * 13 + (this.isPortrait ? 29 : 7);
        const x0 = hash01(seed) * WW;
        const length = (26 + hash01(seed + 2) * 84) * (this.isPortrait ? 0.78 : 1);
        const amp = (1.2 + hash01(seed + 4) * 2.4) * this.chop;
        const phase = this.wavePhase * (0.65 + row * 0.08) + seed * 0.17;
        g.lineStyle(row % 4 === 0 ? 2 : 1.5, color, alpha);
        g.beginPath();
        for (let point = 0; point <= 4; point++) {
          const x = x0 + (length * point) / 4;
          if (x > WW) break;
          const y = yBase + Math.sin(x * 0.018 + phase) * amp + Math.sin(point * 1.4 + phase) * 0.7;
          if (point === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.strokePath();
      }
    }
  }

  // ---------- W1 living environment (procedural, rights-clean) ----------

  /** Runtime canvas strip textures (seamless by construction: wrapped dashes). */
  private makeDriftTextures(): void {
    if (!this.textures.exists("beaconsoft")) {
      const t = this.textures.createCanvas("beaconsoft", 960, 256);
      if (t) {
        const ctx = t.getContext();
        ctx.clearRect(0, 0, 960, 256);
        ctx.save();
        ctx.filter = "blur(18px)";
        ctx.fillStyle = "rgba(255,209,102,0.82)";
        ctx.beginPath();
        ctx.moveTo(0, 108);
        ctx.lineTo(960, 0);
        ctx.lineTo(960, 256);
        ctx.lineTo(0, 148);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        const distance = ctx.createLinearGradient(0, 128, 960, 128);
        distance.addColorStop(0, "rgba(255,255,255,0.82)");
        distance.addColorStop(0.24, "rgba(255,255,255,0.56)");
        distance.addColorStop(0.72, "rgba(255,255,255,0.2)");
        distance.addColorStop(1, "rgba(255,255,255,0)");
        ctx.globalCompositeOperation = "destination-in";
        ctx.fillStyle = distance;
        ctx.fillRect(0, 0, 960, 256);
        ctx.globalCompositeOperation = "source-over";
        t.refresh();
      }
    }
    if (!this.textures.exists("foamstrip")) {
      const t = this.textures.createCanvas("foamstrip", 256, 32);
      if (t) {
        const ctx = t.getContext();
        ctx.clearRect(0, 0, 256, 32);
        ctx.fillStyle = "rgba(244,239,228,0.85)";
        // Wrapped dash row: period 64px divides 256 → seamless horizontal tile.
        for (let x = 8; x < 256; x += 64) {
          ctx.fillRect(x, 10, 34, 3);
          ctx.fillRect(x + 40, 20, 20, 2);
        }
        t.refresh();
      }
    }
    if (!this.textures.exists("swellband")) {
      const t = this.textures.createCanvas("swellband", 256, 64);
      if (t) {
        const ctx = t.getContext();
        ctx.clearRect(0, 0, 256, 64);
        // Soft swell shading: vertical gradient block (x-invariant → seamless).
        const grad = ctx.createLinearGradient(0, 0, 0, 64);
        grad.addColorStop(0, "rgba(61,90,128,0)");
        grad.addColorStop(0.5, "rgba(61,90,128,0.5)");
        grad.addColorStop(1, "rgba(22,50,74,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 256, 64);
        t.refresh();
      }
    }
  }

  /**
   * Two opposing TileSprite drift layers over the sea (offset drift only).
   * Static under reduced motion. Never gameplay state.
   */
  private buildSeaDrift(): void {
    this.makeDriftTextures();
    // Production plates carry their own sea motion (zero duplicate drivers).
    if (this.envReady) return;
    const WW = this.WW;
    const WH = this.WH;
    const HZ = this.HZ;
    const seaH = WH - HZ;
    if (this.textures.exists("swellband")) {
      this.driftFar = this.add.tileSprite(0, HZ + seaH * 0.25, WW, 64, "swellband").setOrigin(0, 0.5).setDepth(2).setAlpha(0.28);
    }
    if (this.textures.exists("foamstrip")) {
      this.driftNear = this.add.tileSprite(0, HZ + seaH * 0.62, WW, 32, "foamstrip").setOrigin(0, 0.5).setDepth(2).setAlpha(0.16);
    }
    // Moon-road shimmer: short broken gold dashes under the moon column.
    this.shimmer = this.add.graphics().setDepth(2);
    const mx = this.isPortrait ? 580 : 1560;
    this.shimmer.fillStyle(0xffd166, 1);
    for (let i = 0; i < 6; i++) {
      const y = HZ + 40 + i * 52;
      const wob = ((i * 37) % 40) - 20;
      this.shimmer.fillRect(mx - 46 + wob, y, 92 - (i % 3) * 18, 3);
    }
    this.shimmer.setAlpha(0.1);
    if (!this.reducedMotion) {
      this.tweens.add({ targets: this.shimmer, alpha: 0.17, duration: 7200, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    }
  }

  /**
   * Low coastal mist banks + horizon haze (large soft ellipses, slow drift).
   * Depth 2–3, always behind entities (depth 4+). Static under reduced motion.
   */
  private buildMist(): void {
    // Production mist layer replaces these banks (no duplicate motion).
    if (this.envReady) return;
    const HZ = this.HZ;
    const P = this.isPortrait;
    const banks: Array<[number, number, number, number, number]> = P
      ? [
          [260, HZ + 120, 520, 90, 0.07],
          [800, HZ + 260, 560, 100, 0.06],
          [540, HZ - 30, 700, 70, 0.08],
        ]
      : [
          [500, HZ + 130, 700, 100, 0.07],
          [1300, HZ + 260, 800, 110, 0.06],
          [960, HZ - 30, 1100, 80, 0.08],
        ];
    this.mistBanks = [];
    for (let i = 0; i < banks.length; i++) {
      const [x, y, w, h, a] = banks[i];
      const m = this.add.ellipse(x, y, w, h, 0xb9b3c7, a * 0.7).setDepth(2 + (i % 2));
      this.mistBanks.push(m);
      if (!this.reducedMotion) {
        this.tweens.add({ targets: m, x: x + (i % 2 === 0 ? 38 : -38), alpha: a * 0.85, duration: 32000 + i * 7000, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      }
    }
  }

  private buildCinderholm(): void {
    const P = this.isPortrait;
    // Island center: landscape (300,760) / portrait (540,560) upper-third.
    const icx = P ? 540 : 300;
    const icy = P ? 560 : 760;
    // Island rock + cliffs.
    const rock = this.add.graphics().setDepth(2);
    this.stashEnvPrimitive(rock);
    rock.fillStyle(0x1c2233, 1);
    rock.fillEllipse(icx, icy, 560, 210);
    rock.fillStyle(0x2b3448, 1);
    rock.fillEllipse(P ? 520 : 280, P ? 530 : 730, 460, 150);
    rock.lineStyle(3, 0x90e0ef, 0.22);
    rock.strokeEllipse(icx, icy, 560, 210);

    // Keep walls + lighthouse tower (the lantern anchor).
    const keep = this.add.graphics().setDepth(3);
    this.stashEnvPrimitive(keep);
    if (P) {
      keep.fillStyle(0x3a4358, 1); // curtain wall
      keep.fillRect(440, 500, 200, 130);
      keep.fillStyle(0x8d99ae, 1); // tower
      keep.fillRect(485, 290, 110, 260);
      keep.fillStyle(0x6c757d, 1); // gallery trim
      keep.fillRect(475, 270, 130, 26);
      keep.fillStyle(0x2b2d42, 1); // gate
      keep.fillRect(516, 560, 48, 70);
      // Crenellations.
      keep.fillStyle(0x8d99ae, 1);
      for (let i = 0; i < 4; i++) keep.fillRect(448 + i * 52, 478, 30, 24);
      // Tower window slits.
      keep.fillStyle(0x1a1033, 1);
      keep.fillRect(532, 330, 16, 40);
      keep.fillRect(532, 400, 16, 40);
      // Lantern room glass.
      keep.fillStyle(0x90e0ef, 0.85);
      keep.fillRect(492, 232, 96, 40);
    } else {
      keep.fillStyle(0x3a4358, 1); // curtain wall
      keep.fillRect(120, 640, 200, 130);
      keep.fillStyle(0x8d99ae, 1); // tower
      keep.fillRect(245, 430, 110, 260);
      keep.fillStyle(0x6c757d, 1); // gallery trim
      keep.fillRect(235, 410, 130, 26);
      keep.fillStyle(0x2b2d42, 1); // gate
      keep.fillRect(196, 700, 48, 70);
      // Crenellations.
      keep.fillStyle(0x8d99ae, 1);
      for (let i = 0; i < 4; i++) keep.fillRect(128 + i * 52, 618, 30, 24);
      // Tower window slits.
      keep.fillStyle(0x1a1033, 1);
      keep.fillRect(292, 470, 16, 40);
      keep.fillRect(292, 540, 16, 40);
      // Lantern room glass.
      keep.fillStyle(0x90e0ef, 0.85);
      keep.fillRect(252, 372, 96, 40);
    }

    // Light beam (alpha pulsed in sync/effects; static under reduced motion).
    // The lamp-relative pivot keeps the subtle sweep attached to the tower.
    const lampX = P ? 540 : 300;
    const lampY = P ? 252 : 392;
    if (this.textures.exists("beaconsoft")) {
      this.beam = this.add.image(P ? 0 : 50, 0, "beaconsoft").setOrigin(0, 0.5).setScale(P ? 0.56 : 0.9).setAlpha(0.13);
    } else {
      const wedge = this.add.graphics();
      wedge.fillStyle(0xffd166, 1);
      if (P) {
        wedge.fillTriangle(0, -12, 0, 12, 520, -90);
        wedge.fillTriangle(0, -12, 0, 12, 520, 90);
      } else {
        wedge.fillTriangle(50, -12, 50, 12, 900, -100);
        wedge.fillTriangle(50, -12, 50, 12, 900, 100);
      }
      this.beam = wedge.setAlpha(0.13);
    }
    // Beam core: narrower brighter strip over the soft cone.
    this.beamCore = this.add.graphics();
    this.beamCore.fillStyle(0xfff3d6, 1);
    if (P) {
      this.beamCore.fillTriangle(0, -5, 0, 5, 260, -38);
      this.beamCore.fillTriangle(0, -5, 0, 5, 260, 44);
    } else {
      this.beamCore.fillTriangle(50, -5, 50, 5, 850, -60);
      this.beamCore.fillTriangle(50, -5, 50, 5, 850, 60);
    }
    this.beamCore.setAlpha(0.055);
    this.beamSweep = this.add.container(lampX, lampY, [this.beam, this.beamCore]);
    this.beamSweep.setDepth(2);
    this.stashEnvPrimitive(this.beamSweep);
    if (!this.reducedMotion && !this.envReady) {
      // Slow bounded sweep (subtle at 4 FPS capture; never full rotation).
      this.tweens.add({ targets: this.beamSweep, angle: 2.2, duration: 20000, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      this.tweens.add({ targets: this.beamCore, alpha: 0.085, duration: 6800, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    }

    this.lampGlow = this.add.circle(lampX, lampY, 46, 0xffd166, 0.28).setDepth(4);
    this.stashEnvPrimitive(this.lampGlow);
    this.lampCore = this.add.circle(lampX, lampY, 15, 0xffd166, 1).setDepth(5);
    this.stashEnvPrimitive(this.lampCore);
    if (!this.reducedMotion && !this.envReady) {
      this.tweens.add({ targets: this.lampGlow, scale: 1.25, alpha: 0.16, duration: 1400, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    }
    // W1: lantern-room flicker (warm glass breathing; lost state recolors
    // the core via syncWorld, flicker follows the same lamp).
    this.lanternFlicker = this.add.circle(lampX, lampY, 24, 0xfff3d6, 0.5).setDepth(4);
    this.stashEnvPrimitive(this.lanternFlicker);
    if (!this.reducedMotion && !this.envReady) {
      this.tweens.add({ targets: this.lanternFlicker, alpha: 0.22, scale: 1.18, duration: 900, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    }
    // W1: shoreline foam caps at the island waterline (gentle pulse only).
    this.foamCaps = [];
    const foamSpots: Array<[number, number, number]> = P
      ? [
          [330, 648, 16],
          [540, 668, 20],
          [750, 648, 16],
        ]
      : [
          [90, 852, 18],
          [300, 872, 22],
          [510, 852, 18],
        ];
    for (const [fx, fy, fr] of foamSpots) {
      const cap = this.add.circle(fx, fy, fr, 0xf4efe4, 0.16).setDepth(3);
      this.stashEnvPrimitive(cap);
      this.foamCaps.push(cap);
    }
    if (!this.reducedMotion && !this.envReady) {
      for (let i = 0; i < this.foamCaps.length; i++) {
        this.tweens.add({ targets: this.foamCaps[i], alpha: 0.22, duration: 3600 + i * 650, scale: 1.06, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      }
    }

    const shieldPos = P ? { x: 540, y: 420 } : { x: 300, y: 560 };
    this.shieldBubble = this.add.circle(shieldPos.x, shieldPos.y, P ? 180 : 235, 0x90e0ef, 0.14).setVisible(false).setDepth(6);
    this.shieldText = this.add
      .text(P ? 540 : 300, P ? 216 : 356, "WARD UP", { fontSize: P ? "30px" : "24px", color: "#90e0ef", fontStyle: "bold" })
      .setOrigin(0.5, 1)
      .setVisible(false)
      .setDepth(7);

    this.keepBar = this.add.graphics().setDepth(7);
    this.keepLabel = this.add
      .text(P ? 540 : 435, P ? 670 : 700, "CINDERHOLM", { fontSize: P ? "32px" : "26px", color: "#edf2f4", fontStyle: "bold" })
      .setOrigin(0.5, 0)
      .setDepth(7);
    this.keepHpText = this.add
      .text(P ? 540 : 435, P ? 702 : 730, "", { fontSize: P ? "28px" : "22px", color: "#b9b3c7" })
      .setOrigin(0.5, 0)
      .setDepth(7);
  }

  // ---------- P1D keeper sprite (atlas-gated, primitives = fallback) ----------

  /**
   * Keeper sprite vertical offset inside the hero container.
   * Container origin is (720, 800); the spec feet anchor is (720, 834),
   * matching the primitive cloak bottom (r34) and the skiff hull top
   * (y=838). Chosen by rendered geometry; see the P1D A/B record.
   */
  private keeperSpriteDY(): number {
    return 34;
  }

  private setupKeeperSprite(): void {
    try {
      if (typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search);
        if (params.get("noatlas") === "1") return; // explicit fallback test
      }
    } catch {
      return;
    }
    if (!this.textures.exists(KEEPER_ATLAS_KEY)) return;
    const tex = this.textures.get(KEEPER_ATLAS_KEY);
    for (const f of allKeeperFrames()) {
      if (!tex.has(f)) return; // incomplete atlas -> primitives stay
    }
    try {
      this.registerKeeperAnims();
      const sprite = this.add.sprite(0, this.keeperSpriteDY(), KEEPER_ATLAS_KEY, keeperFrame("idle", 0));
      sprite.setOrigin(0.5, 1).setScale(this.isPortrait ? 0.8 : 0.78).setDepth(4);
      this.hero.add(sprite);
      this.keeperSprite = sprite;
      for (const p of this.keeperPrimitives) p.setVisible(false);
      this.playKeeper("idle");
      // P1F dev-only preview: `?keeperPreview=<pose>` locks one pose for
      // motion observation (walk/interact have no gameplay trigger).
      // Absent/invalid without the flag: keeperPreview stays null and
      // playback below is byte-identical to production.
      this.keeperPreview = resolveKeeperPreview(window.location.search);
      if (this.keeperPreview) {
        this.keeperAnim = null;
        this.keeperOneShot = false;
        this.playKeeper(this.keeperPreview);
      }
    } catch {
      this.keeperSprite = null; // sprite creation failed -> primitives stay
    }
  }

  private registerKeeperAnims(): void {
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
  }

  private playKeeper(pose: KeeperPose): void {
    const sprite = this.keeperSprite;
    if (!sprite) return;
    const key = keeperAnimKey(pose);
    if (!this.anims.exists(key)) return;
    // P1F dev-only preview lock: while `?keeperPreview=` is set, world
    // sync and result effects must not steal the locked pose. No world
    // state is read or written here — sprite playback only.
    if (this.keeperPreview && pose !== this.keeperPreview) return;
    if (this.keeperOneShot && sprite.anims.isPlaying && KEEPER_POSES[pose].oneShot === false) {
      return; // let the one-shot finish before returning to persistent pose
    }
    if (!shouldSwitchAnim(this.keeperAnim, key) && sprite.anims.isPlaying) return;
    const def = KEEPER_POSES[pose];
    this.keeperAnim = key;
    // W1-R stationary Keeper: persistent poses hold one approved frame.
    // Looping idle/shield repaints cape/hand/lantern per drawing and reads
    // as locomotion, so the scene displays frame 0 instead of playing the
    // loop. The environment (sea/cloud/beam/mist) carries motion. One-shot
    // result poses bypass this branch via def.oneShot and still play once.
    // The dev-only preview lock stays exempt for atlas observation.
    if (!this.keeperPreview && keeperIsStationaryPose(pose)) {
      const still = keeperStationaryFrame(pose);
      if (sprite.frame.name === still && !sprite.anims.isPlaying) return;
      sprite.stop();
      sprite.setTexture(KEEPER_ATLAS_KEY, still);
      this.keeperOneShot = false;
      return;
    }
    if (this.reducedMotion) {
      sprite.stop();
      sprite.setTexture(KEEPER_ATLAS_KEY, keeperFrame(pose, 0));
      this.keeperOneShot = false;
      return;
    }
    this.keeperOneShot = def.oneShot;
    sprite.play(key);
    if (def.oneShot) {
      sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE_KEY, () => {
        this.keeperOneShot = false;
        if (this.keeperPreview) {
          // P1F dev-only preview: replay the locked pose so one-shots
          // (strike/mend/interact) can be observed without gameplay.
          this.keeperAnim = null;
          this.playKeeper(this.keeperPreview);
          return;
        }
        this.playKeeper(resolveKeeperPose(this.keeperShieldOn));
      });
    }
  }

  private buildSkiff(): void {
    const P = this.isPortrait;
    // Portrait production staging rides the rock-shelf waterline in the
    // cover-fit plate (approval 2); other compositions keep their homes.
    const skiff = P
      ? this.envPortrait ? { x: PORTRAIT_ENV_STAGING.skiff.x, y: PORTRAIT_ENV_STAGING.skiff.y } : { x: 540, y: 900 }
      : { x: 720, y: 800 };
    // Keeper skiff riding the swell.
    const hull = this.add.graphics().setDepth(3);
    hull.fillStyle(0x4a3728, 1);
    if (this.envPortrait) {
      hull.fillTriangle(342, 1630, 562, 1630, 522, 1675);
      hull.fillRect(352, 1618, 200, 18);
      hull.lineStyle(2, 0xffd166, 0.35);
      hull.lineBetween(352, 1618, 552, 1618);
    } else if (P) {
      hull.fillTriangle(430, 950, 650, 950, 610, 995);
      hull.fillRect(440, 938, 200, 18);
      hull.lineStyle(2, 0xffd166, 0.35);
      hull.lineBetween(440, 938, 640, 938);
    } else {
      hull.fillTriangle(610, 850, 830, 850, 790, 895);
      hull.fillRect(620, 838, 200, 18);
      hull.lineStyle(2, 0xffd166, 0.35);
      hull.lineBetween(620, 838, 820, 838);
    }

    this.hero = this.add.container(skiff.x, skiff.y).setDepth(4);
    const cloak = this.add.circle(0, 0, 34, 0x43aa8b);
    const hood = this.add.circle(0, -30, 18, 0x2d6a4f);
    const helm = this.add.rectangle(0, -46, 44, 12, 0xf9c74f);
    const oar = this.add.rectangle(44, 6, 56, 8, 0xe9ecef).setAngle(-22);
    this.hero.add([cloak, hood, helm, oar]);
    this.keeperPrimitives = [cloak, hood, helm, oar];
    this.keeperFlashPrimitive = cloak;
    this.setupKeeperSprite();
    // Keep the feet anchored to the skiff during idle; environmental water
    // supplies motion without a character-only bob that reads as foot sliding.
    // Stern lantern (flares on heal).
    const lanternPos = this.envPortrait ? { x: 510, y: 1540 } : P ? { x: 598, y: 860 } : { x: 778, y: 760 };
    const pole = this.add.rectangle(this.envPortrait ? 510 : P ? 598 : 778, this.envPortrait ? 1576 : P ? 896 : 796, 6, 60, 0x6c757d).setDepth(4);
    void pole;
    this.skiffLantern = this.add.circle(lanternPos.x, lanternPos.y, 11, 0xffd166, 1).setDepth(5);
    this.add.circle(lanternPos.x, lanternPos.y, 24, 0xffd166, 0.22).setDepth(4);

    this.heroBar = this.add.graphics().setDepth(7);
    this.add
      .text(this.envPortrait ? 452 : P ? 540 : 720, this.envPortrait ? 1692 : P ? 978 : 878, "KEEPER'S SKIFF", { fontSize: P ? "30px" : "24px", color: "#b7f7c9", fontStyle: "bold" })
      .setOrigin(0.5, 0)
      .setDepth(7);
    this.heroHpText = this.add
      .text(this.envPortrait ? 452 : P ? 540 : 720, this.envPortrait ? 1724 : P ? 1010 : 906, "", { fontSize: P ? "28px" : "22px", color: "#b9b3c7" })
      .setOrigin(0.5, 0)
      .setDepth(7);
  }

  private buildReef(): void {
    const P = this.isPortrait;
    const EP = this.envPortrait;
    const rcx = P ? (EP ? PORTRAIT_ENV_STAGING.reef.x : 540) : 1050;
    const rcy = P ? (EP ? PORTRAIT_ENV_STAGING.reef.y : 1240) : 940;
    // Pale Reaches: low misty reef with five chart-lantern posts.
    const reef = this.add.graphics().setDepth(2);
    this.stashEnvPrimitive(reef);
    reef.fillStyle(0x232b3d, 1);
    reef.fillEllipse(rcx, rcy, 560, 120);
    reef.fillStyle(0x2e3a52, 1);
    reef.fillEllipse(rcx - 50, rcy - 20, 380, 80);
    // Mist.
    reef.fillStyle(0xb9b3c7, 0.08);
    reef.fillEllipse(rcx, rcy - 40, 620, 90);

    this.reefLanterns = [];
    for (let i = 0; i < 5; i++) {
      const x = P ? (EP ? 620 + i * 90 : 340 + i * 100) : 850 + i * 100;
      const yBase = rcy - 56;
      const yLamp = rcy - 90;
      this.add.rectangle(x, yBase, 8, 56, 0x4a4360).setDepth(3);
      const lamp = this.add.circle(x, yLamp, 12, 0x3a3454, 1).setDepth(4);
      this.add.circle(x, yLamp, 24, 0xffd166, 0).setDepth(3);
      this.reefLanterns.push(lamp);
    }
    this.reefLabel = this.add
      .text(rcx, rcy + 22, "", { fontSize: P ? "28px" : "22px", color: "#90e0ef" })
      .setOrigin(0.5, 0)
      .setDepth(7);
  }

  private buildVessel(): void {
    const P = this.isPortrait;
    // G2-A6: approved berth A in landscape. Portrait production staging
    // moors in the open-water slot of the cover-fit plate (approval 2);
    // the primitive fallback keeps the GameScene home.
    const home = P
      ? this.envPortrait
        ? { x: PORTRAIT_ENV_STAGING.vessel.x, y: PORTRAIT_ENV_STAGING.vessel.y }
        : { x: 820, y: 720 }
      : { x: BERTH_A.x, y: BERTH_A.y };
    // Gloam Vessel: siege hull offshore, gloam-lit.
    this.vessel = this.add.container(home.x, home.y).setDepth(4);
    this.vesselBody = this.add.rectangle(0, 0, 210, 84, 0x9d0208);
    const prow = this.add.triangle(135, 0, 0, -42, 0, 42, 60, 0, 0x6a040f);
    const rail = this.add.rectangle(0, -50, 190, 14, 0x370617);
    const mast1 = this.add.rectangle(-50, -110, 12, 140, 0x2b2d42);
    const mast2 = this.add.rectangle(55, -100, 12, 120, 0x2b2d42);
    const sail1 = this.add.triangle(-50, -110, -70, 0, 70, 0, 0, -90, 0x1c1440);
    const sail2 = this.add.triangle(55, -100, -58, 0, 58, 0, 0, -76, 0x241640);
    this.vessel.add([this.vesselBody, prow, rail, mast1, mast2, sail1, sail2]);
    this.vesselLights = [];
    for (const [lx, ly] of [[-70, -12], [0, -8], [70, -12]] as Array<[number, number]>) {
      const l = this.add.circle(lx, ly, 10, 0x80ffdb, 1);
      this.vessel.add(l);
      this.vesselLights.push(l);
    }
    const spriteReady = this.setupVesselSprite();
    if (!this.reducedMotion && !spriteReady && !this.envReady) {
      this.tweens.add({ targets: this.vessel, y: home.y + 12, duration: 2600, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    }
    if (!this.reducedMotion && !spriteReady && !this.envReady) {
      for (let i = 0; i < this.vesselLights.length; i++) {
        this.tweens.add({ targets: this.vesselLights[i], alpha: 0.45, duration: 700 + i * 260, yoyo: true, repeat: -1 });
      }
    }
    // Hull wake.
    const wake = this.add.graphics().setDepth(3);
    wake.lineStyle(2, 0x90e0ef, 0.3);
    if (this.envPortrait) wake.lineBetween(495, 1435, 755, 1435);
    else if (this.isPortrait) wake.lineBetween(690, 770, 950, 770);
    else wake.lineBetween(1100, 830, 1360, 830);

    this.vesselBar = this.add.graphics().setDepth(7);
    this.vesselLabel = this.add
      .text(this.envPortrait ? 625 : this.isPortrait ? 820 : 1420, this.envPortrait ? 1160 : this.isPortrait ? 500 : 630, "", { fontSize: this.isPortrait ? "32px" : "26px", color: "#ff8fa3", fontStyle: "bold" })
      .setOrigin(0.5, 0)
      .setDepth(7);
    this.vesselHpText = this.add
      .text(this.envPortrait ? 625 : this.isPortrait ? 820 : 1420, this.envPortrait ? 1194 : this.isPortrait ? 534 : 660, "", { fontSize: this.isPortrait ? "28px" : "22px", color: "#b9b3c7" })
      .setOrigin(0.5, 0)
      .setDepth(7);
  }

  /** Attach the atlas sprite only when every required frame is available. */
  private setupVesselSprite(): boolean {
    if (!this.textures.exists(VESSEL_ATLAS_KEY)) return false;
    const texture = this.textures.get(VESSEL_ATLAS_KEY);
    if (!VESSEL_IDLE_FRAMES.every((frame) => texture.has(frame))) return false;
    let sprite: Phaser.GameObjects.Sprite | null = null;
    try {
      if (!this.anims.exists(VESSEL_IDLE_ANIM)) {
        this.anims.create({
          key: VESSEL_IDLE_ANIM,
          frames: VESSEL_IDLE_FRAMES.map((frame) => ({ key: VESSEL_ATLAS_KEY, frame })),
          frameRate: VESSEL_IDLE_FRAME_RATE,
          repeat: VESSEL_IDLE_REPEAT,
        });
      }
      sprite = this.add.sprite(0, 0, VESSEL_ATLAS_KEY, VESSEL_IDLE_FRAMES[0]);
      // The approved lower-hull pivot stays fixed. W0.1's orientation-specific
      // staging scales keep the vessel prominent in both compositions.
      sprite.setOrigin(0.5, 0.86).setScale(this.isPortrait ? 0.76 : 0.9);
      this.vessel.add(sprite);
      if (this.reducedMotion) {
        sprite.stop();
        sprite.setTexture(VESSEL_ATLAS_KEY, VESSEL_IDLE_FRAMES[0]);
      } else {
        sprite.play(VESSEL_IDLE_ANIM);
      }
      this.vesselSprite = sprite;
      for (const child of this.vessel.list) {
        if (child !== sprite) {
          (child as Phaser.GameObjects.GameObject & { setVisible: (visible: boolean) => unknown }).setVisible(false);
        }
      }
      return true;
    } catch {
      sprite?.destroy();
      this.vesselSprite = null;
      for (const child of this.vessel.list) {
        (child as Phaser.GameObjects.GameObject & { setVisible: (visible: boolean) => unknown }).setVisible(true);
      }
      return false;
    }
  }

  private buildChapelBrazier(): void {
    const P = this.isPortrait;
    const EP = this.envPortrait;
    // Chapel Steps: stair cut into Cinderholm's flank + story brazier.
    // Portrait production staging seats the brazier on the left rock shelf
    // of the cover-fit plate (approval 2).
    const steps = this.add.graphics().setDepth(3);
    steps.fillStyle(0x4a4360, 1);
    if (EP) {
      steps.fillRect(140, 1600, 90, 16);
      steps.fillRect(150, 1584, 80, 16);
      steps.fillRect(160, 1568, 70, 16);
    } else if (P) {
      steps.fillRect(310, 1080, 90, 16);
      steps.fillRect(320, 1064, 80, 16);
      steps.fillRect(330, 1048, 70, 16);
    } else {
      steps.fillRect(470, 780, 90, 16);
      steps.fillRect(480, 764, 80, 16);
      steps.fillRect(490, 748, 70, 16);
    }
    this.add.rectangle(EP ? 195 : P ? 365 : 525, EP ? 1546 : P ? 1026 : 726, 34, 22, 0x2b2d42).setDepth(3);
    this.chapelFlame = this.add.circle(EP ? 195 : P ? 365 : 525, EP ? 1526 : P ? 1006 : 706, 12, 0xff9a3c, 1).setDepth(4);
    this.add.circle(EP ? 195 : P ? 365 : 525, EP ? 1526 : P ? 1006 : 706, 24, 0xff9a3c, 0.2).setDepth(3);
    if (!this.reducedMotion) {
      this.tweens.add({ targets: this.chapelFlame, scale: 1.35, alpha: 0.75, duration: 620, yoyo: true, repeat: -1 });
    }
    this.chapelLabel = this.add
      .text(EP ? 195 : P ? 365 : 525, EP ? 1620 : P ? 1100 : 800, "CHAPEL STEPS", { fontSize: P ? "26px" : "20px", color: "#b9b3c7" })
      .setOrigin(0.5, 0)
      .setDepth(7);
  }

  private buildEyebrow(): void {
    // Intentionally empty: titles and meters live in the DOM so the
    // diorama never collides with the dashboard header or overlay HUD.
    // Kept as a seam for future world-anchored chrome.
  }

  private buildStaticMarkers(): void {
    // Addendum static equivalents: text + symbol, no color-alone, no motion.
    // Hidden until a reduced-motion result shows them; syncWorld never hides
    // the shield (persistent), impact/heal markers hide on a 3s timer (no tween).
    this.impactGlyph = this.add.circle(0, 0, 18, 0x000000, 0.72).setDepth(9);
    this.impactLabel = this.add
      .text(0, -34, "✖ HIT", { fontSize: "22px", color: "#ff8fa3", fontStyle: "bold" })
      .setOrigin(0.5, 0)
      .setDepth(9);
    this.impactMarker = this.add.container(0, 0, [this.impactGlyph, this.impactLabel]).setDepth(9).setVisible(false);

    this.healGlyph = this.add.circle(0, 0, 18, 0x000000, 0.72).setDepth(9);
    this.healLabel = this.add
      .text(0, -34, "+ AID", { fontSize: "22px", color: "#43ff9a", fontStyle: "bold" })
      .setOrigin(0.5, 0)
      .setDepth(9);
    this.healMarker = this.add.container(0, 0, [this.healGlyph, this.healLabel]).setDepth(9).setVisible(false);
  }

  private showImpactStatic(x: number, y: number, label: string): void {
    if (!this.impactMarker) return;
    this.impactLabel.setText(label);
    this.impactMarker.setPosition(x, y).setVisible(true).setAlpha(1);
    this.time.delayedCall(3000, () => {
      if (this.impactMarker) this.impactMarker.setVisible(false);
    });
  }

  private showHealStatic(x: number, y: number): void {
    if (!this.healMarker) return;
    this.healMarker.setPosition(x, y).setVisible(true).setAlpha(1);
    this.time.delayedCall(3000, () => {
      if (this.healMarker) this.healMarker.setVisible(false);
    });
  }

  // ---------- helpers ----------

  private drawBar(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    value: number,
    max: number,
    color: number,
  ): void {
    g.clear();
    g.fillStyle(0x000000, 0.6).fillRect(x, y, width, 20);
    const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    g.fillStyle(color, 1).fillRect(x + 2, y + 2, (width - 4) * frac, 16);
  }

  private flash(target: Phaser.GameObjects.Shape, color: number): void {
    const orig = (target as unknown as { fillColor: number }).fillColor;
    target.setFillStyle(color, 1);
    this.time.delayedCall(120, () => target.setFillStyle(orig, 1));
  }

  private burst(x: number, y: number, tint: number): void {
    if (!this.textures.exists("px")) return;
    const p = this.add.particles(x, y, "px", {
      lifespan: 520,
      speed: { min: 80, max: 260 },
      scale: { min: 0.3, max: 0.9 },
      alpha: { start: 1, end: 0 },
      tint,
      quantity: 14,
      emitting: true,
    });
    p.setDepth(8);
    p.explode(14, x, y);
    this.time.delayedCall(1000, () => p.destroy());
  }
}
