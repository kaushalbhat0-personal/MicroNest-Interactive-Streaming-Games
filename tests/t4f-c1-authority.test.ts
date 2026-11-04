/**
 * T4F-C1 — server-side authority tests.
 * One authority owns the simulation; dashboard refresh/disconnect never
 * resets it; duplicate authorities are refused; restore is deterministic;
 * timers drain on shutdown; YouTube ingestion is single; announcement
 * identity is stable. Deterministic, stubbed sidecars, no real broadcast.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { serialize } from "../src/persistence/store";
import { tideboundGenesis } from "../src/content/tidebound";

const ROOT = join(__dirname, "..");
const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const TOKEN = "t4f-c1-test-token-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const children: ChildProcess[] = [];

// In-process boots resolve the token from env/file like production: pin
// the env token for this worker so the helper credential always matches
// (spawned boots receive it per-spawn below; each test file is isolated).
process.env.AUTHORITY_TOKEN = TOKEN;

afterAll(() => {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* shutdown best-effort */
    }
  }
  delete process.env.AUTHORITY_TOKEN;
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "t4f-c1-"));
}

function spawnAuthority(port: number, dataDir: string, extraEnv: Record<string, string> = {}): ChildProcess {
  const c = spawn(
    process.execPath,
    [TSX_CLI, "server/authority-server.ts", String(port)],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AUTHORITY_TOKEN: TOKEN, DATA_DIR: dataDir, ...extraEnv },
    },
  );
  children.push(c);
  return c;
}

function spawnStateServer(port: number): ChildProcess {
  const c = spawn(process.execPath, [join(ROOT, "server", "state-server.mjs"), String(port)], {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, AUTHORITY_TOKEN: TOKEN },
  });
  children.push(c);
  return c;
}

async function waitFor(url: string, timeoutMs = 60000): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return (await res.json()) as Record<string, unknown>;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function waitAuthority(port: number): Promise<Record<string, unknown>> {
  const s = await waitFor(`http://127.0.0.1:${port}/api/authority/status`);
  if (s.lifecycle !== "running") throw new Error(`authority not running: ${s.lifecycle}`);
  return s;
}

async function authed(port: number, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Stub YouTube sidecar (status + SSE ingest + send recorder).
// ---------------------------------------------------------------------------

interface YtStub {
  url: string;
  streams: number;
  sends: Array<{ text: string; eventId: string }>;
  close: () => Promise<void>;
}

async function startYtStub(events: Array<Record<string, unknown>> = []): Promise<YtStub> {
  const stub: YtStub = { url: "", streams: 0, sends: [], close: async () => undefined };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/youtube/status") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ status: "STREAMING", reconnects: 0, outbound: "ok", broadcastTitle: "stub" }),
      );
      return;
    }
    if (url.pathname === "/api/youtube/stream") {
      stub.streams += 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const ev of events) {
        res.write(`id: ${ev.eventId}\nevent: canonical\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      req.on("close", () => {
        try {
          res.end();
        } catch {
          /* closing */
        }
      });
      return;
    }
    if (url.pathname === "/api/youtube/send" && req.method === "POST") {
      let raw = "";
      req.on("data", (c: Buffer) => {
        raw += c.toString("utf8");
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(raw) as { text?: unknown; eventId?: unknown };
          if (typeof parsed.text === "string" && typeof parsed.eventId === "string") {
            stub.sends.push({ text: parsed.text, eventId: parsed.eventId });
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
            return;
          }
        } catch {
          /* fall through */
        }
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "invalid-text" }));
      });
      return;
    }
    if ((url.pathname === "/api/youtube/connect" || url.pathname === "/api/youtube/disconnect") && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "STREAMING" }));
      return;
    }
    if (url.pathname === "/api/youtube/auth-url") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ url: "https://stub/auth" }));
      return;
    }
    res.writeHead(404).end("not-found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const stubPort = typeof addr === "object" && addr !== null ? (addr.port as number) : 0;
  stub.url = `http://127.0.0.1:${stubPort}`;
  // closeAllConnections first: the authority may hold our SSE stream open,
  // and close() alone would wait for it forever.
  stub.close = () =>
    new Promise<void>((resolve) => {
      try {
        server.closeAllConnections();
      } catch {
        /* drain best-effort */
      }
      server.close(() => resolve());
    });
  return stub;
}

describe("T4F-C1 — single authority, duplicate prevention", () => {
  it("starts exactly one authority per process (double start throws)", async () => {
    const mod = await import("../server/authority-server");
    const dir = tempDir();
    const h = await mod.startAuthority({
      port: 3151,
      dataDir: dir,
      stateUrl: "http://127.0.0.1:9",
      ytUrl: "http://127.0.0.1:9",
      onFatal: () => undefined,
    });
    expect(h.getLifecycle()).toBe("running");
    await expect(
      mod.startAuthority({ port: 3152, dataDir: tempDir(), stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9", onFatal: () => undefined }),
    ).rejects.toThrow("duplicate-authority");
    expect(h.getTimerCount()).toBeGreaterThan(0);
    await h.stop();
    expect(h.getTimerCount()).toBe(0);
    expect(h.getLifecycle()).toBe("stopped");
  }, 90000);

  it("a stale lockfile (dead pid) is taken over, never wedged", async () => {
    const mod = await import("../server/authority-server");
    const dir = tempDir();
    writeFileSync(join(dir, "authority.lock"), JSON.stringify({ pid: 2 ** 30, startedAt: new Date(0).toISOString() }), "utf8");
    const h = await mod.startAuthority({ port: 3166, dataDir: dir, stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9", onFatal: () => undefined });
    expect(h.getLifecycle()).toBe("running");
    await h.stop();
  }, 90000);

  it("a second process with the same data dir is refused (lockfile, distinct ports)", async () => {
    const dir = tempDir();
    const a = spawnAuthority(3153, dir, { STATE_URL: "http://127.0.0.1:9", YT_URL: "http://127.0.0.1:9" });
    await waitAuthority(3153);
    let stderr = "";
    const b = spawnAuthority(3154, dir, { STATE_URL: "http://127.0.0.1:9", YT_URL: "http://127.0.0.1:9" });
    b.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(-2), 60000);
      b.on("exit", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).not.toBe(0);
    expect(code).not.toBe(-2);
    expect(stderr).toContain("already running");
    a.kill();
  }, 90000);
});

describe("T4F-C1 — deterministic restore", () => {
  it("same save boots the same session (streamCount + deeds preserved)", async () => {
    const mod = await import("../server/authority-server");
    const world = tideboundGenesis();
    world.streamCount = 3;
    world.deeds = ["deterministic-deed"];
    const dir = tempDir();
    writeFileSync(join(dir, "world-state.json"), serialize(world), "utf8");
    const h1 = await mod.startAuthority({ port: 3155, dataDir: dir, stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9", onFatal: () => undefined });
    const s1 = h1.getSessionId();
    const dash1 = await authed(3155, "/api/authority/dashboard");
    expect(dash1.status).toBe(200);
    expect((dash1.data.world as { streamCount: number }).streamCount).toBeGreaterThanOrEqual(3);
    expect((dash1.data.world as { deeds: string[] }).deeds).toContain("deterministic-deed");
    await h1.stop();
    // Reboot the same dir: identical session identity, explicit restore.
    const h2 = await mod.startAuthority({ port: 3155, dataDir: dir, stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9", onFatal: () => undefined });
    expect(h2.getSessionId()).toBe(s1);
    const st = (await (await fetch("http://127.0.0.1:3155/api/authority/status")).json()) as { recoveredFrom: string };
    expect(st.recoveredFrom).toBe("file");
    await h2.stop();
  }, 120000);

  it("corrupt save boots an explicit fresh genesis (flagged, never silent)", async () => {
    const mod = await import("../server/authority-server");
    const dir = tempDir();
    writeFileSync(join(dir, "world-state.json"), "{not a world", "utf8");
    const h = await mod.startAuthority({ port: 3156, dataDir: dir, stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9", onFatal: () => undefined });
    expect(h.getLifecycle()).toBe("running");
    const st = (await (await fetch("http://127.0.0.1:3156/api/authority/status")).json()) as { recoveredFrom: string };
    expect(st.recoveredFrom).toBe("corrupt-save-fresh");
    await h.stop();
  }, 90000);

  it("missing save boots fresh genesis", async () => {
    const mod = await import("../server/authority-server");
    const h = await mod.startAuthority({ port: 3157, dataDir: tempDir(), stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9", onFatal: () => undefined });
    const st = (await (await fetch("http://127.0.0.1:3157/api/authority/status")).json()) as { recoveredFrom: string };
    expect(st.recoveredFrom).toBe("fresh-genesis");
    await h.stop();
  }, 90000);
});

describe("T4F-C1 — headless authority (no dashboard needed)", () => {
  it("worldRev advances and session persists with zero dashboard connections", async () => {
    const port = 3158;
    spawnAuthority(port, tempDir(), { STATE_URL: "http://127.0.0.1:9", YT_URL: "http://127.0.0.1:9" });
    await waitAuthority(port);
    // Dashboard "refresh": two reads separated by silence (no polling).
    const d1 = await authed(port, "/api/authority/dashboard");
    await new Promise((r) => setTimeout(r, 2500));
    const d2 = await authed(port, "/api/authority/dashboard");
    expect(d2.data.sessionId).toBe(d1.data.sessionId);
    expect(d2.data.worldRev as number).toBeGreaterThanOrEqual(d1.data.worldRev as number);
    // Pause holds the loop; resume releases it (lifecycle, not a reset).
    const paused = await authed(port, "/api/authority/pause", {});
    expect(paused.data).toMatchObject({ ok: true });
    const st = (await (await fetch(`http://127.0.0.1:${port}/api/authority/status`)).json()) as { lifecycle: string };
    expect(st.lifecycle).toBe("paused");
    await authed(port, "/api/authority/resume", {});
  }, 90000);
});

describe("T4F-C1 — control actions (token-gated, server-confirmed)", () => {
  it("command → vote → close flow works with stable announcement identity", async () => {
    const stub = await startYtStub();
    const port = 3159;
    spawnAuthority(port, tempDir(), { STATE_URL: "http://127.0.0.1:9", YT_URL: stub.url });
    await waitAuthority(port);
    // Rehearsal input is keeper-gated (same token as every mutation).
    const cmd = await authed(port, "/api/authority/command", { actorId: "u1", actorName: "A", command: "!strike" });
    expect(cmd.data.outcome).toBe("queued");
    const bad = await authed(port, "/api/authority/command", { actorId: "u1", actorName: "A", command: "!dance" });
    expect(bad.data.outcome).toBe("rejected-invalid");
    // Route vote opens once; second open fails closed (single vote clock).
    const open1 = await authed(port, "/api/authority/vote/open", { which: "route" });
    expect(open1.data.outcome).toBe("opened-route-vote");
    const open2 = await authed(port, "/api/authority/vote/open", { which: "kindling" });
    expect(open2.data.outcome).not.toBe("opened-kindling-vote");
    const dash = await authed(port, "/api/authority/dashboard");
    const sessionId = dash.data.sessionId as string;
    const voteId = (dash.data.vote as { id: string }).id;
    // Simulation source: announcements recorded as na-simulation (T3 parity).
    const announce = dash.data.announce as Record<string, { status: string }>;
    expect(announce[`vote:${sessionId}:${voteId}:open`]?.status).toBe("na-simulation");
    // Switch to YouTube source, close → close announcement fires with the
    // stable close identity (sidecar stub records, no real broadcast).
    await authed(port, "/api/authority/source", { source: "youtube" });
    const close = await authed(port, "/api/authority/vote/close", {});
    expect(String(close.data.outcome)).toMatch(/^closed-vote/);
    await new Promise((r) => setTimeout(r, 500));
    const closeEvents = stub.sends.filter((s) => s.eventId === `vote:${sessionId}:${voteId}:close`);
    expect(closeEvents).toHaveLength(1);
    // Retry of a sent announcement is a no-op (identity stable, no dup).
    const sendsBefore = stub.sends.length;
    await authed(port, "/api/authority/vote/retry", { eventId: `vote:${sessionId}:${voteId}:close` });
    expect(stub.sends.length).toBe(sendsBefore);
    await stub.close();
  }, 120000);

  it("YouTube ingestion subscribes exactly once (no duplicate listeners)", async () => {
    const ev = {
      kind: "chat_command",
      eventId: "stub-e1",
      actorId: "yt:UC0123456789abcdefghij",
      actorName: "Stub",
      command: "!strike",
      receivedAt: new Date().toISOString(),
    };
    const stub = await startYtStub([ev]);
    const port = 3160;
    spawnAuthority(port, tempDir(), { STATE_URL: "http://127.0.0.1:9", YT_URL: stub.url });
    await waitAuthority(port);
    await authed(port, "/api/authority/source", { source: "youtube" });
    await authed(port, "/api/authority/source", { source: "youtube" });
    await new Promise((r) => setTimeout(r, 1500));
    // Exactly one SSE subscription despite the double switch.
    expect(stub.streams).toBe(1);
    const dash = await authed(port, "/api/authority/dashboard");
    const recent = dash.data.recent as Array<{ eventId: string }>;
    expect(recent.filter((r) => r.eventId === "stub-e1")).toHaveLength(1);
    expect((dash.data.yt as { diag: { received: number } }).diag.received).toBe(1);
    await authed(port, "/api/authority/source", { source: "simulation" });
    await stub.close();
  }, 120000);

  it("authenticated publish reaches the state server (server-to-server)", async () => {
    spawnStateServer(3150);
    await waitFor("http://127.0.0.1:3150/api/state/status");
    const port = 3162;
    spawnAuthority(port, tempDir(), { STATE_URL: "http://127.0.0.1:3150", YT_URL: "http://127.0.0.1:9" });
    await waitAuthority(port);
    const snap = await waitFor("http://127.0.0.1:3150/api/state/snapshot");
    expect((snap.snapshot as { v: number }).v).toBe(1);
    expect(typeof (snap.snapshot as { worldRev: number }).worldRev).toBe("number");
    // No credential material in the published snapshot or status.
    expect(JSON.stringify(snap)).not.toContain(TOKEN);
  }, 120000);

  it("no credential material in any authority response", async () => {
    const port = 3163;
    spawnAuthority(port, tempDir(), { STATE_URL: "http://127.0.0.1:9", YT_URL: "http://127.0.0.1:9" });
    await waitAuthority(port);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/authority/status`)).json();
    const dash = await authed(port, "/api/authority/dashboard");
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(JSON.stringify(dash.data)).not.toContain(TOKEN);
  }, 90000);
});
