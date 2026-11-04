import { COMMANDS } from "../engine/config";
import type { GameEngine } from "../engine/engine";
import type { CanonicalEvent } from "../engine/types";

export type YtConnection =
  | "off" | "DISCONNECTED" | "CONNECTING" | "AUTH_REQUIRED" | "CONNECTED"
  | "LIVE_CHAT_FOUND" | "STREAMING" | "RECONNECTING" | "STREAM_ENDED" | "ERROR";

export interface YtStatus {
  status: YtConnection;
  error?: string | null;
  configured?: boolean;
  authenticated?: boolean;
  liveChatId?: string | null;
  broadcastTitle?: string | null;
  reconnects?: number;
  /** T3 outbound capability: unknown until the first insert proves the grant. */
  outbound?: "unknown" | "ok" | "insufficient";
  diag?: { seen: number; commands: number; paid: number; ignored: number; polls: number; apiErrors: number };
}

const LAST_ID_KEY = "emberkeep.yt.lastId";

/**
 * F1 vote-token → ballot option index (T4C: three whitelisted vote tokens).
 * The engine whitelist admits exactly three vote tokens; the index selects
 * into the active vote's options and `castVote` re-validates the bounds.
 * Anything else is not a ballot.
 * The mapper already lowercases the token, so matching is exact here.
 */
export function voteOptionIndex(command: string): number | null {
  if (command === "!votea") return 0;
  if (command === "!voteb") return 1;
  if (command === "!votec") return 2;
  return null;
}

function isCanonical(ev: unknown): ev is CanonicalEvent {
  if (!ev || typeof ev !== "object") return false;
  const e = ev as Record<string, unknown>;
  if (e.kind === "paid_retraction") {
    // 5G-1 candidate: reference only — no actor, no amount. The ledger
    // (5G-2) decides whether the referenced message affected the world.
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

/**
 * YouTube input source (dev console only — never the overlay).
 * Subscribes to the local sidecar's SSE stream and feeds canonical events
 * into the EXISTING engine via the same ingest() path simulation uses.
 * The engine re-validates everything (whitelist, shape, dedup, cooldowns).
 */
export class YouTubeSource {
  private es: EventSource | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(s: YtStatus) => void>();
  lastStatus: YtStatus = { status: "off" };
  /** Browser-side counters: what arrived vs what the engine accepted. */
  diag = { received: 0, queued: 0, duplicate: 0, rejected: 0 };

  /**
   * F1: observer for whitelisted vote commands. The app shell casts these
   * through the same authoritative session operation the simulation panel
   * uses (`castSessionVote`); transport never touches vote state directly.
   * Invoked with the stable channel identity (`yt:<channelId>`) and the
   * ballot option index. Fires before engine ingest, mirroring `sendCommand`
   * (ballot rides alongside ingestion); `castVote` itself re-validates the
   * session, the actor, and the index, and repeat messages collapse to one
   * ballot per actor by construction.
   */
  onVoteCommand?: (actorId: string, optionIndex: number) => void;

  constructor(private readonly engine: GameEngine) {}

  onStatus(fn: (s: YtStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.lastStatus);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(s: YtStatus): void {
    this.lastStatus = s;
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch {
        /* ignore */
      }
    }
  }

  async refreshStatus(): Promise<YtStatus> {
    try {
      const res = await fetch("/api/youtube/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`status:${res.status}`);
      const s = (await res.json()) as YtStatus;
      this.emit(s.status ? s : { status: "DISCONNECTED", error: "bad-status" });
    } catch {
      this.emit({ status: "DISCONNECTED", error: "sidecar-unreachable" });
    }
    return this.lastStatus;
  }

  /** Start SSE ingestion. Safe to call repeatedly; engine dedup absorbs replays. */
  start(): void {
    if (this.es) return;
    const lastId = localStorage.getItem(LAST_ID_KEY);
    const url = lastId ? `/api/youtube/stream?lastId=${encodeURIComponent(lastId)}` : "/api/youtube/stream";
    // Note: EventSource auto-sends Last-Event-ID on reconnect; the query
    // param covers the first connect after a full page reload.
    const es = new EventSource(url);
    this.es = es;
    es.addEventListener("canonical", (msg) => {
      const raw = (msg as MessageEvent).data;
      let ev: unknown;
      try {
        ev = JSON.parse(raw);
      } catch {
        this.diag.rejected += 1;
        return;
      }
      this.ingestOne(ev, (msg as MessageEvent).lastEventId);
    });
    es.onmessage = (msg) => {
      // Fallback: treat default messages the same way.
      let ev: unknown;
      try {
        ev = JSON.parse((msg as MessageEvent).data);
      } catch {
        return;
      }
      this.ingestOne(ev, (msg as MessageEvent).lastEventId);
    };
    es.onerror = () => {
      // EventSource reconnects on its own; sidecar replays missed events.
    };
    this.statusTimer = setInterval(() => void this.refreshStatus(), 3000);
    void this.refreshStatus();
  }

  stop(): void {
    this.es?.close();
    this.es = null;
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.emit({ status: "off" });
  }

  private ingestOne(ev: unknown, sseId: string): void {
    if (!isCanonical(ev)) {
      this.diag.rejected += 1;
      return;
    }
    // Authoritative whitelist lives in the engine config — same check the
    // simulation panel applies. Unknown tokens never reach the queue.
    if (ev.kind === "chat_command" && !(ev.command in COMMANDS)) {
      this.diag.rejected += 1;
      return;
    }
    // F1: vote ballots ride alongside ingestion through the shared session
    // operation (wired by the app shell). Only whitelisted tokens reach here.
    if (ev.kind === "chat_command") {
      const idx = voteOptionIndex(ev.command);
      if (idx !== null) this.onVoteCommand?.(ev.actorId, idx);
    }
    this.diag.received += 1;
    const outcome = this.engine.ingest(ev);
    if (outcome === "queued") this.diag.queued += 1;
    else if (outcome === "duplicate") this.diag.duplicate += 1;
    else this.diag.rejected += 1;
    if (sseId) {
      try {
        localStorage.setItem(LAST_ID_KEY, sseId);
      } catch {
        /* ignore */
      }
    }
  }

  async connect(): Promise<void> {
    await fetch("/api/youtube/connect", { method: "POST" });
    await this.refreshStatus();
  }

  /**
   * T3: submit one announcement (text + safe event id). The sidecar owns
   * tokens and the insert call; the browser never sees credentials.
   * Never throws for expected failures — always a typed result.
   */
  async sendAnnouncement(
    text: string,
    eventId: string,
  ): Promise<{ ok: true; duplicate?: boolean } | { ok: false; reason: string }> {
    try {
      const res = await fetch("/api/youtube/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, eventId }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; duplicate?: boolean } | null;
      if (res.ok && data?.ok) return { ok: true, duplicate: !!data.duplicate };
      const reason = typeof data?.error === "string" && data.error.length > 0 ? data.error : "api-error";
      await this.refreshStatus();
      return { ok: false, reason };
    } catch {
      return { ok: false, reason: "sidecar-unreachable" };
    }
  }

  async disconnectServer(): Promise<void> {
    await fetch("/api/youtube/disconnect", { method: "POST" });
    await this.refreshStatus();
  }

  async authUrl(): Promise<string | null> {
    try {
      const res = await fetch("/api/youtube/auth-url");
      if (!res.ok) return null;
      const data = (await res.json()) as { url?: string };
      return data.url ?? null;
    } catch {
      return null;
    }
  }
}
