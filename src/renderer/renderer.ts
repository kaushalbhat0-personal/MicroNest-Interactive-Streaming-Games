/**
 * T4F-B — renderer bootstrap (RENDERER-ONLY, read-only).
 *
 * One renderer page owns exactly one Phaser.Game + GameScene + HUD paint,
 * subscribes to the single authoritative runtime via snapshot + sequenced
 * SSE, and renders both presentation formats from the same state pipeline:
 * - landscape 1920×1080 (default, `overlay.html`);
 * - portrait 1080×1920 (`overlay.html?format=portrait`).
 *
 * Renderer invariants (mechanical):
 * - no GameEngine / EventQueue / command ingestion / YouTubeSource / ballot
 *   mutation / vote clock / simulation interval / persistence write /
 *   announcement sender anywhere in this module (boundary test enforces);
 * - on authority unavailability the page shows a safe waiting state and
 *   NEVER starts its own simulation (no fallback path exists here).
 *
 * Authority lifecycle (documented limitation of this prototype):
 * - the authority lives in the keeper-console dashboard page's memory.
 *   Refreshing/closing the dashboard restarts the game (new sessionId);
 *   renderers detect the session change, resync fully, and keep showing the
 *   last authoritative frame with a disconnected notice until then.
 * - renderer refresh/disconnect/reconnect never touches authority state:
 *   resume uses the `since` cursor, gaps refetch the snapshot, stale
 *   deliveries are rejected.
 */

import Phaser from "phaser";
import { parseOverlayFormat } from "../dashboard/format";
import { GameScene } from "../phaser/GameScene";
import type { SnapshotV1 } from "../shared/snapshot";
import type { RendererConnState } from "../shared/transport-core";
import { connectRendererTransport } from "./transport-client";
import { resolveStateTransportUrls } from "./state-transport-urls";
import {
  applySnapshotToScene,
  rendererDims,
  renderSnapshotOverlay,
  type RendererFormat,
} from "./apply-snapshot";
import "../presentation/tidebound.css";

export interface RendererDebug {
  readonly format: RendererFormat;
  connState: () => RendererConnState;
  worldRev: () => number | null;
  seq: () => number | null;
}

function statusEl(): HTMLElement | null {
  try {
    return document.getElementById("renderer-status");
  } catch {
    return null;
  }
}

function paintStatus(state: RendererConnState, detail: string, rev: number | null, seq: number | null): void {
  const el = statusEl();
  if (!el) return;
  const revLine = rev !== null ? ` · worldRev ${rev}` : "";
  const seqLine = seq !== null ? ` · seq ${seq}` : "";
  if (state === "connected") {
    el.textContent = `Live — same game as the keeper console${revLine}${seqLine}`;
    el.setAttribute("data-s", "live");
  } else if (state === "connecting" || state === "reconnecting") {
    el.textContent = `Waiting — ${detail}${rev !== null ? ` (last good${revLine}${seqLine})` : ""}`;
    el.setAttribute("data-s", "waiting");
  } else {
    el.textContent = `Not connected — ${detail}${rev !== null ? ` (last good${revLine}${seqLine})` : ""}`;
    el.setAttribute("data-s", "down");
  }
}

export function bootRenderer(): RendererDebug {
  const params = new URLSearchParams(location.search);
  const format: RendererFormat = parseOverlayFormat(params.get("format"));
  const transparent = params.get("transparent") === "1";
  const { width, height } = rendererDims(format);

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    width,
    height,
    transparent,
    backgroundColor: transparent ? "rgba(0,0,0,0)" : "#1a1033",
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.NO_CENTER },
    scene: [GameScene],
  });

  function getScene(): GameScene | null {
    try {
      const s = game.scene.getScene("game") as GameScene | null | undefined;
      if (!s) return null;
      return s.scene && s.scene.isActive() ? s : null;
    } catch {
      return null;
    }
  }

  const seenIds = new Set<string>();
  let lastSnap: SnapshotV1 | null = null;

  function onSnapshot(snap: SnapshotV1): void {
    lastSnap = snap;
    applySnapshotToScene(getScene(), snap, seenIds);
    const hud = document.getElementById("hud");
    renderSnapshotOverlay(hud, snap, format);
    paintStatus(transport.getState(), "", snap.worldRev, transport.getLastSeq());
  }

  function onState(state: RendererConnState, detail: string): void {
    paintStatus(state, detail, lastSnap ? lastSnap.worldRev : null, transport.getLastSeq());
  }

  const transport = connectRendererTransport({ onSnapshot, onState }, { format, ...resolveStateTransportUrls() });

  // Synchronous first paint note: with no authority yet the page shows the
  // waiting state over an empty stage (never a local simulation).
  // ?debug=1 keeps the live pill visible for verification (it hides while
  // live by default so the broadcast frame stays clean).
  try {
    if (params.get("debug") === "1") statusEl()?.setAttribute("data-debug", "1");
  } catch {
    /* debug flag must never break boot */
  }
  paintStatus("connecting", "waiting for the keeper console authority…", null, null);
  // Keep the scene synced on a slow cadence even between snapshots (shield
  // expiry is wall-clock driven); best-effort, never a simulation.
  setInterval(() => {
    if (lastSnap) {
      try {
        getScene()?.syncWorld(lastSnap.world, lastSnap.storyLog, lastSnap.feed);
      } catch {
        /* best-effort only */
      }
    }
  }, 1000);

  const debug: RendererDebug = {
    format,
    connState: () => transport.getState(),
    worldRev: () => transport.getWorldRev(),
    seq: () => transport.getLastSeq(),
  };
  try {
    (window as unknown as { __tbRenderer?: RendererDebug }).__tbRenderer = debug;
  } catch {
    /* non-browser test env */
  }
  return debug;
}
