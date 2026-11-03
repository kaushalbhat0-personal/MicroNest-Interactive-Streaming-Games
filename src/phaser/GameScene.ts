import Phaser from "phaser";
import type { FeedEntry } from "../engine/feed";
import type { GameResult, WorldState } from "../engine/types";

const W = 1920;
const H = 1080;

/** Minimal overlay scene: primitive shapes + text only. Visualizes state; holds no game logic. */
export class GameScene extends Phaser.Scene {
  private topText!: Phaser.GameObjects.Text;
  private threatBar!: Phaser.GameObjects.Graphics;
  private heroBar!: Phaser.GameObjects.Graphics;
  private keepBar!: Phaser.GameObjects.Graphics;
  private enemyBar!: Phaser.GameObjects.Graphics;
  private heroHpText!: Phaser.GameObjects.Text;
  private keepHpText!: Phaser.GameObjects.Text;
  private enemyHpText!: Phaser.GameObjects.Text;
  private enemyLabel!: Phaser.GameObjects.Text;
  private resourceText!: Phaser.GameObjects.Text;
  private waveText!: Phaser.GameObjects.Text;
  private storyText!: Phaser.GameObjects.Text;
  private feedText!: Phaser.GameObjects.Text;
  private shieldText!: Phaser.GameObjects.Text;
  private vexText!: Phaser.GameObjects.Text;
  private placeText!: Phaser.GameObjects.Text;
  private reducedMotion: boolean = false;
  private hero!: Phaser.GameObjects.Container;
  private enemy!: Phaser.GameObjects.Container;
  private enemyBody!: Phaser.GameObjects.Rectangle;
  private keep!: Phaser.GameObjects.Container;
  private shieldBubble!: Phaser.GameObjects.Arc;
  private embers!: Phaser.GameObjects.Particles.ParticleEmitter;

  constructor() {
    super("game");
  }

  create(): void {
    this.reducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Background: dark gradient bands + distant hills (primitives only).
    const bg = this.add.graphics();
    bg.fillGradientStyle(0x1a1033, 0x1a1033, 0x3d1e3f, 0x3d1e3f, 1);
    bg.fillRect(0, 0, W, H);
    bg.fillStyle(0x241640, 1);
    bg.fillEllipse(300, 1150, 1400, 500);
    bg.fillStyle(0x2c1c4d, 1);
    bg.fillEllipse(1500, 1180, 1500, 520);
    // Ground
    bg.fillStyle(0x141021, 1);
    bg.fillRect(0, 880, W, H - 880);
    bg.lineStyle(2, 0xff9a3c, 0.35);
    bg.lineBetween(0, 880, W, 880);

    // Floating embers (ambient particles, Phaser built-in texture).
    const px = this.textures.createCanvas("px");
    if (px) {
      const ctx = px.getContext();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 8, 8);
      px.refresh();
    }
    this.embers = this.add.particles(0, 0, "px", {
      x: { min: 0, max: W },
      y: { min: 300, max: 900 },
      lifespan: 4000,
      speedY: { min: -60, max: -20 },
      scale: { min: 0.2, max: 0.7 },
      alpha: { min: 0.1, max: 0.6 },
      tint: [0xff9a3c, 0xffd166, 0xff5d5d],
      frequency: 120,
    });
    this.embers.setDepth(-1);

    // ---- Top bar ----
    this.topText = this.add
      .text(40, 24, "", { fontSize: "40px", color: "#ffd166", fontStyle: "bold" })
      .setDepth(10);
    this.threatBar = this.add.graphics().setDepth(10);
    this.add
      .text(1450, 30, "THREAT", { fontSize: "28px", color: "#ff8fa3" })
      .setDepth(10);

    // ---- Keep (left) ----
    this.keep = this.add.container(330, 620);
    const tower = this.add.rectangle(0, 0, 220, 320, 0x8d99ae);
    const trim = this.add.rectangle(0, -120, 240, 40, 0x6c757d);
    const gate = this.add.rectangle(0, 90, 90, 140, 0x2b2d42);
    const b1 = this.add.rectangle(-80, -180, 50, 50, 0x8d99ae);
    const b2 = this.add.rectangle(0, -180, 50, 50, 0x8d99ae);
    const b3 = this.add.rectangle(80, -180, 50, 50, 0x8d99ae);
    const flame = this.add.circle(0, -230, 16, 0xff9a3c);
    this.keep.add([tower, trim, gate, b1, b2, b3, flame]);
    this.tweens.add({ targets: flame, scale: 1.4, alpha: 0.6, duration: 600, yoyo: true, repeat: -1 });
    this.add.text(230, 400, "CINDERHOLM", { fontSize: "30px", color: "#edf2f4" });
    this.keepBar = this.add.graphics();
    this.keepHpText = this.add.text(230, 440, "", { fontSize: "26px", color: "#edf2f4" });
    this.shieldBubble = this.add.circle(330, 620, 210, 0x90e0ef, 0.18).setVisible(false);
    this.shieldText = this.add
      .text(230, 478, "", { fontSize: "26px", color: "#90e0ef" })
      .setVisible(false);

    // ---- Hero (mid) ----
    this.hero = this.add.container(830, 700);
    const body = this.add.circle(0, 0, 46, 0x43aa8b);
    const helm = this.add.rectangle(0, -52, 60, 18, 0xf9c74f);
    const sword = this.add.rectangle(52, -10, 70, 10, 0xe9ecef).setAngle(-25);
    this.hero.add([body, helm, sword]);
    this.add.text(770, 770, "KEEPER", { fontSize: "28px", color: "#b7f7c9" });
    this.heroBar = this.add.graphics();
    this.heroHpText = this.add.text(740, 806, "", { fontSize: "26px", color: "#edf2f4" });

    // ---- Enemy (right) ----
    this.enemy = this.add.container(1400, 690);
    this.enemyBody = this.add.rectangle(0, 0, 110, 130, 0x9d0208);
    const spike1 = this.add.triangle(0, -95, -30, 0, 30, 0, 0, -60, 0x6a040f);
    const eye1 = this.add.circle(-22, -15, 10, 0xffd166);
    const eye2 = this.add.circle(22, -15, 10, 0xffd166);
    this.enemy.add([this.enemyBody, spike1, eye1, eye2]);
    this.enemyLabel = this.add.text(1290, 790, "", {
      fontSize: "30px",
      color: "#ff8fa3",
      fontStyle: "bold",
    });
    this.enemyBar = this.add.graphics();
    this.enemyHpText = this.add.text(1320, 830, "", { fontSize: "26px", color: "#edf2f4" });

    // ---- Bottom-left: resources / wave ----
    this.resourceText = this.add.text(40, 950, "", { fontSize: "32px", color: "#ffd166" });
    this.waveText = this.add.text(40, 995, "", { fontSize: "26px", color: "#adb5bd" });

    // ---- Right panel: story + feed ----
    this.add.rectangle(1560, 640, 680, 640, 0x000000, 0.45).setStrokeStyle(2, 0xffd166, 0.4);
    this.add.text(1240, 340, "STORY", { fontSize: "26px", color: "#ffd166" });
    this.vexText = this.add
      .text(960, 120, "", { fontSize: "34px", color: "#ff8fa3", fontStyle: "bold" })
      .setOrigin(0.5, 0)
      .setDepth(11);
    this.placeText = this.add
      .text(40, 900, "", { fontSize: "26px", color: "#90e0ef" })
      .setDepth(10);
    this.storyText = this.add.text(1240, 375, "…", {
      fontSize: "25px",
      color: "#fff3d6",
      wordWrap: { width: 640 },
    });
    this.add.text(1240, 560, "LIVE EVENTS", { fontSize: "26px", color: "#90e0ef" });
    this.feedText = this.add.text(1240, 595, "", {
      fontSize: "24px",
      color: "#edf2f4",
      wordWrap: { width: 640 },
      lineSpacing: 6,
    });

    this.cameras.main.setBounds(0, 0, W, H);
  }

  // ---------- state sync (called by app after every pump/tick) ----------

  syncWorld(w: WorldState, storyLatest: string[], feed: FeedEntry[]): void {
    this.topText.setText(`${w.worldName}  ·  Arc ${w.currentArc} · Chapter ${w.currentChapter}`);
    this.drawThreat(w.threatLevel);
    this.drawBar(this.keepBar, 230, 400 - 60, 220, w.keepHp, w.maxKeepHp, 0x90be6d);
    this.keepHpText.setText(`Keep ${w.keepHp}/${w.maxKeepHp}`);
    this.drawBar(this.heroBar, 740, 770 - 60, 200, w.heroHp, w.maxHeroHp, 0x43aa8b);
    this.heroHpText.setText(`Hero ${w.heroHp}/${w.maxHeroHp}`);
    this.drawBar(this.enemyBar, 1290, 790 - 60, 230, w.enemy.hp, w.enemy.maxHp, 0xe63946);
    this.enemyHpText.setText(
      w.enemy.hp > 0 ? `${w.enemy.hp}/${w.enemy.maxHp}` : "DEFEATED",
    );
    this.enemyLabel.setText(w.enemy.isElite ? `⚠ ELITE: ${w.enemy.name}` : w.enemy.name);
    this.enemyBody.setFillStyle(w.enemy.isElite ? 0x6a040f : 0x9d0208);
    this.resourceText.setText(`◆ Supplies ${w.resources}    👁 Lanterns ${w.uniqueSearchers.length}/5`);
    this.waveText.setText(
      `Wave ${w.waveNumber} · ${Object.entries(w.factionState).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
    );
    const shieldOn = Date.now() < w.keepShieldUntil;
    this.shieldBubble.setVisible(shieldOn);
    this.shieldText.setVisible(shieldOn).setText(shieldOn ? "🛡 WARD UP" : "");

    // Place + herald pressure, in Tidebound language (read-only projection).
    const locParts = w.unlockedLocations.map((id) => {
      const s = w.locationState[id] ?? "sound";
      const name =
        id === "cinderholm" ? "Cinderholm" : id === "pale-reaches" ? "Pale Reaches" : id === "chapel-steps" ? "Chapel Steps" : id;
      return `${name} ${s.toUpperCase()}`;
    });
    this.placeText.setText(`◈ ${locParts.join(" · ")}`);
    const drivenOff = w.storyFlags["c.vex.driven-off"] === true;
    const vexMet = w.storyFlags["c.vex.met"] === true;
    if (drivenOff) {
      this.vexText.setText("✦ VEX DRIVEN OFF — CINDERHOLM BREATHES").setColor("#90be6d");
    } else if (vexMet) {
      this.vexText.setText("⚠ HERALD VEX — CINDERHOLM STRAINED").setColor("#ff8fa3");
    } else if (w.enemy.isElite) {
      this.vexText.setText("⚠ AN ELITE HERALD SAILS FOR CINDERHOLM").setColor("#ff8fa3");
    } else {
      this.vexText.setText("");
    }

    if (storyLatest.length > 0) this.storyText.setText(storyLatest[0]);
    this.feedText.setText(feed.map((e) => (e.count > 1 ? `• ${e.text}` : `• ${e.text}`)).join("\n"));
  }

  // ---------- effects (one per processed result) ----------

  playResult(r: GameResult): void {
    if (this.reducedMotion) {
      // Reduced motion: state still updates via syncWorld; skip shake/flash.
      if (r.visual.hitEnemy) this.burst(1400, 690, 0xffd166);
      return;
    }
    if (r.visual.shake) this.cameras.main.shake(180, 0.006);
    if (r.visual.hitEnemy) {
      this.flash(this.enemyBody, 0xffffff);
      this.tweens.add({ targets: this.enemy, x: "+=18", duration: 70, yoyo: true, repeat: 3 });
      this.burst(1400, 690, 0xffd166);
    }
    if (r.visual.healHero) {
      this.burst(830, 700, 0x43ff9a);
      this.tweens.add({ targets: this.hero, scale: 1.12, duration: 160, yoyo: true });
    }
    if (r.visual.shieldKeep) {
      this.shieldBubble.setVisible(true);
      this.shieldText.setVisible(true).setText("🛡 WARD UP");
    }
    if (r.visual.spawnElite || r.visual.spawnWave) {
      this.enemy.setScale(0.2);
      this.tweens.add({ targets: this.enemy, scale: 1, duration: 500, ease: "Back.easeOut" });
      this.burst(1400, 690, 0xff0054);
    }
    if (r.visual.discovery) this.burst(1000, 500, 0x90e0ef);
    if (r.visual.majorStory) {
      this.cameras.main.flash(300, 255, 209, 102);
      this.burst(960, 400, 0xffd166);
    }
    if (r.visual.hitHero) this.flash(this.hero.getAt(0) as Phaser.GameObjects.Arc, 0xff0000);
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
    g.fillStyle(0x000000, 0.55).fillRect(x, y, width, 22);
    const frac = max > 0 ? Math.max(0, value / max) : 0;
    g.fillStyle(color, 1).fillRect(x + 2, y + 2, (width - 4) * frac, 18);
  }

  private drawThreat(level: number): void {
    const g = this.threatBar;
    g.clear();
    g.fillStyle(0x000000, 0.55).fillRect(1560, 28, 300, 24);
    g.fillStyle(level >= 70 ? 0xe63946 : 0xf4a261, 1).fillRect(1562, 30, 296 * (level / 100), 20);
    if (!this.threatLabel) {
      this.threatLabel = this.add.text(1560, 56, "", { fontSize: "24px", color: "#edf2f4" });
    }
    this.threatLabel.setText(`Threat ${level}/100`);
  }

  private threatLabel?: Phaser.GameObjects.Text;

  private flash(target: Phaser.GameObjects.Shape, color: number): void {
    const orig = (target as unknown as { fillColor: number }).fillColor;
    target.setFillStyle(color, 1);
    this.time.delayedCall(120, () => target.setFillStyle(orig, 1));
  }

  private burst(x: number, y: number, tint: number): void {
    this.add.particles(x, y, "px", {
      lifespan: 500,
      speed: { min: 80, max: 260 },
      scale: { min: 0.3, max: 0.9 },
      alpha: { start: 1, end: 0 },
      tint,
      quantity: 14,
      emitting: true,
    }).explode(14, x, y);
  }
}
