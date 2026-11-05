/**
 * T4F-C2.7-D1-C — durable persistence adapter tests (injected mocks only).
 * No cloud resources, no live YouTube, no real database required. Every
 * store accepts an injected {query} client; fakes below interpret the exact
 * SQL each store emits. A local-Postgres integration path runs only when
 * TEST_LOCAL_PG=1 and a reachable instance exists (otherwise skipped).
 */
import { describe, expect, it } from "vitest";
import { normalizeWorld, serialize } from "../src/persistence/store";
import { tideboundGenesis } from "../src/content/tidebound";
import {
  resolvePersistenceConfig,
  redactDatabaseUrl,
  poolOptionsFor,
  requireAuthorityTokenEnv,
} from "../server/persistence/db-config.mjs";
import { getSchemaVersion, ensureMigrated, CURRENT_SCHEMA_VERSION } from "../server/persistence/migrate.mjs";
import { DbWorldStore } from "../server/persistence/world-store.mjs";
import { DbCredentialRepository, CredentialStoreError } from "../server/persistence/credential-store.mjs";
import { PgOAuthStateStore, STATE_TTL_MS } from "../server/persistence/oauth-state-store.mjs";
import { DbMetadataStore } from "../server/persistence/metadata-store.mjs";
import { OUTAGE_POLICY, readyStatus, checkConnectivity } from "../server/persistence/storage.mjs";

const KEY = Buffer.alloc(32, 0x3a);
const WRONG_KEY = Buffer.alloc(32, 0x7b);
const CANARY_ACCESS = "CANARY-DB-ACCESS-9f8e7d6c5b4a";
const CANARY_REFRESH = "CANARY-DB-REFRESH-1a2b3c4d5e6f";

// ---------------------------------------------------------------------------
// Fakes (interpret the exact SQL each store emits; nothing more)
// ---------------------------------------------------------------------------

function worldFake(initial: Array<Record<string, unknown>> = [], opts: { fail?: boolean } = {}) {
  const firstRev = typeof initial[0]?.revision === "number" ? (initial[0].revision as number) : 0;
  const state = { rows: [...initial], revision: firstRev, fail: !!opts.fail };
  return {
    state,
    async query(text: string, params: unknown[] = []) {
      if (state.fail) throw new Error("connection-terminated");
      const t = text.trim().toUpperCase();
      if (t === "BEGIN" || t === "COMMIT" || t === "ROLLBACK") return { rows: [] };
      if (text.includes("SELECT payload")) return { rows: [...state.rows] };
      if (text.includes("INSERT INTO world_state")) {
        const payload = JSON.parse(String(params[1]));
        state.revision += 1;
        state.rows = [{ payload, revision: state.revision }];
        return { rows: [{ revision: state.revision }] };
      }
      throw new Error(`unexpected world query: ${text.slice(0, 80)}`);
    },
  };
}

function credFake(initial: Record<string, unknown> = {}, opts: { fail?: boolean } = {}) {
  const state = { map: new Map<string, unknown>(Object.entries(initial)), fail: !!opts.fail };
  return {
    state,
    async query(text: string, params: unknown[] = []) {
      if (state.fail) throw new Error("connection-reset");
      if (text.includes("SELECT envelope")) {
        const id = String(params[0]);
        return state.map.has(id) ? { rows: [{ envelope: state.map.get(id) }] } : { rows: [] };
      }
      if (text.includes("INSERT INTO authority_credentials")) {
        state.map.set(String(params[0]), JSON.parse(String(params[1])));
        return { rows: [] };
      }
      if (text.startsWith("DELETE FROM authority_credentials")) {
        state.map.delete(String(params[0]));
        return { rows: [] };
      }
      throw new Error(`unexpected cred query: ${text.slice(0, 80)}`);
    },
  };
}

function oauthFake(opts: { fail?: boolean } = {}) {
  const map = new Map<string, { created_at: number; consumed: boolean; data: string | null }>();
  const state = { map, fail: !!opts.fail };
  return {
    state,
    async query(text: string, params: unknown[] = []) {
      if (state.fail) throw new Error("connection-terminated");
      if (text.startsWith("DELETE FROM oauth_state WHERE created_at <")) {
        const cutoff = Number(params[0]);
        for (const [k, r] of [...map]) if (r.created_at < cutoff) map.delete(k);
        return { rows: [] };
      }
      if (text.includes("SELECT COUNT(")) {
        return { rows: [{ n: map.size }] };
      }
      if (text.startsWith("INSERT INTO oauth_state")) {
        const h = String(params[0]);
        if (map.has(h)) {
          const e = new Error("duplicate key") as Error & { code?: string };
          e.code = "23505";
          throw e;
        }
        map.set(h, { created_at: Number(params[1]), consumed: false, data: (params[2] as string | null) ?? null });
        return { rows: [] };
      }
      if (text.startsWith("UPDATE oauth_state SET consumed")) {
        const h = String(params[0]);
        const cutoff = Number(params[1]);
        const r = map.get(h);
        if (r && !r.consumed && r.created_at > cutoff) {
          r.consumed = true;
          return { rows: [{ data: r.data }] };
        }
        return { rows: [] };
      }
      if (text.startsWith("SELECT consumed, created_at")) {
        const r = map.get(String(params[0]));
        return r ? { rows: [{ consumed: r.consumed, created_at: r.created_at }] } : { rows: [] };
      }
      if (text.startsWith("DELETE FROM oauth_state WHERE h =")) {
        map.delete(String(params[0]));
        return { rows: [] };
      }
      throw new Error(`unexpected oauth query: ${text.slice(0, 90)}`);
    },
  };
}

function metaFake(initial: Record<string, unknown> = {}, opts: { fail?: boolean } = {}) {
  const map = new Map<string, unknown>(Object.entries(initial));
  const state = { map, fail: !!opts.fail };
  return {
    state,
    async query(text: string, params: unknown[] = []) {
      if (state.fail) throw new Error("connection-terminated");
      if (text.includes("SELECT value")) {
        const k = String(params[0]);
        return map.has(k) ? { rows: [{ value: map.get(k) }] } : { rows: [] };
      }
      if (text.includes("INSERT INTO authority_metadata")) {
        map.set(String(params[0]), JSON.parse(String(params[1])));
        return { rows: [] };
      }
      if (text.startsWith("DELETE FROM authority_metadata")) {
        map.delete(String(params[0]));
        return { rows: [] };
      }
      throw new Error(`unexpected meta query: ${text.slice(0, 80)}`);
    },
  };
}

// ---------------------------------------------------------------------------
// db-config: selection, TLS, redaction, token boundary
// ---------------------------------------------------------------------------

describe("D1-C persistence config (explicit selection, no silent fallback)", () => {
  it("defaults to file (local dev preserves current behavior)", () => {
    expect(resolvePersistenceConfig({})).toEqual({ ok: true, config: { backend: "file" } });
  });
  it("rejects unknown backends", () => {
    expect(resolvePersistenceConfig({ PERSISTENCE_BACKEND: "sqlite" })).toMatchObject({ ok: false });
  });
  it("postgres requires DATABASE_URL (never falls back to files)", () => {
    expect(resolvePersistenceConfig({ PERSISTENCE_BACKEND: "postgres" })).toMatchObject({ ok: false, reason: "database-url-required" });
    expect(resolvePersistenceConfig({ PERSISTENCE_BACKEND: "postgres", DATABASE_URL: "not-a-url" })).toMatchObject({
      ok: false,
      reason: "database-url-required",
    });
  });
  it("production with file backend is rejected (cloud must use postgres)", () => {
    expect(resolvePersistenceConfig({ NODE_ENV: "production" })).toMatchObject({ ok: false, reason: "production-requires-postgres" });
    const ok = resolvePersistenceConfig({ NODE_ENV: "production", PERSISTENCE_BACKEND: "postgres", DATABASE_URL: "postgresql://u:p@db.example.com:5432/tidebound" });
    expect(ok.ok).toBe(true);
  });
  it("remote hosts require TLS; loopback does not", () => {
    const remote = resolvePersistenceConfig({ PERSISTENCE_BACKEND: "postgres", DATABASE_URL: "postgresql://u:p@db.example.com:5432/t" });
    expect(remote).toMatchObject({ ok: true });
    if (remote.ok && remote.config.backend === "postgres") {
      expect(remote.config.requireTls).toBe(true);
      expect(poolOptionsFor(remote.config as never)).toMatchObject({ ssl: { rejectUnauthorized: true } });
    }
    const local = resolvePersistenceConfig({ PERSISTENCE_BACKEND: "postgres", DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/t" });
    if (local.ok && local.config.backend === "postgres") {
      expect(local.config.requireTls).toBe(false);
      expect(poolOptionsFor(local.config as never)).not.toHaveProperty("ssl");
    }
  });
  it("pool is sized for one authority (max 3, short timeouts, statement guard)", () => {
    const r = resolvePersistenceConfig({ PERSISTENCE_BACKEND: "postgres", DATABASE_URL: "postgresql://u:p@db.example.com:5432/t" });
    if (r.ok && r.config.backend === "postgres") {
      const opts = poolOptionsFor(r.config as never) as Record<string, unknown>;
      expect(opts.max).toBe(3);
      expect(opts.connectionTimeoutMillis).toBe(5_000);
      expect(String(opts.options)).toContain("statement_timeout=5000");
    } else throw new Error("expected postgres config");
  });
  it("pooled (-pooler) hosts skip the options startup parameter (PgBouncer-safe client timeout)", () => {
    const r = resolvePersistenceConfig({ PERSISTENCE_BACKEND: "postgres", DATABASE_URL: "postgresql://u:p@ep-xyz-123-pooler.c-2.aws.neon.tech/tidebound?sslmode=require" });
    if (r.ok && r.config.backend === "postgres") {
      expect(r.config.isPooled).toBe(true);
      const opts = poolOptionsFor(r.config as never) as Record<string, unknown>;
      expect(opts).not.toHaveProperty("options");
      expect(opts.query_timeout).toBe(5_000);
      expect(opts.max).toBe(3);
    } else throw new Error("expected postgres config");
  });
  it("redaction never includes user, password, or params", () => {
    const red = redactDatabaseUrl("postgresql://user:s3cret@db.example.com:5432/tidebound?sslmode=require");
    expect(red).toContain("db.example.com");
    expect(red).not.toContain("user");
    expect(red).not.toContain("s3cret");
    expect(red).not.toContain("sslmode");
    expect(redactDatabaseUrl("garbage")).toBe("invalid-database-url");
  });
  it("postgres mode requires AUTHORITY_TOKEN env (never generates ephemeral bearer)", () => {
    expect(requireAuthorityTokenEnv({})).toMatchObject({ ok: false, reason: "authority-token-required" });
    expect(requireAuthorityTokenEnv({ AUTHORITY_TOKEN: "short" })).toMatchObject({ ok: false });
    expect(requireAuthorityTokenEnv({ AUTHORITY_TOKEN: "0123456789abcdef0123456789abcdef" })).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// migrate/schema
// ---------------------------------------------------------------------------

describe("D1-C migrations (versioned, mismatch fails boot)", () => {
  it("CURRENT_SCHEMA_VERSION is 1", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });
  it("missing table reports version 0 (no-save, not outage)", async () => {
    const db = { async query() { const e = new Error('relation "schema_migrations" does not exist') as Error & { code?: string }; e.code = "42P01"; throw e; } };
    expect(await getSchemaVersion(db)).toEqual({ ok: true, version: 0 });
  });
  it("connection failure reports db-unavailable (distinct from no-save)", async () => {
    const db = { async query() { throw new Error("connect timeout"); } };
    expect(await getSchemaVersion(db)).toMatchObject({ ok: false, reason: "db-unavailable" });
  });
  it("applies 001 and records version 1 (idempotent re-run)", async () => {
    let version = 0;
    const db = {
      async query(text: string) {
        if (text.includes("SELECT version")) return { rows: version === 0 ? [] : [{ version }] };
        version = 1; // 001_init.sql applied (idempotent DDL + INSERT ... ON CONFLICT)
        return { rows: [] };
      },
    };
    const first = await ensureMigrated(db);
    expect(first).toMatchObject({ ok: true, version: 1, applied: true });
    const second = await ensureMigrated(db);
    expect(second).toMatchObject({ ok: true, version: 1, applied: false });
  });
  it("database newer than code fails (migration-version-mismatch)", async () => {
    const db = { async query() { return { rows: [{ version: 99 }] }; } };
    expect(await ensureMigrated(db)).toMatchObject({ ok: false, reason: "migration-version-mismatch" });
  });
  it("migration SQL file exists and stores envelopes as JSONB (no plaintext columns)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const sql = await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "server", "persistence", "migrations", "001_init.sql"), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS world_state");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS authority_credentials");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS authority_metadata");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS oauth_state");
    expect(sql).toContain("envelope JSONB");
    expect(sql.toLowerCase()).not.toContain("access_token");
    expect(sql.toLowerCase()).not.toContain("refresh_token");
    expect(sql.toLowerCase()).not.toContain("encryption_key");
  });
});

// ---------------------------------------------------------------------------
// world-state repository
// ---------------------------------------------------------------------------

describe("D1-C world-state repository (validated, atomic, outage != empty)", () => {
  function world(over: Record<string, unknown> = {}) {
    const g = tideboundGenesis() as unknown as Record<string, unknown>;
    return { ...g, ...over };
  }
  it("1. save and reload preserves the exact supported world fields", async () => {
    const fake = worldFake();
    const store = new DbWorldStore({ db: fake, normalizeWorld, serialize });
    const input = world({ streamCount: 4, deeds: ["deed-a", "deed-b"] });
    const saved = await store.save(input as never);
    expect(saved.ok).toBe(true);
    const loaded = await store.load();
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.world.streamCount).toBe(4);
      expect(loaded.world.deeds).toEqual(["deed-a", "deed-b"]);
      expect(normalizeWorld(loaded.world)).not.toBeNull();
    }
  });
  it("2. genuinely absent state reports no-save (fresh genesis allowed)", async () => {
    const store = new DbWorldStore({ db: worldFake([]), normalizeWorld, serialize });
    expect(await store.load()).toEqual({ status: "no-save" });
  });
  it("3. invalid save is rejected before any database touch", async () => {
    let touched = false;
    const db = { async query() { touched = true; return { rows: [] }; } };
    const store = new DbWorldStore({ db, normalizeWorld, serialize });
    const out = await store.save({ worldId: "nope" } as never);
    expect(out).toMatchObject({ ok: false, reason: "invalid-save" });
    expect(touched).toBe(false);
  });
  it("4. corrupt stored data fails safely (never silent genesis)", async () => {
    const fake = worldFake([{ payload: { worldId: "emberkeep-prototype", deeds: "not-an-array" }, revision: 1 }]);
    const store = new DbWorldStore({ db: fake, normalizeWorld, serialize });
    expect(await store.load()).toMatchObject({ status: "corrupt" });
  });
  it("5. database outage is unavailable — never an empty world", async () => {
    const store = new DbWorldStore({ db: worldFake([], { fail: true }), normalizeWorld, serialize });
    const loaded = await store.load();
    expect(loaded.status).toBe("unavailable");
    expect(loaded).not.toEqual({ status: "no-save" });
    const saved = await store.save(world() as never);
    expect(saved).toMatchObject({ ok: false, reason: "db-unavailable" });
  });
  it("6. two sequential revisions preserve ordering", async () => {
    const fake = worldFake();
    const store = new DbWorldStore({ db: fake, normalizeWorld, serialize });
    const r1 = await store.save(world({ streamCount: 1 }) as never);
    const r2 = await store.save(world({ streamCount: 2 }) as never);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r2.revision).toBeGreaterThan(r1.revision);
    const loaded = await store.load();
    if (loaded.status === "ok") expect(loaded.world.streamCount).toBe(2);
    else throw new Error("expected ok load");
  });
  it("7. failed transaction preserves the previous valid state", async () => {
    const fake = worldFake();
    const store = new DbWorldStore({ db: fake, normalizeWorld, serialize });
    await store.save(world({ streamCount: 7 }) as never);
    fake.state.fail = true;
    expect(await store.save(world({ streamCount: 8 }) as never)).toMatchObject({ ok: false, reason: "db-unavailable" });
    fake.state.fail = false;
    const loaded = await store.load();
    if (loaded.status !== "ok") throw new Error("expected ok");
    expect(loaded.world.streamCount).toBe(7);
  });
  it("8. restart restores the latest committed revision (new instance, same db)", async () => {
    const fake = worldFake();
    const a = new DbWorldStore({ db: fake, normalizeWorld, serialize });
    await a.save(world({ streamCount: 11 }) as never);
    const b = new DbWorldStore({ db: fake, normalizeWorld, serialize });
    const loaded = await b.load();
    if (loaded.status !== "ok") throw new Error("expected ok");
    expect(loaded.world.streamCount).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// encrypted credential repository (database medium, same envelope)
// ---------------------------------------------------------------------------

describe("D1-C encrypted credential repository (envelope only, outage != absence)", () => {
  function creds(over: Record<string, unknown> = {}) {
    return {
      access_token: CANARY_ACCESS,
      refresh_token: CANARY_REFRESH,
      expires_at: Date.now() + 3600_000,
      scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
      obtainedAt: 1_700_000_000_000,
      ...over,
    };
  }
  it("1. encrypted save/load round trip through the adapter", async () => {
    const fake = credFake();
    const repo = new DbCredentialRepository({ db: fake, id: "youtube-credentials", key: KEY });
    const input = creds({ channel: { id: "UC-CANARY" } });
    await repo.save(input);
    expect(await repo.load()).toEqual(input);
    expect(await repo.hasCredentials()).toBe(true);
  });
  it("2. database bytes do not contain canary plaintext tokens", async () => {
    const fake = credFake();
    const repo = new DbCredentialRepository({ db: fake, id: "youtube-credentials", key: KEY });
    await repo.save(creds());
    const raw = JSON.stringify([...fake.state.map.values()]);
    expect(raw).not.toContain(CANARY_ACCESS);
    expect(raw).not.toContain(CANARY_REFRESH);
  });
  it("3. wrong key fails closed (and preserves the row)", async () => {
    const fake = credFake();
    await new DbCredentialRepository({ db: fake, id: "youtube-credentials", key: KEY }).save(creds());
    const before = JSON.stringify([...fake.state.map.values()]);
    const wrong = new DbCredentialRepository({ db: fake, id: "youtube-credentials", key: WRONG_KEY });
    await expect(wrong.load()).rejects.toMatchObject({ code: "auth-failed" });
    expect(JSON.stringify([...fake.state.map.values()])).toBe(before);
  });
  it("4. tampered envelope fails authentication", async () => {
    const fake = credFake();
    const repo = new DbCredentialRepository({ db: fake, id: "youtube-credentials", key: KEY });
    await repo.save(creds());
    const env = fake.state.map.get("youtube-credentials") as Record<string, string>;
    const data = Buffer.from(env.data, "base64");
    data[0] ^= 0xff;
    fake.state.map.set("youtube-credentials", { ...env, data: data.toString("base64") });
    await expect(repo.load()).rejects.toMatchObject({ code: "auth-failed" });
  });
  it("5. outage preserves grant semantics (missing != error, never silent delete)", async () => {
    const missing = new DbCredentialRepository({ db: credFake({}), id: "youtube-credentials", key: KEY });
    expect(await missing.load()).toBeNull();
    expect(await missing.hasCredentials()).toBe(false);
    const down = new DbCredentialRepository({ db: credFake({}, { fail: true }), id: "youtube-credentials", key: KEY });
    await expect(down.load()).rejects.toMatchObject({ code: "db-unavailable" });
    await expect(down.save(creds())).rejects.toMatchObject({ code: "db-unavailable" });
    await expect(down.clear()).rejects.toMatchObject({ code: "db-unavailable" });
  });
  it("6. refresh rotation persists atomically (single save replaces the grant)", async () => {
    const fake = credFake();
    const repo = new DbCredentialRepository({ db: fake, id: "youtube-credentials", key: KEY });
    await repo.save(creds({ refresh_token: "RT-OLD" }));
    await repo.save(creds({ access_token: "AT-NEW", refresh_token: "RT-NEW" }));
    const out = await repo.load();
    expect(out?.access_token).toBe("AT-NEW");
    expect(out?.refresh_token).toBe("RT-NEW");
  });
  it("7. concurrent saves cannot create partial credential state", async () => {
    const fake = credFake();
    const repo = new DbCredentialRepository({ db: fake, id: "youtube-credentials", key: KEY });
    const variants = Array.from({ length: 8 }, (_, i) => creds({ access_token: `${CANARY_ACCESS}-${i}` }));
    await Promise.all(variants.map((v) => repo.save(v)));
    const out = await repo.load();
    expect(variants.map((v) => v.access_token)).toContain(out?.access_token);
    expect(JSON.stringify([...fake.state.map.values()])).not.toContain(CANARY_REFRESH);
  });
  it("rejects unknown row ids (no ad-hoc credential rows)", () => {
    const fake = credFake();
    expect(() => new DbCredentialRepository({ db: fake, id: "operator-bearer" as never, key: KEY })).toThrowError(CredentialStoreError);
  });
});

// ---------------------------------------------------------------------------
// pending grants (remain encrypted, confirm/cancel semantics)
// ---------------------------------------------------------------------------

describe("D1-C pending channel grants (encrypted staging, explicit confirm)", () => {
  it("staged grant round-trips encrypted; confirm moves it live; cancel discards", async () => {
    const fake = credFake();
    const live = new DbCredentialRepository({ db: fake, id: "youtube-credentials", key: KEY });
    const pending = new DbCredentialRepository({ db: fake, id: "youtube-pending-grant", key: KEY });
    await live.save({ access_token: "AT-1", refresh_token: "RT-1", channel: { id: "UC-1" } });
    await pending.save({ access_token: "AT-2", refresh_token: "RT-2", channel: { id: "UC-2" } });
    // Live grant untouched by staging.
    expect((await live.load())?.channel).toMatchObject({ id: "UC-1" });
    // Confirm: copy staged -> live, then clear staging (authority flow).
    const staged = await pending.load();
    await live.save(staged);
    await pending.clear();
    expect((await live.load())?.channel).toMatchObject({ id: "UC-2" });
    expect(await pending.load()).toBeNull();
    // Stored bytes never contain plaintext.
    expect(JSON.stringify([...fake.state.map.values()])).not.toContain("AT-2");
  });
  it("cancel path leaves the live grant intact", async () => {
    const fake = credFake();
    const live = new DbCredentialRepository({ db: fake, id: "youtube-credentials", key: KEY });
    const pending = new DbCredentialRepository({ db: fake, id: "youtube-pending-grant", key: KEY });
    await live.save({ access_token: "AT-1", channel: { id: "UC-1" } });
    await pending.save({ access_token: "AT-2", channel: { id: "UC-2" } });
    await pending.clear();
    expect((await live.load())?.channel).toMatchObject({ id: "UC-1" });
    expect(await pending.load()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// OAuth state (hash-only, TTL, atomic single-use)
// ---------------------------------------------------------------------------

describe("D1-C OAuth state persistence (single-use preserved)", () => {
  it(`default TTL is 10 minutes (${STATE_TTL_MS}ms)`, () => {
    expect(STATE_TTL_MS).toBe(10 * 60 * 1000);
  });
  it("minted states are 32-byte random URL-safe strings; only hashes persist", async () => {
    const fake = oauthFake();
    const s = new PgOAuthStateStore({ db: fake });
    expect((await s.init()).ok).toBe(true);
    const st = await s.create();
    expect(st.length).toBeGreaterThanOrEqual(43);
    expect(/^[A-Za-z0-9_-]+$/.test(st)).toBe(true);
    const rows = JSON.stringify([...fake.state.map.keys()]);
    expect(rows).not.toContain(st); // hash only
    expect(await s.count()).toBe(1);
  });
  it("valid state consumes once; replay is already-consumed", async () => {
    const fake = oauthFake();
    const s = new PgOAuthStateStore({ db: fake });
    await s.init();
    const st = await s.create();
    expect(await s.consume(st)).toEqual({ ok: true });
    expect(await s.consume(st)).toMatchObject({ ok: false, reason: "already-consumed" });
  });
  it("unknown and invalid states are rejected without echoing values", async () => {
    const fake = oauthFake();
    const s = new PgOAuthStateStore({ db: fake });
    await s.init();
    const st = await s.create();
    const out = await s.consume(`${st}DIFFERENT`);
    expect(out).toMatchObject({ ok: false });
    expect(JSON.stringify(out)).not.toContain(st);
    expect(await s.consume("short")).toMatchObject({ ok: false, reason: "invalid-state" });
  });
  it("expired states are rejected and pruned", async () => {
    let t = 1_000_000;
    const fake = oauthFake();
    const s = new PgOAuthStateStore({ db: fake, ttlMs: 60_000, now: () => t });
    await s.init();
    const st = await s.create();
    t += 60_001;
    expect(await s.consume(st)).toMatchObject({ ok: false, reason: "expired-state" });
    expect(await s.count()).toBe(0);
  });
  it("concurrent consumption allows exactly one success (atomic UPDATE)", async () => {
    const fake = oauthFake();
    const s = new PgOAuthStateStore({ db: fake });
    await s.init();
    const st = await s.create();
    const results = await Promise.all(Array.from({ length: 10 }, () => s.consume(st)));
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).length).toBe(9);
  });
  it("restart behavior is deterministic (unexpired valid, consumed stays consumed)", async () => {
    const fake = oauthFake();
    let t = 5_000_000;
    const now = () => t;
    const a = new PgOAuthStateStore({ db: fake, now });
    await a.init();
    const st = await a.create();
    const b = new PgOAuthStateStore({ db: fake, now }); // simulated restart, same db
    expect((await b.init()).restored).toBe(1);
    expect(await b.consume(st)).toEqual({ ok: true });
    const c = new PgOAuthStateStore({ db: fake, now });
    await c.init();
    expect(await c.consume(st)).toMatchObject({ ok: false, reason: "already-consumed" });
  });
  it("correlation binding round-trips (data hash only, never a credential)", async () => {
    const fake = oauthFake();
    const s = new PgOAuthStateStore({ db: fake });
    await s.init();
    const st = await s.create({ data: "corr-hash-abc" });
    expect(await s.consume(st)).toEqual({ ok: true, data: "corr-hash-abc" });
  });
  it("database outage fails closed (state-unavailable, never false validity)", async () => {
    const fake = oauthFake({ fail: true });
    const s = new PgOAuthStateStore({ db: fake });
    expect(await s.init()).toMatchObject({ ok: false });
    await expect(s.create()).rejects.toThrow("state-unavailable");
    expect(await s.consume("x".repeat(43))).toMatchObject({ ok: false, reason: "state-unavailable" });
  });
});

// ---------------------------------------------------------------------------
// cursors + pending-channel metadata
// ---------------------------------------------------------------------------

describe("D1-C cursor and pending-channel metadata (allowlisted, fail closed)", () => {
  it("authority + adapter cursors round-trip; missing returns null", async () => {
    const fake = metaFake();
    const m = new DbMetadataStore({ db: fake });
    expect(await m.get("authority-cursor")).toBeNull();
    await m.set("authority-cursor", { lastYtEventId: "yt:abc" });
    expect(await m.get("authority-cursor")).toEqual({ lastYtEventId: "yt:abc" });
    await m.set("youtube-adapter-cursor", { liveChatId: "CHAT", platformId: "MSG-9", publishedAt: "2026-01-01T00:00:00.000Z" });
    expect(await m.get("youtube-adapter-cursor")).toMatchObject({ liveChatId: "CHAT", platformId: "MSG-9" });
  });
  it("pending-channel meta round-trips (non-secret identity only)", async () => {
    const fake = metaFake();
    const m = new DbMetadataStore({ db: fake });
    const meta = { newChannel: { id: "UC-2" }, previousChannelId: "UC-1", at: new Date(0).toISOString() };
    await m.set("youtube-pending-channel", meta);
    expect(await m.get("youtube-pending-channel")).toEqual(meta);
    await m.delete("youtube-pending-channel");
    expect(await m.get("youtube-pending-channel")).toBeNull();
  });
  it("unknown keys are rejected (no ad-hoc rows)", async () => {
    const m = new DbMetadataStore({ db: metaFake() });
    await expect(m.get("operator-bearer" as never)).rejects.toThrow("metadata-key-not-allowed");
    await expect(m.set("operator-bearer" as never, {})).rejects.toThrow("metadata-key-not-allowed");
  });
  it("corrupt values fail closed (never silent reset)", async () => {
    const fake = metaFake({ "authority-cursor": { bogus: 1 } });
    const m = new DbMetadataStore({ db: fake });
    await expect(m.get("authority-cursor")).rejects.toThrow("corrupt-storage");
    await expect(m.set("authority-cursor", { bogus: 1 } as never)).rejects.toThrow("metadata-value-invalid");
  });
  it("outage throws db-unavailable (missing != error)", async () => {
    const m = new DbMetadataStore({ db: metaFake({}, { fail: true }) });
    await expect(m.get("authority-cursor")).rejects.toThrow("db-unavailable");
    await expect(m.set("authority-cursor", { lastYtEventId: null })).rejects.toThrow("db-unavailable");
  });
});

// ---------------------------------------------------------------------------
// outage + readiness + restart policy surface
// ---------------------------------------------------------------------------

describe("D1-C outage and startup policy surface", () => {
  it("OUTAGE_POLICY prefers last-committed-world over silent progress (no auto-pause)", () => {
    expect(OUTAGE_POLICY).toMatchObject({
      startupUnavailable: "fail-boot",
      restartDuringOutage: "fail-boot-never-empty-world",
      migrationMismatch: "fail-boot",
      autoPauseOnPersistenceFailure: false,
    });
  });
  it("readiness is gated (running + persistenceReady only)", () => {
    expect(readyStatus({ lifecycle: "running", persistenceReady: true })).toBe(true);
    expect(readyStatus({ lifecycle: "running", persistenceReady: false })).toBe(false);
    expect(readyStatus({ lifecycle: "recovering", persistenceReady: true })).toBe(false);
  });
  it("connectivity check distinguishes outage from health", async () => {
    expect(await checkConnectivity({ async query() { return { rows: [] }; } })).toMatchObject({ ok: true });
    expect(await checkConnectivity({ async query() { throw new Error("down"); } })).toMatchObject({ ok: false, reason: "database-unavailable" });
  });
});

// ---------------------------------------------------------------------------
// file-backend preservation (existing repos untouched by this change)
// ---------------------------------------------------------------------------

describe("D1-C file-backend preservation (existing change intact)", () => {
  it("file CredentialRepository and OAuthStateStore modules still load with their interfaces", async () => {
    const cred = await import("../server/youtube/credential-repository.mjs");
    expect(typeof cred.CredentialRepository).toBe("function");
    expect(typeof cred.decodeEncryptionKey).toBe("function");
    expect(typeof cred.validateCredentials).toBe("function");
    const st = await import("../server/youtube/oauth-state-store.mjs");
    expect(typeof st.OAuthStateStore).toBe("function");
    expect(st.STATE_TTL_MS).toBe(10 * 60 * 1000);
    expect(st.STATE_RANDOM_BYTES).toBe(32);
  });
  it("world validation boundary still rejects invalid saves", () => {
    expect(normalizeWorld({ worldId: "nope" })).toBeNull();
    expect(normalizeWorld(tideboundGenesis())).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// local-Postgres integration (only when a local instance is provided)
// ---------------------------------------------------------------------------

describe("D1-C local-Postgres integration (opt-in, no cloud)", () => {
  it.runIf(process.env.TEST_LOCAL_PG === "1")("round-trips world + envelope against a local instance", async () => {
    const url = process.env.TEST_LOCAL_PG_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pgMod = (await import("pg").catch(() => ({ default: null }))) as unknown as { default: (new (opts: Record<string, unknown>) => { query: Function; end: () => Promise<void> }) | null };
    if (!pgMod.default) throw new Error("pg-missing");
    const pool = new pgMod.default({
      connectionString: url,
      connectionTimeoutMillis: 3000,
    });
    const db = { query: (t: string, p?: unknown[]) => (pool.query as Function)(t, p) as Promise<{ rows: Record<string, unknown>[] }> };
    expect((await ensureMigrated(db)).ok).toBe(true);
    const store = new DbWorldStore({ db, normalizeWorld, serialize });
    await store.save(tideboundGenesis() as never);
    expect((await store.load()).status).toBe("ok");
    await pool.end();
  });
  it("skips by default (no local instance required for CI)", () => {
    if (process.env.TEST_LOCAL_PG === "1") return;
    expect(true).toBe(true);
  });
});
