/**
 * T4F-B — renderer snapshot application (RENDERER-ONLY, read-only).
 *
 * Applies one authoritative snapshot to a live renderer page:
 * - GameScene.syncWorld (world-anchored canvas state, both formats);
 * - playResult replays for newly seen sanitized results (bounded);
 * - renderOverlay with the authority's prebuilt public projections.
 *
 * No simulation, no ingestion, no mutation. The scene type is structural
 * (no Phaser import needed here); the concrete GameScene is constructed
 * once in renderer.ts.
 */

import type { GameResult } from "../engine/types";
import { FORMAT_DIMS } from "../dashboard/format";
import { renderOverlay, type OverlayInput } from "../presentation/hud";
import {
  rendererSessionStub,
  revisionSignature,
  type SnapshotV1,
} from "../shared/snapshot";

export type RendererFormat = "landscape" | "portrait";

/**
 * Authoritative canvas/source dimensions per renderer (T4B locked).
 * Phaser-free so unit tests can pin the layout contract without booting
 * a game.
 */
export function rendererDims(format: RendererFormat): { width: number; height: number } {
  const d = FORMAT_DIMS[format];
  return { width: d.width, height: d.height };
}

/** Minimal scene surface a renderer drives (GameScene satisfies this). */
export interface RendererScene {
  syncWorld: (world: SnapshotV1["world"], storyLatest: string[], feed: SnapshotV1["feed"]) => void;
  playResult: (r: GameResult) => void;
}

/** Max animation replays per applied snapshot (gap bursts stay watchable). */
export const REPLAY_PER_SNAPSHOT_MAX = 3;

/**
 * Apply a snapshot to the scene. Unseen recent results replay oldest-first
 * (bounded); everything unseen is marked seen so a later snapshot never
 * double-plays. Renderers may differ in animation progress (independent
 * rendering) but never in event identity or order.
 */
export function applySnapshotToScene(
  scene: RendererScene | null,
  snap: SnapshotV1,
  seenIds: Set<string>,
): void {
  if (!scene) return;
  try {
    scene.syncWorld(snap.world, snap.storyLog, snap.feed);
  } catch {
    /* a not-yet-ready scene must never break subscription */
  }
  const fresh = snap.recent.filter((r) => !seenIds.has(r.eventId));
  for (const r of snap.recent) seenIds.add(r.eventId);
  // Prune the dedupe set (recent retention is bounded upstream; keep slack).
  if (seenIds.size > 500) {
    const keep = new Set(snap.recent.map((r) => r.eventId));
    for (const id of [...seenIds]) {
      if (!keep.has(id)) seenIds.delete(id);
    }
  }
  const ordered = [...fresh].reverse().slice(0, REPLAY_PER_SNAPSHOT_MAX);
  for (const r of ordered) {
    try {
      scene.playResult(r);
    } catch {
      /* one bad cue must never break the rest */
    }
  }
}

/** Render the DOM HUD for a snapshot (idempotent per snapshot). */
export function renderSnapshotOverlay(
  hudEl: HTMLElement | null,
  snap: SnapshotV1,
  format: RendererFormat,
): void {
  if (!hudEl) return;
  const input: OverlayInput = {
    world: snap.world,
    session: rendererSessionStub(snap),
    storyLog: snap.storyLog,
    feed: snap.feed,
    recent: snap.recent,
    paused: snap.paused,
    format,
    viewerFeedItems: snap.viewerFeed,
    banner: snap.banner,
    vote: snap.vote,
  };
  try {
    renderOverlay(hudEl, input);
  } catch {
    /* HUD paint must never break subscription */
  }
}

/**
 * Paint fingerprint: the exact presentation identity both renderers must
 * share for one snapshot (event identity, order, authoritative state).
 * Animation progress is excluded by design (independent rendering).
 */
export function rendererPaintFingerprint(snap: SnapshotV1): string {
  return JSON.stringify({
    rev: snap.worldRev,
    session: `${snap.sessionId}#${snap.streamNumber}:${snap.sessionPhase}`,
    vote: snap.vote,
    feed: snap.viewerFeed.map((i) => i.id),
    banner: snap.banner?.id ?? null,
    sig: revisionSignature(snap),
  });
}
