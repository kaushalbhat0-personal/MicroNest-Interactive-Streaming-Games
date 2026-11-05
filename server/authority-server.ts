/**
 * T4F-C1 — server-side authoritative Tidebound runtime.
 *
 * Run:  npx tsx server/authority-server.ts [port]   (default 3004)
 * Env:  AUTHORITY_TOKEN  explicit credential (tests/ephemeral setups)
 *       STATE_URL        state-transport base (default http://127.0.0.1:3003)
 *       YT_URL           youtube sidecar base (default http://127.0.0.1:3002)
 *       DATA_DIR         runtime state dir (default ./data)
 *
 * This process is the SOLE authority. It owns: GameEngine + EventQueue +
 * WorldState, StreamSession + ballot box + vote clock, the 250ms pump/tick
 * loop, FeedAggregator + ViewerFeedStore + BannerQueue, the single
 * sidecar-SSE ingestion, outbound announcement orchestration, snapshot
 * publication (authenticated), and persistence coordination. The dashboard
 * is a control client; renderers stay read-only subscribers. Nothing here
 * depends on a browser tab remaining open.
 *
 * Lifecycle: starting → recovering (restore/reload) → running ⇄ paused
 *            → stopped (clean shutdown) | failed (unrecoverable).
 * Persisted: world save (data/world-state.json), authority token
 *            (data/authority-token.json, 0600), youtube cursor
 *            (data/authority-cursor.json). Ephemeral: session, ballots,
 *            vote clock position, queue, storyLog, feed/banners, announce
 *            map, SSE cursors-in-flight, source selection (safe default:
 *            simulation). A corrupt save boots an explicit fresh genesis
 *            (flagged in status) — never a silent second authority.
 *
 * Threat boundary: every mutation endpoint requires
 * `Authorization: Bearer <token>` (constant-time compare). Renderers and
 * any party without the token can only read. Only /status is public
 * (lifecycle counters, no secrets). The token never appears in
 * responses, snapshots, SSE, or logs. All servers bind 127.0.0.1.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, QUEUE } from "../src/engine/config";
import { GameEngine, makeEventId } from "../src/engine/engine";
import type { CanonicalEvent } from "../src/engine/types";
import { FeedAggregator } from "../src/engine/feed";
import { ledgerStatus } from "../src/engine/ledger";
import {
  castSessionVote,
  openSessionVote,
  type StreamSession,
} from "../src/engine/lifecycle";
import {
  closeStreamAndFire,
  closeVoteAndFire,
  fireRite,
  handleProcessedResult,
  openStreamAndFire,
  overrideVoteAndFire,
} from "../src/runtime/progression";
import {
  beaconOilModel,
  paleChartModel,
  voteModel,
  vexModel,
} from "../src/presentation/tidebound-presentation";
import { BannerQueue, ViewerFeedStore } from "../src/presentation/viewer-feed";
import {
  ANNOUNCE_MAX_CHARS,
  closeEventId,
  composeVoteOpen,
  composeVoteResult,
  openEventId,
  type AnnounceStatus,
} from "../src/presentation/vote-announce";
import { KINDLING_VOTE, ROUTE_VOTE, TIDEBOUND_LIBRARY, tideboundGenesis } from "../src/content/tidebound";
import {
  buildSnapshot,
  revisionSignature,
  shouldBumpRevision,
  type SnapshotV1,
} from "../src/shared/snapshot";
import { TRANSPORT_PROTOCOL } from "../src/shared/transport-core";
import { normalizeWorld, serialize } from "../src/persistence/store";
import { bearerToken, resolveAuthorityToken, tokensEqual, TOKEN_FILE } from "./authority-token.mjs";
import { applyCors, resolveCorsConfig } from "./cors.mjs";
import { resolveListenerConfig } from "./listen.mjs";
import { createStateTransport } from "./state-transport.mjs";
import {
  resolvePersistenceConfig,
  requireAuthorityTokenEnv,
  createPgPool,
  redactDatabaseUrl,
} from "./persistence/db-config.mjs";
import { ensureMigrated } from "./persistence/migrate.mjs";
import { DbWorldStore } from "./persistence/world-store.mjs";
import { DbCredentialRepository } from "./persistence/credential-store.mjs";
import { PgOAuthStateStore } from "./persistence/oauth-state-store.mjs";
import { DbMetadataStore } from "./persistence/metadata-store.mjs";
import { checkConnectivity } from "./persistence/storage.mjs";
import { YouTubeAdapter } from "./youtube/adapter.mjs";
import { OAuthStateStore } from "./youtube/oauth-state-store.mjs";
import { CredentialRepository, decodeEncryptionKey } from "./youtube/credential-repository.mjs";
import {
  OAUTH_SCOPES,
  OAUTH_SECURITY_HEADERS,
  buildCorrelationSetCookie,
  buildWebAuthUrl,
  handleOAuthCallback,
  hashCorrelation,
  loadOAuthConfig,
  mintCorrelationSecret,
  parseCorrelationCookie,
  renderLandingPage,
  type ChannelIdentity,
  type OAuthConfig,
} from "./youtube/oauth-web.mjs";

// ---------------------------------------------------------------------------
// Small local mirrors (kept dependency-free: no browser modules server-side)
// ---------------------------------------------------------------------------

/** Mirrors voteOptionIndex() in src/youtube/client.ts (whitelist mapping). */
function voteOptionIndex(command: string): number | null {
  if (command === "!votea") return 0;
  if (command === "!voteb") return 1;
  if (command === "!votec") return 2;
  return null;
}

/** Mirrors isCanonical() in src/youtube/client.ts (sidecar event shape). */
function isCanonicalEv(ev: unknown): ev is CanonicalEvent {
  if (!ev || typeof ev !== "object") return false;
  const e = ev as Record<string, unknown>;
  if (e.kind === "paid_retraction") {
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

function commandKeys(): string[] {
  return Object.keys(COMMANDS);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthorityLifecycle = "starting" | "recovering" | "running" | "paused" | "stopped" | "failed";

export interface AuthorityOpts {
  port?: number;
  dataDir?: string;
  stateUrl?: string;
  ytUrl?: string;
  /** Override timers (tests). */
  pollMs?: number;
  publishMs?: number;
  ytStatusMs?: number;
  /** Transport for Google/YouTube server-to-server calls (tests stub this). */
  fetchImpl?: typeof fetch;
  /** OAuth Web Server flow config (tests/dev). Defaults to process.env. */
  oauth?: {
    clientId?: unknown;
    clientSecret?: unknown;
    redirectUri?: unknown;
    encryptionKey?: unknown;
    dashboardUrl?: unknown;
    allowHttpLoopback?: boolean;
  };
  /** Never exits the process on fatal boot errors (tests). */
  onFatal?: (message: string) => void;
  /** Durable persistence selection (D1-C). Defaults to env PERSISTENCE_BACKEND / DATABASE_URL. */
  persistenceBackend?: "file" | "postgres";
  /** Overrides DATABASE_URL env (tests). */
  databaseUrl?: string;
  /** Injected database client {query} for postgres mode (unit tests). Skips pg pool creation. */
  db?: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }> };
  /** Single-port state transport (D1-D). Defaults to env STATE_TRANSPORT ("external" preserves local dev). */
  stateTransport?: "external" | "embedded";
  /** Listener host override (tests). Defaults to HOST env / loopback dev / 0.0.0.0 prod. */
  host?: string;
  /** CORS origin allowlist override (tests). Defaults to CORS_ORIGINS env / dev defaults. */
  corsOrigins?: string[];
}

export interface AuthorityHandle {
  getLifecycle: () => AuthorityLifecycle;
  getWorldRev: () => number;
  getSeq: () => number | null;
  getSessionId: () => string;
  getTimerCount: () => number;
  getStatus: () => Record<string, unknown>;
  stop: () => Promise<void>;
}

interface AnnounceState {
  kind: "open" | "close";
  status: AnnounceStatus;
  reason?: string;
  text?: string;
  attempts: number;
}

const BODY_MAX_BYTES = 64 * 1024;
const CURSOR_FILE = "authority-cursor.json";
const LOCK_FILE = "authority.lock";
const SAVE_FILE = "world-state.json";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

let activeAuthority: { stop: () => Promise<void> } | null = null;

export async function startAuthority(opts?: AuthorityOpts): Promise<AuthorityHandle> {
  if (activeAuthority) throw new Error("duplicate-authority: an authority is already active in this process");
  const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = opts?.dataDir ?? process.env.DATA_DIR ?? join(moduleRoot, "data");
  const stateUrl = (opts?.stateUrl ?? process.env.STATE_URL ?? "http://127.0.0.1:3003").replace(/\/$/, "");
  const ytUrl = (opts?.ytUrl ?? process.env.YT_URL ?? "http://127.0.0.1:3002").replace(/\/$/, "");
  const pollMs = opts?.pollMs ?? 250;
  const publishMs = opts?.publishMs ?? 400;
  const ytStatusMs = opts?.ytStatusMs ?? 3000;
  const startedAt = Date.now();

  await mkdir(dataDir, { recursive: true });

  let lifecycle: AuthorityLifecycle = "starting";
  let lastError: string | null = null;
  let recoveredFrom: string = "none";
  const fail = (message: string): never => {
    lifecycle = "failed";
    lastError = message;
    if (opts?.onFatal) {
      opts.onFatal(message);
      throw new Error(message);
    }
    console.error(`[tidebound] authority failed: ${message}`);
    process.exit(1);
  };

  // ---- D1-C durable persistence selection (explicit, never silent fallback) ----
  // File mode preserves historical behavior bit-for-bit. Postgres mode
  // requires DATABASE_URL + AUTHORITY_TOKEN env and fails boot visibly when
  // the database is unavailable (never falls back to ephemeral files, never
  // boots an empty world on outage). The lock file below is intentionally
  // NOT migrated (ephemeral single-instance guard, not durable data).
  const persistenceEnv = {
    ...process.env,
    ...(opts?.persistenceBackend !== undefined ? { PERSISTENCE_BACKEND: opts.persistenceBackend } : {}),
    ...(opts?.databaseUrl !== undefined ? { DATABASE_URL: opts.databaseUrl } : {}),
  };
  const persistenceResolved = resolvePersistenceConfig(persistenceEnv);
  if (!persistenceResolved.ok) {
    fail(`persistence-misconfigured:${persistenceResolved.reason}`);
  }
  const persistenceBackend = persistenceResolved.ok && persistenceResolved.config.backend === "postgres" ? "postgres" : "file";
  const isPostgres = persistenceBackend === "postgres";
  // Postgres pool handle (real pg Pool or injected test client). File mode
  // never touches the driver.
  let pgPool: { query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>; end?: () => Promise<void> } | null = null;
  let dbWorld: DbWorldStore | null = null;
  let dbMeta: DbMetadataStore | null = null;

  // ---- D1-D single-port listener + CORS + transport topology ----
  // Render exposes ONE public HTTP port. Local dev keeps two processes
  // (authority :3004 + state transport :3003, both loopback). The Render
  // topology mounts the state transport INSIDE this listener (embedded) so
  // dashboard control, OAuth, snapshots, and SSE share one port with no
  // second service and no reverse proxy. Production requires embedded
  // explicitly (fail-closed config, never a silent split topology).
  const nodeEnv = typeof process.env.NODE_ENV === "string" ? process.env.NODE_ENV : "";
  const isProdEnv = nodeEnv === "production";
  const stateTransportMode =
    opts?.stateTransport ?? (typeof process.env.STATE_TRANSPORT === "string" && process.env.STATE_TRANSPORT !== "" ? process.env.STATE_TRANSPORT : "external");
  if (stateTransportMode !== "external" && stateTransportMode !== "embedded") {
    fail("transport-misconfigured:STATE_TRANSPORT must be external|embedded");
  }
  if (isProdEnv && stateTransportMode !== "embedded") {
    fail("transport-misconfigured:production requires STATE_TRANSPORT=embedded (single public listener)");
  }
  const isEmbeddedTransport = stateTransportMode === "embedded";
  const corsEnv =
    opts?.corsOrigins !== undefined
      ? { ...process.env, CORS_ORIGINS: opts.corsOrigins.join(",") }
      : process.env;
  const corsResolved = resolveCorsConfig(corsEnv);
  if (!corsResolved.ok) {
    fail(`cors-misconfigured:${corsResolved.reason}`);
  }
  const corsOrigins = corsResolved.ok ? corsResolved.origins : [];
  const argvPort = process.argv[2] !== undefined ? Number(process.argv[2]) : undefined;
  const listener = resolveListenerConfig({
    defaultPort: 3004,
    env: process.env,
    argvPort: opts?.port ?? argvPort,
    overrides: opts?.host !== undefined ? { host: opts.host } : undefined,
  });
  if (!listener.ok) {
    fail(`listener-misconfigured:${listener.reason}`);
  }
  const { host: listenHost, port } = listener.ok ? listener : { host: "127.0.0.1", port: 3004 };

  // Mutable: operator rotation replaces the value at runtime. File mode: the
  // file stays the source of truth (state server re-resolves per request).
  // Postgres mode: the AUTHORITY_TOKEN env (Render secret) is the source of
  // truth — generating an ephemeral file token on an ephemeral filesystem
  // would silently lock the operator out on every restart, so absence fails
  // boot instead (deployment blocker, never plaintext in the database).
  let authorityToken: string;
  let tokenGenerated = false;
  if (isPostgres) {
    const tok = requireAuthorityTokenEnv(process.env);
    if (!tok.ok) {
      fail("authority-token-required:set AUTHORITY_TOKEN as a Render secret (shared by authority + state server); refusing to generate an ephemeral bearer on ephemeral storage");
    }
    authorityToken = (tok as { ok: true; token: string }).token;
    const cfg = (persistenceResolved as { ok: true; config: { backend: string; databaseUrl: string } }).config;
    if (opts?.db) {
      pgPool = opts.db;
    } else {
      const created = await createPgPool(cfg as never);
      if (!created.ok) {
        fail(`database-unavailable:${created.reason} (${redactDatabaseUrl(cfg.databaseUrl)})`);
      }
      pgPool = (created as unknown as { ok: true; pool: typeof pgPool }).pool;
    }
    const conn = await checkConnectivity(pgPool as never);
    if (!conn.ok) {
      fail(`database-unavailable:${conn.detail ?? conn.reason} (${redactDatabaseUrl(cfg.databaseUrl)})`);
    }
    const migrated = await ensureMigrated(pgPool as never);
    if (!migrated.ok) {
      fail(`persistence-misconfigured:${migrated.reason}${migrated.reason === "migration-version-mismatch" ? `:db-v${(migrated as { version?: number }).version}` : ""}`);
    }
    dbWorld = new DbWorldStore({ db: pgPool as never, normalizeWorld, serialize });
    dbMeta = new DbMetadataStore({ db: pgPool as never });
  } else {
    ({ token: authorityToken, generated: tokenGenerated } = await resolveAuthorityToken(dataDir));
  }
  const netFetch: typeof fetch = opts?.fetchImpl ?? fetch;

  // ---- D1-D embedded state transport (single-port mode only) ----
  // The same module as the standalone state server (identical seq, replay,
  // recovery, read-only semantics). External mode keeps the historical
  // stateUrl POST path untouched. Embedded mode publishes in-process via
  // publishLocal (no HTTP hop, no second listener); the HTTP publish route
  // below stays bearer-gated for compatibility. isAuthorized reads the live
  // `authorityToken` variable so file-mode rotation takes effect immediately.
  const embeddedTransport = isEmbeddedTransport
    ? createStateTransport({ isAuthorized: (req) => tokensEqual(bearerToken(req as never), authorityToken) })
    : null;

  // ---- T4F-C2.7-C server-owned YouTube OAuth (Web Server flow) ----
  // Optional and additive: when fully configured, the authority owns OAuth
  // initiation, callback, encrypted persistence, and an embedded adapter.
  // When absent/misconfigured, every legacy sidecar path below behaves
  // exactly as before (local-dev loopback preserved).
  const oauthInput = opts?.oauth ?? {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
    encryptionKey: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY,
    dashboardUrl: process.env.DASHBOARD_URL,
  };
  const oauthLoaded = loadOAuthConfig(oauthInput);
  const oauthCfg: OAuthConfig | null = oauthLoaded.ok ? oauthLoaded.config : null;
  const oauthEnabled = oauthCfg !== null;
  // File and postgres stores share the same method surface (create/consume,
  // load/save/clear); the union below is structural — file mode is untouched.
  let oauthState: OAuthStateStore | PgOAuthStateStore | null = null;
  let oauthRepo: CredentialRepository | DbCredentialRepository | null = null;
  let oauthPendingRepo: CredentialRepository | DbCredentialRepository | null = null;
  let oauthLast: { at: string | null; error: string | null } = { at: null, error: null };
  const OAUTH_PENDING_META = "youtube-pending-channel.json";
  let oauthActive = false;
  if (oauthEnabled && oauthCfg) {
    let keyOk = false;
    try {
      decodeEncryptionKey(oauthCfg.encryptionKey);
      keyOk = true;
    } catch {
      keyOk = false;
    }
    if (keyOk) {
      if (isPostgres && pgPool) {
        // Postgres mode: encrypted envelopes in authority_credentials,
        // hash-only nonces in oauth_state. No file fallback — outage fails
        // boot (operator retries Connect after recovery).
        const dbState = new PgOAuthStateStore({ db: pgPool as never });
        const inited = await dbState.init();
        if (!inited.ok) {
          fail(`database-unavailable:oauth-state (${inited.reason})`);
        }
        oauthState = dbState;
        oauthRepo = new DbCredentialRepository({ db: pgPool as never, id: "youtube-credentials", key: oauthCfg.encryptionKey });
        oauthPendingRepo = new DbCredentialRepository({ db: pgPool as never, id: "youtube-pending-grant", key: oauthCfg.encryptionKey });
      } else {
        oauthState = new OAuthStateStore({ path: join(dataDir, "youtube-oauth-state.json") });
        await oauthState.init();
        oauthRepo = new CredentialRepository({ path: join(dataDir, "youtube-credentials.enc.json"), key: oauthCfg.encryptionKey });
        oauthPendingRepo = new CredentialRepository({ path: join(dataDir, "youtube-pending-grant.enc.json"), key: oauthCfg.encryptionKey });
      }
      oauthActive = true;
    } else {
      console.log("[tidebound] youtube oauth disabled: encryption key unusable");
    }
  }

  // (lifecycle/fail defined above in the D1-C persistence selection block)

  // ---- single-authority lock (no silent second authority) ----
  const lockPath = join(dataDir, LOCK_FILE);
  let lockOwned = false;
  try {
    const raw = await readFile(lockPath, "utf8");
    const lock = JSON.parse(raw) as { pid?: unknown };
    if (typeof lock.pid === "number" && pidAlive(lock.pid)) {
      fail(`authority already running (pid ${lock.pid})`);
    }
    console.log("[tidebound] stale authority lock found (dead pid) — taking over");
  } catch (e) {
    if ((e as Error).message.startsWith("authority already running")) throw e;
    /* no lock -> proceed */
  }
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
  lockOwned = true;

  // ---- engine + session (exactly one; hook wired at construction) ----
  // persistFrom covers both backends: file mode ("file"/"file-error") and
  // postgres mode ("postgres"/"db-error"). The dashboard maps both error
  // values to a degraded display (additive; file behavior unchanged).
  const store = { persistFrom: "none" as "file" | "local" | "none" | "file-error" | "postgres" | "db-error" };
  const feed = new FeedAggregator();
  const viewerFeed = new ViewerFeedStore();
  const banners = new BannerQueue();
  let session: StreamSession;
  const engine = new GameEngine({
      onResult: (r) => {
        feed.push(r);
        viewerFeed.push(r, { world: engine.world, vote: voteFeedCtx(session) });
        banners.pushResult(r, engine.world);
        // Single wiring point for collective story advancement (mirrors
        // the former app-shell wiring): meters → assembly reaction →
        // ambient thresholds, at most one vote firing on close.
        const h = handleProcessedResult(engine, session, r, TIDEBOUND_LIBRARY);
        const wasOpen = session.activeVote !== null && !session.activeVote.closed;
        session = h.session;
        if (wasOpen && session.activeVote !== null && session.activeVote.closed) {
          void announceVoteClose();
        }
        scheduleAutosave();
      },
    },
  );
  const game = engine;

  function voteFeedCtx(session: StreamSession) {
    const v = session.activeVote;
    if (!v) return null;
    const m = voteModel(session, engine.world, TIDEBOUND_LIBRARY);
    return {
      phase: m.phase,
      totalBallots: m.totalBallots,
      ballots: { ...v.ballots },
      options: m.options.map((o) => ({ label: o.label, command: o.command })),
    };
  }

  // Restore persisted world BEFORE first snapshot (validated; explicit).
  // File mode keeps its historical behavior (corrupt save -> explicit fresh
  // genesis with "corrupt-save-fresh"). Postgres mode is stricter by design:
  // genuinely absent state ("no-save") boots fresh genesis, but "corrupt" or
  // "unavailable" FAIL boot — auto-wiping a production world or mistaking an
  // outage for an empty world would be data loss (see storage.mjs policy).
  lifecycle = "recovering";
  let restoredWorld: ReturnType<typeof normalizeWorld> = null;
  let savePresent = false;
  if (isPostgres && dbWorld) {
    const loaded = await dbWorld.load();
    if (loaded.status === "ok") {
      restoredWorld = loaded.world;
      savePresent = true;
    } else if (loaded.status === "no-save") {
      restoredWorld = null;
      savePresent = false;
    } else if (loaded.status === "corrupt") {
      fail(`world-corrupt: stored postgres world failed validation (operator must restore/repair; refusing silent genesis): ${loaded.error}`);
    } else {
      fail(`database-unavailable: world load failed (${loaded.error}); refusing to boot an empty world on outage`);
    }
  } else {
    try {
      const raw = await readFile(join(dataDir, SAVE_FILE), "utf8");
      savePresent = true;
      restoredWorld = normalizeWorld(JSON.parse(raw));
    } catch {
      restoredWorld = null;
    }
  }
  if (restoredWorld) {
    engine.loadWorld(restoredWorld);
    engine.storyLog.unshift(isPostgres ? "World restored (postgres). Tidebound remembers." : "World restored (file). Tidebound remembers.");
    recoveredFrom = isPostgres ? "postgres" : "file";
    store.persistFrom = isPostgres ? "postgres" : "file";
  } else {
    engine.loadWorld(tideboundGenesis());
    recoveredFrom = savePresent ? "corrupt-save-fresh" : isPostgres ? "postgres-fresh" : "fresh-genesis";
    if (savePresent) console.log("[tidebound] saved world invalid — booting explicit fresh genesis");
  }

  {
    const opened = openStreamAndFire(engine.world, TIDEBOUND_LIBRARY);
    if (opened.ok) {
      engine.world = opened.world;
      for (const d of opened.newDeeds) engine.pushStory(d);
      session = opened.session;
    } else {
      engine.loadWorld(tideboundGenesis());
      recoveredFrom = "fresh-genesis";
      const retry = openStreamAndFire(engine.world, TIDEBOUND_LIBRARY);
      if (retry.ok) {
        engine.world = retry.world;
        for (const d of retry.newDeeds) engine.pushStory(d);
        session = retry.session;
      } else {
        fail("could not open stream session");
      }
    }
  }

  let paused = false;
  let source: "simulation" | "youtube" = "simulation";
  const announce: Record<string, AnnounceState> = {};
  const diag = { received: 0, queued: 0, duplicate: 0, rejected: 0 };
  let ytStatus: { status: string; error?: string | null; [k: string]: unknown } = { status: "off" };
  let worldRev = 0;
  let lastSig: string | null = null;
  let lastSeq: number | null = null;
  let lastPublishAtIso: string | null = null;
  let publishes = 0;

  // ---- timer registry (every timer tracked; stop() drains all) ----
  const timers = new Set<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>>();
  function every(ms: number, fn: () => void): ReturnType<typeof setInterval> {
    const t = setInterval(fn, ms);
    timers.add(t);
    return t;
  }
  function after(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  }
  function clearTimer(t: unknown): void {
    clearInterval(t as ReturnType<typeof setInterval>);
    clearTimeout(t as ReturnType<typeof setTimeout>);
    timers.delete(t as ReturnType<typeof setInterval>);
  }

  // ---- persistence (file or postgres; degraded mode never silent) ----
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleAutosave(): void {
    if (saveTimer) return;
    saveTimer = after(2000, () => {
      saveTimer = null;
      void persistWorld();
    });
  }
  async function persistWorld(): Promise<"file" | "file-error" | "postgres" | "db-error"> {
    if (isPostgres && dbWorld) {
      // Degraded-continue policy (storage.mjs): a failed save keeps serving
      // the last committed row, marks persistFrom "db-error" + lastError,
      // and retries on the next mutation/shutdown. Never silent.
      const out = await dbWorld.save(engine.world);
      if (out.ok) {
        store.persistFrom = "postgres";
        return "postgres";
      }
      store.persistFrom = "db-error";
      lastError = `persist-failed: ${out.reason}${out.detail ? `:${out.detail}` : ""}`;
      return "db-error";
    }
    try {
      await writeFile(join(dataDir, SAVE_FILE), serialize(engine.world), "utf8");
      store.persistFrom = "file";
      return "file";
    } catch (e) {
      store.persistFrom = "file-error";
      lastError = `persist-failed: ${String((e as Error)?.message ?? e)}`;
      return "file-error";
    }
  }

  // ---- snapshot publication (authenticated, change-gated) ----
  function candidate(rev: number): SnapshotV1 {
    const led = ledgerStatus(engine.world.paidLedger);
    return buildSnapshot({
      world: engine.world,
      session,
      storyLog: engine.storyLog,
      feed: feed.list(),
      recent: engine.recentResults,
      viewerFeed: viewerFeed.list(),
      banner: banners.current(),
      paused,
      vote: voteModel(session, engine.world, TIDEBOUND_LIBRARY),
      paid: { applied: led.applied, compensated: led.compensated, noted: led.noted, total: led.total },
      worldRev: rev,
      atIso: new Date().toISOString(),
    });
  }

  async function postSnapshot(snap: SnapshotV1): Promise<{ ok: true; seq: number } | { ok: false; reason: string }> {
    // Single-port mode: in-process publish (same validation/seq/buffer as
    // the standalone server — one writer, no HTTP hop, no second listener).
    if (isEmbeddedTransport && embeddedTransport) {
      try {
        const out = embeddedTransport.publishLocal(snap);
        if (out.ok) return { ok: true, seq: out.seq };
        return { ok: false, reason: out.reason };
      } catch {
        return { ok: false, reason: "state-transport-unavailable" };
      }
    }
    try {
      const res = await fetch(`${stateUrl}/api/state/publish`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${authorityToken}` },
        body: JSON.stringify({ protocol: TRANSPORT_PROTOCOL, snapshot: snap }),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { seq?: unknown } | null;
        return { ok: true, seq: typeof data?.seq === "number" ? data.seq : -1 };
      }
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      return { ok: false, reason: typeof data?.error === "string" ? data.error : `http-${res.status}` };
    } catch {
      return { ok: false, reason: "state-server-unreachable" };
    }
  }

  async function fetchServerRev(): Promise<number | null> {
    // Single-port mode: single writer, so stale-revision cannot occur and no
    // revision bump is ever needed (publishOnce treats it as such).
    if (isEmbeddedTransport && embeddedTransport) return null;
    try {
      const res = await fetch(`${stateUrl}/api/state/snapshot`, { headers: { accept: "application/json" } });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as { snapshot?: { worldRev?: unknown } } | null;
      return typeof data?.snapshot?.worldRev === "number" ? data.snapshot.worldRev : null;
    } catch {
      return null;
    }
  }

  let publishing = false;
  async function publishOnce(): Promise<void> {
    if (publishing || lifecycle === "stopped" || lifecycle === "failed") return;
    publishing = true;
    try {
      const next = candidate(worldRev + 1);
      const sig = revisionSignature(next);
      if (!shouldBumpRevision(lastSig, sig) && worldRev > 0) return;
      worldRev += 1;
      const snap = worldRev === next.worldRev ? next : candidate(worldRev);
      let res = await postSnapshot(snap);
      if (!res.ok && res.reason === "stale-revision") {
        const serverRev = await fetchServerRev();
        if (serverRev !== null && serverRev >= worldRev) worldRev = serverRev + 1;
        res = await postSnapshot(candidate(worldRev));
      }
      if (res.ok) {
        lastSig = revisionSignature(snap);
        publishes += 1;
        lastSeq = res.seq;
        lastPublishAtIso = snap.atIso;
      } else {
        lastError = `publish-${res.reason}`;
      }
    } finally {
      publishing = false;
    }
  }

  // ---- outbound announcements (T3 orchestration, server-side) ----
  async function ytSend(text: string, eventId: string): Promise<{ ok: true; duplicate?: boolean } | { ok: false; reason: string }> {
    if (text.length > 4096) return { ok: false, reason: "too-long" };
    // Cloud OAuth mode: the embedded adapter sends directly (same typed
    // results as the sidecar path below; no tokens leave the process).
    if (oauthActive && embeddedYt) {
      try {
        const out = await embeddedYt.sendChatMessage({ text, eventId });
        if (out.ok) return { ok: true, duplicate: !!out.duplicate };
        return { ok: false, reason: out.error };
      } catch {
        return { ok: false, reason: "api-error" };
      }
    }
    try {
      const res = await fetch(`${ytUrl}/api/youtube/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, eventId }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; duplicate?: boolean } | null;
      if (res.ok && data?.ok) return { ok: true, duplicate: !!data.duplicate };
      return { ok: false, reason: typeof data?.error === "string" && data.error ? data.error : "api-error" };
    } catch {
      return { ok: false, reason: "sidecar-unreachable" };
    }
  }

  function applySendResult(eventId: string, kind: "open" | "close", res: { ok: true } | { ok: false; reason: string }): void {
    const cur = announce[eventId] ?? { kind, status: "failed" as const, attempts: 0 };
    if (res.ok) {
      announce[eventId] = { ...cur, kind, status: "sent", reason: undefined };
    } else {
      const status: AnnounceStatus =
        res.reason === "uncertain" ? "uncertain"
        : res.reason === "insufficient-scope" ? "reauth-required"
        : res.reason === "no-live-chat" || res.reason === "auth-required" || res.reason === "sidecar-unreachable" ? "not-connected"
        : "failed";
      announce[eventId] = { ...cur, kind, status, reason: res.reason };
    }
  }

  async function postAnnouncement(eventId: string, kind: "open" | "close", text: string): Promise<void> {
    const existing = announce[eventId];
    announce[eventId] = { kind, status: "sending", text, attempts: (existing?.attempts ?? 0) + 1 };
    const res = await ytSend(text, eventId);
    applySendResult(eventId, kind, res);
  }

  function voteSnapshotForAnnounce() {
    const v = voteModel(session, engine.world, TIDEBOUND_LIBRARY);
    if (v.phase === "none" || !v.id) return null;
    return { vote: v, sessionId: session.sessionId };
  }

  async function announceVoteOpen(): Promise<void> {
    const snap = voteSnapshotForAnnounce();
    if (!snap) return;
    const eventId = openEventId(snap.sessionId, snap.vote.id);
    delete announce[closeEventId(snap.sessionId, snap.vote.id)];
    const composed = composeVoteOpen({
      prompt: snap.vote.prompt,
      options: snap.vote.options.map((o) => ({ label: o.label, command: o.command })),
      maxCommands: snap.vote.maxCommands,
    });
    if (!composed.ok) {
      announce[eventId] = { kind: "open", status: "failed", reason: `composition-${composed.reason}`, attempts: 0 };
      return;
    }
    if (source !== "youtube") {
      announce[eventId] = { kind: "open", status: "na-simulation", text: composed.text, attempts: 0 };
      return;
    }
    if (composed.text.length > ANNOUNCE_MAX_CHARS) {
      announce[eventId] = { kind: "open", status: "failed", reason: "composition-too-long", attempts: 0 };
      return;
    }
    await postAnnouncement(eventId, "open", composed.text);
  }

  async function announceVoteClose(): Promise<void> {
    const snap = voteSnapshotForAnnounce();
    if (!snap || snap.vote.phase !== "closed") return;
    const eventId = closeEventId(snap.sessionId, snap.vote.id);
    const existing = announce[eventId];
    if (existing && (existing.status === "sent" || existing.status === "sending")) return;
    const composed = composeVoteResult({
      prompt: snap.vote.prompt,
      totalBallots: snap.vote.totalBallots,
      winnerLabel: snap.vote.winnerLabel,
      winnerReason: snap.vote.winnerReason,
    });
    if (!composed.ok) {
      announce[eventId] = { kind: "close", status: "failed", reason: `composition-${composed.reason}`, attempts: existing?.attempts ?? 0 };
      return;
    }
    if (source !== "youtube") {
      announce[eventId] = { kind: "close", status: "na-simulation", text: composed.text, attempts: existing?.attempts ?? 0 };
      return;
    }
    await postAnnouncement(eventId, "close", composed.text);
  }

  async function retryAnnounce(eventId: string): Promise<{ ok: boolean }> {
    const existing = announce[eventId];
    if (!existing || !existing.text) return { ok: false };
    if (existing.status === "sent" || existing.status === "sending") return { ok: false };
    if (source !== "youtube") {
      announce[eventId] = { ...existing, status: "na-simulation" };
      return { ok: true };
    }
    await postAnnouncement(eventId, existing.kind, existing.text);
    return { ok: true };
  }

  function resetViewerPresentation(): void {
    viewerFeed.clear();
    banners.clear();
  }

  // ---- simulation step (single pump/tick loop; held unless running) ----
  function step(): void {
    if (lifecycle !== "running") return;
    if (paused) return;
    const results = engine.pump();
    const ticked = engine.tick();
    if (results.length > 0 || ticked.length > 0) scheduleAutosave();
  }

  // (Single wiring point — no other result path exists.)

  // ---- T4F-C2.7-C embedded YouTube adapter (cloud OAuth mode only) ----
  // When OAuth is configured, the authority owns the adapter directly
  // (encrypted repository credentials, in-process poll loop). Otherwise the
  // legacy sidecar-SSE path below is used untouched. Exactly one ingestion
  // path is ever active: source switches stop the other first.
  let embeddedYt: YouTubeAdapter | null = null;
  function ensureEmbedded(): YouTubeAdapter | null {
    if (!oauthActive || !oauthCfg || !oauthRepo) return null;
    if (!embeddedYt) {
      const cfg = oauthCfg;
      const repo = oauthRepo;
      embeddedYt = new YouTubeAdapter({
        fetchImpl: netFetch,
        onEvents: (events) => {
          for (const ev of events) ingestSidecarEvent(ev, String((ev as { eventId?: unknown }).eventId ?? ""));
        },
        onStatus: () => {},
        client: { clientId: cfg.clientId, clientSecret: cfg.clientSecret },
        redirectUri: cfg.redirectUri,
        // Postgres mode disables the file cursor (ephemeral filesystem);
        // the resume pointer lives in authority_metadata instead (patched
        // below). File mode keeps the historical file path untouched.
        cursorPath: isPostgres ? null : join(dataDir, "youtube-adapter-cursor.json"),
        persistTokens: async (t) => {
          // Refresh persistence merges into the stored grant: tokens rotate,
          // while scopes/channel/obtainedAt are preserved server-side.
          // A database outage here never deletes the previous grant: the
          // adapter keeps serving it and the next refresh retries.
          let prev: Record<string, unknown> | null = null;
          try {
            prev = (await repo.load()) as Record<string, unknown> | null;
          } catch {
            prev = null;
          }
          const at = typeof t.access_token === "string" ? t.access_token : "";
          if (!at) return;
          try {
            await repo.save({
              access_token: at,
              refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : ((prev?.refresh_token as string | null | undefined) ?? null),
              expires_at: typeof t.expires_at === "number" ? t.expires_at : Date.now(),
              scopes: Array.isArray(prev?.scopes) ? (prev.scopes as string[]) : [...OAUTH_SCOPES],
              channel: (prev?.channel as ChannelIdentity | null | undefined) ?? null,
              obtainedAt: typeof prev?.obtainedAt === "number" ? (prev.obtainedAt as number) : Date.now(),
              updatedAt: Date.now(),
            });
          } catch {
            // Outage during refresh persistence: keep the previous grant
            // (fail closed, retry later). Never delete on write failure.
            oauthLast = { at: oauthLast.at, error: "credential-persist-unavailable" };
          }
        },
      });
      if (isPostgres && dbMeta) {
        // Postgres mode: mirror the adapter's best-effort cursor into the
        // allowlisted metadata row (same resume semantics, durable). A
        // cursor write failure must never block polling (dedup degrades to
        // engine-level dedup; bounded re-forward is safe).
        const meta = dbMeta;
        const adapter = embeddedYt;
        adapter.saveCursor = async () => {
          try {
            const c = (adapter as unknown as { cursor?: { liveChatId?: unknown; platformId?: unknown; publishedAt?: unknown } | null }).cursor;
            if (c && typeof c.liveChatId === "string" && typeof c.platformId === "string") {
              await meta.set("youtube-adapter-cursor", {
                liveChatId: c.liveChatId,
                platformId: c.platformId,
                publishedAt: typeof c.publishedAt === "string" ? c.publishedAt : new Date().toISOString(),
              });
            }
          } catch {
            /* cursor is best-effort; polling must not die */
          }
        };
      }
    }
    return embeddedYt;
  }
  async function resumeEmbedded(): Promise<void> {
    const adapter = ensureEmbedded();
    if (!adapter || !oauthRepo) return;
    // Postgres mode: restore the durable adapter cursor before applying
    // credentials (same resume semantics as the file cursor it replaces).
    if (isPostgres && dbMeta) {
      try {
        const saved = await dbMeta.get("youtube-adapter-cursor");
        if (saved && typeof saved.liveChatId === "string" && typeof saved.platformId === "string") {
          (adapter as unknown as { cursor?: unknown }).cursor = {
            liveChatId: saved.liveChatId,
            platformId: saved.platformId,
            publishedAt: typeof saved.publishedAt === "string" ? saved.publishedAt : new Date().toISOString(),
          };
        }
      } catch {
        /* corrupt/outage cursor: start without resume (engine dedups) */
      }
    }
    try {
      const creds = await oauthRepo.load();
      adapter.applyCredentials(creds as { access_token?: string; refresh_token?: string | null; expires_at?: number } | null);
      if (creds && typeof creds === "object") {
        const updatedAt = (creds as { updatedAt?: unknown }).updatedAt;
        if (typeof updatedAt === "number") oauthLast = { at: new Date(updatedAt).toISOString(), error: null };
      }
    } catch {
      // Corrupt/wrong-key file — or postgres outage/unreadable envelope:
      // fail closed to AUTH_REQUIRED, never crash boot, never delete.
      adapter.applyCredentials(null);
      oauthLast = { at: oauthLast.at, error: "credential-store-unreadable" };
    }
  }
  /** Non-secret summary of the stored grant for retention/mismatch decisions. */
  async function oauthCurrentSummary(): Promise<{ refresh_token?: string | null; obtainedAt?: number; channel?: { id?: string } | null } | null> {
    if (!oauthRepo) return null;
    try {
      const c = (await oauthRepo.load()) as null | {
        refresh_token?: string | null;
        obtainedAt?: number;
        channel?: { id?: string } | null;
      };
      if (!c) return null;
      return {
        refresh_token: typeof c.refresh_token === "string" ? c.refresh_token : null,
        obtainedAt: typeof c.obtainedAt === "number" ? c.obtainedAt : undefined,
        channel: c.channel && typeof c.channel === "object" ? { id: typeof c.channel.id === "string" ? c.channel.id : undefined } : null,
      };
    } catch {
      return null;
    }
  }
  async function readPendingMeta(): Promise<{ newChannel: ChannelIdentity; previousChannelId: string; at: string } | null> {
    if (isPostgres && dbMeta) {
      try {
        const v = await dbMeta.get("youtube-pending-channel");
        if (v && typeof v.previousChannelId === "string" && v.newChannel && typeof v.newChannel === "object") {
          return { newChannel: v.newChannel as ChannelIdentity, previousChannelId: v.previousChannelId, at: typeof v.at === "string" ? v.at : "" };
        }
      } catch {
        /* corrupt/outage: fail closed (no pending switch claimed) */
      }
      return null;
    }
    try {
      const raw = await readFile(join(dataDir, OAUTH_PENDING_META), "utf8");
      const p = JSON.parse(raw) as { newChannel?: unknown; previousChannelId?: unknown; at?: unknown };
      if (p && typeof p.previousChannelId === "string" && p.newChannel && typeof p.newChannel === "object") {
        return { newChannel: p.newChannel as ChannelIdentity, previousChannelId: p.previousChannelId, at: typeof p.at === "string" ? p.at : "" };
      }
    } catch {
      /* no pending switch */
    }
    return null;
  }
  async function clearPending(): Promise<void> {
    if (oauthPendingRepo) {
      try {
        await oauthPendingRepo.clear();
      } catch {
        /* best-effort */
      }
    }
    if (isPostgres && dbMeta) {
      try {
        await dbMeta.delete("youtube-pending-channel");
      } catch {
        /* already absent / outage best-effort */
      }
      return;
    }
    try {
      await unlink(join(dataDir, OAUTH_PENDING_META));
    } catch {
      /* already absent */
    }
  }
  async function oauthStatusPayload(): Promise<Record<string, unknown>> {
    const pending = await readPendingMeta();
    let connected = false;
    let channel: ChannelIdentity | null = null;
    let lastAuthAt: string | null = oauthLast.at;
    if (oauthRepo) {
      try {
        const c = (await oauthRepo.load()) as null | { channel?: ChannelIdentity | null; updatedAt?: unknown };
        if (c) {
          connected = true;
          channel = c.channel && typeof c.channel === "object" ? (c.channel as ChannelIdentity) : null;
          if (typeof c.updatedAt === "number") lastAuthAt = new Date(c.updatedAt).toISOString();
        }
      } catch {
        connected = false;
      }
    }
    const adapterState = embeddedYt ? embeddedYt.getState() : null;
    return {
      configured: oauthActive,
      connected,
      outbound: adapterState && typeof adapterState.outbound === "string" ? adapterState.outbound : "unknown",
      ytStatus: adapterState && typeof adapterState.status === "string" ? adapterState.status : null,
      authenticated: adapterState ? !!adapterState.authenticated : connected,
      channel,
      pendingChannel: pending,
      lastAuthAt,
      lastError: oauthLast.error,
    };
  }
  async function embeddedConnect(): Promise<void> {
    const adapter = ensureEmbedded();
    if (!adapter) return;
    stopIngestion();
    try {
      await adapter.connect();
    } catch {
      /* adapter records its own status; polling continues via its loop */
    }
    await refreshYtStatus();
  }
  function embeddedDisconnect(): void {
    // Stop polling only. The encrypted grant is preserved (never deleted
    // on disconnect; there is no forget/revoke endpoint in this milestone).
    embeddedYt?.disconnect();
  }

  // ---- YouTube ingestion (single sidecar SSE subscription) ----
  let ytReader: { abort: () => void } | null = null;
  let ytStatusTimer: ReturnType<typeof setInterval> | null = null;
  let ytCursor: string | null = null;
  if (isPostgres && dbMeta) {
    // Durable resume pointer (same dedup semantics as the file cursor).
    // Outage/corrupt at boot: start without resume (engine dedups).
    try {
      const saved = await dbMeta.get("authority-cursor");
      if (saved && typeof saved.lastYtEventId === "string") ytCursor = saved.lastYtEventId;
    } catch {
      /* no cursor yet */
    }
  } else {
    try {
      const raw = await readFile(join(dataDir, CURSOR_FILE), "utf8");
      const parsed = JSON.parse(raw) as { lastYtEventId?: unknown };
      if (typeof parsed.lastYtEventId === "string") ytCursor = parsed.lastYtEventId;
    } catch {
      /* no cursor yet */
    }
  }
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleCursorSave(): void {
    if (cursorTimer) return;
    cursorTimer = after(2000, () => {
      cursorTimer = null;
      if (isPostgres && dbMeta) {
        // Best-effort only: cursor loss degrades to engine dedup (safe).
        void dbMeta.set("authority-cursor", { lastYtEventId: ytCursor }).catch(() => undefined);
        return;
      }
      void writeFile(join(dataDir, CURSOR_FILE), JSON.stringify({ lastYtEventId: ytCursor }), "utf8").catch(() => undefined);
    });
  }

  async function refreshYtStatus(): Promise<void> {
    // Cloud OAuth mode: status comes from the embedded adapter (same state
    // shape as the sidecar status below; no credentials included).
    if (oauthActive && embeddedYt) {
      const s = embeddedYt.getState() as unknown as typeof ytStatus;
      ytStatus = s && typeof s.status === "string" ? s : { status: "DISCONNECTED", error: "bad-status" };
      return;
    }
    try {
      const res = await fetch(`${ytUrl}/api/youtube/status`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`status:${res.status}`);
      const s = (await res.json()) as typeof ytStatus;
      ytStatus = s && typeof s.status === "string" ? s : { status: "DISCONNECTED", error: "bad-status" };
    } catch {
      ytStatus = { status: "DISCONNECTED", error: "sidecar-unreachable" };
    }
  }

  function ingestSidecarEvent(ev: unknown, sseId: string): void {
    if (!isCanonicalEv(ev)) {
      diag.rejected += 1;
      return;
    }
    if (ev.kind === "chat_command" && !(ev.command in COMMANDS)) {
      diag.rejected += 1;
      return;
    }
    if (ev.kind === "chat_command") {
      const idx = voteOptionIndex(ev.command);
      if (idx !== null) {
        const casted = castSessionVote(session, ev.actorId, idx);
        if (casted.ok) session = casted.session;
      }
    }
    diag.received += 1;
    const outcome = game.ingest(ev);
    if (outcome === "queued") diag.queued += 1;
    else if (outcome === "duplicate") diag.duplicate += 1;
    else diag.rejected += 1;
    if (sseId) {
      ytCursor = sseId;
      scheduleCursorSave();
    }
  }

  async function runYtReader(signal: AbortSignal, resumeFrom: string | null): Promise<void> {
    const url = resumeFrom ? `${ytUrl}/api/youtube/stream?lastId=${encodeURIComponent(resumeFrom)}` : `${ytUrl}/api/youtube/stream`;
    const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal });
    if (!res.ok || !res.body) throw new Error(`stream:${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let id = "";
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
          if (line.startsWith("id:")) id = line.slice(3).trim();
          else if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (data && (name === "canonical" || name === "message")) {
          try {
            ingestSidecarEvent(JSON.parse(data), id);
          } catch {
            diag.rejected += 1;
          }
        }
        name = "message";
      }
    }
  }

  let ytReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let ytAttempt = 0;
  function startIngestion(): void {
    if (ytReader) return; // single subscription — never duplicated
    const ctl = new AbortController();
    ytReader = { abort: () => ctl.abort() };
    ytAttempt = 0;
    void refreshYtStatus();
    if (ytStatusTimer) clearTimer(ytStatusTimer);
    ytStatusTimer = every(ytStatusMs, () => void refreshYtStatus());
    const loop = async (): Promise<void> => {
      if (!ytReader) return;
      try {
        await runYtReader(ctl.signal, ytCursor);
      } catch {
        /* interrupted or sidecar down — backoff below */
      }
      if (!ytReader) return;
      const delay = Math.min(15000, 1000 * 2 ** Math.min(ytAttempt, 4));
      ytAttempt += 1;
      if (ytReconnectTimer) clearTimer(ytReconnectTimer);
      ytReconnectTimer = after(delay, () => void loop());
    };
    void loop();
  }

  function stopIngestion(): void {
    ytReader?.abort();
    ytReader = null;
    if (ytStatusTimer) {
      clearTimer(ytStatusTimer);
      ytStatusTimer = null;
    }
    if (ytReconnectTimer) {
      clearTimer(ytReconnectTimer);
      ytReconnectTimer = null;
    }
    ytStatus = { status: "off" };
  }

  function isYtIngesting(): boolean {
    return ytReader !== null;
  }

  // ---- control-plane (keeper-trusted, token-gated; mirrors Runtime reads) ----
  function controlPlane(): Record<string, unknown> {
    const led = ledgerStatus(game.world.paidLedger);
    const vote = voteModel(session, game.world, TIDEBOUND_LIBRARY);
    return {
      lifecycle,
      worldRev,
      seq: lastSeq,
      publishes,
      sessionId: session.sessionId,
      streamNumber: session.streamNumber,
      sessionPhase: session.phase,
      session,
      vote,
      paused,
      source,
      ingesting: isYtIngesting(),
      world: game.world,
      storyLog: game.storyLog,
      feed: feed.list(),
      recent: game.recentResults,
      queue: { size: game.queue.size, max: QUEUE.maxSize, peek: game.queue.peekAll() },
      paid: { applied: led.applied, compensated: led.compensated, noted: led.noted, total: led.total, overflow: led.overflow },
      announce: Object.fromEntries(
        Object.entries(announce).map(([k, a]) => [k, { kind: a.kind, status: a.status, reason: a.reason ?? null, attempts: a.attempts }]),
      ),
      meters: { paleChart: paleChartModel(game.world), beaconOil: beaconOilModel(game.world) },
      vexStage: vexModel(game.world).stage,
      yt: { lastStatus: ytStatus, diag: { ...diag } },
      persist: { from: store.persistFrom, backend: persistenceBackend },
      persistenceBackend,
      stateTransport: { mode: stateTransportMode, seq: embeddedTransport ? embeddedTransport.getSeq() : lastSeq },
      listener: { host: listenHost, port },
      recoveredFrom,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      timers: timers.size,
      lastError,
      lastPublishAtIso: lastPublishAtIso,
    };
  }

  function publicStatus(): Record<string, unknown> {
    return {
      lifecycle,
      worldRev,
      seq: lastSeq,
      sessionId: session.sessionId,
      streamNumber: session.streamNumber,
      paused,
      source,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      timers: timers.size,
      queueSize: game.queue.size,
      recoveredFrom,
      persistFrom: store.persistFrom,
      persistenceBackend,
      stateTransport: stateTransportMode,
      listener: { host: listenHost, port },
    };
  }

  // ---- control mutations (outcome strings match the former Runtime API) ----
  function doCommand(body: { actorId?: unknown; actorName?: unknown; command?: unknown }): { ok: boolean; outcome: string } {
    const actorId = typeof body.actorId === "string" && body.actorId ? body.actorId : "anon";
    const actorName = typeof body.actorName === "string" && body.actorName ? body.actorName : "A watcher";
    const command = typeof body.command === "string" ? body.command : "";
    const token = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!commandKeys().includes(token)) return { ok: true, outcome: "rejected-invalid" };
    if ((token === "!votea" || token === "!voteb" || token === "!votec") && session.activeVote !== null) {
      const idx = token === "!votea" ? 0 : token === "!voteb" ? 1 : 2;
      const casted = castSessionVote(session, actorId, idx);
      if (casted.ok) session = casted.session;
    }
    return { ok: true, outcome: game.ingestCommand(actorId, actorName, token, makeEventId("cmd")) };
  }

  function doPaid(body: { actorId?: unknown; actorName?: unknown; amountMinor?: unknown; currency?: unknown }): { ok: boolean; outcome: string } {
    const actorId = typeof body.actorId === "string" && body.actorId ? body.actorId : "anon";
    const actorName = typeof body.actorName === "string" && body.actorName ? body.actorName : "Someone";
    const amountMinor = typeof body.amountMinor === "number" && Number.isFinite(body.amountMinor) ? Math.round(body.amountMinor) : NaN;
    const currency = typeof body.currency === "string" ? body.currency : "INR";
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) return { ok: true, outcome: "rejected-invalid" };
    return { ok: true, outcome: game.ingestPaid(actorId, actorName, amountMinor, currency, makeEventId("paid")) };
  }

  async function doOpenVote(which: string): Promise<{ ok: boolean; outcome: string }> {
    const def = which === "kindling" ? KINDLING_VOTE : ROUTE_VOTE;
    const r = openSessionVote(session, { ...def, library: TIDEBOUND_LIBRARY });
    if (!r.ok) return { ok: true, outcome: r.reason };
    session = r.session;
    scheduleAutosave();
    await announceVoteOpen();
    return { ok: true, outcome: which === "kindling" ? "opened-kindling-vote" : "opened-route-vote" };
  }

  async function doCloseVote(): Promise<{ ok: boolean; outcome: string }> {
    const r = closeVoteAndFire(session, game.world, TIDEBOUND_LIBRARY);
    session = r.session;
    game.world = r.world;
    for (const d of r.newDeeds) game.pushStory(d);
    scheduleAutosave();
    if (!r.didClose) return { ok: true, outcome: r.reason ?? "closed-vote" };
    await announceVoteClose();
    return { ok: true, outcome: r.fired ? `closed-vote:fired:${r.fired}` : `closed-vote:${r.reason ?? "no-winner"}` };
  }

  async function doOverride(optionIndex: number): Promise<{ ok: boolean; outcome: string }> {
    const r = overrideVoteAndFire(session, game.world, TIDEBOUND_LIBRARY, optionIndex);
    if (r.winner === null) return { ok: true, outcome: r.reason ?? "override-failed" };
    game.world = r.world;
    session = r.session;
    for (const d of r.newDeeds) game.pushStory(d);
    scheduleAutosave();
    if (r.didClose) await announceVoteClose();
    return { ok: true, outcome: r.fired ? `override:${r.winner}:fired` : `override:${r.winner}:no-fire:${r.reason ?? "unknown"}` };
  }

  async function doRite(templateId: string): Promise<{ ok: boolean; outcome: string }> {
    const r = fireRite(game.world, TIDEBOUND_LIBRARY, templateId);
    if (!r.ok) return { ok: true, outcome: r.reason ?? "rite-failed" };
    game.world = r.world;
    for (const d of r.newDeeds) game.pushStory(d);
    scheduleAutosave();
    return { ok: true, outcome: `rite-fired:${r.fired}` };
  }

  async function doEndStream(): Promise<{ ok: boolean; outcome: string }> {
    const f = closeStreamAndFire(game.world, session, TIDEBOUND_LIBRARY);
    if (!f.ok) return { ok: true, outcome: f.reason };
    game.world = f.world;
    for (const d of f.newDeeds) game.pushStory(d);
    game.loadWorld(game.world);
    resetViewerPresentation();
    const opened = openStreamAndFire(game.world, TIDEBOUND_LIBRARY);
    if (!opened.ok) return { ok: true, outcome: opened.reason };
    game.world = opened.world;
    session = opened.session;
    for (const d of opened.newDeeds) game.pushStory(d);
    await persistWorld();
    return { ok: true, outcome: `stream-closed:${f.world.streamCount}` };
  }

  async function doReload(): Promise<{ ok: boolean; outcome: string }> {
    lifecycle = "recovering";
    try {
      if (isPostgres && dbWorld) {
        // Postgres reload: outage and corrupt are explicit failures (never
        // silent genesis, never empty-world-on-outage). Genuinely absent is
        // reload-no-save (same as file mode).
        const loaded = await dbWorld.load();
        if (loaded.status === "ok") {
          game.loadWorld(loaded.world);
          resetViewerPresentation();
          game.storyLog.unshift("World reloaded (postgres).");
          const opened = openStreamAndFire(game.world, TIDEBOUND_LIBRARY);
          if (opened.ok) {
            game.world = opened.world;
            session = opened.session;
            for (const d of opened.newDeeds) game.pushStory(d);
          }
          recoveredFrom = "reload-postgres";
          return { ok: true, outcome: "reloaded-postgres" };
        }
        if (loaded.status === "no-save") return { ok: true, outcome: "reload-no-save" };
        if (loaded.status === "corrupt") return { ok: true, outcome: "reload-invalid-save" };
        return { ok: true, outcome: "reload-unavailable" };
      }
      const raw = await readFile(join(dataDir, SAVE_FILE), "utf8");
      const state = normalizeWorld(JSON.parse(raw));
      if (state) {
        game.loadWorld(state);
        resetViewerPresentation();
        game.storyLog.unshift("World reloaded (file).");
        const opened = openStreamAndFire(game.world, TIDEBOUND_LIBRARY);
        if (opened.ok) {
          game.world = opened.world;
          session = opened.session;
          for (const d of opened.newDeeds) game.pushStory(d);
        }
        recoveredFrom = "reload-file";
        return { ok: true, outcome: "reloaded-file" };
      }
      return { ok: true, outcome: "reload-invalid-save" };
    } catch {
      return { ok: true, outcome: "reload-no-save" };
    } finally {
      lifecycle = paused ? "paused" : "running";
    }
  }

  async function doReset(): Promise<{ ok: boolean; outcome: string }> {
    game.loadWorld(tideboundGenesis());
    resetViewerPresentation();
    const opened = openStreamAndFire(game.world, TIDEBOUND_LIBRARY);
    if (opened.ok) {
      game.world = opened.world;
      session = opened.session;
      for (const d of opened.newDeeds) game.pushStory(d);
    }
    await persistWorld();
    return { ok: true, outcome: "reset-genesis" };
  }

  async function doRotateToken(): Promise<{ ok: boolean; outcome: string }> {
    // Postgres mode: the bearer lives in the AUTHORITY_TOKEN env (Render
    // secret shared by authority + state server) and is NEVER stored in the
    // database in plaintext. Rotating via a file write here would diverge
    // from the state server and be lost on the next ephemeral restart — so
    // rotation is an explicit operator action (update the Render secret on
    // both services and redeploy), not an API mutation. Documented as such;
    // this endpoint refuses rather than weakening the boundary.
    if (isPostgres) {
      return { ok: false, outcome: "rotate-requires-env" };
    }
    // Operator rotation / revocation / loss-recovery in one move: mint a
    // fresh credential, persist it as the file source of truth, adopt it
    // for this process. The state server re-resolves per request, so no
    // restart is needed anywhere. The response NEVER contains the value —
    // the operator reads it from data/authority-token.json (same trust as
    // the server console) and re-pastes it into the dashboard, whose old
    // token then 401s with re-paste guidance.
    const fresh = randomBytes(32).toString("hex");
    try {
      await writeFile(join(dataDir, TOKEN_FILE), JSON.stringify({ token: fresh }, null, 2), { mode: 0o600, encoding: "utf8" });
      try {
        await chmod(join(dataDir, TOKEN_FILE), 0o600);
      } catch {
        /* best-effort on filesystems without modes */
      }
    } catch {
      return { ok: false, outcome: "rotate-persist-failed" };
    }
    authorityToken = fresh;
    return { ok: true, outcome: "token-rotated" };
  }

  // ---- HTTP ----
  function sendJson(res: ServerResponse, code: number, obj: unknown): void {
    res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(obj));
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let raw = "";
      let tooLong = false;
      req.on("data", (chunk: Buffer) => {
        if (tooLong) return;
        raw += chunk.toString("utf8");
        if (Buffer.byteLength(raw, "utf8") > BODY_MAX_BYTES) {
          tooLong = true;
          reject(Object.assign(new Error("too-long"), { code: "too-long" }));
        }
      });
      req.on("end", () => (tooLong ? null : resolve(raw)));
      req.on("error", reject);
    });
  }

  function authorized(req: IncomingMessage): boolean {
    return tokensEqual(bearerToken(req), authorityToken);
  }

  // ---- D1-D health semantics (no secrets in any payload) ----
  // Liveness (/api/healthz): the process answers. Readiness (/api/readyz):
  // the authority initialized, required persistence connected/migrated, and
  // the runtime serves. Degraded persistence (db-error/file-error) stays
  // READY but is explicitly flagged (never misreported as healthy).
  function degradedPersistence(): boolean {
    return store.persistFrom === "db-error" || store.persistFrom === "file-error";
  }

  function readiness(): { code: number; body: Record<string, unknown> } {
    if (lifecycle !== "running" && lifecycle !== "paused") {
      return {
        code: 503,
        body: {
          ready: false,
          reason: lifecycle === "failed" ? (lastError ?? "failed") : "not-ready",
          lifecycle,
          persistenceBackend,
          stateTransport: stateTransportMode,
        },
      };
    }
    return {
      code: 200,
      body: {
        ready: true,
        lifecycle,
        persistence: { backend: persistenceBackend, from: store.persistFrom, degraded: degradedPersistence() },
        stateTransport: { mode: stateTransportMode, seq: embeddedTransport ? embeddedTransport.getSeq() : lastSeq },
      },
    };
  }

  const server = createServer(async (req, res) => {
    // Narrow CORS allowlist (D1-D): unknown origins are rejected here with
    // 403 (no ACAO); allowed preflights end 204 here. Requests without an
    // Origin header (curl, Render health checks) proceed header-free.
    if (applyCors(req, res, corsOrigins).handled) return;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // Liveness: process is alive (public, no secrets, no env values).
    if (url.pathname === "/api/healthz" && req.method === "GET") {
      sendJson(res, 200, { ok: true, service: "tidebound-authority" });
      return;
    }

    // Readiness: initialized + persistence ready (public, degraded explicit).
    if (url.pathname === "/api/readyz" && req.method === "GET") {
      const r = readiness();
      sendJson(res, r.code, r.body);
      return;
    }

    // Single-port state transport (embedded): snapshot/SSE reads stay
    // public and read-only; publish stays bearer-gated inside the module.
    // External mode: these paths 404 here (the standalone state server on
    // :3003 serves them, exactly as before).
    if (isEmbeddedTransport && embeddedTransport && url.pathname.startsWith("/api/state")) {
      if (await embeddedTransport.handleRequest(req, res, url)) return;
    }

    if (url.pathname === "/api/authority/status" && req.method === "GET") {
      sendJson(res, 200, publicStatus());
      return;
    }

    const oauthCallbackPath = oauthActive && oauthCfg ? oauthCfg.redirectPath : null;

    // Public: Google OAuth callback (Render-hosted redirect target). Google
    // cannot present the authority bearer, so this route is protected by
    // server state + browser correlation instead. Query values are never
    // logged, never reflected, and tokens never leave the process.
    if (oauthCallbackPath && url.pathname === oauthCallbackPath && req.method === "GET") {
      if (!oauthActive || !oauthCfg || !oauthState || !oauthRepo || !oauthPendingRepo) {
        for (const [k, v] of Object.entries(OAUTH_SECURITY_HEADERS)) res.setHeader(k, v);
        res.writeHead(503, { "content-type": "text/html; charset=utf-8" }).end(renderLandingPage({ ok: false, reason: "oauth-not-configured" }, null));
        return;
      }
      const cfg = oauthCfg;
      const params = url.searchParams;
      const rawCookie = Array.isArray(req.headers.cookie) ? req.headers.cookie.join("; ") : (req.headers.cookie ?? null);
      const outcome = await handleOAuthCallback({
        config: cfg,
        stateStore: oauthState,
        query: { code: params.get("code"), state: params.get("state"), error: params.get("error") },
        cookieSecret: parseCorrelationCookie(rawCookie, { secure: cfg.isProd }),
        fetchImpl: netFetch,
        current: await oauthCurrentSummary(),
        persistGrant: async (creds) => {
          await (oauthRepo as CredentialRepository).save(creds);
        },
        stagePendingGrant: async ({ creds, newChannel, previousChannelId }) => {
          await (oauthPendingRepo as CredentialRepository).save(creds);
          if (isPostgres && dbMeta) {
            // Pending-channel identity is non-secret channel metadata
            // (allowlisted row); the grant itself stays encrypted above.
            await dbMeta.set("youtube-pending-channel", { newChannel, previousChannelId, at: new Date().toISOString() });
            return;
          }
          await writeFile(join(dataDir, OAUTH_PENDING_META), JSON.stringify({ newChannel, previousChannelId, at: new Date().toISOString() }), "utf8");
        },
      });
      if (outcome.ok) {
        await clearPending();
        await resumeEmbedded();
        oauthLast = { at: new Date().toISOString(), error: null };
        if (source === "youtube") await embeddedConnect();
        else await refreshYtStatus();
      } else {
        oauthLast = { at: oauthLast.at, error: outcome.reason };
        await refreshYtStatus();
      }
      for (const [k, v] of Object.entries(OAUTH_SECURITY_HEADERS)) res.setHeader(k, v);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(renderLandingPage(outcome, cfg.dashboardUrl));
      return;
    }

    // OAuth initiation via top-level form POST (Vercel dashboard -> Render).
    // The bearer travels in the POST body because a top-level form cannot
    // set an Authorization header and must never place it in a URL. The
    // response sets the correlation cookie (first-party top-level context)
    // and redirects the browser to Google. Bodies are never logged.
    if (url.pathname === "/api/authority/youtube/oauth/start" && req.method === "POST") {
      if (!oauthActive || !oauthCfg || !oauthState) {
        sendJson(res, 503, { error: "oauth-not-configured" });
        return;
      }
      const cfg = oauthCfg;
      let raw = "";
      try {
        raw = await readBody(req);
      } catch (e) {
        sendJson(res, (e as Error).message === "too-long" || (e as { code?: string }).code === "too-long" ? 413 : 400, { error: "invalid-body" });
        return;
      }
      let bodyToken: unknown = null;
      try {
        const ct = String(req.headers["content-type"] ?? "");
        if (ct.includes("application/json")) {
          const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          bodyToken = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).token : null;
        } else {
          bodyToken = new URLSearchParams(raw).get("token");
        }
      } catch {
        sendJson(res, 400, { error: "invalid-body" });
        return;
      }
      const authed = authorized(req) || (typeof bodyToken === "string" && tokensEqual(bodyToken, authorityToken));
      if (!authed) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      try {
        const secret = mintCorrelationSecret();
        const state = await (oauthState as OAuthStateStore).create({ data: hashCorrelation(secret) });
        const googleUrl = buildWebAuthUrl({ config: cfg, state });
        res.setHeader("set-cookie", buildCorrelationSetCookie(secret, { secure: cfg.isProd }));
        for (const [k, v] of Object.entries(OAUTH_SECURITY_HEADERS)) res.setHeader(k, v);
        res.writeHead(303, { location: googleUrl }).end();
      } catch {
        sendJson(res, 500, { error: "oauth-start-failed" });
      }
      return;
    }

    // Everything below is authority-only (keeper credential required).
    if (!authorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (url.pathname === "/api/authority/dashboard" && req.method === "GET") {
      sendJson(res, 200, controlPlane());
      return;
    }

    if (url.pathname === "/api/authority/youtube/oauth/status" && req.method === "GET") {
      if (!oauthActive) {
        sendJson(res, 200, { configured: false, connected: false });
        return;
      }
      sendJson(res, 200, await oauthStatusPayload());
      return;
    }

    if (req.method === "POST") {
      let body: Record<string, unknown> = {};
      try {
        const raw = await readBody(req);
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("bad-body");
      } catch (e) {
        sendJson(res, (e as Error).message === "too-long" || (e as { code?: string }).code === "too-long" ? 413 : 400, { error: "invalid-body" });
        return;
      }
      const path = url.pathname;
      try {
        if (path === "/api/authority/command") return sendJson(res, 200, doCommand(body));
        if (path === "/api/authority/paid") return sendJson(res, 200, doPaid(body));
        if (path === "/api/authority/vote/open") {
          const which = body.which === "kindling" ? "kindling" : "route";
          return sendJson(res, 200, await doOpenVote(which));
        }
        if (path === "/api/authority/vote/close") return sendJson(res, 200, await doCloseVote());
        if (path === "/api/authority/vote/override") {
          const idx = typeof body.optionIndex === "number" ? body.optionIndex : -1;
          if (!Number.isInteger(idx) || idx < 0 || idx > 2) return sendJson(res, 400, { error: "bad-option" });
          return sendJson(res, 200, await doOverride(idx));
        }
        if (path === "/api/authority/vote/retry") {
          if (typeof body.eventId !== "string" || !body.eventId) return sendJson(res, 400, { error: "bad-event" });
          return sendJson(res, 200, await retryAnnounce(body.eventId));
        }
        if (path === "/api/authority/rite") {
          if (typeof body.templateId !== "string" || !body.templateId) return sendJson(res, 400, { error: "bad-rite" });
          return sendJson(res, 200, await doRite(body.templateId));
        }
        if (path === "/api/authority/pause") {
          paused = true;
          lifecycle = "paused";
          return sendJson(res, 200, { ok: true, outcome: "paused" });
        }
        if (path === "/api/authority/resume") {
          paused = false;
          lifecycle = "running";
          return sendJson(res, 200, { ok: true, outcome: "resumed" });
        }
        if (path === "/api/authority/save") {
          const r = await persistWorld();
          return sendJson(res, 200, { ok: r === "file" || r === "postgres", outcome: r });
        }
        if (path === "/api/authority/reload") return sendJson(res, 200, await doReload());
        if (path === "/api/authority/reset") return sendJson(res, 200, await doReset());
        if (path === "/api/authority/end-stream") return sendJson(res, 200, await doEndStream());
        if (path === "/api/authority/source") {
          if (body.source !== "simulation" && body.source !== "youtube") return sendJson(res, 400, { error: "bad-source" });
          source = body.source;
          if (source === "youtube") {
            if (oauthActive) await embeddedConnect();
            else startIngestion();
          } else {
            if (oauthActive) embeddedDisconnect();
            stopIngestion();
          }
          return sendJson(res, 200, { ok: true, outcome: source, source });
        }
        if (path === "/api/authority/token/rotate") {
          return sendJson(res, 200, await doRotateToken());
        }
        if (path === "/api/authority/youtube/connect") {
          // Cloud OAuth mode: the embedded adapter connects directly (same
          // idempotent single-reader guard as the sidecar path below).
          if (oauthActive) {
            await embeddedConnect();
            return sendJson(res, 200, { ok: true });
          }
          try {
            const r = await fetch(`${ytUrl}/api/youtube/connect`, { method: "POST" });
            await refreshYtStatus();
            return sendJson(res, 200, { ok: r.ok });
          } catch {
            return sendJson(res, 200, { ok: false, reason: "sidecar-unreachable" });
          }
        }
        if (path === "/api/authority/youtube/disconnect") {
          // Cloud OAuth mode: stop polling only — the encrypted grant is
          // preserved (no forget/revoke endpoint in this milestone).
          if (oauthActive) {
            embeddedDisconnect();
            await refreshYtStatus();
            return sendJson(res, 200, { ok: true });
          }
          try {
            await fetch(`${ytUrl}/api/youtube/disconnect`, { method: "POST" });
          } catch {
            /* status refresh reports the truth */
          }
          await refreshYtStatus();
          return sendJson(res, 200, { ok: true });
        }
        if (path === "/api/authority/youtube/auth-url") {
          try {
            const r = await fetch(`${ytUrl}/api/youtube/auth-url`);
            if (!r.ok) return sendJson(res, 200, { url: null });
            const data = (await r.json().catch(() => null)) as { url?: unknown } | null;
            return sendJson(res, 200, { url: typeof data?.url === "string" ? data.url : null });
          } catch {
            return sendJson(res, 200, { url: null });
          }
        }
        if (path === "/api/authority/youtube/oauth/confirm-channel") {
          // Explicit recovery for a channel switch: confirm moves the staged
          // pending grant into the live repository; cancel discards it.
          // Nothing here contacts Google; no silent rebinds ever happen.
          if (!oauthActive || !oauthRepo || !oauthPendingRepo) {
            return sendJson(res, 200, { ok: false, reason: "oauth-not-configured" });
          }
          const pending = await readPendingMeta();
          let staged: unknown = null;
          try {
            staged = await oauthPendingRepo.load();
          } catch {
            staged = null;
          }
          if (!pending || !staged) {
            await clearPending();
            return sendJson(res, 200, { ok: false, reason: "no-pending-channel" });
          }
          if (body.confirm === true) {
            try {
              await oauthRepo.save(staged);
            } catch {
              return sendJson(res, 200, { ok: false, reason: "persistence-failed" });
            }
            await clearPending();
            await resumeEmbedded();
            oauthLast = { at: new Date().toISOString(), error: null };
            if (source === "youtube") await embeddedConnect();
            else await refreshYtStatus();
            return sendJson(res, 200, { ok: true, outcome: "channel-confirmed" });
          }
          await clearPending();
          await refreshYtStatus();
          return sendJson(res, 200, { ok: true, outcome: "channel-cancelled" });
        }
      } catch (e) {
        return sendJson(res, 500, { error: "authority-error", detail: String((e as Error)?.message ?? e).slice(0, 120) });
      }
    }
    sendJson(res, 404, { error: "not-found" });
  });

  // ---- loops ----
  every(pollMs, step);
  every(publishMs, () => void publishOnce());
  // NOTE: `source` narrows to its initializer at this point (later
  // reassignments happen in request handlers); the cast reads runtime truth.
  // Default source is always simulation at boot, so this is a no-op guard
  // for future default changes — never a second ingestion path.
  if ((source as string) === "youtube") startIngestion();

  // Cloud OAuth mode: resume the stored grant into the embedded adapter
  // (credentials only; polling starts on source selection as usual).
  await resumeEmbedded();

  lifecycle = "running";
  // Exactly ONE public HTTP listener for this process (Render: 0.0.0.0:$PORT;
  // local dev: 127.0.0.1:3004). No second listener exists — the state
  // transport is either mounted here (embedded) or served by the separate
  // local-dev state-server process (external, never started in production).
  await new Promise<void>((resolve) => server.listen(port, listenHost, () => resolve()));
  console.log(`[tidebound] authority server on http://${listenHost}:${port} (lifecycle=running, recoveredFrom=${recoveredFrom}, persistence=${persistenceBackend}, stateTransport=${stateTransportMode})`);
  if (tokenGenerated) {
    console.log("[tidebound] authority token GENERATED — copy it from data/authority-token.json into the dashboard token field (shown once here in provisioning terms only; the value is never printed)");
  }
  if (isPostgres) {
    console.log("[tidebound] durable persistence: postgres (Render/Neon); ephemeral file fallback disabled; bearer from AUTHORITY_TOKEN env");
  }
  void publishOnce();

  let stopping = false;
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    lifecycle = "stopped";
    stopIngestion();
    // Cloud OAuth mode: halt the embedded poll loop (grant stays stored).
    try {
      embeddedDisconnect();
    } catch {
      /* shutdown best-effort */
    }
    for (const t of [...timers]) clearTimer(t);
    try {
      await persistWorld();
    } catch {
      /* shutdown flush best-effort */
    }
    // Graceful order: end SSE streams + heartbeat timers first (renderers
    // see a clean close and reconnect with `since`), then drain sockets,
    // then close the single listener, then the database pool, then the lock.
    try {
      embeddedTransport?.close();
    } catch {
      /* transport drain best-effort */
    }
    // Drain keep-alive/SSE sockets first: close() alone waits for idle
    // connections (test clients, subscriber sockets) and would hang.
    try {
      server.closeAllConnections();
    } catch {
      /* drain best-effort */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Postgres pool shutdown (file mode: pgPool is null; injected test
    // clients have no end()). Never touches secrets.
    if (pgPool && typeof (pgPool as { end?: unknown }).end === "function" && !opts?.db) {
      try {
        await (pgPool as { end: () => Promise<void> }).end();
      } catch {
        /* pool shutdown best-effort */
      }
    }
    if (lockOwned) {
      try {
        await unlink(lockPath);
      } catch {
        /* lock release best-effort */
      }
      lockOwned = false;
    }
    if (activeAuthority?.stop === stop) activeAuthority = null;
  }

  const handle: AuthorityHandle = {
    getLifecycle: () => lifecycle,
    getWorldRev: () => worldRev,
    getSeq: () => lastSeq,
    getSessionId: () => session.sessionId,
    getTimerCount: () => timers.size,
    getStatus: () => publicStatus(),
    stop,
  };
  activeAuthority = handle;

  const onSignal = (): void => {
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return handle;
}

// Direct run: `npx tsx server/authority-server.ts [port]`.
const invokedDirectly = process.argv[1] !== undefined && /authority-server\.(ts|mjs|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  await startAuthority();
}
