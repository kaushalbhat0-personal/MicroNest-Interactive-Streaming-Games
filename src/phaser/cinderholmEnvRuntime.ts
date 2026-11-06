/**
 * G2-A6 — Cinderholm production environment runtime (Phaser-owned).
 *
 * Production port of the approved G2-A4.3 animated preview. Pure data and
 * staging live in `./cinderholmEnv` (headless-tested); this file owns only
 * the Phaser objects GameScene drives at its existing seams.
 *
 * Boundaries: visual-only, zero tweens (sine-phase advance), preallocated
 * pools, SHUTDOWN-safe dispose(). Type-only Phaser import keeps unit tests
 * headless-safe.
 */

import Phaser from "phaser";
import {
  BEAM_LAMP_LANDSCAPE,
  BEAM_LAMP_PORTRAIT,
  BERTH_A,
  ENV_CEILINGS,
  EnvController,
  FOAM_RANGES_LANDSCAPE,
  FOAM_RANGES_PORTRAIT,
  LANTERN_LANDSCAPE,
  LANTERN_PORTRAIT,
  SHORE_LANDSCAPE,
  SHORE_PORTRAIT,
  envAssetDefs,
  gradeForWorld,
  resolveEnvPreview,
  vesselKeelY,
  waterlineAt,
  type EnvPresetName,
  type ShorePoint,
  type WorldFormat,
} from "./cinderholmEnv";

const TAU = Math.PI * 2;
const RAIN_POOL = 140;

interface Splash {
  obj: Phaser.GameObjects.Ellipse;
  x: number;
  y: number;
  period: number;
  phase: number;
}

export class CinderholmEnvironment {
  readonly ctl = new EnvController("calm");
  readonly format: WorldFormat;
  readonly reduced: boolean;
  readonly fxDisabled: boolean;
  readonly preview: EnvPresetName | null;
  active = false;
  envTime = 0;
  missing: string[] = [];

  private W = 0;
  private H = 0;
  private sea: Phaser.GameObjects.Image | null = null;
  private seaBaseX = 0;
  private sheen: Phaser.GameObjects.Image | null = null;
  private sheenBaseX = 0;
  private mist: Phaser.GameObjects.Image | null = null;
  private mistBaseX = 0;
  private cloud: Phaser.GameObjects.Image | null = null;
  private cloudBaseX = 0;
  private mountains: Phaser.GameObjects.Image | null = null;
  private mountainsBaseX = 0;
  private beam: Phaser.GameObjects.Image | null = null;
  private glow: Phaser.GameObjects.Image | null = null;
  private foam: Phaser.GameObjects.Graphics | null = null;
  private collarBack: Phaser.GameObjects.Graphics | null = null;
  private collarLap: Phaser.GameObjects.Graphics | null = null;
  private splashes: Splash[] = [];
  private rainDrops: Phaser.GameObjects.Rectangle[] = [];
  private dropX = new Float32Array(RAIN_POOL);
  private dropY = new Float32Array(RAIN_POOL);
  private dropSpd = new Float32Array(RAIN_POOL);
  private lastWindApplied = 0;
  private dim: Phaser.GameObjects.Rectangle | null = null;
  private warm: Phaser.GameObjects.Rectangle | null = null;
  private flash: Phaser.GameObjects.Rectangle | null = null;
  private nextStrikeAt = 9;
  private flashT = -1;

  constructor(format: WorldFormat, reduced: boolean, search?: string) {
    this.format = format;
    this.reduced = reduced;
    const q = new URLSearchParams(search ?? "");
    this.fxDisabled = q.get("fx") === "0";
    this.preview = resolveEnvPreview(search ?? null);
    this.ctl.applyPreset(this.preview ?? "calm", 1);
    this.ctl.snapTo(this.ctl.target);
    if (this.fxDisabled) {
      this.ctl.snapTo({ sheen: 0, mist: 0, cloud: 0, beam: 0, glow: 0, rain: 0, lightning: 0, overcast: 0, warmth: 0 });
      this.ctl.setEffectEnabled("atmosphere", false);
      this.ctl.setEffectEnabled("weather", false);
      this.ctl.setEffectEnabled("motion", false);
    }
    if (reduced) this.ctl.setEffectEnabled("motion", false);
  }

  /** Queue WebP primaries; per-key fallback to PNG/JPG on load error. */
  preload(scene: Phaser.Scene): void {
    const plates = new Set(["env-sky", "env-mountains", "env-castle", "env-sea", "env-rocks"]);
    const defs = envAssetDefs(this.format).filter((d) => !this.fxDisabled || plates.has(d.key));
    const fallbacks = new Map(defs.map((d) => [d.key, d.fallback]));
    const retried = new Set<string>();
    const onError = (file: { key?: string }): void => {
      if (!file || typeof file.key !== "string") return;
      const fb = fallbacks.get(file.key);
      if (fb && !retried.has(file.key)) {
        retried.add(file.key);
        this.missing.push(`${file.key}:webp`);
        scene.load.image(file.key, fb);
      } else {
        this.missing.push(file.key);
      }
    };
    scene.load.on("loaderror", onError);
    for (const d of defs) scene.load.image(d.key, d.webp);
    scene.load.once("complete", () => scene.load.off("loaderror", onError));
  }

  private layer(scene: Phaser.Scene, key: string, depth: number, offsetX: number): Phaser.GameObjects.Image | null {
    if (!scene.textures.exists(key)) return null;
    const img = scene.add.image(0, 0, key).setDepth(depth);
    if (this.format === "landscape") {
      img.setOrigin(0, 0).setDisplaySize(this.W, this.H).setX(offsetX);
    } else {
      const tw = scene.textures.get(key).getSourceImage() as unknown as { width: number; height: number };
      const k = Math.max(this.W / tw.width, this.H / tw.height);
      img.setOrigin(0.5, 0).setDisplaySize(tw.width * k, tw.height * k).setX(this.W / 2 + offsetX);
    }
    return img;
  }

  private driftLayer(scene: Phaser.Scene, key: string, depth: number, margin: number): Phaser.GameObjects.Image | null {
    if (!scene.textures.exists(key)) return null;
    const img = scene.add.image(0, 0, key).setDepth(depth);
    if (this.format === "landscape") {
      img.setOrigin(0.5, 0).setDisplaySize(this.W + margin, this.H).setX(this.W / 2);
    } else {
      const tw = scene.textures.get(key).getSourceImage() as unknown as { width: number; height: number };
      const k = Math.max(this.W / tw.width, this.H / tw.height);
      img.setOrigin(0.5, 0).setDisplaySize(tw.width * k + margin, tw.height * k).setX(this.W / 2);
    }
    return img;
  }

  private shore(): ShorePoint[] {
    return this.format === "landscape" ? SHORE_LANDSCAPE : SHORE_PORTRAIT;
  }

  private foamRanges(): Array<[number, number]> {
    return this.format === "landscape" ? FOAM_RANGES_LANDSCAPE : FOAM_RANGES_PORTRAIT;
  }

  private maskBelow(scene: Phaser.Scene, target: Phaser.GameObjects.Image, depth: number): void {
    const pts = this.shore().map((p) => new Phaser.Geom.Point(p.x, p.y));
    pts.push(new Phaser.Geom.Point(this.W, this.H), new Phaser.Geom.Point(0, this.H));
    const maskG = scene.add.graphics().setDepth(depth);
    maskG.fillPoints(pts, true);
    target.setMask(maskG.createGeometryMask());
  }

  /**
   * Build production layers. Returns true when the required plates exist;
   * GameScene then hides conflicting primitive fills (which stay as the
   * fallback when this returns false).
   */
  create(scene: Phaser.Scene, W: number, H: number): boolean {
    this.W = W;
    this.H = H;
    for (const k of ["env-sky", "env-mountains", "env-castle", "env-sea", "env-rocks"]) {
      if (!scene.textures.exists(k)) {
        this.missing.push(k);
        this.active = false;
        return false;
      }
    }
    this.active = true;

    this.layer(scene, "env-sky", 0, 0);
    const mtn = this.layer(scene, "env-mountains", 1, 0);
    if (mtn) {
      if (this.format === "landscape") mtn.setDisplaySize(W + 32, H).setOrigin(0.5, 0).setX(W / 2);
      this.mountains = mtn;
      this.mountainsBaseX = mtn.x;
    }
    this.layer(scene, "env-castle", 2, this.format === "landscape" ? 0 : 60);

    const sea = this.driftLayer(scene, "env-sea", 2.5, 64);
    if (sea) {
      this.sea = sea;
      this.seaBaseX = sea.x;
      this.maskBelow(scene, sea, 2.5);
      this.drawShoreFoam(scene);
    }
    // Foreground shore occludes hull feet (draft read), like the preview.
    this.layer(scene, "env-rocks", 4.5, 0);

    if (!this.fxDisabled) this.createOverlays(scene);

    if (this.format === "landscape") this.drawVesselCollar(scene, BERTH_A.x);

    this.createWeather(scene);
    this.applyStatic();
    return true;
  }

  private drawShoreFoam(scene: Phaser.Scene): void {
    const foam = scene.add.graphics().setDepth(3.2);
    for (const pass of [{ w: 14, a: 0.1 }, { w: 6, a: 0.3 }]) {
      foam.lineStyle(pass.w, 0xdfe9f2, pass.a);
      for (const [from, to] of this.foamRanges()) {
        foam.beginPath();
        foam.moveTo(this.shore()[from].x, this.shore()[from].y + 2);
        for (let i = from + 1; i <= to; i++) foam.lineTo(this.shore()[i].x, this.shore()[i].y + 2);
        foam.strokePath();
      }
    }
    this.foam = foam;
  }

  private drawVesselCollar(scene: Phaser.Scene, vx: number): void {
    const wy = waterlineAt(this.shore(), vx);
    const hullW = 512 * BERTH_A.scale;
    const keelY = vesselKeelY(BERTH_A.y, BERTH_A.scale);
    const back = scene.add.graphics().setDepth(3.4);
    back.fillStyle(0xdfe9f2, 0.3);
    back.fillEllipse(vx - hullW * 0.5, wy + 1, hullW, 10);
    back.fillStyle(0xdfe9f2, 0.2);
    back.fillEllipse(vx - hullW * 0.45, keelY - 7, hullW * 0.9, 26);
    const lap = scene.add.graphics().setDepth(3.6);
    lap.fillStyle(0xdfe9f2, 0.25);
    lap.fillEllipse(vx - hullW * 0.42, keelY + 6, hullW * 0.85, 8);
    this.collarBack = back;
    this.collarLap = lap;
  }

  private createOverlays(scene: Phaser.Scene): void {
    if (scene.textures.exists("env-sheen") && scene.textures.exists("env-sea")) {
      const sheen = this.driftLayer(scene, "env-sheen", 3.1, 64);
      if (sheen) {
        this.maskBelow(scene, sheen, 3.1);
        this.sheen = sheen;
        this.sheenBaseX = sheen.x;
      }
    }
    if (scene.textures.exists("env-mist")) {
      const mist = this.driftLayer(scene, "env-mist", 2.5, 64);
      if (mist) {
        this.mist = mist;
        this.mistBaseX = mist.x;
      }
      const cloud = this.driftLayer(scene, "env-mist", 1.5, 96);
      if (cloud) {
        cloud.setY(-this.H * 0.12);
        this.cloud = cloud;
        this.cloudBaseX = cloud.x;
      }
    }
    if (scene.textures.exists("env-beam")) {
      const lampFrac = this.format === "landscape" ? BEAM_LAMP_LANDSCAPE : BEAM_LAMP_PORTRAIT;
      const lamp = this.format === "landscape" ? LANTERN_LANDSCAPE : LANTERN_PORTRAIT;
      const beam = scene.add
        .image(lamp.x, lamp.y, "env-beam")
        .setOrigin(lampFrac.x, lampFrac.y)
        .setDepth(2.7);
      if (this.format === "landscape") {
        beam.setDisplaySize(this.W, this.H);
      } else {
        const tw = scene.textures.get("env-beam").getSourceImage() as unknown as { width: number; height: number };
        const k = Math.max(this.W / tw.width, this.H / tw.height);
        beam.setDisplaySize(tw.width * k, tw.height * k);
      }
      this.beam = beam;
      const GR = 128;
      if (!scene.textures.exists("env-glow-soft")) {
        const glowTex = scene.textures.createCanvas("env-glow-soft", GR, GR);
        const ctx = glowTex?.getContext();
        if (ctx) {
          const grad = ctx.createRadialGradient(GR / 2, GR / 2, 0, GR / 2, GR / 2, GR / 2);
          grad.addColorStop(0, "rgba(255,233,168,1)");
          grad.addColorStop(0.35, "rgba(255,233,168,0.55)");
          grad.addColorStop(1, "rgba(255,233,168,0)");
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, GR, GR);
          glowTex?.refresh();
        }
      }
      if (scene.textures.exists("env-glow-soft")) {
        const d = this.format === "landscape" ? 110 : 170;
        this.glow = scene.add.image(lamp.x, lamp.y, "env-glow-soft").setDisplaySize(d, d).setDepth(2.6);
        this.glow.setBlendMode(Phaser.BlendModes.ADD);
      }
    }
    if (scene.textures.exists("env-sea") && !this.reduced) {
      const pts: ShorePoint[] = [];
      for (const [from, to] of this.foamRanges()) {
        for (let i = from; i <= to && pts.length < 6; i++) pts.push(this.shore()[i]);
      }
      const ranges = this.foamRanges();
      const a = this.shore()[ranges[0][1]];
      const b = this.shore()[ranges[1][0]];
      pts.push(
        { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        { x: (a.x + b.x) / 2 + (this.format === "landscape" ? 60 : 30), y: (a.y + b.y) / 2 + 1 },
      );
      pts.slice(0, 8).forEach((p, i) => {
        const w = i % 2 === 0 ? 34 : 44;
        const obj = scene.add.ellipse(p.x, p.y, w, 6, 0xe8f1f8).setDepth(3.3).setAlpha(0);
        this.splashes.push({ obj, x: p.x, y: p.y, period: 2.2 + (i % 4) * 0.25, phase: i / 8 });
      });
    }
  }

  private createWeather(scene: Phaser.Scene): void {
    const W = this.W;
    const H = this.H;
    this.dim = scene.add.rectangle(0, 0, W, H, 0x0b1026).setOrigin(0, 0).setDepth(6.5).setAlpha(0);
    this.warm = scene.add.rectangle(0, 0, W, H, 0xffd9a0).setOrigin(0, 0).setDepth(6.4).setAlpha(0);
    this.flash = scene.add.rectangle(0, 0, W, H, 0xffffff).setOrigin(0, 0).setDepth(8).setAlpha(0);
    const dw = this.format === "landscape" ? 2 : 3;
    const dh = this.format === "landscape" ? 16 : 22;
    for (let i = 0; i < RAIN_POOL; i++) {
      const d = scene.add.rectangle(-60, -60, dw, dh, 0xcfe3f5).setDepth(6.8).setAlpha(0.32).setVisible(false);
      this.rainDrops.push(d);
      this.dropX[i] = Math.random() * (W + 80) - 40;
      this.dropY[i] = Math.random() * (H + 60) - 30;
      this.dropSpd[i] = 950 + Math.random() * 400;
    }
    this.applyWindSlant(true);
    this.nextStrikeAt = 9;
  }

  private applyWindSlant(force = false): void {
    const w = this.ctl.current.wind;
    if (!force && Math.abs(w - this.lastWindApplied) < 0.02) return;
    this.lastWindApplied = w;
    const rot = w * 0.3;
    for (const d of this.rainDrops) d.setRotation(rot);
  }

  /**
   * State-driven grade (plain values only — no engine reads). A dev `?env=`
   * lock behaves like the keeperPreview lock: sync never steals it.
   */
  applyGrade(threatLevel: number, cinder: string, drivenOff: boolean): void {
    const grade = this.preview ?? gradeForWorld(threatLevel, drivenOff);
    this.ctl.applyPreset(grade);
    if (cinder === "lost") {
      this.ctl.target.beam = 0;
      this.ctl.target.glow = 0;
    } else if (cinder === "strained") {
      this.ctl.target.beam = Math.min(this.ctl.target.beam, 0.1);
    }
  }

  private activeRainCount(): number {
    if (this.reduced || this.fxDisabled || !this.ctl.enabled.weather) return 0;
    return Math.round(this.ctl.effectiveRain() * RAIN_POOL);
  }

  /** Zero-tween advance: arithmetic + transform writes only. */
  update(dtMs: number): void {
    if (!this.active || this.reduced) return;
    const dt = Math.min(dtMs, 100);
    this.ctl.update(dt);
    const c = this.ctl.current;
    const motionOn = this.ctl.enabled.motion && !this.fxDisabled;
    const atmoOn = this.ctl.enabled.atmosphere && !this.fxDisabled;
    this.envTime += (dt / 1000) * (motionOn ? c.speed : 0);
    const t = this.envTime;
    const W = this.W;
    const H = this.H;

    if (this.sea) {
      this.sea.x = this.seaBaseX + (motionOn ? Math.sin((TAU * t) / 9) * 10 * Math.min(c.swell, 1.8) : 0);
    }
    if (this.mountains) {
      this.mountains.x = this.mountainsBaseX + (motionOn ? Math.sin((TAU * t) / 26) * 12 : 0);
    }
    if (this.sheen) {
      const vis = atmoOn && c.sheen > 0.004;
      this.sheen.setVisible(vis);
      if (vis) {
        this.sheen.setAlpha(c.sheen);
        this.sheen.x = this.sheenBaseX + (motionOn ? Math.sin((TAU * t) / 18 + 2) * 18 * Math.min(c.swell, 1.3) : 0);
      }
    }
    if (this.mist) {
      const vis = atmoOn && c.mist > 0.004;
      this.mist.setVisible(vis);
      if (vis) {
        this.mist.setAlpha(c.mist * (motionOn ? 0.9 + 0.1 * Math.sin((TAU * t) / 11) : 1));
        this.mist.x = this.mistBaseX + (motionOn ? Math.sin((TAU * t) / 34) * 24 * (1 + c.wind * 0.6) : 0);
      }
    }
    if (this.cloud) {
      const vis = atmoOn && c.cloud > 0.004;
      this.cloud.setVisible(vis);
      if (vis) {
        this.cloud.setAlpha(c.cloud);
        this.cloud.x = this.cloudBaseX + (motionOn ? Math.sin((TAU * t) / 41 + 3) * 30 * (1 + c.wind * 0.6) : 0);
      }
    }
    if (this.foam) {
      const osc = motionOn ? 0.8 + 0.2 * Math.sin((TAU * t) / 3.2) : 1;
      this.foam.setAlpha(Math.min(1, 0.85 * c.foam * osc));
      this.foam.y = motionOn ? Math.sin((TAU * t) / 5.1) * 1.5 : 0;
    }
    const pulse = motionOn ? 0.85 + 0.15 * Math.sin((TAU * t) / 2.8) : 1;
    if (this.collarBack) this.collarBack.setAlpha(Math.min(1, pulse));
    if (this.collarLap) this.collarLap.setAlpha(Math.min(1, pulse));
    const splashBase = Math.min(0.5, 0.3 * c.foam);
    for (const s of this.splashes) {
      const vis = motionOn && splashBase > 0.01;
      s.obj.setVisible(vis);
      if (!vis) continue;
      const u = (((t / s.period + s.phase) % 1) + 1) % 1;
      s.obj.setAlpha(Math.sin(Math.PI * u) * splashBase);
      s.obj.setScale(1, 0.7 + 0.7 * u);
      s.obj.y = s.y - 7 * u;
    }
    if (this.beam) {
      const vis = atmoOn && c.beam > 0.004;
      this.beam.setVisible(vis);
      if (this.glow) this.glow.setVisible(vis);
      if (vis) {
        this.beam.setAlpha(Math.min(ENV_CEILINGS.beamGlobal, c.beam * (motionOn ? 0.86 + 0.14 * Math.sin((TAU * t) / 5.2 + 1) : 1)));
        this.beam.setRotation(motionOn ? Math.sin((TAU * t) / 9) * 0.05 : 0);
        if (this.glow) this.glow.setAlpha(Math.min(ENV_CEILINGS.beamGlobal, c.glow));
      }
    }
    this.applyWindSlant();
    const activeRain = this.activeRainCount();
    for (let i = 0; i < this.rainDrops.length; i++) {
      const d = this.rainDrops[i];
      if (i < activeRain) {
        if (!d.visible) d.setVisible(true);
        const step = (dt / 1000) * c.speed;
        let y = this.dropY[i] + this.dropSpd[i] * step;
        let x = this.dropX[i] + c.wind * 380 * step;
        if (y > H + 20) {
          y = -20 - Math.random() * 40;
          x = Math.random() * (W + 80) - 40;
        }
        if (x > W + 40) x -= W + 80;
        else if (x < -40) x += W + 80;
        this.dropX[i] = x;
        this.dropY[i] = y;
        d.setPosition(x, y);
      } else if (d.visible) {
        d.setVisible(false);
      }
    }
    if (this.dim) {
      const target = this.ctl.enabled.weather && !this.fxDisabled ? c.overcast : 0;
      this.dim.setVisible(target > 0.004);
      this.dim.setAlpha(Math.min(ENV_CEILINGS.dim + 0.22, target));
    }
    if (this.warm) {
      const target = atmoOn ? c.warmth : 0;
      this.warm.setVisible(target > 0.004);
      this.warm.setAlpha(Math.min(0.15, target));
    }
    if (this.flash) {
      const rate = this.ctl.effectiveLightning();
      if (rate > 0.01) {
        if (this.flashT < 0 && t >= this.nextStrikeAt) {
          this.flashT = 0;
          this.nextStrikeAt = t + (16 - 11 * rate) * (0.6 + Math.random() * 0.8);
        }
        if (this.flashT >= 0) {
          this.flashT += dt;
          const ft = this.flashT;
          let a = 0;
          if (ft < 60) a = 0.5 * rate * (ft / 60);
          else if (ft < 120) a = 0.5 * rate * (1 - (ft - 60) / 60);
          else if (ft < 180) a = 0.65 * rate * ((ft - 120) / 60);
          else if (ft < 420) a = 0.65 * rate * (1 - (ft - 180) / 240);
          else this.flashT = -1;
          this.flash.setVisible(a > 0.004);
          this.flash.setAlpha(Math.min(0.7, a));
        } else {
          this.flash.setVisible(false);
        }
      } else {
        this.flash.setVisible(false);
        this.flashT = -1;
        this.nextStrikeAt = t + 9;
      }
    }
  }

  /** Reduced-motion / fx-off hold: base values, movers hidden. */
  applyStatic(): void {
    if (!this.active) return;
    const c = this.ctl.current;
    if (this.sea) this.sea.x = this.seaBaseX;
    if (this.mountains) this.mountains.x = this.mountainsBaseX;
    if (this.sheen) {
      this.sheen.x = this.sheenBaseX;
      this.sheen.setAlpha(c.sheen);
      this.sheen.setVisible(this.ctl.enabled.atmosphere && c.sheen > 0.004);
    }
    if (this.mist) {
      this.mist.x = this.mistBaseX;
      this.mist.setAlpha(c.mist);
      this.mist.setVisible(this.ctl.enabled.atmosphere && c.mist > 0.004);
    }
    if (this.cloud) this.cloud.setVisible(false);
    if (this.foam) {
      this.foam.setAlpha(Math.min(1, 0.85 * c.foam));
      this.foam.y = 0;
    }
    for (const s of this.splashes) s.obj.setVisible(false);
    if (this.beam) {
      this.beam.setRotation(0);
      this.beam.setAlpha(Math.min(ENV_CEILINGS.beamGlobal, c.beam));
      this.beam.setVisible(this.ctl.enabled.atmosphere && c.beam > 0.004);
    }
    if (this.glow) {
      this.glow.setAlpha(Math.min(ENV_CEILINGS.beamGlobal, c.glow));
      this.glow.setVisible(this.ctl.enabled.atmosphere && c.glow > 0.004);
    }
    for (const d of this.rainDrops) if (d.visible) d.setVisible(false);
    if (this.dim) this.dim.setVisible(false);
    if (this.warm) {
      this.warm.setVisible(this.ctl.enabled.atmosphere && c.warmth > 0.004);
      this.warm.setAlpha(Math.min(0.15, c.warmth));
    }
    if (this.flash) this.flash.setVisible(false);
  }

  /**
   * SHUTDOWN cleanup: pools are scene-owned and destroyed with it; clear
   * refs so a restart can never double-drive them.
   */
  dispose(): void {
    this.splashes = [];
    this.rainDrops = [];
    this.sea = this.sheen = this.mist = this.cloud = this.mountains = null;
    this.beam = this.glow = null;
    this.foam = this.collarBack = this.collarLap = null;
    this.dim = this.warm = this.flash = null;
    this.active = false;
  }
}
