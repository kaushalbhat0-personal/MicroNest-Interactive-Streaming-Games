/**
 * T4F-B — transport tests: pure sequencing core, renderer delivery
 * decisions, and live state-server integration (spawned on an ephemeral
 * port; no mocks of the server itself).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GameEngine } from "../src/engine/engine";
import { tideboundGenesis, TIDEBOUND_LIBRARY } from "../src/content/tidebound";
import { openStream } from "../src/engine/lifecycle";
import { ledgerStatus } from "../src/engine/ledger";
import { voteModel } from "../src/presentation/tidebound-presentation";
import { decideDelivery } from "../src/renderer/transport-client";
import {
  buildSnapshot,
  type SnapshotV1,
} from "../src/shared/snapshot";
import {
  classifyIncoming,
  parseSinceParam,
  reconnectDelayMs,
  RECONNECT_MAX_MS,
  TRANSPORT_PROTOCOL,
} from "../src/shared/transport-core";

function liveSnapshot(worldRev: number): SnapshotV1 {
  const engine = new GameEngine({}, tideboundGenesis());
  const stream = openStream(engine.world);
  if (!stream.ok) throw new Error("openStream failed");
  engine.world = stream.world;
  const led = ledgerStatus(engine.world.paidLedger);
  return buildSnapshot({
    world: engine.world,
    session: stream.session,
    storyLog: engine.storyLog,
    feed: [],
    recent: engine.recentResults,
    viewerFeed: [],
    banner: null,
    paused: false,
    vote: voteModel(stream.session, engine.world, TIDEBOUND_LIBRARY),
    paid: { applied: led.applied, compensated: led.compensated, noted: led.noted, total: led.total },
    worldRev,
    atIso: new Date().toISOString(),
  });
}

describe("T4F-B — sequencing core (pure)", () => {
  it("classifies next/stale/gap deliveries", () => {
    expect(classifyIncoming(4, 5)).toEqual({ kind: "apply" });
    expect(classifyIncoming(5, 5)).toEqual({ kind: "stale" });
    expect(classifyIncoming(5, 3)).toEqual({ kind: "stale" });
    expect(classifyIncoming(5, 8)).toEqual({ kind: "gap", missingFrom: 6, received: 8 });
    expect(classifyIncoming(0, 1)).toEqual({ kind: "apply" });
  });

  it("parses resume cursors strictly", () => {
    expect(parseSinceParam("5")).toBe(5);
    expect(parseSinceParam(7)).toBe(7);
    expect(parseSinceParam("0")).toBe(0);
    expect(parseSinceParam("abc")).toBeNull();
    expect(parseSinceParam("-1")).toBeNull();
    expect(parseSinceParam("3.5")).toBeNull();
    expect(parseSinceParam(null)).toBeNull();
    expect(parseSinceParam(undefined)).toBeNull();
  });

  it("backs off reconnects with a cap", () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(1)).toBe(2000);
    expect(reconnectDelayMs(2)).toBe(4000);
    expect(reconnectDelayMs(99)).toBe(RECONNECT_MAX_MS);
  });
});

describe("T4F-B — renderer delivery decisions (pure)", () => {
  it("applies the first snapshot with no cursor", () => {
    const snap = liveSnapshot(1);
    const d = decideDelivery(null, null, 1, snap);
    expect(d.action).toBe("apply");
  });

  it("ignores invalid payloads (never a guessed render)", () => {
    const snap = liveSnapshot(1);
    const d = decideDelivery(null, null, 1, { ...snap, v: 999 });
    expect(d).toEqual({ action: "ignore", reason: "invalid" });
  });

  it("ignores stale snapshots and duplicate seqs", () => {
    const cur = liveSnapshot(5);
    const old = liveSnapshot(4);
    expect(decideDelivery(cur, 10, 10, old)).toEqual({ action: "ignore", reason: "stale" });
    expect(decideDelivery(cur, 10, 9, old)).toEqual({ action: "ignore", reason: "stale" });
    // Identical-content redelivery on an older cursor re-applies idempotently
    // (same render) and adopts the new epoch cursor — never a wedge.
    const dup = decideDelivery(cur, 10, 9, cur);
    expect(dup.action).toBe("apply");
  });

  it("requests refetch on a sequence gap", () => {
    const snap = liveSnapshot(6);
    const cur = liveSnapshot(5);
    const d = decideDelivery(cur, 4, 6, snap);
    expect(d).toEqual({ action: "refetch", reason: "gap", missingFrom: 5, received: 6 });
  });

  it("adopts a new server epoch (lower seq, non-stale snapshot) instead of wedging", () => {
    const cur = liveSnapshot(5);
    const fresh = liveSnapshot(6);
    const d = decideDelivery(cur, 50, 1, fresh);
    expect(d.action).toBe("apply");
  });
});

// ---------------------------------------------------------------------------
// Live state-server integration (real server, real HTTP, real SSE parsing).
// ---------------------------------------------------------------------------

const PORT = 31313;
const BASE = `http://localhost:${PORT}`;
// T4F-C1: the publish route requires the authority credential. Tests
// provision it explicitly via env (deterministic, never logged).
const TEST_TOKEN = "t4f-b-test-token-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
let child: ChildProcess | null = null;

async function waitForStatus(): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/api/state/status`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function startServer(): Promise<void> {
  if (child) return;
  const serverPath = join(__dirname, "..", "server", "state-server.mjs");
  child = spawn(process.execPath, [serverPath, String(PORT)], {
    stdio: "ignore",
    env: { ...process.env, AUTHORITY_TOKEN: TEST_TOKEN },
  });
  const up = await waitForStatus();
  if (!up) throw new Error("state-server did not start");
}

async function publish(snap: SnapshotV1, extraHeaders?: Record<string, string>) {
  return fetch(`${BASE}/api/state/publish`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ protocol: TRANSPORT_PROTOCOL, snapshot: snap }),
  });
}

afterAll(() => {
  try {
    child?.kill();
  } catch {
    /* shutdown best-effort */
  }
  child = null;
});

async function readSseEvents(onEvent: (name: string, data: string) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(`${BASE}/api/state/stream?since=0&format=landscape`, {
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`sse status ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
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
        if (line.startsWith("event:")) name = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onEvent(name, data);
      name = "message";
    }
  }
}

describe("T4F-B — state-server integration", () => {
  it("starts with no snapshot; validates publishes", async () => {
    await startServer();
    const empty = await fetch(`${BASE}/api/state/snapshot`);
    expect(empty.status).toBe(404);

    // T4F-C1: the publish route is authority-only (401 without/without
    // a wrong credential — checked before any payload validation).
    const noAuth = await publish(liveSnapshot(1));
    expect(noAuth.status).toBe(401);
    const wrongAuth = await publish(liveSnapshot(1), { authorization: "Bearer wrong-token-0123456789abcdef" });
    expect(wrongAuth.status).toBe(401);
    const queryToken = await fetch(`${BASE}/api/state/publish?token=${TEST_TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol: TRANSPORT_PROTOCOL, snapshot: liveSnapshot(1) }),
    });
    expect(queryToken.status).toBe(401);

    const badProto = await fetch(`${BASE}/api/state/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ protocol: 999, snapshot: liveSnapshot(1) }),
    });
    expect(badProto.status).toBe(400);

    const badShape = await fetch(`${BASE}/api/state/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ protocol: TRANSPORT_PROTOCOL, snapshot: { v: 1 } }),
    });
    expect(badShape.status).toBe(400);

    const badSince = await fetch(`${BASE}/api/state/stream?since=abc`);
    expect(badSince.status).toBe(400);
  });

  it("publishes, serves, and sequences snapshots", async () => {
    await startServer();
    const s1 = liveSnapshot(1);
    const p1 = await publish(s1, AUTH);
    expect(p1.ok).toBe(true);
    const seq1 = ((await p1.json()) as { seq: number }).seq;
    expect(seq1).toBe(1);

    const got = (await (await fetch(`${BASE}/api/state/snapshot`)).json()) as { seq: number; snapshot: SnapshotV1 };
    expect(got.seq).toBe(1);
    expect(got.snapshot.worldRev).toBe(1);
    expect(got.snapshot.sessionId).toBe(s1.sessionId);

    // Monotonic seq; stale worldRev rejected (never rewinds).
    const s2 = liveSnapshot(2);
    const p2 = await publish(s2, AUTH);
    expect((((await p2.json()) as { seq: number }).seq)).toBe(2);
    const stale = await publish(liveSnapshot(1), AUTH);
    expect(stale.status).toBe(409);

    const status = (await (await fetch(`${BASE}/api/state/status`)).json()) as {
      protocol: number;
      seq: number;
      worldRev: number;
      subscribers: { total: number };
    };
    expect(status.protocol).toBe(TRANSPORT_PROTOCOL);
    expect(status.seq).toBe(2);
    expect(status.worldRev).toBe(2);
    expect(status.subscribers.total).toBe(0);
  });

  it("replays missed snapshots to a resuming subscriber, then streams live", async () => {
    await startServer();
    const seen: Array<{ name: string; seq: number }> = [];
    const ctl = new AbortController();
    const reader = readSseEvents((name, data) => {
      try {
        const parsed = JSON.parse(data) as { seq?: number };
        if (typeof parsed.seq === "number") seen.push({ name, seq: parsed.seq });
      } catch {
        /* heartbeats carry seq too; ignore unparseable */
      }
      if (seen.filter((e) => e.name === "state").length >= 3) ctl.abort();
    }, ctl.signal).catch(() => undefined);

    // Give the subscriber a moment to connect, then publish live.
    await new Promise((r) => setTimeout(r, 300));
    await publish(liveSnapshot(3), AUTH);
    await reader;
    const states = seen.filter((e) => e.name === "state").map((e) => e.seq);
    // Replay of seq 1..2 (since=0) plus the live seq 3.
    expect(states).toContain(1);
    expect(states).toContain(2);
    expect(states).toContain(3);
    expect([...states].sort((a, b) => a - b)).toEqual(states);
  });

  it("signals recovery when the resume cursor predates the buffer", async () => {
    await startServer();
    // Overflow the 50-deep buffer (seqs so far: 1..3, then these).
    for (let rev = 4; rev <= 70; rev++) {
      const res = await publish(liveSnapshot(rev), AUTH);
      expect(res.ok).toBe(true);
    }
    // since=1 predates the retained window (oldest retained seq is 21):
    // the server must answer recovery, never a partial replay.
    const ctl = new AbortController();
    const res = await fetch(`${BASE}/api/state/stream?since=1&format=portrait`, {
      headers: { accept: "text/event-stream" },
      signal: ctl.signal,
    });
    expect(res.ok).toBe(true);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sawRecovery = false;
    for (let i = 0; i < 50 && !sawRecovery; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes("event: recovery")) sawRecovery = true;
    }
    ctl.abort();
    try {
      await reader.cancel();
    } catch {
      /* closing best-effort */
    }
    expect(sawRecovery).toBe(true);
  });
});
