/**
 * T4F-C1 — server-side authoritative Tidebound runtime.
 *
 * Run:  npx tsx server/authority-server.ts [port]   (default 3004)
 * Env:  AUTHORITY_TOKEN  explicit credential (tests/ephemeral setups)
 *       STATE_URL        state-transport base (default http://127.0.0.1:3003)
 *       YT_URL           youtube sidecar base (default http://127.0.0.1:3002)
 *       DATA_DIR         runtime state dir (default ./data)
 *
 * This process is the SOLE authority. It owns: GameEngine + EventQueue +
 * WorldState, StreamSession + ballot box + vote clock, the 250ms pump/tick
 * loop, FeedAggregator + ViewerFeedStore + BannerQueue, the single
 * sidecar-SSE ingestion, outbound announcement orchestration, snapshot
 * publication (authenticated), and persistence coordination. The dashboard
 * is a control client; renderers stay read-only subscribers. Nothing here
 * depends on a browser tab remaining open.
 *
 * Lifecycle: starting → recovering (restore/reload) → running ⇄ paused
 *            → stopped (clean shutdown) | failed (unrecoverable).
 * Persisted: world save (data/world-state.json), authority token
 *            (data/authority-token.json, 0600), youtube cursor
 *            (data/authority-cursor.json). Ephemeral: session, ballots,
 *            vote clock position, queue, storyLog, feed/banners, announce
 *            map, SSE cursors-in-flight, source selection (safe default:
 *            simulation). A corrupt save boots an explicit fresh genesis
 *            (flagged in status) — never a silent second authority.
 *
 * Threat boundary: every mutation endpoint requires
 * `Authorization: Bearer <token>` (constant-time compare). Renderers and
 * any party without the token can only read. Only /status is public
 * (lifecycle counters, no secrets). The token never appears in
 * responses, snapshots, SSE, or logs. All servers bind 127.0.0.1.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, QUEUE } from "../src/engine/config";
import { GameEngine, makeEventId } from "../src/engine/engine";
import type { CanonicalEvent } from "../src/engine/types";
import { FeedAggregator } from "../src/engine/feed";
import { ledgerStatus } from "../src/engine/ledger";
import {
  castSessionVote,
  openSessionVote,
  type StreamSession,
} from "../src/engine/lifecycle";
import {
  closeStreamAndFire,
  closeVoteAndFire,
  fireRite,
  handleProcessedResult,
  openStreamAndFire,
  overrideVoteAndFire,
} from "../src/runtime/progression";
import {
  beaconOilModel,
  paleChartModel,
  voteModel,
  vexModel,
} from "../src/presentation/tidebound-presentation";
import { BannerQueue, ViewerFeedStore } from "../src/presentation/viewer-feed";
import {
  ANNOUNCE_MAX_CHARS,
  closeEventId,
  composeVoteOpen,
  composeVoteResult,
  openEventId,
  type AnnounceStatus,
} from "../src/presentation/vote-announce";
import { KINDLING_VOTE, ROUTE_VOTE, TIDEBOUND_LIBRARY, tideboundGenesis } from "../src/content/tidebound";
import {
  buildSnapshot,
  revisionSignature,
  shouldBumpRevision,
  type SnapshotV1,
} from "../src/shared/snapshot";
import { TRANSPORT_PROTOCOL } from "../src/shared/transport-core";
import { normalizeWorld, serialize } from "../src/persistence/store";
import { bearerToken, resolveAuthorityToken, tokensEqual, TOKEN_FILE } from "./authority-token.mjs";

// ---------------------------------------------------------------------------
// Small local mirrors (kept dependency-free: no browser modules server-side)
// ---------------------------------------------------------------------------

/** Mirrors voteOptionIndex() in src/youtube/client.ts (whitelist mapping). */
function voteOptionIndex(command: string): number | null {
  if (command === "!votea") return 0;
  if (command === "!voteb") return 1;
  if (command === "!votec") return 2;
  return null;
}

/** Mirrors isCanonical() in src/youtube/client.ts (sidecar event shape). */
function isCanonicalEv(ev: unknown): ev is CanonicalEvent {
  if (!ev || typeof ev !== "object") return false;
  const e = ev as Record<string, unknown>;
  if (e.kind === "paid_retraction") {
    return (
      typeof e.eventId === "string" && !!e.eventId &&
      typeof e.refPlatformId === "string" && !!e.refPlatformId &&
      typeof e.receivedAt === "string"
    );
  }
  if (e.kind !== "chat_command" && e.kind !== "paid_event") return false;
  return (
    typeof e.eventId === "string" && !!e.eventId &&
    typeof e.actorId === "string" && !!e.actorId &&
    typeof e.actorName === "string" && !!e.actorName &&
    typeof e.receivedAt === "string"
  );
}

function commandKeys(): string[] {
  return Object.keys(COMMANDS);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthorityLifecycle = "starting" | "recovering" | "running" | "paused" | "stopped" | "failed";

export interface AuthorityOpts {
  port?: number;
  dataDir?: string;
  stateUrl?: string;
  ytUrl?: string;
  /** Override timers (tests). */
  pollMs?: number;
  publishMs?: number;
  ytStatusMs?: number;
  /** Never exits the process on fatal boot errors (tests). */
  onFatal?: (message: string) => void;
}

export interface AuthorityHandle {
  getLifecycle: () => AuthorityLifecycle;
  getWorldRev: () => number;
  getSeq: () => number | null;
  getSessionId: () => string;
  getTimerCount: () => number;
  getStatus: () => Record<string, unknown>;
  stop: () => Promise<void>;
}

interface AnnounceState {
  kind: "open" | "close";
  status: AnnounceStatus;
  reason?: string;
  text?: string;
  attempts: number;
}

const BODY_MAX_BYTES = 64 * 1024;
const CURSOR_FILE = "authority-cursor.json";
const LOCK_FILE = "authority.lock";
const SAVE_FILE = "world-state.json";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

let activeAuthority: { stop: () => Promise<void> } | null = null;

export async function startAuthority(opts?: AuthorityOpts): Promise<AuthorityHandle> {
  if (activeAuthority) throw new Error("duplicate-authority: an authority is already active in this process");
  const port = opts?.port ?? Number(process.argv[2] ?? 3004);
  const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = opts?.dataDir ?? process.env.DATA_DIR ?? join(moduleRoot, "data");
  const stateUrl = (opts?.stateUrl ?? process.env.STATE_URL ?? "http://127.0.0.1:3003").replace(/\/$/, "");
  const ytUrl = (opts?.ytUrl ?? process.env.YT_URL ?? "http://127.0.0.1:3002").replace(/\/$/, "");
  const pollMs = opts?.pollMs ?? 250;
  const publishMs = opts?.publishMs ?? 400;
  const ytStatusMs = opts?.ytStatusMs ?? 3000;
  const startedAt = Date.now();

  await mkdir(dataDir, { recursive: true });
  // Mutable: operator rotation replaces the value at runtime (the file
  // stays the source of truth; the state server re-resolves per request).
  let { token: authorityToken, generated: tokenGenerated } = await resolveAuthorityToken(dataDir);

  let lifecycle: AuthorityLifecycle = "starting";
  let lastError: string | null = null;
  let recoveredFrom: string = "none";
  const fail = (message: string): never => {
    lifecycle = "failed";
    lastError = message;
    if (opts?.onFatal) {
      opts.onFatal(message);
      throw new Error(message);
    }
    console.error(`[tidebound] authority failed: ${message}`);
    process.exit(1);
  };

  // ---- single-authority lock (no silent second authority) ----
  const lockPath = join(dataDir, LOCK_FILE);
  let lockOwned = false;
  try {
    const raw = await readFile(lockPath, "utf8");
    const lock = JSON.parse(raw) as { pid?: unknown };
    if (typeof lock.pid === "number" && pidAlive(lock.pid)) {
      fail(`authority already running (pid ${lock.pid})`);
    }
    console.log("[tidebound] stale authority lock found (dead pid) — taking over");
  } catch (e) {
    if ((e as Error).message.startsWith("authority already running")) throw e;
    /* no lock -> proceed */
  }
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
  lockOwned = true;

  // ---- engine + session (exactly one; hook wired at construction) ----
  const store = { persistFrom: "none" as "file" | "local" | "none" | "file-error" };
  const feed = new FeedAggregator();
  const viewerFeed = new ViewerFeedStore();
  const banners = new BannerQueue();
  let session: StreamSession;
  const engine = new GameEngine({
      onResult: (r) => {
        feed.push(r);
        viewerFeed.push(r, { world: engine.world, vote: voteFeedCtx(session) });
        banners.pushResult(r, engine.world);
        // Single wiring point for collective story advancement (mirrors
        // the former app-shell wiring): meters → assembly reaction →
        // ambient thresholds, at most one vote firing on close.
        const h = handleProcessedResult(engine, session, r, TIDEBOUND_LIBRARY);
        const wasOpen = session.activeVote !== null && !session.activeVote.closed;
        session = h.session;
        if (wasOpen && session.activeVote !== null && session.activeVote.closed) {
          void announceVoteClose();
        }
        scheduleAutosave();
      },
    },
  );
  const game = engine;

  function voteFeedCtx(session: StreamSession) {
    const v = session.activeVote;
    if (!v) return null;
    const m = voteModel(session, engine.world, TIDEBOUND_LIBRARY);
    return {
      phase: m.phase,
      totalBallots: m.totalBallots,
      ballots: { ...v.ballots },
      options: m.options.map((o) => ({ label: o.label, command: o.command })),
    };
  }

  // Restore persisted world BEFORE first snapshot (validated; explicit).
  lifecycle = "recovering";
  let restoredWorld: ReturnType<typeof normalizeWorld> = null;
  let savePresent = false;
  try {
    const raw = await readFile(join(dataDir, SAVE_FILE), "utf8");
    savePresent = true;
    restoredWorld = normalizeWorld(JSON.parse(raw));
  } catch {
    restoredWorld = null;
  }
  if (restoredWorld) {
    engine.loadWorld(restoredWorld);
    engine.storyLog.unshift("World restored (file). Tidebound remembers.");
    recoveredFrom = "file";
    store.persistFrom = "file";
  } else {
    engine.loadWorld(tideboundGenesis());
    recoveredFrom = savePresent ? "corrupt-save-fresh" : "fresh-genesis";
    if (savePresent) console.log("[tidebound] saved world invalid — booting explicit fresh genesis");
  }

  {
    const opened = openStreamAndFire(engine.world, TIDEBOUND_LIBRARY);
    if (opened.ok) {
      engine.world = opened.world;
      for (const d of opened.newDeeds) engine.pushStory(d);
      session = opened.session;
    } else {
      engine.loadWorld(tideboundGenesis());
      recoveredFrom = "fresh-genesis";
      const retry = openStreamAndFire(engine.world, TIDEBOUND_LIBRARY);
      if (retry.ok) {
        engine.world = retry.world;
        for (const d of retry.newDeeds) engine.pushStory(d);
        session = retry.session;
      } else {
        fail("could not open stream session");
      }
    }
  }

  let paused = false;
  let source: "simulation" | "youtube" = "simulation";
  const announce: Record<string, AnnounceState> = {};
  const diag = { received: 0, queued: 0, duplicate: 0, rejected: 0 };
  let ytStatus: { status: string; error?: string | null; [k: string]: unknown } = { status: "off" };
  let worldRev = 0;
  let lastSig: string | null = null;
  let lastSeq: number | null = null;
  let lastPublishAtIso: string | null = null;
  let publishes = 0;

  // ---- timer registry (every timer tracked; stop() drains all) ----
  const timers = new Set<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>>();
  function every(ms: number, fn: () => void): ReturnType<typeof setInterval> {
    const t = setInterval(fn, ms);
    timers.add(t);
    return t;
  }
  function after(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  }
  function clearTimer(t: unknown): void {
    clearInterval(t as ReturnType<typeof setInterval>);
    clearTimeout(t as ReturnType<typeof setTimeout>);
    timers.delete(t as ReturnType<typeof setInterval>);
  }

  // ---- persistence (file only; the server has fs, no localStorage) ----
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleAutosave(): void {
    if (saveTimer) return;
    saveTimer = after(2000, () => {
      saveTimer = null;
      void persistWorld();
    });
  }
  async function persistWorld(): Promise<"file" | "file-error"> {
    try {
      await writeFile(join(dataDir, SAVE_FILE), serialize(engine.world), "utf8");
      store.persistFrom = "file";
      return "file";
    } catch (e) {
      store.persistFrom = "file-error";
      lastError = `persist-failed: ${String((e as Error)?.message ?? e)}`;
      return "file-error";
    }
  }

  // ---- snapshot publication (authenticated, change-gated) ----
  function candidate(rev: number): SnapshotV1 {
    const led = ledgerStatus(engine.world.paidLedger);
    return buildSnapshot({
      world: engine.world,
      session,
      storyLog: engine.storyLog,
      feed: feed.list(),
      recent: engine.recentResults,
      viewerFeed: viewerFeed.list(),
      banner: banners.current(),
      paused,
      vote: voteModel(session, engine.world, TIDEBOUND_LIBRARY),
      paid: { applied: led.applied, compensated: led.compensated, noted: led.noted, total: led.total },
      worldRev: rev,
      atIso: new Date().toISOString(),
    });
  }

  async function postSnapshot(snap: SnapshotV1): Promise<{ ok: true; seq: number } | { ok: false; reason: string }> {
    try {
      const res = await fetch(`${stateUrl}/api/state/publish`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${authorityToken}` },
        body: JSON.stringify({ protocol: TRANSPORT_PROTOCOL, snapshot: snap }),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { seq?: unknown } | null;
        return { ok: true, seq: typeof data?.seq === "number" ? data.seq : -1 };
      }
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      return { ok: false, reason: typeof data?.error === "string" ? data.error : `http-${res.status}` };
    } catch {
      return { ok: false, reason: "state-server-unreachable" };
    }
  }

  async function fetchServerRev(): Promise<number | null> {
    try {
      const res = await fetch(`${stateUrl}/api/state/snapshot`, { headers: { accept: "application/json" } });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as { snapshot?: { worldRev?: unknown } } | null;
      return typeof data?.snapshot?.worldRev === "number" ? data.snapshot.worldRev : null;
    } catch {
      return null;
    }
  }

  let publishing = false;
  async function publishOnce(): Promise<void> {
    if (publishing || lifecycle === "stopped" || lifecycle === "failed") return;
    publishing = true;
    try {
      const next = candidate(worldRev + 1);
      const sig = revisionSignature(next);
      if (!shouldBumpRevision(lastSig, sig) && worldRev > 0) return;
      worldRev += 1;
      const snap = worldRev === next.worldRev ? next : candidate(worldRev);
      let res = await postSnapshot(snap);
      if (!res.ok && res.reason === "stale-revision") {
        const serverRev = await fetchServerRev();
        if (serverRev !== null && serverRev >= worldRev) worldRev = serverRev + 1;
        res = await postSnapshot(candidate(worldRev));
      }
      if (res.ok) {
        lastSig = revisionSignature(snap);
        publishes += 1;
        lastSeq = res.seq;
        lastPublishAtIso = snap.atIso;
      } else {
        lastError = `publish-${res.reason}`;
      }
    } finally {
      publishing = false;
    }
  }

  // ---- outbound announcements (T3 orchestration, server-side) ----
  async function ytSend(text: string, eventId: string): Promise<{ ok: true; duplicate?: boolean } | { ok: false; reason: string }> {
    if (text.length > 4096) return { ok: false, reason: "too-long" };
    try {
      const res = await fetch(`${ytUrl}/api/youtube/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, eventId }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; duplicate?: boolean } | null;
      if (res.ok && data?.ok) return { ok: true, duplicate: !!data.duplicate };
      return { ok: false, reason: typeof data?.error === "string" && data.error ? data.error : "api-error" };
    } catch {
      return { ok: false, reason: "sidecar-unreachable" };
    }
  }

  function applySendResult(eventId: string, kind: "open" | "close", res: { ok: true } | { ok: false; reason: string }): void {
    const cur = announce[eventId] ?? { kind, status: "failed" as const, attempts: 0 };
    if (res.ok) {
      announce[eventId] = { ...cur, kind, status: "sent", reason: undefined };
    } else {
      const status: AnnounceStatus =
        res.reason === "uncertain" ? "uncertain"
        : res.reason === "insufficient-scope" ? "reauth-required"
        : res.reason === "no-live-chat" || res.reason === "auth-required" || res.reason === "sidecar-unreachable" ? "not-connected"
        : "failed";
      announce[eventId] = { ...cur, kind, status, reason: res.reason };
    }
  }

  async function postAnnouncement(eventId: string, kind: "open" | "close", text: string): Promise<void> {
    const existing = announce[eventId];
    announce[eventId] = { kind, status: "sending", text, attempts: (existing?.attempts ?? 0) + 1 };
    const res = await ytSend(text, eventId);
    applySendResult(eventId, kind, res);
  }

  function voteSnapshotForAnnounce() {
    const v = voteModel(session, engine.world, TIDEBOUND_LIBRARY);
    if (v.phase === "none" || !v.id) return null;
    return { vote: v, sessionId: session.sessionId };
  }

  async function announceVoteOpen(): Promise<void> {
    const snap = voteSnapshotForAnnounce();
    if (!snap) return;
    const eventId = openEventId(snap.sessionId, snap.vote.id);
    delete announce[closeEventId(snap.sessionId, snap.vote.id)];
    const composed = composeVoteOpen({
      prompt: snap.vote.prompt,
      options: snap.vote.options.map((o) => ({ label: o.label, command: o.command })),
      maxCommands: snap.vote.maxCommands,
    });
    if (!composed.ok) {
      announce[eventId] = { kind: "open", status: "failed", reason: `composition-${composed.reason}`, attempts: 0 };
      return;
    }
    if (source !== "youtube") {
      announce[eventId] = { kind: "open", status: "na-simulation", text: composed.text, attempts: 0 };
      return;
    }
    if (composed.text.length > ANNOUNCE_MAX_CHARS) {
      announce[eventId] = { kind: "open", status: "failed", reason: "composition-too-long", attempts: 0 };
      return;
    }
    await postAnnouncement(eventId, "open", composed.text);
  }

  async function announceVoteClose(): Promise<void> {
    const snap = voteSnapshotForAnnounce();
    if (!snap || snap.vote.phase !== "closed") return;
    const eventId = closeEventId(snap.sessionId, snap.vote.id);
    const existing = announce[eventId];
    if (existing && (existing.status === "sent" || existing.status === "sending")) return;
    const composed = composeVoteResult({
      prompt: snap.vote.prompt,
      totalBallots: snap.vote.totalBallots,
      winnerLabel: snap.vote.winnerLabel,
      winnerReason: snap.vote.winnerReason,
    });
    if (!composed.ok) {
      announce[eventId] = { kind: "close", status: "failed", reason: `composition-${composed.reason}`, attempts: existing?.attempts ?? 0 };
      return;
    }
    if (source !== "youtube") {
      announce[eventId] = { kind: "close", status: "na-simulation", text: composed.text, attempts: existing?.attempts ?? 0 };
      return;
    }
    await postAnnouncement(eventId, "close", composed.text);
  }

  async function retryAnnounce(eventId: string): Promise<{ ok: boolean }> {
    const existing = announce[eventId];
    if (!existing || !existing.text) return { ok: false };
    if (existing.status === "sent" || existing.status === "sending") return { ok: false };
    if (source !== "youtube") {
      announce[eventId] = { ...existing, status: "na-simulation" };
      return { ok: true };
    }
    await postAnnouncement(eventId, existing.kind, existing.text);
    return { ok: true };
  }

  function resetViewerPresentation(): void {
    viewerFeed.clear();
    banners.clear();
  }

  // ---- simulation step (single pump/tick loop; held unless running) ----
  function step(): void {
    if (lifecycle !== "running") return;
    if (paused) return;
    const results = engine.pump();
    const ticked = engine.tick();
    if (results.length > 0 || ticked.length > 0) scheduleAutosave();
  }

  // (Single wiring point — no other result path exists.)

  // ---- YouTube ingestion (single sidecar SSE subscription) ----
  let ytReader: { abort: () => void } | null = null;
  let ytStatusTimer: ReturnType<typeof setInterval> | null = null;
  let ytCursor: string | null = null;
  try {
    const raw = await readFile(join(dataDir, CURSOR_FILE), "utf8");
    const parsed = JSON.parse(raw) as { lastYtEventId?: unknown };
    if (typeof parsed.lastYtEventId === "string") ytCursor = parsed.lastYtEventId;
  } catch {
    /* no cursor yet */
  }
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleCursorSave(): void {
    if (cursorTimer) return;
    cursorTimer = after(2000, () => {
      cursorTimer = null;
      void writeFile(join(dataDir, CURSOR_FILE), JSON.stringify({ lastYtEventId: ytCursor }), "utf8").catch(() => undefined);
    });
  }

  async function refreshYtStatus(): Promise<void> {
    try {
      const res = await fetch(`${ytUrl}/api/youtube/status`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`status:${res.status}`);
      const s = (await res.json()) as typeof ytStatus;
      ytStatus = s && typeof s.status === "string" ? s : { status: "DISCONNECTED", error: "bad-status" };
    } catch {
      ytStatus = { status: "DISCONNECTED", error: "sidecar-unreachable" };
    }
  }

  function ingestSidecarEvent(ev: unknown, sseId: string): void {
    if (!isCanonicalEv(ev)) {
      diag.rejected += 1;
      return;
    }
    if (ev.kind === "chat_command" && !(ev.command in COMMANDS)) {
      diag.rejected += 1;
      return;
    }
    if (ev.kind === "chat_command") {
      const idx = voteOptionIndex(ev.command);
      if (idx !== null) {
        const casted = castSessionVote(session, ev.actorId, idx);
        if (casted.ok) session = casted.session;
      }
    }
    diag.received += 1;
    const outcome = game.ingest(ev);
    if (outcome === "queued") diag.queued += 1;
    else if (outcome === "duplicate") diag.duplicate += 1;
    else diag.rejected += 1;
    if (sseId) {
      ytCursor = sseId;
      scheduleCursorSave();
    }
  }

  async function runYtReader(signal: AbortSignal, resumeFrom: string | null): Promise<void> {
    const url = resumeFrom ? `${ytUrl}/api/youtube/stream?lastId=${encodeURIComponent(resumeFrom)}` : `${ytUrl}/api/youtube/stream`;
    const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal });
    if (!res.ok || !res.body) throw new Error(`stream:${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let id = "";
    let name = "message";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("id:")) id = line.slice(3).trim();
          else if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (data && (name === "canonical" || name === "message")) {
          try {
            ingestSidecarEvent(JSON.parse(data), id);
          } catch {
            diag.rejected += 1;
          }
        }
        name = "message";
      }
    }
  }

  let ytReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let ytAttempt = 0;
  function startIngestion(): void {
    if (ytReader) return; // single subscription — never duplicated
    const ctl = new AbortController();
    ytReader = { abort: () => ctl.abort() };
    ytAttempt = 0;
    void refreshYtStatus();
    if (ytStatusTimer) clearTimer(ytStatusTimer);
    ytStatusTimer = every(ytStatusMs, () => void refreshYtStatus());
    const loop = async (): Promise<void> => {
      if (!ytReader) return;
      try {
        await runYtReader(ctl.signal, ytCursor);
      } catch {
        /* interrupted or sidecar down — backoff below */
      }
      if (!ytReader) return;
      const delay = Math.min(15000, 1000 * 2 ** Math.min(ytAttempt, 4));
      ytAttempt += 1;
      if (ytReconnectTimer) clearTimer(ytReconnectTimer);
      ytReconnectTimer = after(delay, () => void loop());
    };
    void loop();
  }

  function stopIngestion(): void {
    ytReader?.abort();
    ytReader = null;
    if (ytStatusTimer) {
      clearTimer(ytStatusTimer);
      ytStatusTimer = null;
    }
    if (ytReconnectTimer) {
      clearTimer(ytReconnectTimer);
      ytReconnectTimer = null;
    }
    ytStatus = { status: "off" };
  }

  function isYtIngesting(): boolean {
    return ytReader !== null;
  }

  // ---- control-plane (keeper-trusted, token-gated; mirrors Runtime reads) ----
  function controlPlane(): Record<string, unknown> {
    const led = ledgerStatus(game.world.paidLedger);
    const vote = voteModel(session, game.world, TIDEBOUND_LIBRARY);
    return {
      lifecycle,
      worldRev,
      seq: lastSeq,
      publishes,
      sessionId: session.sessionId,
      streamNumber: session.streamNumber,
      sessionPhase: session.phase,
      session,
      vote,
      paused,
      source,
      ingesting: isYtIngesting(),
      world: game.world,
      storyLog: game.storyLog,
      feed: feed.list(),
      recent: game.recentResults,
      queue: { size: game.queue.size, max: QUEUE.maxSize, peek: game.queue.peekAll() },
      paid: { applied: led.applied, compensated: led.compensated, noted: led.noted, total: led.total, overflow: led.overflow },
      announce: Object.fromEntries(
        Object.entries(announce).map(([k, a]) => [k, { kind: a.kind, status: a.status, reason: a.reason ?? null, attempts: a.attempts }]),
      ),
      meters: { paleChart: paleChartModel(game.world), beaconOil: beaconOilModel(game.world) },
      vexStage: vexModel(game.world).stage,
      yt: { lastStatus: ytStatus, diag: { ...diag } },
      persist: { from: store.persistFrom },
      recoveredFrom,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      timers: timers.size,
      lastError,
      lastPublishAtIso: lastPublishAtIso,
    };
  }

  function publicStatus(): Record<string, unknown> {
    return {
      lifecycle,
      worldRev,
      seq: lastSeq,
      sessionId: session.sessionId,
      streamNumber: session.streamNumber,
      paused,
      source,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      timers: timers.size,
      queueSize: game.queue.size,
      recoveredFrom,
      persistFrom: store.persistFrom,
    };
  }

  // ---- control mutations (outcome strings match the former Runtime API) ----
  function doCommand(body: { actorId?: unknown; actorName?: unknown; command?: unknown }): { ok: boolean; outcome: string } {
    const actorId = typeof body.actorId === "string" && body.actorId ? body.actorId : "anon";
    const actorName = typeof body.actorName === "string" && body.actorName ? body.actorName : "A watcher";
    const command = typeof body.command === "string" ? body.command : "";
    const token = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!commandKeys().includes(token)) return { ok: true, outcome: "rejected-invalid" };
    if ((token === "!votea" || token === "!voteb" || token === "!votec") && session.activeVote !== null) {
      const idx = token === "!votea" ? 0 : token === "!voteb" ? 1 : 2;
      const casted = castSessionVote(session, actorId, idx);
      if (casted.ok) session = casted.session;
    }
    return { ok: true, outcome: game.ingestCommand(actorId, actorName, token, makeEventId("cmd")) };
  }

  function doPaid(body: { actorId?: unknown; actorName?: unknown; amountMinor?: unknown; currency?: unknown }): { ok: boolean; outcome: string } {
    const actorId = typeof body.actorId === "string" && body.actorId ? body.actorId : "anon";
    const actorName = typeof body.actorName === "string" && body.actorName ? body.actorName : "Someone";
    const amountMinor = typeof body.amountMinor === "number" && Number.isFinite(body.amountMinor) ? Math.round(body.amountMinor) : NaN;
    const currency = typeof body.currency === "string" ? body.currency : "INR";
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) return { ok: true, outcome: "rejected-invalid" };
    return { ok: true, outcome: game.ingestPaid(actorId, actorName, amountMinor, currency, makeEventId("paid")) };
  }

  async function doOpenVote(which: string): Promise<{ ok: boolean; outcome: string }> {
    const def = which === "kindling" ? KINDLING_VOTE : ROUTE_VOTE;
    const r = openSessionVote(session, { ...def, library: TIDEBOUND_LIBRARY });
    if (!r.ok) return { ok: true, outcome: r.reason };
    session = r.session;
    scheduleAutosave();
    await announceVoteOpen();
    return { ok: true, outcome: which === "kindling" ? "opened-kindling-vote" : "opened-route-vote" };
  }

  async function doCloseVote(): Promise<{ ok: boolean; outcome: string }> {
    const r = closeVoteAndFire(session, game.world, TIDEBOUND_LIBRARY);
    session = r.session;
    game.world = r.world;
    for (const d of r.newDeeds) game.pushStory(d);
    scheduleAutosave();
    if (!r.didClose) return { ok: true, outcome: r.reason ?? "closed-vote" };
    await announceVoteClose();
    return { ok: true, outcome: r.fired ? `closed-vote:fired:${r.fired}` : `closed-vote:${r.reason ?? "no-winner"}` };
  }

  async function doOverride(optionIndex: number): Promise<{ ok: boolean; outcome: string }> {
    const r = overrideVoteAndFire(session, game.world, TIDEBOUND_LIBRARY, optionIndex);
    if (r.winner === null) return { ok: true, outcome: r.reason ?? "override-failed" };
    game.world = r.world;
    session = r.session;
    for (const d of r.newDeeds) game.pushStory(d);
    scheduleAutosave();
    if (r.didClose) await announceVoteClose();
    return { ok: true, outcome: r.fired ? `override:${r.winner}:fired` : `override:${r.winner}:no-fire:${r.reason ?? "unknown"}` };
  }

  async function doRite(templateId: string): Promise<{ ok: boolean; outcome: string }> {
    const r = fireRite(game.world, TIDEBOUND_LIBRARY, templateId);
    if (!r.ok) return { ok: true, outcome: r.reason ?? "rite-failed" };
    game.world = r.world;
    for (const d of r.newDeeds) game.pushStory(d);
    scheduleAutosave();
    return { ok: true, outcome: `rite-fired:${r.fired}` };
  }

  async function doEndStream(): Promise<{ ok: boolean; outcome: string }> {
    const f = closeStreamAndFire(game.world, session, TIDEBOUND_LIBRARY);
    if (!f.ok) return { ok: true, outcome: f.reason };
    game.world = f.world;
    for (const d of f.newDeeds) game.pushStory(d);
    game.loadWorld(game.world);
    resetViewerPresentation();
    const opened = openStreamAndFire(game.world, TIDEBOUND_LIBRARY);
    if (!opened.ok) return { ok: true, outcome: opened.reason };
    game.world = opened.world;
    session = opened.session;
    for (const d of opened.newDeeds) game.pushStory(d);
    await persistWorld();
    return { ok: true, outcome: `stream-closed:${f.world.streamCount}` };
  }

  async function doReload(): Promise<{ ok: boolean; outcome: string }> {
    lifecycle = "recovering";
    try {
      const raw = await readFile(join(dataDir, SAVE_FILE), "utf8");
      const state = normalizeWorld(JSON.parse(raw));
      if (state) {
        game.loadWorld(state);
        resetViewerPresentation();
        game.storyLog.unshift("World reloaded (file).");
        const opened = openStreamAndFire(game.world, TIDEBOUND_LIBRARY);
        if (opened.ok) {
          game.world = opened.world;
          session = opened.session;
          for (const d of opened.newDeeds) game.pushStory(d);
        }
        recoveredFrom = "reload-file";
        return { ok: true, outcome: "reloaded-file" };
      }
      return { ok: true, outcome: "reload-invalid-save" };
    } catch {
      return { ok: true, outcome: "reload-no-save" };
    } finally {
      lifecycle = paused ? "paused" : "running";
    }
  }

  async function doReset(): Promise<{ ok: boolean; outcome: string }> {
    game.loadWorld(tideboundGenesis());
    resetViewerPresentation();
    const opened = openStreamAndFire(game.world, TIDEBOUND_LIBRARY);
    if (opened.ok) {
      game.world = opened.world;
      session = opened.session;
      for (const d of opened.newDeeds) game.pushStory(d);
    }
    await persistWorld();
    return { ok: true, outcome: "reset-genesis" };
  }

  async function doRotateToken(): Promise<{ ok: boolean; outcome: string }> {
    // Operator rotation / revocation / loss-recovery in one move: mint a
    // fresh credential, persist it as the file source of truth, adopt it
    // for this process. The state server re-resolves per request, so no
    // restart is needed anywhere. The response NEVER contains the value —
    // the operator reads it from data/authority-token.json (same trust as
    // the server console) and re-pastes it into the dashboard, whose old
    // token then 401s with re-paste guidance.
    const fresh = randomBytes(32).toString("hex");
    try {
      await writeFile(join(dataDir, TOKEN_FILE), JSON.stringify({ token: fresh }, null, 2), { mode: 0o600, encoding: "utf8" });
      try {
        await chmod(join(dataDir, TOKEN_FILE), 0o600);
      } catch {
        /* best-effort on filesystems without modes */
      }
    } catch {
      return { ok: false, outcome: "rotate-persist-failed" };
    }
    authorityToken = fresh;
    return { ok: true, outcome: "token-rotated" };
  }

  // ---- HTTP ----
  function sendJson(res: ServerResponse, code: number, obj: unknown): void {
    res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let raw = "";
      let tooLong = false;
      req.on("data", (chunk: Buffer) => {
        if (tooLong) return;
        raw += chunk.toString("utf8");
        if (Buffer.byteLength(raw, "utf8") > BODY_MAX_BYTES) {
          tooLong = true;
          reject(Object.assign(new Error("too-long"), { code: "too-long" }));
        }
      });
      req.on("end", () => (tooLong ? null : resolve(raw)));
      req.on("error", reject);
    });
  }

  function authorized(req: IncomingMessage): boolean {
    return tokensEqual(bearerToken(req), authorityToken);
  }

  const server = createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/api/authority/status" && req.method === "GET") {
      sendJson(res, 200, publicStatus());
      return;
    }

    // Everything below is authority-only (keeper credential required).
    if (!authorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (url.pathname === "/api/authority/dashboard" && req.method === "GET") {
      sendJson(res, 200, controlPlane());
      return;
    }

    if (req.method === "POST") {
      let body: Record<string, unknown> = {};
      try {
        const raw = await readBody(req);
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("bad-body");
      } catch (e) {
        sendJson(res, (e as Error).message === "too-long" || (e as { code?: string }).code === "too-long" ? 413 : 400, { error: "invalid-body" });
        return;
      }
      const path = url.pathname;
      try {
        if (path === "/api/authority/command") return sendJson(res, 200, doCommand(body));
        if (path === "/api/authority/paid") return sendJson(res, 200, doPaid(body));
        if (path === "/api/authority/vote/open") {
          const which = body.which === "kindling" ? "kindling" : "route";
          return sendJson(res, 200, await doOpenVote(which));
        }
        if (path === "/api/authority/vote/close") return sendJson(res, 200, await doCloseVote());
        if (path === "/api/authority/vote/override") {
          const idx = typeof body.optionIndex === "number" ? body.optionIndex : -1;
          if (!Number.isInteger(idx) || idx < 0 || idx > 2) return sendJson(res, 400, { error: "bad-option" });
          return sendJson(res, 200, await doOverride(idx));
        }
        if (path === "/api/authority/vote/retry") {
          if (typeof body.eventId !== "string" || !body.eventId) return sendJson(res, 400, { error: "bad-event" });
          return sendJson(res, 200, await retryAnnounce(body.eventId));
        }
        if (path === "/api/authority/rite") {
          if (typeof body.templateId !== "string" || !body.templateId) return sendJson(res, 400, { error: "bad-rite" });
          return sendJson(res, 200, await doRite(body.templateId));
        }
        if (path === "/api/authority/pause") {
          paused = true;
          lifecycle = "paused";
          return sendJson(res, 200, { ok: true, outcome: "paused" });
        }
        if (path === "/api/authority/resume") {
          paused = false;
          lifecycle = "running";
          return sendJson(res, 200, { ok: true, outcome: "resumed" });
        }
        if (path === "/api/authority/save") {
          const r = await persistWorld();
          return sendJson(res, 200, { ok: r === "file", outcome: r });
        }
        if (path === "/api/authority/reload") return sendJson(res, 200, await doReload());
        if (path === "/api/authority/reset") return sendJson(res, 200, await doReset());
        if (path === "/api/authority/end-stream") return sendJson(res, 200, await doEndStream());
        if (path === "/api/authority/source") {
          if (body.source !== "simulation" && body.source !== "youtube") return sendJson(res, 400, { error: "bad-source" });
          source = body.source;
          if (source === "youtube") startIngestion();
          else stopIngestion();
          return sendJson(res, 200, { ok: true, outcome: source, source });
        }
        if (path === "/api/authority/token/rotate") {
          return sendJson(res, 200, await doRotateToken());
        }
        if (path === "/api/authority/youtube/connect") {
          try {
            const r = await fetch(`${ytUrl}/api/youtube/connect`, { method: "POST" });
            await refreshYtStatus();
            return sendJson(res, 200, { ok: r.ok });
          } catch {
            return sendJson(res, 200, { ok: false, reason: "sidecar-unreachable" });
          }
        }
        if (path === "/api/authority/youtube/disconnect") {
          try {
            await fetch(`${ytUrl}/api/youtube/disconnect`, { method: "POST" });
          } catch {
            /* status refresh reports the truth */
          }
          await refreshYtStatus();
          return sendJson(res, 200, { ok: true });
        }
        if (path === "/api/authority/youtube/auth-url") {
          try {
            const r = await fetch(`${ytUrl}/api/youtube/auth-url`);
            if (!r.ok) return sendJson(res, 200, { url: null });
            const data = (await r.json().catch(() => null)) as { url?: unknown } | null;
            return sendJson(res, 200, { url: typeof data?.url === "string" ? data.url : null });
          } catch {
            return sendJson(res, 200, { url: null });
          }
        }
      } catch (e) {
        return sendJson(res, 500, { error: "authority-error", detail: String((e as Error)?.message ?? e).slice(0, 120) });
      }
    }
    sendJson(res, 404, { error: "not-found" });
  });

  // ---- loops ----
  every(pollMs, step);
  every(publishMs, () => void publishOnce());
  // NOTE: `source` narrows to its initializer at this point (later
  // reassignments happen in request handlers); the cast reads runtime truth.
  // Default source is always simulation at boot, so this is a no-op guard
  // for future default changes — never a second ingestion path.
  if ((source as string) === "youtube") startIngestion();

  lifecycle = "running";
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  console.log(`[tidebound] authority server on http://127.0.0.1:${port} (lifecycle=running, recoveredFrom=${recoveredFrom})`);
  if (tokenGenerated) {
    console.log("[tidebound] authority token GENERATED — copy it from data/authority-token.json into the dashboard token field (shown once here in provisioning terms only; the value is never printed)");
  }
  void publishOnce();

  let stopping = false;
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    lifecycle = "stopped";
    stopIngestion();
    for (const t of [...timers]) clearTimer(t);
    try {
      await persistWorld();
    } catch {
      /* shutdown flush best-effort */
    }
    // Drain keep-alive/SSE sockets first: close() alone waits for idle
    // connections (test clients, subscriber sockets) and would hang.
    try {
      server.closeAllConnections();
    } catch {
      /* drain best-effort */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (lockOwned) {
      try {
        await unlink(lockPath);
      } catch {
        /* lock release best-effort */
      }
      lockOwned = false;
    }
    if (activeAuthority?.stop === stop) activeAuthority = null;
  }

  const handle: AuthorityHandle = {
    getLifecycle: () => lifecycle,
    getWorldRev: () => worldRev,
    getSeq: () => lastSeq,
    getSessionId: () => session.sessionId,
    getTimerCount: () => timers.size,
    getStatus: () => publicStatus(),
    stop,
  };
  activeAuthority = handle;

  const onSignal = (): void => {
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return handle;
}

// Direct run: `npx tsx server/authority-server.ts [port]`.
const invokedDirectly = process.argv[1] !== undefined && /authority-server\.(ts|mjs|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  await startAuthority();
}
