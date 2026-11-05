/**
 * T4F-C1 — server-backed dashboard runtime (CONTROL CLIENT, never authority).
 *
 * Implements the `Runtime` view from app.ts over the authority control
 * API. This is the ONLY browser module allowed to call the token-gated
 * control endpoints (boundary test enforces: no fetch() in app.ts, no
 * engine construction anywhere in browser source).
 *
 * Rules:
 * - every mutation POSTs and returns the SERVER's outcome string. Control
 *   results are never fabricated: transport/auth failures surface as
 *   explicit failure outcomes ("authority-unreachable",
 *   "unauthorized-…"), never as fake successes.
 * - the token lives in dashboard localStorage (operator-provisioned once
 *   from the server console) and travels ONLY as an Authorization header.
 *   It is never rendered, never logged, never put in URLs or snapshots.
 * - read views (engine/feed/session/announce/yt) serve the latest
 *   control-plane payload; before the first successful fetch the boot
 *   module must not wire the panel (see main.ts).
 */

import type {
  AnnounceState,
  EngineView,
  FeedView,
  Runtime,
  YtDiag,
  YtView,
} from "../app";
import type { YtStatus } from "../youtube/client";
import type { StreamSession } from "../engine/lifecycle";
import type { FeedEntry } from "../engine/feed";
import type { CanonicalEvent, GameResult, WorldState } from "../engine/types";
import { WorldStore } from "../persistence/store";
import { BannerQueue, ViewerFeedStore } from "../presentation/viewer-feed";
import { resolveOAuthStartUrl } from "../renderer/state-transport-urls";
import { setPersistFrom } from "../app";

export const AUTHORITY_TOKEN_KEY = "tidebound.authority.token";
const FETCH_TIMEOUT_MS = 8000;

export function getStoredToken(): string {
  try {
    const v = localStorage.getItem(AUTHORITY_TOKEN_KEY);
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

export function setStoredToken(token: string): void {
  try {
    localStorage.setItem(AUTHORITY_TOKEN_KEY, token.trim());
  } catch {
    /* storage unavailable — operator must re-enter per load */
  }
}

/** Forget the paired token (shared machines, suspected exposure). */
export function clearStoredToken(): void {
  try {
    localStorage.removeItem(AUTHORITY_TOKEN_KEY);
  } catch {
    /* storage unavailable — nothing persisted to clear */
  }
}

interface ControlPlane {
  lifecycle: string;
  worldRev: number;
  seq: number | null;
  publishes: number;
  sessionId: string;
  streamNumber: number;
  sessionPhase: string;
  session: StreamSession;
  paused: boolean;
  source: "simulation" | "youtube";
  ingesting: boolean;
  world: WorldState;
  storyLog: string[];
  feed: FeedEntry[];
  recent: GameResult[];
  queue: { size: number; max: number; peek: CanonicalEvent[] };
  announce: Record<string, AnnounceState>;
  yt: { lastStatus: YtStatus; diag: YtDiag };
  persist: { from: string };
  recoveredFrom: string;
  uptimeSec: number;
  timers: number;
  lastError: string | null;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; data: unknown }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const data = (await res.json().catch(() => null)) as unknown;
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function outcomeOf(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const o = (data as Record<string, unknown>).outcome;
    if (typeof o === "string" && o) return o;
    const reason = (data as Record<string, unknown>).reason;
    if (typeof reason === "string" && reason) return reason;
    if ((data as Record<string, unknown>).ok === true) return "ok";
  }
  return fallback;
}

export class ServerRuntime implements Runtime {
  private plane: ControlPlane | null = null;
  private ytListeners = new Set<(s: YtStatus) => void>();
  private lastYtStatusJson = "";
  readonly viewerFeed = new ViewerFeedStore();
  readonly banners = new BannerQueue();
  readonly store = new WorldStore();
  private sceneGetter: () => import("../phaser/GameScene").GameScene | null = () => null;

  attachScene(getter: () => import("../phaser/GameScene").GameScene | null): void {
    this.sceneGetter = getter;
  }

  get scene(): import("../phaser/GameScene").GameScene | null {
    try {
      return this.sceneGetter();
    } catch {
      return null;
    }
  }

  get hasData(): boolean {
    return this.plane !== null;
  }

  get lifecycle(): string {
    return this.plane?.lifecycle ?? "unknown";
  }

  get worldRev(): number {
    return this.plane?.worldRev ?? 0;
  }

  // ---- read views over the latest control-plane payload ----
  get engine(): EngineView {
    const p = this.plane;
    if (!p) throw new Error("control-plane not loaded yet");
    return {
      world: p.world,
      storyLog: p.storyLog,
      recentResults: p.recent,
      queue: { size: p.queue.size, peekAll: () => p.queue.peek },
    };
  }

  get feed(): FeedView {
    const p = this.plane;
    if (!p) throw new Error("control-plane not loaded yet");
    return { list: () => p.feed };
  }

  get session(): StreamSession {
    if (!this.plane) throw new Error("control-plane not loaded yet");
    return this.plane.session;
  }

  get paused(): boolean {
    return this.plane?.paused ?? false;
  }

  get announce(): Record<string, AnnounceState> {
    return this.plane?.announce ?? {};
  }

  get yt(): YtView {
    return {
      lastStatus: this.plane?.yt.lastStatus ?? { status: "off" as const },
      diag: this.plane?.yt.diag ?? { received: 0, queued: 0, duplicate: 0, rejected: 0 },
      start: () => this.postSource("youtube").then(() => undefined),
      stop: () => this.postSource("simulation").then(() => undefined),
      refreshStatus: async () => {
        await this.refresh();
        return this.plane?.yt.lastStatus ?? { status: "off" as const };
      },
      connect: async () => {
        await this.post("/api/authority/youtube/connect", {});
      },
      disconnectServer: async () => {
        await this.post("/api/authority/youtube/disconnect", {});
      },
      authUrl: async () => {
        const r = await this.post("/api/authority/youtube/auth-url", {});
        return typeof r.data === "object" && r.data !== null && typeof (r.data as { url?: unknown }).url === "string"
          ? ((r.data as { url: string }).url as string)
          : null;
      },
      startWebOAuth: () => {
        // D2.6: direct-to-Render start via top-level navigation. The bearer
        // travels in the POST body (a form cannot set headers and must never
        // use a URL token). The action MUST be the absolute backend URL: the
        // authority sets a host-bound `__Host-` correlation cookie, and a
        // Vercel-proxied start would store it on the Vercel hostname, which
        // the Render callback can never receive (correlation-missing). A
        // missing/invalid backend origin fails visibly — never silently fall
        // back to the relative proxy route. Top-level form navigation needs
        // no CORS; the dashboard tab stays open.
        try {
          const token = getStoredToken();
          if (!token) return false;
          const action = resolveOAuthStartUrl();
          if (!action) return false;
          const form = document.createElement("form");
          form.method = "POST";
          form.action = action;
          form.target = "_blank";
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = "token";
          input.value = token;
          form.appendChild(input);
          document.body.appendChild(form);
          form.submit();
          form.remove();
          return true;
        } catch {
          /* navigation handoff must never break the panel */
          return false;
        }
      },
      oauthStatus: async () => {
        try {
          const r = await fetchJson("/api/authority/youtube/oauth/status", { headers: { ...this.authHeaders() } });
          if (r.status === 200 && r.data && typeof r.data === "object") return r.data as Record<string, unknown>;
          return null;
        } catch {
          return null;
        }
      },
      onStatus: (fn: (s: YtStatus) => void) => {
        this.ytListeners.add(fn);
        if (this.plane) {
          try {
            fn(this.plane.yt.lastStatus);
          } catch {
            /* listener errors never break refresh */
          }
        }
        return () => {
          this.ytListeners.delete(fn);
        };
      },
    };
  }

  // ---- transport ----
  private authHeaders(): Record<string, string> {
    const token = getStoredToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  private async post(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
    try {
      return await fetchJson(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.authHeaders() },
        body: JSON.stringify(body),
      });
    } catch {
      return { status: 0, data: null };
    }
  }

  private failureOutcome(status: number): string {
    if (status === 401) return "unauthorized — set the authority token in Settings";
    if (status === 0) return "authority-unreachable — start it with: npm run authority-server";
    return `authority-error (http ${status})`;
  }

  private async mutate(path: string, body: unknown): Promise<string> {
    const r = await this.post(path, body);
    if (r.status === 200) {
      await this.refresh();
      return outcomeOf(r.data, "ok");
    }
    return this.failureOutcome(r.status);
  }

  // ---- Runtime mutations (server-confirmed outcomes only) ----
  sendCommand(actorId: string, actorName: string, command: string): Promise<string> {
    return this.mutate("/api/authority/command", { actorId, actorName, command });
  }

  sendPaid(actorId: string, actorName: string, amountMinor: number, currency: string): Promise<string> {
    return this.mutate("/api/authority/paid", { actorId, actorName, amountMinor, currency });
  }

  async save(): Promise<void> {
    await this.mutate("/api/authority/save", {});
  }

  async reload(): Promise<void> {
    await this.mutate("/api/authority/reload", {});
  }

  async reset(): Promise<void> {
    await this.mutate("/api/authority/reset", {});
  }

  pause(): Promise<void> {
    return this.mutate("/api/authority/pause", {}).then(() => undefined);
  }

  resume(): Promise<void> {
    return this.mutate("/api/authority/resume", {}).then(() => undefined);
  }

  openRouteVote(): Promise<string> {
    return this.mutate("/api/authority/vote/open", { which: "route" });
  }

  openKindlingVote(): Promise<string> {
    return this.mutate("/api/authority/vote/open", { which: "kindling" });
  }

  closeActiveVote(): Promise<string> {
    return this.mutate("/api/authority/vote/close", {});
  }

  overrideVote(optionIndex: number): Promise<string> {
    return this.mutate("/api/authority/vote/override", { optionIndex });
  }

  async retryAnnounce(eventId: string): Promise<void> {
    await this.mutate("/api/authority/vote/retry", { eventId });
  }

  fireRite(templateId: string): Promise<string> {
    return this.mutate("/api/authority/rite", { templateId });
  }

  endStream(): Promise<string> {
    return this.mutate("/api/authority/end-stream", {});
  }

  /**
   * Rotate the authority credential. Requires the CURRENT token; on
   * success the local pairing is cleared (it just died) and the operator
   * re-pastes the new value from data/authority-token.json. The response
   * never contains the new value.
   */
  async rotateToken(): Promise<string> {
    const out = await this.mutate("/api/authority/token/rotate", {});
    if (out === "token-rotated") clearStoredToken();
    return out;
  }

  // ---- refresh ----
  async refresh(): Promise<boolean> {
    if (!getStoredToken()) return false;
    let r: { status: number; data: unknown };
    try {
      r = await fetchJson("/api/authority/dashboard", { headers: { ...this.authHeaders() } });
    } catch {
      return false;
    }
    if (r.status !== 200 || !r.data || typeof r.data !== "object") return false;
    this.plane = r.data as ControlPlane;
    try {
      setPersistFrom(this.plane.persist?.from as "file" | "local" | "none" | "postgres" | "db-error" | "file-error" | undefined ?? "none");
    } catch {
      /* panel state sync must never break refresh */
    }
    // Source radio mirror (programmatic check — fires no change events).
    try {
      const srcYt = document.getElementById("src-yt");
      if (srcYt instanceof HTMLInputElement) srcYt.checked = this.plane.source === "youtube";
      const srcSim = document.getElementById("src-sim");
      if (srcSim instanceof HTMLInputElement) srcSim.checked = this.plane.source !== "youtube";
    } catch {
      /* radio mirror must never break refresh */
    }
    // Fan out YouTube status (server-owned subscription, single listener set).
    try {
      const sig = JSON.stringify(this.plane.yt.lastStatus);
      if (sig !== this.lastYtStatusJson) {
        this.lastYtStatusJson = sig;
        for (const fn of this.ytListeners) {
          try {
            fn(this.plane.yt.lastStatus);
          } catch {
            /* listener errors never break refresh */
          }
        }
      }
    } catch {
      /* status fan-out must never break refresh */
    }
    return true;
  }

  private async postSource(source: "simulation" | "youtube"): Promise<void> {
    await this.mutate("/api/authority/source", { source });
  }

  async fetchAuthorityStatus(): Promise<Record<string, unknown> | null> {
    try {
      const r = await fetchJson("/api/authority/status");
      if (r.status === 200 && r.data && typeof r.data === "object") return r.data as Record<string, unknown>;
      return null;
    } catch {
      return null;
    }
  }
}
