/**
 * T4F-B — renderer transport client (RENDERER-ONLY, read-only).
 *
 * Subscribes one renderer page to the authoritative state-transport server:
 * initial snapshot fetch, sequenced SSE with a `since` resume cursor, gap
 * detection → authoritative refetch, stale rejection, protocol validation,
 * heartbeat stall detection, and backoff reconnect.
 *
 * Safety rules (mechanical, not comments):
 * - no imports from authority-only modules (boundary test enforces);
 * - never constructs GameEngine / EventQueue / YouTubeSource / WorldStore;
 * - never mutates authority state (only GETs; the single POST endpoint is
 *   the authority's and is never called here);
 * - on authority unavailability the renderer reports a disconnected state
 *   and NEVER falls back to starting its own simulation.
 */

import {
  classifyIncoming,
  reconnectDelayMs,
  STALL_AFTER_MS,
  TRANSPORT_PROTOCOL,
  type RendererConnState,
} from "../shared/transport-core";
import {
  isStaleSnapshot,
  validateSnapshot,
  type SnapshotV1,
} from "../shared/snapshot";

export interface TransportEvents {
  onSnapshot: (snap: SnapshotV1, seq: number) => void;
  onState: (state: RendererConnState, detail: string) => void;
}

export interface RendererTransport {
  stop: () => void;
  getState: () => RendererConnState;
  getLastSeq: () => number | null;
  getWorldRev: () => number | null;
}

/**
 * Pure delivery decision, unit-tested without a network. Returns what the
 * client should do with one `state` event payload.
 */
export function decideDelivery(
  current: SnapshotV1 | null,
  lastSeq: number | null,
  seq: number,
  payload: unknown,
):
  | { action: "apply"; snapshot: SnapshotV1 }
  | { action: "ignore"; reason: "invalid" | "stale" }
  | { action: "refetch"; reason: "gap"; missingFrom: number; received: number } {
  const validated = validateSnapshot(payload);
  if (!validated.ok) return { action: "ignore", reason: "invalid" };
  const snap = validated.snapshot;
  if (current && isStaleSnapshot(current, snap)) return { action: "ignore", reason: "stale" };
  if (lastSeq === null) return { action: "apply", snapshot: snap };
  const verdict = classifyIncoming(lastSeq, seq);
  if (verdict.kind === "stale") {
    // Same-or-older transport seq carrying a non-stale snapshot (e.g. the
    // server restarted and its seq reset while the authority republished):
    // the snapshot recency check above already passed, so apply and adopt
    // the new epoch cursor rather than wedging on an old cursor.
    return { action: "apply", snapshot: snap };
  }
  if (verdict.kind === "gap") {
    return { action: "refetch", reason: "gap", missingFrom: verdict.missingFrom, received: verdict.received };
  }
  return { action: "apply", snapshot: snap };
}

interface Opts {
  snapshotUrl?: string;
  streamUrl?: string;
  format?: string;
}

export function connectRendererTransport(events: TransportEvents, opts?: Opts): RendererTransport {
  const snapshotUrl = opts?.snapshotUrl ?? "/api/state/snapshot";
  const streamBase = opts?.streamUrl ?? "/api/state/stream";
  const format = opts?.format ?? "unknown";

  let state: RendererConnState = "connecting";
  let current: SnapshotV1 | null = null;
  let lastSeq: number | null = null;
  let stopped = false;
  let source: EventSource | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  function setState(s: RendererConnState, detail: string): void {
    state = s;
    try {
      events.onState(s, detail);
    } catch {
      /* status rendering must never break the transport loop */
    }
  }

  function armStall(): void {
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (stopped) return;
      reconnect("no heartbeat — resubscribing");
    }, STALL_AFTER_MS);
  }

  function closeStream(): void {
    if (stallTimer !== null) {
      clearTimeout(stallTimer);
      stallTimer = null;
    }
    if (source !== null) {
      try {
        source.close();
      } catch {
        /* closing must never throw */
      }
      source = null;
    }
  }

  async function fetchSnapshot(): Promise<{ snap: SnapshotV1; seq: number } | { error: string }> {
    try {
      const res = await fetch(snapshotUrl, { headers: { accept: "application/json" } });
      if (res.status === 404) return { error: "no-authority-yet" };
      if (!res.ok) return { error: `snapshot-http-${res.status}` };
      const data = (await res.json().catch(() => null)) as { seq?: unknown; snapshot?: unknown } | null;
      if (!data || typeof data.seq !== "number") return { error: "bad-snapshot-shape" };
      const validated = validateSnapshot(data.snapshot);
      if (!validated.ok) {
        return { error: validated.reason === "bad-protocol" ? "protocol-mismatch" : "bad-snapshot-shape" };
      }
      return { snap: validated.snapshot, seq: data.seq };
    } catch {
      return { error: "transport-unreachable" };
    }
  }

  function applySnapshot(snap: SnapshotV1, seq: number): void {
    current = snap;
    lastSeq = seq;
    try {
      events.onSnapshot(snap, seq);
    } catch {
      /* rendering must never break the transport loop */
    }
  }

  function openStream(since: number | null): void {
    if (stopped) return;
    closeStream();
    try {
      const url = since === null ? `${streamBase}?format=${encodeURIComponent(format)}` : `${streamBase}?since=${since}&format=${encodeURIComponent(format)}`;
      const es = new EventSource(url);
      source = es;
      armStall();
      es.addEventListener("state", (ev) => {
        if (stopped) return;
        armStall();
        let parsed: { seq?: unknown; snapshot?: unknown } | null = null;
        try {
          parsed = JSON.parse((ev as MessageEvent).data as string) as { seq?: unknown; snapshot?: unknown };
        } catch {
          parsed = null;
        }
        if (!parsed || typeof parsed.seq !== "number") return;
        const decision = decideDelivery(current, lastSeq, parsed.seq, parsed.snapshot);
        if (decision.action === "apply") {
          attempt = 0;
          applySnapshot(decision.snapshot, parsed.seq);
          if (state !== "connected") setState("connected", `subscribed · seq ${parsed.seq}`);
        } else if (decision.action === "refetch") {
          void recover(`missed events ${decision.missingFrom}–${decision.received - 1} — reloading authoritative state`);
        }
        // "ignore" (stale/invalid): stay subscribed, keep current display.
      });
      es.addEventListener("recovery", () => {
        if (stopped) return;
        void recover("replay window moved on — reloading authoritative state");
      });
      es.addEventListener("heartbeat", () => {
        if (stopped) return;
        armStall();
      });
      es.onerror = () => {
        if (stopped) return;
        reconnect("event stream interrupted — resubscribing");
      };
    } catch {
      reconnect("event stream unavailable — retrying");
    }
  }

  async function recover(detail: string): Promise<void> {
    setState("reconnecting", detail);
    const fetched = await fetchSnapshot();
    if (stopped) return;
    if ("error" in fetched) {
      scheduleRetry(fetched.error);
      return;
    }
    if (current && isStaleSnapshot(current, fetched.snap) && lastSeq !== null && fetched.seq <= lastSeq) return;
    attempt = 0;
    applySnapshot(fetched.snap, fetched.seq);
    setState("connected", `recovered · seq ${fetched.seq}`);
    openStream(fetched.seq);
  }

  async function bootstrap(): Promise<void> {
    if (stopped) return;
    setState("connecting", "waiting for the keeper console authority…");
    const fetched = await fetchSnapshot();
    if (stopped) return;
    if ("error" in fetched) {
      scheduleRetry(
        fetched.error === "no-authority-yet"
          ? "no authority snapshot yet — open the keeper console (it owns the game)"
          : fetched.error === "protocol-mismatch"
            ? "protocol mismatch — reload this page after updating"
            : "state transport unreachable — renderers never simulate on their own",
      );
      return;
    }
    attempt = 0;
    applySnapshot(fetched.snap, fetched.seq);
    setState("connected", `subscribed · seq ${fetched.seq}`);
    openStream(fetched.seq);
  }

  function scheduleRetry(detail: string): void {
    if (stopped) return;
    setState("disconnected", detail);
    const delay = reconnectDelayMs(attempt);
    attempt += 1;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (stopped) return;
      setState("connecting", "retrying the keeper console authority…");
      void bootstrap();
    }, delay);
  }

  function reconnect(detail: string): void {
    closeStream();
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    if (stopped) return;
    setState("reconnecting", detail);
    const delay = reconnectDelayMs(attempt);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      if (stopped) return;
      void recover("resubscribing to the keeper console authority");
    }, delay);
  }

  // Transport protocol guard: a server speaking a newer protocol answers
  // with snapshots this client must refuse (safe waiting state, never a
  // guessed render). The check itself lives in validateSnapshot; the
  // constant is referenced here so protocol bumps touch this file loudly.
  void TRANSPORT_PROTOCOL;

  void bootstrap();

  return {
    stop: () => {
      stopped = true;
      closeStream();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    },
    getState: () => state,
    getLastSeq: () => lastSeq,
    getWorldRev: () => (current ? current.worldRev : null),
  };
}
