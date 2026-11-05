/**
 * T4F-C2.7-D1-C — authority postgres-mode integration (injected fake DB).
 * No real database, no cloud, no live YouTube. The fake interprets the exact
 * SQL the postgres backend emits (migrations, world, credentials, oauth
 * state, metadata) so restart/recovery, outage, and token-policy behavior is
 * exercised end-to-end through startAuthority().
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "d1c-test-token-0123456789abcdef0123456789";
process.env.AUTHORITY_TOKEN = TOKEN;

const KEY = Buffer.alloc(32, 0x3a);
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
  const d = await mkdtemp(join(tmpdir(), "tb-d1c-auth-"));
  dirs.push(d);
  return d;
}

/** Unified in-memory Postgres fake for the full authority backend. */
function fakePostgres(opts: { fail?: boolean; corruptWorld?: boolean } = {}) {
  const state = {
    fail: !!opts.fail,
    corruptWorld: !!opts.corruptWorld,
    schemaVersion: 0,
    world: null as { payload: unknown; revision: number } | null,
    worldRevision: 0,
    creds: new Map<string, unknown>(),
    oauth: new Map<string, { created_at: number; consumed: boolean; data: string | null }>(),
    meta: new Map<string, unknown>(),
  };
  return {
    state,
    async query(text: string, params: unknown[] = []) {
      if (state.fail) throw new Error("connection-terminated");
      // Migrations / version
      if (text.includes("SELECT version FROM schema_migrations")) {
        return { rows: state.schemaVersion === 0 ? [] : [{ version: state.schemaVersion }] };
      }
      if (text.includes("CREATE TABLE IF NOT EXISTS") || text.includes("INSERT INTO schema_migrations")) {
        state.schemaVersion = 1;
        return { rows: [] };
      }
      // World
      if (text.includes("SELECT payload, revision FROM world_state")) {
        if (!state.world) return { rows: [] };
        const payload = state.corruptWorld ? { worldId: "emberkeep-prototype", deeds: "corrupt" } : state.world.payload;
        return { rows: [{ payload, revision: state.world.revision }] };
      }
      if (text.includes("INSERT INTO world_state")) {
        const payload = JSON.parse(String(params[1]));
        state.worldRevision += 1;
        state.world = { payload, revision: state.worldRevision };
        return { rows: [{ revision: state.worldRevision }] };
      }
      if (text.trim().toUpperCase() === "BEGIN" || text.trim().toUpperCase() === "COMMIT" || text.trim().toUpperCase() === "ROLLBACK") {
        return { rows: [] };
      }
      // Credentials
      if (text.includes("SELECT envelope FROM authority_credentials")) {
        const id = String(params[0]);
        return state.creds.has(id) ? { rows: [{ envelope: state.creds.get(id) }] } : { rows: [] };
      }
      if (text.includes("INSERT INTO authority_credentials")) {
        state.creds.set(String(params[0]), JSON.parse(String(params[1])));
        return { rows: [] };
      }
      if (text.startsWith("DELETE FROM authority_credentials")) {
        state.creds.delete(String(params[0]));
        return { rows: [] };
      }
      // OAuth state
      if (text.startsWith("DELETE FROM oauth_state WHERE created_at <")) {
        const cutoff = Number(params[0]);
        for (const [k, r] of [...state.oauth]) if (r.created_at < cutoff) state.oauth.delete(k);
        return { rows: [] };
      }
      if (text.includes("SELECT COUNT(") && text.includes("oauth_state")) {
        return { rows: [{ n: state.oauth.size }] };
      }
      if (text.startsWith("INSERT INTO oauth_state")) {
        const h = String(params[0]);
        if (state.oauth.has(h)) {
          const e = new Error("duplicate key") as Error & { code?: string };
          e.code = "23505";
          throw e;
        }
        state.oauth.set(h, { created_at: Number(params[1]), consumed: false, data: (params[2] as string | null) ?? null });
        return { rows: [] };
      }
      if (text.startsWith("UPDATE oauth_state SET consumed")) {
        const h = String(params[0]);
        const cutoff = Number(params[1]);
        const r = state.oauth.get(h);
        if (r && !r.consumed && r.created_at > cutoff) {
          r.consumed = true;
          return { rows: [{ data: r.data }] };
        }
        return { rows: [] };
      }
      if (text.startsWith("SELECT consumed, created_at")) {
        const r = state.oauth.get(String(params[0]));
        return r ? { rows: [{ consumed: r.consumed, created_at: r.created_at }] } : { rows: [] };
      }
      if (text.startsWith("DELETE FROM oauth_state WHERE h =")) {
        state.oauth.delete(String(params[0]));
        return { rows: [] };
      }
      // Metadata
      if (text.includes("SELECT value FROM authority_metadata")) {
        const k = String(params[0]);
        return state.meta.has(k) ? { rows: [{ value: state.meta.get(k) }] } : { rows: [] };
      }
      if (text.includes("INSERT INTO authority_metadata")) {
        state.meta.set(String(params[0]), JSON.parse(String(params[1])));
        return { rows: [] };
      }
      if (text.startsWith("DELETE FROM authority_metadata")) {
        state.meta.delete(String(params[0]));
        return { rows: [] };
      }
      if (text.trim() === "SELECT 1 AS ok" || text.includes("SELECT 1")) return { rows: [{ ok: 1 }] };
      throw new Error(`unexpected fake query: ${text.slice(0, 100)}`);
    },
  };
}

async function authed(port: number, path: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("D1-C authority postgres mode (durable, outage-safe)", () => {
  it("empty database boots postgres-fresh and reports the postgres backend", async () => {
    const mod = await import("../server/authority-server");
    const dir = await freshDir();
    const fake = fakePostgres();
    const h = await mod.startAuthority({
      port: 3381,
      dataDir: dir,
      stateUrl: "http://127.0.0.1:9",
      ytUrl: "http://127.0.0.1:9",
      persistenceBackend: "postgres",
      databaseUrl: "postgresql://u:p@127.0.0.1:5432/test",
      db: fake,
      onFatal: () => undefined,
    });
    handles.push(h);
    const st = (await (await fetch("http://127.0.0.1:3381/api/authority/status")).json()) as Record<string, unknown>;
    expect(st).toMatchObject({ lifecycle: "running", recoveredFrom: "postgres-fresh", persistenceBackend: "postgres" });
    const dash = await authed(3381, "/api/authority/dashboard");
    expect((dash.data.persist as { backend: string }).backend).toBe("postgres");
  }, 60000);

  it("restart restores the latest committed world and session (no silent genesis)", async () => {
    const mod = await import("../server/authority-server");
    const dir = await freshDir();
    const fake = fakePostgres();
    const base = { stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9", persistenceBackend: "postgres" as const, databaseUrl: "postgresql://u:p@127.0.0.1:5432/test", db: fake, onFatal: () => undefined };
    const h1 = await mod.startAuthority({ port: 3382, dataDir: dir, ...base });
    handles.push(h1);
    const cmd = await authed(3382, "/api/authority/command", { actorId: "u1", actorName: "A", command: "!strike" });
    expect(cmd.data.outcome).toBe("queued");
    const save = await authed(3382, "/api/authority/save", {});
    expect(save.data).toMatchObject({ ok: true, outcome: "postgres" });
    const d1 = await authed(3382, "/api/authority/dashboard");
    const sessionId = d1.data.sessionId as string;
    await h1.stop();
    handles.pop();
    const h2 = await mod.startAuthority({ port: 3382, dataDir: dir, ...base });
    handles.push(h2);
    expect(h2.getSessionId()).toBe(sessionId);
    const st = (await (await fetch("http://127.0.0.1:3382/api/authority/status")).json()) as Record<string, unknown>;
    expect(st.recoveredFrom).toBe("postgres");
  }, 90000);

  it("corrupt stored world fails boot (never silent genesis)", async () => {
    const mod = await import("../server/authority-server");
    const dir = await freshDir();
    const fake = fakePostgres();
    // Seed one valid world first so a row exists, then corrupt it.
    const seed = await mod.startAuthority({
      port: 3383, dataDir: dir, stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9",
      persistenceBackend: "postgres", databaseUrl: "postgresql://u:p@127.0.0.1:5432/test", db: fake, onFatal: () => undefined,
    });
    handles.push(seed);
    await authed(3383, "/api/authority/save", {});
    await seed.stop();
    handles.pop();
    fake.state.corruptWorld = true;
    let fatal = "";
    await expect(
      mod.startAuthority({
        port: 3383, dataDir: dir, stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9",
        persistenceBackend: "postgres", databaseUrl: "postgresql://u:p@127.0.0.1:5432/test", db: fake,
        onFatal: (m) => void (fatal = m),
      }),
    ).rejects.toThrow();
    expect(fatal).toContain("world-corrupt");
  }, 90000);

  it("database outage at startup fails boot (never an empty world)", async () => {
    const mod = await import("../server/authority-server");
    const dir = await freshDir();
    const fake = fakePostgres({ fail: true });
    let fatal = "";
    await expect(
      mod.startAuthority({
        port: 3384, dataDir: dir, stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9",
        persistenceBackend: "postgres", databaseUrl: "postgresql://u:p@127.0.0.1:5432/test", db: fake,
        onFatal: (m) => void (fatal = m),
      }),
    ).rejects.toThrow();
    expect(fatal).toContain("database-unavailable");
  }, 60000);

  it("save failure during a stream degrades visibly (db-error, lastError, retry recovers)", async () => {
    const mod = await import("../server/authority-server");
    const dir = await freshDir();
    const fake = fakePostgres();
    const h = await mod.startAuthority({
      port: 3385, dataDir: dir, stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9",
      persistenceBackend: "postgres", databaseUrl: "postgresql://u:p@127.0.0.1:5432/test", db: fake, onFatal: () => undefined,
    });
    handles.push(h);
    fake.state.fail = true;
    const bad = await authed(3385, "/api/authority/save", {});
    expect(bad.data).toMatchObject({ ok: false, outcome: "db-error" });
    const dash = await authed(3385, "/api/authority/dashboard");
    expect((dash.data.persist as { from: string }).from).toBe("db-error");
    expect(typeof dash.data.lastError).toBe("string");
    // Reconnect: next save clears the degraded flag.
    fake.state.fail = false;
    const good = await authed(3385, "/api/authority/save", {});
    expect(good.data).toMatchObject({ ok: true, outcome: "postgres" });
  }, 60000);

  it("token rotation is refused in postgres mode (rotate-requires-env, bearer unchanged)", async () => {
    const mod = await import("../server/authority-server");
    const dir = await freshDir();
    const fake = fakePostgres();
    const h = await mod.startAuthority({
      port: 3386, dataDir: dir, stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9",
      persistenceBackend: "postgres", databaseUrl: "postgresql://u:p@127.0.0.1:5432/test", db: fake, onFatal: () => undefined,
    });
    handles.push(h);
    const r = await authed(3386, "/api/authority/token/rotate", {});
    expect(r.data).toMatchObject({ ok: false, outcome: "rotate-requires-env" });
    // Bearer still works (unchanged).
    const dash = await authed(3386, "/api/authority/dashboard");
    expect(dash.status).toBe(200);
  }, 60000);

  it("OAuth grant in postgres mode resumes across restart with envelopes encrypted", async () => {
    const mod = await import("../server/authority-server");
    const dir = await freshDir();
    const fake = fakePostgres();
    const exchanges = { n: 0 };
    const googleMock = (async (url: unknown) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/token")) {
        exchanges.n += 1;
        return { ok: true, status: 200, json: async () => ({ access_token: `CANARY-AT-${exchanges.n}`, refresh_token: `CANARY-RT-${exchanges.n}`, expires_in: 3600 }) };
      }
      if (u.includes("/youtube/v3/channels")) {
        return { ok: true, status: 200, json: async () => ({ items: [{ id: "UC-DB-1", snippet: { title: "DB", customUrl: "@db" } }] }) };
      }
      if (u.includes("/youtube/v3/liveBroadcasts")) {
        return { ok: true, status: 200, json: async () => ({ items: [{ snippet: { liveChatId: "CHAT-DB", channelId: "UC-DB-1", title: "Live" } }] }) };
      }
      if (u.includes("/youtube/v3/liveChat/messages")) {
        return { ok: true, status: 200, json: async () => ({ items: [], nextPageToken: "p1", pollingIntervalMillis: 15000 }) };
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;
    const oauth = {
      clientId: "test-client.apps.googleusercontent.com",
      clientSecret: "test-secret",
      redirectUri: "http://127.0.0.1:3387/api/youtube/oauth-callback",
      allowHttpLoopback: true,
      encryptionKey: KEY,
      dashboardUrl: "https://dash.example.test/",
    };
    const base = {
      dataDir: dir, stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9",
      persistenceBackend: "postgres" as const, databaseUrl: "postgresql://u:p@127.0.0.1:5432/test", db: fake,
      fetchImpl: googleMock, oauth, onFatal: () => undefined,
    };
    const h1 = await mod.startAuthority({ port: 3387, ...base });
    handles.push(h1);
    const start = await fetch("http://127.0.0.1:3387/api/authority/youtube/oauth/start", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: TOKEN }).toString(), redirect: "manual",
    });
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") as string;
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
    const cb = await fetch(`http://127.0.0.1:3387/api/youtube/oauth-callback?code=C1&state=${state}`, { headers: { cookie } });
    expect(cb.status).toBe(200);
    expect(exchanges.n).toBe(1);
    // Database bytes never contain plaintext canaries.
    expect(JSON.stringify([...fake.state.creds.values()])).not.toContain("CANARY-AT-1");
    expect(JSON.stringify([...fake.state.creds.values()])).not.toContain("CANARY-RT-1");
    await h1.stop();
    handles.pop();
    const h2 = await mod.startAuthority({ port: 3388, ...base });
    handles.push(h2);
    const auth = { authorization: `Bearer ${TOKEN}` };
    const st = (await (await fetch("http://127.0.0.1:3388/api/authority/youtube/oauth/status", { headers: auth })).json()) as Record<string, unknown>;
    expect(st).toMatchObject({ configured: true, connected: true });
    expect(exchanges.n).toBe(1); // resumed, no new exchange
  }, 90000);
});
