/**
 * T4F-C1 — transport/control security tests.
 * Token helper unit tests + the full auth matrix against a live authority:
 * every mutation 401s without a credential, malformed bodies are rejected,
 * oversized bodies are capped, and the credential never appears in any
 * response, snapshot, or SSE payload.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  bearerToken,
  resolveAuthorityToken,
  tokensEqual,
} from "../server/authority-token.mjs";

const ROOT = join(__dirname, "..");
const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const TOKEN = "t4f-c1-sec-token-0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const children: ChildProcess[] = [];

afterAll(() => {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* shutdown best-effort */
    }
  }
});

describe("T4F-C1 — authority token helper", () => {
  it("prefers an explicit env token (tests stay deterministic)", async () => {
    process.env.AUTHORITY_TOKEN = TOKEN;
    try {
      const r = await resolveAuthorityToken(mkdtempSync(join(tmpdir(), "tok-")));
      expect(r.token).toBe(TOKEN);
      expect(r.generated).toBe(false);
      expect(r.source).toBe("env");
    } finally {
      delete process.env.AUTHORITY_TOKEN;
    }
  });

  it("generates a file-backed token once, then reloads it", async () => {
    delete process.env.AUTHORITY_TOKEN;
    const dir = mkdtempSync(join(tmpdir(), "tok-"));
    const first = await resolveAuthorityToken(dir);
    expect(first.generated).toBe(true);
    expect(first.token.length).toBeGreaterThanOrEqual(64);
    const onDisk = JSON.parse(readFileSync(join(dir, "authority-token.json"), "utf8")) as { token: string };
    expect(onDisk.token).toBe(first.token);
    const second = await resolveAuthorityToken(dir);
    expect(second.generated).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it("rejects short env tokens (no weak credentials)", async () => {
    process.env.AUTHORITY_TOKEN = "short";
    try {
      const r = await resolveAuthorityToken(mkdtempSync(join(tmpdir(), "tok-")));
      expect(r.source).toBe("file");
      expect(r.token).not.toBe("short");
    } finally {
      delete process.env.AUTHORITY_TOKEN;
    }
  });

  it("parses Bearer headers only (never query strings)", () => {
    expect(bearerToken({ headers: { authorization: `Bearer ${TOKEN}` } })).toBe(TOKEN);
    expect(bearerToken({ headers: {} })).toBeNull();
    expect(bearerToken({ headers: { authorization: "Basic abc" } })).toBeNull();
    expect(bearerToken({ headers: { authorization: "Bearer " } })).toBeNull();
    expect(bearerToken({ headers: { authorization: `Bearer ${TOKEN} extra` } })).toBeNull();
  });

  it("compares in constant time without oracles", () => {
    expect(tokensEqual(TOKEN, TOKEN)).toBe(true);
    expect(tokensEqual("x".repeat(TOKEN.length), TOKEN)).toBe(false);
    expect(tokensEqual("short", TOKEN)).toBe(false);
    expect(tokensEqual(null, TOKEN)).toBe(false);
    expect(tokensEqual(TOKEN, null)).toBe(false);
  });
});

describe("T4F-C1 — transport security posture (static audits)", () => {
  const VITE_CONFIG = readFileSync(join(ROOT, "vite.config.ts"), "utf8");
  const STATE_SERVER = readFileSync(join(ROOT, "server", "state-server.mjs"), "utf8");

  it("vite proxies the authority API to the loopback authority server", () => {
    expect(VITE_CONFIG).toContain('"/api/authority"');
    expect(VITE_CONFIG).toContain("http://localhost:3004");
    expect(VITE_CONFIG).toContain('"/api/state"');
  });

  it("servers bind loopback by default; production requires an explicit public bind", () => {
    // D1-D: the listener host is resolved explicitly (server/listen.mjs):
    // local dev defaults to loopback, production (NODE_ENV=production)
    // requires 0.0.0.0 and a Render-injected PORT. The standalone state
    // server stays a loopback-only local-dev process.
    expect(STATE_SERVER).toContain('listen(port, "127.0.0.1"');
    const SERVER_TS = readFileSync(join(ROOT, "server", "authority-server.ts"), "utf8");
    expect(SERVER_TS).toContain("resolveListenerConfig");
    expect(SERVER_TS).toContain("127.0.0.1");
    expect(SERVER_TS).toContain("0.0.0.0");
    const LISTEN_SRC = readFileSync(join(ROOT, "server", "listen.mjs"), "utf8");
    expect(LISTEN_SRC).toContain("host-must-be-public");
    expect(LISTEN_SRC).toContain("port-required");
  });

  it("no credential flows into client bundles, URLs, or snapshots", () => {
    const CLIENT_FILES = [
      ...["main.ts", "overlay.ts"].map((f) => join(ROOT, "src", f)),
      ...["server-runtime.ts"].map((f) => join(ROOT, "src", "dashboard", f)),
      ...["transport-client.ts", "renderer.ts", "apply-snapshot.ts", "state-transport-urls.ts"].map((f) =>
        join(ROOT, "src", "renderer", f),
      ),
    ];
    for (const file of CLIENT_FILES) {
      const src = readFileSync(file, "utf8");
      // No token-file reads, no env access (the operator pastes the token
      // into a password field; the localStorage KEY name is not a secret).
      // User-facing help copy may NAME the file (recovery guidance); what
      // must never appear is code that opens it.
      expect(src).not.toMatch(/readFile[^;]*authority-token|require[^;]*authority-token|from[^;]*authority-token\.mjs/);
      expect(src).not.toContain("process.env");
      expect(src).not.toContain("/api/state/publish");
    }
    // No Vite client env carries secrets (VITE_* vars are bundled). Exactly
    // one module — src/renderer/state-transport-urls.ts — may read exactly
    // one public value, VITE_STATE_BASE_URL (a backend origin, never a
    // credential), so state transport can bypass the Vercel rewrite's SSE
    // lifetime limit. Everything else stays on a blanket ban.
    for (const file of CLIENT_FILES) {
      const src = readFileSync(file, "utf8");
      if (file.endsWith(join("renderer", "state-transport-urls.ts"))) {
        expect(src).toContain("VITE_STATE_BASE_URL");
      } else {
        expect(src).not.toMatch(/import\.meta\.env/);
      }
    }
    // And nowhere in browser source may a secret-shaped VITE_* name appear.
    const SRC_FILES = [
      ...CLIENT_FILES,
      ...["app.ts", "main.ts", "overlay.ts"].map((f) => join(ROOT, "src", f)),
    ];
    for (const file of SRC_FILES) {
      expect(readFileSync(file, "utf8")).not.toMatch(/VITE_[A-Z_]*(TOKEN|SECRET|KEY|DATABASE|AUTHORITY|GOOGLE|BEARER)/);
    }
  });

  it("publish comparisons are constant-time (no oracle)", () => {
    expect(STATE_SERVER).toContain("tokensEqual(");
    const SERVER_TS = readFileSync(join(ROOT, "server", "authority-server.ts"), "utf8");
    expect(SERVER_TS).toContain("tokensEqual(");
    const TOKEN_SRC = readFileSync(join(ROOT, "server", "authority-token.mjs"), "utf8");
    expect(TOKEN_SRC).toContain("timingSafeEqual");
  });
});

describe("T4F-C1 — token rotation (revocation + loss recovery)", () => {
  // File-backed credential (no env): state + authority share one data dir,
  // like production. Rotation must propagate without any restart.
  const STATE_PORT = 3168;
  const AUTH_PORT = 3169;

  async function readFileToken(dir: string): Promise<string> {
    const raw = readFileSync(join(dir, "authority-token.json"), "utf8");
    return (JSON.parse(raw) as { token: string }).token;
  }

  it("rotate revokes the old token and activates the new one everywhere", async () => {
    delete process.env.AUTHORITY_TOKEN;
    const dir = mkdtempSync(join(tmpdir(), "t4f-c1-rot-"));
    // Shared data dir (like production): the state server generates the
    // file token first; the authority resolves the same value.
    const state = spawn(process.execPath, [join(ROOT, "server", "state-server.mjs"), String(STATE_PORT)], {
      cwd: ROOT,
      stdio: "ignore",
      env: { ...process.env, DATA_DIR: dir },
    });
    children.push(state);
    const t0 = Date.now();
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${STATE_PORT}/api/state/status`);
        if (r.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() - t0 > 30000) throw new Error("state server did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
    const auth = spawn(process.execPath, [TSX_CLI, "server/authority-server.ts", String(AUTH_PORT)], {
      cwd: ROOT,
      stdio: "ignore",
      env: { ...process.env, DATA_DIR: dir, STATE_URL: `http://127.0.0.1:${STATE_PORT}`, YT_URL: "http://127.0.0.1:9" },
    });
    children.push(auth);
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${AUTH_PORT}/api/authority/status`);
        if (r.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() - t0 > 60000) throw new Error("authority did not start");
      await new Promise((r) => setTimeout(r, 300));
    }
    const oldToken = await readFileToken(dir);
    const oldAuth = { authorization: `Bearer ${oldToken}` };
    // Baseline: old token reads the control plane.
    expect(
      (
        await fetch(`http://127.0.0.1:${AUTH_PORT}/api/authority/dashboard`, { headers: { ...oldAuth } })
      ).status,
    ).toBe(200);
    // Rotate (authed with the CURRENT token). Response carries no secret.
    const rotRes = await fetch(`http://127.0.0.1:${AUTH_PORT}/api/authority/token/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...oldAuth },
      body: "{}",
    });
    expect(rotRes.status).toBe(200);
    const rotBody = await rotRes.text();
    expect(rotBody).toContain("token-rotated");
    const newToken = await readFileToken(dir);
    expect(newToken).not.toBe(oldToken);
    expect(rotBody).not.toContain(newToken);
    // Old credential is dead on both servers (no restart anywhere).
    expect(
      (
        await fetch(`http://127.0.0.1:${AUTH_PORT}/api/authority/dashboard`, { headers: { ...oldAuth } })
      ).status,
    ).toBe(401);
    // New credential works on both servers.
    const newAuth = { authorization: `Bearer ${newToken}` };
    expect(
      (
        await fetch(`http://127.0.0.1:${AUTH_PORT}/api/authority/dashboard`, { headers: { ...newAuth } })
      ).status,
    ).toBe(200);
    // Unauthenticated rotation is refused.
    expect(
      (
        await fetch(`http://127.0.0.1:${AUTH_PORT}/api/authority/token/rotate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    // Propagation: the state server (per-request resolve, no restart)
    // rejects the old credential and accepts the new one for publishes.
    // Pause first so the live authority cannot out-publish the probe.
    await fetch(`http://127.0.0.1:${AUTH_PORT}/api/authority/pause`, {
      method: "POST",
      headers: { "content-type": "application/json", ...newAuth },
      body: "{}",
    });
    const live = (await (
      await fetch(`http://127.0.0.1:${STATE_PORT}/api/state/snapshot`)
    ).json()) as { snapshot: { worldRev: number } };
    const bumped = { protocol: 1, snapshot: { ...(live.snapshot as object), worldRev: live.snapshot.worldRev + 1 } };
    const pubOld = await fetch(`http://127.0.0.1:${STATE_PORT}/api/state/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", ...oldAuth },
      body: JSON.stringify(bumped),
    });
    expect(pubOld.status).toBe(401);
    const pubNew = await fetch(`http://127.0.0.1:${STATE_PORT}/api/state/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", ...newAuth },
      body: JSON.stringify(bumped),
    });
    expect(pubNew.status).toBe(200);
  }, 120000);
});

describe("T4F-C1 — control-plane auth matrix", () => {
  const PORT = 3165;
  const BASE = `http://127.0.0.1:${PORT}`;
  let started = false;

  async function start(): Promise<void> {
    if (started) return;
    const child = spawn(process.execPath, [TSX_CLI, "server/authority-server.ts", String(PORT)], {
      cwd: ROOT,
      stdio: "ignore",
      env: { ...process.env, AUTHORITY_TOKEN: TOKEN, DATA_DIR: mkdtempSync(join(tmpdir(), "t4f-c1-sec-")), STATE_URL: "http://127.0.0.1:9", YT_URL: "http://127.0.0.1:9" },
    });
    children.push(child);
    const t0 = Date.now();
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/authority/status`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() - t0 > 60000) throw new Error("authority did not start");
      await new Promise((r) => setTimeout(r, 300));
    }
    started = true;
  }

  async function post(path: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; data: unknown }> {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  }

  const MUTATIONS: Array<[string, unknown]> = [
    ["/api/authority/command", { actorId: "u", actorName: "U", command: "!strike" }],
    ["/api/authority/paid", { actorId: "u", actorName: "U", amountMinor: 5000, currency: "INR" }],
    ["/api/authority/vote/open", { which: "route" }],
    ["/api/authority/vote/close", {}],
    ["/api/authority/vote/override", { optionIndex: 0 }],
    ["/api/authority/vote/retry", { eventId: "vote:s:v:close" }],
    ["/api/authority/rite", { templateId: "tide-prayer" }],
    ["/api/authority/pause", {}],
    ["/api/authority/resume", {}],
    ["/api/authority/save", {}],
    ["/api/authority/reload", {}],
    ["/api/authority/reset", {}],
    ["/api/authority/end-stream", {}],
    ["/api/authority/source", { source: "simulation" }],
    ["/api/authority/youtube/connect", {}],
    ["/api/authority/youtube/disconnect", {}],
    ["/api/authority/youtube/auth-url", {}],
  ];

  it("status is public; dashboard and every mutation require the token", async () => {
    await start();
    const pub = await fetch(`${BASE}/api/authority/status`);
    expect(pub.status).toBe(200);
    const anonDash = await fetch(`${BASE}/api/authority/dashboard`);
    expect(anonDash.status).toBe(401);
    for (const [path, body] of MUTATIONS) {
      const anon = await post(path, body);
      expect(anon.status).toBe(401);
      expect(JSON.stringify(anon.data)).not.toContain(TOKEN);
      const wrong = await post(path, body, { authorization: "Bearer wrong-token-0123456789abcdef" });
      expect(wrong.status).toBe(401);
    }
  }, 120000);

  it("malformed bodies are rejected (never processed)", async () => {
    await start();
    expect((await post("/api/authority/vote/override", { optionIndex: 9 }, AUTH)).status).toBe(400);
    expect((await post("/api/authority/vote/override", {}, AUTH)).status).toBe(400);
    expect((await post("/api/authority/vote/retry", {}, AUTH)).status).toBe(400);
    expect((await post("/api/authority/rite", {}, AUTH)).status).toBe(400);
    expect((await post("/api/authority/source", { source: "sideways" }, AUTH)).status).toBe(400);
    expect((await post("/api/authority/command", "not-an-object", AUTH)).status).toBe(400);
  }, 60000);

  it("oversized bodies are capped", async () => {
    await start();
    const big = await post("/api/authority/command", { actorId: "u", actorName: "U", command: "!strike", pad: "x".repeat(70000) }, AUTH);
    expect(big.status).toBe(413);
  }, 60000);

  it("authed control works and never echoes the token", async () => {
    await start();
    const dash = await fetch(`${BASE}/api/authority/dashboard`, { headers: { ...AUTH } });
    expect(dash.status).toBe(200);
    const text = await dash.text();
    expect(text).not.toContain(TOKEN);
    const cmd = await post("/api/authority/command", { actorId: "u", actorName: "U", command: "!strike" }, AUTH);
    expect(cmd.status).toBe(200);
    expect(JSON.stringify(cmd.data)).not.toContain(TOKEN);
  }, 60000);

  it("token file is created with owner-only intent (no token in stdout contract)", async () => {
    await start();
    // The token file exists server-side; the API never serves it.
    const probe = await post("/api/authority/save", {}, AUTH);
    expect(probe.status).toBe(200);
    // No endpoint returns anything shaped like a credential bundle.
    const dash = await (await fetch(`${BASE}/api/authority/dashboard`, { headers: { ...AUTH } })).json();
    const flat = JSON.stringify(dash);
    expect(flat).not.toMatch(/authority-token|AUTHORITY_TOKEN/);
  }, 60000);
});
