// T4F-C2.7-D1-C — durable persistence: server-only DB configuration.
//
// Responsibility ends at configuration validation + pool factory options.
// NO queries here, NO logging of secrets, NO browser imports.
//
// - `DATABASE_URL` is server-only (Render secret). It never appears in
//   responses, snapshots, SSE, logs, Vercel variables, or browser bundles.
// - TLS is required for every non-loopback host (Neon requires TLS).
// - Pooling is sized for ONE authority process (single writer by design):
//   max 3, no minimum hold (Neon scale-to-zero friendly), short timeouts so
//   a suspended database fails visibly instead of hanging the authority.
// - Neon Free (verified 2026-11-05 docs): 1 GB storage/project, 100 CU-hours
//   /project/month, autoscale to 2 CU, scale-to-zero after 5 min (cannot be
//   disabled on Free), ~97 usable direct connections, pooled up to 10k,
//   5 GB egress/project/month. Our durable footprint is kilobytes (one world
//   row, two credential envelopes, a handful of OAuth nonces + cursors), so
//   storage/quota pressure is negligible; the binding constraints are cold
//   start latency (few hundred ms resume) and CU suspension. Timeouts below
//   encode that: fail visibly on suspension instead of hanging the stream.

export const PERSISTENCE_BACKENDS = ["file", "postgres"];

/** Stable credential row identifiers (never plaintext, envelope only). */
export const CREDENTIAL_IDS = ["youtube-credentials", "youtube-pending-grant"];

/** Allowlisted metadata keys. Anything else is rejected (no ad-hoc rows). */
export const METADATA_KEYS = ["authority-cursor", "youtube-adapter-cursor", "youtube-pending-channel"];

export const DEFAULT_POOL = {
  max: 3,
  min: 0,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
};

export const STATEMENT_TIMEOUT_MS = 5_000;

function isLocalHost(hostname) {
  const h = String(hostname ?? "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** Parse without ever throwing the URL (or its password) to a log. */
function parseDatabaseUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 4096) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
  if (!u.hostname) return null;
  return u;
}

/**
 * Redacted host/db label for diagnostics. NEVER includes user, password,
 * or query parameters. Safe to log.
 */
export function redactDatabaseUrl(url) {
  const u = parseDatabaseUrl(url);
  if (!u) return "invalid-database-url";
  const db = u.pathname && u.pathname !== "/" ? u.pathname.slice(1).split("/")[0] : "";
  return db ? `${u.hostname}/${db}` : u.hostname;
}

/**
 * Validate persistence selection. Explicit only — never silently falls back
 * from postgres to ephemeral files (the caller must fail boot instead).
 *
 * Rules:
 * - `PERSISTENCE_BACKEND` defaults to "file" (local dev preserves current
 *   file behavior bit-for-bit). Any other value is rejected.
 * - `postgres` requires `DATABASE_URL` (postgresql://...). Missing/invalid
 *   is a boot failure, not a fallback.
 * - `NODE_ENV=production` with `file` is rejected: cloud mode must use the
 *   external database (Render filesystem is ephemeral).
 */
export function resolvePersistenceConfig(env = process.env) {
  const rawBackend = env?.PERSISTENCE_BACKEND;
  const backend = rawBackend === undefined || rawBackend === "" ? "file" : String(rawBackend);
  if (backend !== "file" && backend !== "postgres") {
    return { ok: false, reason: "persistence-backend-invalid" };
  }
  const nodeEnv = typeof env?.NODE_ENV === "string" ? env.NODE_ENV : "";
  if (nodeEnv === "production" && backend !== "postgres") {
    return { ok: false, reason: "production-requires-postgres" };
  }
  if (backend === "file") {
    return { ok: true, config: { backend: "file" } };
  }
  const databaseUrl = typeof env?.DATABASE_URL === "string" ? env.DATABASE_URL : "";
  const parsed = parseDatabaseUrl(databaseUrl);
  if (!parsed) {
    return { ok: false, reason: "database-url-required" };
  }
  const requireTls = !isLocalHost(parsed.hostname);
  // Pooled (PgBouncer, `-pooler` host) vs direct: PgBouncer in transaction
  // mode rejects unknown startup parameters, so the `options=-c
  // statement_timeout=...` guard used for direct connections cannot be sent
  // on pooled connections. Pooled pools get a client-side `query_timeout`
  // instead (same bound, PgBouncer-safe); direct keeps the server-side guard.
  const isPooled = parsed.hostname.includes("-pooler");
  return {
    ok: true,
    config: {
      backend: "postgres",
      // The raw URL is carried here in memory only. Callers must never log
      // `config.databaseUrl` — log `redactDatabaseUrl()` instead.
      databaseUrl,
      host: parsed.hostname,
      requireTls,
      isPooled,
      pool: { ...DEFAULT_POOL },
      statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    },
  };
}

/**
 * pg Pool options for the resolved config. TLS is always enabled for
 * non-loopback hosts with full chain verification (Neon presents a valid
 * public certificate). Loopback dev databases use no TLS.
 */
export function poolOptionsFor(config) {
  if (!config || config.backend !== "postgres") throw new Error("persistence-not-postgres");
  const ssl = config.requireTls ? { rejectUnauthorized: true } : undefined;
  const pooled = config.isPooled === true || (typeof config.host === "string" && config.host.includes("-pooler"));
  const timeoutMs = config.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS;
  const options = {
    connectionString: config.databaseUrl,
    max: config.pool?.max ?? DEFAULT_POOL.max,
    min: config.pool?.min ?? DEFAULT_POOL.min,
    idleTimeoutMillis: config.pool?.idleTimeoutMillis ?? DEFAULT_POOL.idleTimeoutMillis,
    connectionTimeoutMillis: config.pool?.connectionTimeoutMillis ?? DEFAULT_POOL.connectionTimeoutMillis,
  };
  if (pooled) {
    // PgBouncer (transaction mode) rejects `options` startup parameters, so
    // the per-statement bound is enforced client-side instead. Same 5 s
    // budget: a suspended Neon compute surfaces as a query error the
    // authority can handle instead of hanging the pump/publish loops.
    options.query_timeout = timeoutMs;
  } else {
    // Bound every statement so a suspended Neon compute (CU/egress
    // exhausted, or cold resume stall) surfaces as an error the authority
    // can handle instead of hanging the pump/publish loops.
    options.options = `-c statement_timeout=${timeoutMs}`;
  }
  if (ssl) options.ssl = ssl;
  return options;
}

/**
 * Create a `pg` Pool. The import is lazy so unit tests can inject a mock
 * client without installing/loading the driver, and so file-mode boots
 * never touch the driver at all.
 */
export async function createPgPool(config, { importImpl } = {}) {
  const options = poolOptionsFor(config);
  let PgPool;
  try {
    const mod = importImpl ? await importImpl("pg") : await import("pg");
    PgPool = mod?.Pool ?? mod?.default?.Pool;
  } catch {
    return { ok: false, reason: "pg-missing" };
  }
  if (typeof PgPool !== "function") return { ok: false, reason: "pg-missing" };
  try {
    const pool = new PgPool(options);
    pool.on("error", () => {
      // Idle-client errors must never crash the authority; queries observe
      // failures per-call and the outage policy handles them. No URL here.
    });
    return { ok: true, pool };
  } catch {
    return { ok: false, reason: "pg-pool-failed" };
  }
}

/**
 * In postgres mode the bearer MUST come from the environment (Render
 * secret shared by authority + state server). Generating an ephemeral file
 * token on an ephemeral filesystem would silently lock the operator out on
 * every restart — so absence is a boot failure, never a generation.
 */
export function requireAuthorityTokenEnv(env = process.env) {
  const v = env?.AUTHORITY_TOKEN;
  if (typeof v === "string" && v.length >= 16) return { ok: true, token: v };
  return { ok: false, reason: "authority-token-required" };
}
