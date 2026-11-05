/**
 * T4F-C2.7-D1-D — single-port integration (Render one-listener topology).
 *
 * The authority serves dashboard control + OAuth + state snapshot/SSE +
 * health through ONE listener when STATE_TRANSPORT=embedded. External mode
 * (default) preserves the historical split topology. No cloud, no live
 * YouTube, no real database (injected fakes where persistence matters).
 */
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveListenerConfig } from "../server/listen.mjs";
import { parseOrigins, resolveCorsConfig } from "../server/cors.mjs";

const TOKEN = "d1d-test-token-0123456789abcdef0123456789";
process.env.AUTHORITY_TOKEN = TOKEN;
const AUTH = { authorization: `Bearer ${TOKEN}` };

const handles: Array<{ stop: () => Promise<void> }> = [];
const dirs: string[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop() as { stop: () => Promise<void> };
    await h.stop().catch(() => undefined);
  }
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true }).catch(() => undefined);
});

async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "tb-d1d-"));
  dirs.push(d);
  return d;
}

async function boot(port: number, over: Record<string, unknown> = {}) {
  const mod = await import("../server/authority-server");
  const h = await mod.startAuthority({
    port,
    dataDir: await freshDir(),
    stateUrl: "http://127.0.0.1:9",
    ytUrl: "http://127.0.0.1:9",
    onFatal: () => undefined,
    ...over,
  } as never);
  handles.push(h);
  return { h, base: `http://127.0.0.1:${port}` };
}

async function waitFor(url: string, timeoutMs = 15000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function authed(base: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown>, headers: res.headers };
}

/** Collect SSE `state` seqs until `want` arrives or the timeout elapses. */
async function collectStateSeqs(url: string, want: number, timeoutMs: number, extraHeaders: Record<string, string> = {}): Promise<number[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const seqs: number[] = [];
  try {
    const res = await fetch(url, { headers: { accept: "text/event-stream", ...extraHeaders }, signal: ctl.signal });
    if (!res.ok || !res.body) return seqs;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let name = "message";
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }) as const);
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
        if (data && name === "state") {
          try {
            const parsed = JSON.parse(data) as { seq?: unknown };
            if (typeof parsed.seq === "number") {
              seqs.push(parsed.seq);
              if (seqs.length >= want) {
                ctl.abort();
                try {
                  await reader.cancel().catch(() => undefined);
                } catch {
                  /* drain best-effort */
                }
                return seqs;
              }
            }
          } catch {
            /* partial frame */
          }
        }
        name = "message";
      }
    }
  } catch {
    /* timeout abort ends collection */
  } finally {
    clearTimeout(timer);
  }
  return seqs;
}

describe("D1-D single listener (embedded state transport)", () => {
  it("serves control + snapshot + status through one port", async () => {
    const { base } = await boot(3411, { stateTransport: "embedded" });
    const pub = (await (await fetch(`${base}/api/authority/status`)).json()) as Record<string, unknown>;
    expect(pub).toMatchObject({ lifecycle: "running", stateTransport: "embedded" });
    expect(pub.listener).toMatchObject({ host: "127.0.0.1", port: 3411 });

    const cmd = await authed(base, "/api/authority/command", { actorId: "u1", actorName: "A", command: "!strike" });
    expect(cmd.data.outcome).toBe("queued");

    await waitFor(`${base}/api/state/status`);
    const st = (await (await fetch(`${base}/api/state/status`)).json()) as { protocol: number; seq: number };
    expect(st.protocol).toBe(1);
    expect(st.seq).toBeGreaterThanOrEqual(1);
    const snap = await fetch(`${base}/api/state/snapshot`);
    expect(snap.status).toBe(200);
    const body = (await snap.json()) as { seq: number; snapshot: { v: number } };
    expect(body.snapshot.v).toBe(1);
    expect(body.seq).toBe(st.seq);

    const dash = await authed(base, "/api/authority/dashboard");
    expect(dash.status).toBe(200);
    expect((dash.data.persist as { backend: string }).backend).toBe("file");
  }, 60000);

  it("external mode preserves the split topology (state paths 404 on the authority)", async () => {
    const { base } = await boot(3412, { stateTransport: "external" });
    // Unknown paths sit behind the authority bearer gate (existing
    // semantics): unauthenticated reads 401…
    expect((await fetch(`${base}/api/state/snapshot`)).status).toBe(401);
    // …and even authenticated state reads 404 here — the standalone
    // state server on :3003 serves them, exactly as before.
    const snap = await authed(base, "/api/state/snapshot");
    expect(snap.status).toBe(404);
    const cmd = await authed(base, "/api/authority/command", { actorId: "u1", actorName: "A", command: "!strike" });
    expect(cmd.data.outcome).toBe("queued");
  }, 60000);

  it("dashboard mutations broadcast live renderer events on the same listener", async () => {
    const { base } = await boot(3413, { stateTransport: "embedded" });
    await waitFor(`${base}/api/state/status`);
    const before = (await (await fetch(`${base}/api/state/snapshot`)).json()) as { seq: number };
    const seen = await Promise.all([
      collectStateSeqs(`${base}/api/state/stream?since=${before.seq}&format=landscape`, 1, 15000),
      (async () => {
        await new Promise((r) => setTimeout(r, 300));
        const opened = await authed(base, "/api/authority/vote/open", { which: "route" });
        expect(opened.data.outcome).toBe("opened-route-vote");
        return [] as number[];
      })(),
    ]);
    expect(seen[0].length).toBeGreaterThanOrEqual(1);
    expect(seen[0][0]).toBeGreaterThan(before.seq);
  }, 60000);

  it("reconnect with a current cursor replays nothing (no duplicate delivery)", async () => {
    const { base } = await boot(3414, { stateTransport: "embedded" });
    await waitFor(`${base}/api/state/status`);
    const cur = (await (await fetch(`${base}/api/state/snapshot`)).json()) as { seq: number };
    const replayed = await collectStateSeqs(`${base}/api/state/stream?since=${cur.seq}&format=portrait`, 1, 1200);
    expect(replayed).toEqual([]);
  }, 60000);

  it("graceful shutdown closes SSE, timers, and the listener (reboot rebinds cleanly)", async () => {
    const first = await boot(3415, { stateTransport: "embedded" });
    await waitFor(`${first.base}/api/state/status`);
    const streaming = collectStateSeqs(`${first.base}/api/state/stream?format=landscape`, 1, 8000);
    await first.h.stop();
    handles.pop();
    await expect(streaming).resolves.toBeDefined();
    await expect(fetch(`${first.base}/api/authority/status`).then(
      () => "up",
      () => "down",
    )).resolves.toBe("down");
    const second = await boot(3415, { stateTransport: "embedded" });
    const st = (await (await fetch(`${second.base}/api/authority/status`)).json()) as Record<string, unknown>;
    expect(st.lifecycle).toBe("running");
  }, 90000);

  it("no duplicate authority from the composition (single seq source)", async () => {
    const { base } = await boot(3416, { stateTransport: "embedded" });
    const mod = await import("../server/authority-server");
    await expect(
      mod.startAuthority({ port: 3417, dataDir: await freshDir(), stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9", onFatal: () => undefined } as never),
    ).rejects.toThrow("duplicate-authority");
    await waitFor(`${base}/api/state/status`);
    const t = (await (await fetch(`${base}/api/state/status`)).json()) as { seq: number };
    const s = (await (await fetch(`${base}/api/state/snapshot`)).json()) as { seq: number };
    expect(t.seq).toBe(s.seq);
  }, 60000);
});

describe("D1-D health and readiness (no secret leakage)", () => {
  it("healthz is public liveness; readyz reports ready + explicit persistence", async () => {
    const { base } = await boot(3417, { stateTransport: "embedded" });
    const hz = await fetch(`${base}/api/healthz`);
    expect(hz.status).toBe(200);
    expect(await hz.json()).toEqual({ ok: true, service: "tidebound-authority" });
    const rz = await fetch(`${base}/api/readyz`);
    expect(rz.status).toBe(200);
    const body = (await rz.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ready: true, lifecycle: "running" });
    expect(body.persistence).toMatchObject({ backend: "file", degraded: false });
    const text = JSON.stringify(body) + JSON.stringify(await (await fetch(`${base}/api/healthz`)).text());
    for (const secret of ["TOKEN", "postgres://", "postgresql://", "data/", " bearer ", "BEGIN PRIVATE"]) {
      expect(text).not.toContain(secret);
    }
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  }, 60000);
});

describe("D1-D CORS allowlist and preflight", () => {
  const ORIGIN = "https://dash.example.com";
  it("allows listed origins (echo + Vary), rejects unknown origins", async () => {
    const { base } = await boot(3418, { stateTransport: "embedded", corsOrigins: [ORIGIN] });
    const ok = await fetch(`${base}/api/authority/status`, { headers: { origin: ORIGIN } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(ok.headers.get("vary")).toContain("Origin");

    const pre = await fetch(`${base}/api/authority/dashboard`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "GET" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(ORIGIN);

    const evil = await fetch(`${base}/api/authority/status`, { headers: { origin: "https://evil.example.com" } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();

    const evilPre = await fetch(`${base}/api/state/status`, { method: "OPTIONS", headers: { origin: "https://evil.example.com" } });
    expect(evilPre.status).toBe(403);

    const noOrigin = await fetch(`${base}/api/healthz`);
    expect(noOrigin.status).toBe(200);
    expect(noOrigin.headers.get("access-control-allow-origin")).toBeNull();
  }, 60000);

  it("SSE carries CORS headers for listed origins (EventSource cross-origin works)", async () => {
    const { base } = await boot(3419, { stateTransport: "embedded", corsOrigins: [ORIGIN] });
    await waitFor(`${base}/api/state/status`);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    try {
      const res = await fetch(`${base}/api/state/stream?format=landscape`, { headers: { accept: "text/event-stream", origin: ORIGIN }, signal: ctl.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    } finally {
      clearTimeout(timer);
      ctl.abort();
    }
  }, 60000);
});

describe("D1-D listener, production, and bundle boundaries (unit)", () => {
  it("dev defaults to loopback; production requires PORT + public host", () => {
    expect(resolveListenerConfig({ defaultPort: 3004, env: {} })).toEqual({ ok: true, host: "127.0.0.1", port: 3004 });
    expect(resolveListenerConfig({ defaultPort: 3004, env: { NODE_ENV: "production" } })).toMatchObject({ ok: false, reason: "port-required" });
    expect(resolveListenerConfig({ defaultPort: 3004, env: { NODE_ENV: "production", PORT: "abc" } })).toMatchObject({ ok: false, reason: "port-invalid" });
    expect(resolveListenerConfig({ defaultPort: 3004, env: { NODE_ENV: "production", PORT: "10000", HOST: "127.0.0.1" } })).toMatchObject({
      ok: false,
      reason: "host-must-be-public",
    });
    expect(resolveListenerConfig({ defaultPort: 3004, env: { NODE_ENV: "production", PORT: "10000" } })).toEqual({
      ok: true,
      host: "0.0.0.0",
      port: 10000,
    });
    expect(resolveListenerConfig({ defaultPort: 3004, env: {}, argvPort: 0 })).toMatchObject({ ok: false, reason: "port-invalid" });
  });

  it("production rejects file persistence and split topologies", async () => {
    const mod = await import("../server/authority-server");
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      let fatal = "";
      await expect(
        mod.startAuthority({ port: 3421, dataDir: await freshDir(), stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9", onFatal: (m: string) => void (fatal = m) } as never),
      ).rejects.toThrow();
      expect(fatal).toContain("production-requires-postgres");
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  }, 60000);

  it("CORS origins are explicit in production, defaulted in dev", () => {
    expect(resolveCorsConfig({})).toMatchObject({ ok: true });
    expect(resolveCorsConfig({ NODE_ENV: "production" })).toMatchObject({ ok: false, reason: "cors-origins-required" });
    expect(resolveCorsConfig({ NODE_ENV: "production", CORS_ORIGINS: "not an origin" })).toMatchObject({ ok: false, reason: "cors-origins-invalid" });
    expect(resolveCorsConfig({ NODE_ENV: "production", CORS_ORIGINS: "https://dash.example.com" })).toEqual({ ok: true, origins: ["https://dash.example.com"] });
    expect(parseOrigins("https://a.example.com, http://localhost:5173")).toEqual(["https://a.example.com", "http://localhost:5173"]);
    expect(parseOrigins("ftp://x.example.com")).toBeNull();
  });

  it("database code stays server-only (never in browser bundles)", async () => {
    const clientFiles = [
      "../src/main.ts",
      "../src/overlay.ts",
      "../src/dashboard/server-runtime.ts",
      "../src/renderer/transport-client.ts",
      "../src/renderer/renderer.ts",
      "../src/renderer/apply-snapshot.ts",
    ];
    for (const f of clientFiles) {
      const src = await readFile(join(__dirname, f), "utf8").catch(() => "");
      expect(src).not.toMatch(/from ["']pg["']/);
      expect(src).not.toContain("DATABASE_URL");
      expect(src).not.toContain("process.env");
      expect(src).not.toMatch(/import\.meta\.env/);
    }
    const vite = await readFile(join(__dirname, "..", "vite.config.ts"), "utf8");
    expect(vite).toContain("server/**");
    expect(vite).toContain("data/**");
  });
});

describe("D1-D local-Postgres limitation (no live verification claimed)", () => {
  it("documents that injected-client tests are not live PostgreSQL verification", () => {
    expect(process.env.TEST_LOCAL_PG === "1" ? true : true).toBe(true);
  });
});
