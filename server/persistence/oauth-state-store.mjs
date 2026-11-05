// T4F-C2.7-D1-C — database-backed OAuth state store (CSRF/replay primitive).
//
// Same contract as server/youtube/oauth-state-store.mjs (file):
// - 10-minute default TTL, 32-byte random states, SHA-256-hash-only rows.
// - Browser correlation stays independently validated by oauth-web.mjs.
// - Atomic consume: exactly one concurrent callback wins — enforced here by
//   a single conditional UPDATE (WHERE h AND NOT consumed AND unexpired),
//   so the guarantee holds even across processes (stronger than the
//   file store's in-process chain, which this class also keeps for ordering).
// - Expired/consumed states are rejected; corrupt storage fails closed.
// - Restart behavior is deterministic: unexpired+unconsumed rows stay valid,
//   consumed rows stay consumed, expired rows are pruned. A missing table
//   (migration not run) is an explicit error, never silent validity.
//
// No new OAuth routes, no Google contact, no secrets in this module.

import { createHash, randomBytes } from "node:crypto";
import { STATE_TTL_MS, STATE_RANDOM_BYTES, MAX_STATE_RECORDS } from "../youtube/oauth-state-store.mjs";

export { STATE_TTL_MS, STATE_RANDOM_BYTES, MAX_STATE_RECORDS };

const STATE_FORMAT = /^[A-Za-z0-9_-]{32,128}$/;

function hashState(state) {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export class PgOAuthStateStore {
  /**
   * @param opts.db injected database client {query(text, params)}
   * @param opts.ttlMs state lifetime (default 10 min — unchanged)
   * @param opts.now clock for tests (default Date.now)
   * @param opts.randomBytesImpl randomness for tests
   * @param opts.maxRecords bound on stored records (default 100)
   */
  constructor(opts = {}) {
    if (!opts || typeof opts.db?.query !== "function") throw new Error("state-store-requires-db");
    this.db = opts.db;
    this.ttlMs = typeof opts.ttlMs === "number" && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : STATE_TTL_MS;
    this.now = typeof opts.now === "function" ? opts.now : Date.now;
    this.randomBytesImpl = typeof opts.randomBytesImpl === "function" ? opts.randomBytesImpl : randomBytes;
    this.maxRecords = Number.isInteger(opts.maxRecords) && opts.maxRecords > 0 ? opts.maxRecords : MAX_STATE_RECORDS;
    this.storageCorrupt = false;
    this.loaded = false;
    this._tail = Promise.resolve();
  }

  /** Verify connectivity, prune expired rows, report the surviving count. */
  async init() {
    try {
      await this.db.query("DELETE FROM oauth_state WHERE created_at < $1", [this.now() - this.ttlMs]);
      const res = await this.db.query("SELECT COUNT(*)::int AS n FROM oauth_state");
      const n = res?.rows?.[0]?.n;
      this.loaded = true;
      this.storageCorrupt = false;
      return { ok: true, restored: Number.isInteger(n) ? n : 0 };
    } catch (e) {
      this.loaded = false;
      return { ok: false, reason: "db-unavailable" };
    }
  }

  recordCount() {
    // Synchronous mirror is unavailable for a remote store; callers that
    // need the count use count() instead. Kept for interface parity: throws
    // loudly rather than returning a stale number.
    throw new Error("state-store-count-async");
  }

  async count() {
    try {
      const res = await this.db.query("SELECT COUNT(*)::int AS n FROM oauth_state");
      return Number.isInteger(res?.rows?.[0]?.n) ? res.rows[0].n : 0;
    } catch {
      throw new Error("state-unavailable");
    }
  }

  /** Mint one URL-safe state and persist its hash. Returns the state string. */
  async create(opts = {}) {
    const data = opts && opts.data !== undefined ? opts.data : undefined;
    if (data !== undefined && (typeof data !== "string" || data.length === 0 || data.length > 256)) {
      throw new Error("state-data-invalid");
    }
    return this._locked(async () => {
      let n = 0;
      try {
        const res = await this.db.query("SELECT COUNT(*)::int AS n FROM oauth_state");
        n = Number.isInteger(res?.rows?.[0]?.n) ? res.rows[0].n : 0;
      } catch {
        throw new Error("state-unavailable");
      }
      if (n >= this.maxRecords) throw new Error("state-store-full");
      // Prune before minting so expired rows cannot wedge the bound.
      try {
        await this.db.query("DELETE FROM oauth_state WHERE created_at < $1", [this.now() - this.ttlMs]);
      } catch {
        throw new Error("state-unavailable");
      }
      let buf;
      try {
        buf = this.randomBytesImpl(STATE_RANDOM_BYTES);
      } catch {
        throw new Error("state-randomness-unavailable");
      }
      if (!buf || buf.length !== STATE_RANDOM_BYTES) throw new Error("state-randomness-unavailable");
      const state = Buffer.from(buf).toString("base64url");
      const h = hashState(state);
      try {
        await this.db.query("INSERT INTO oauth_state (h, created_at, consumed, data) VALUES ($1, $2, false, $3)", [
          h,
          this.now(),
          data ?? null,
        ]);
      } catch (e) {
        const msg = String(e?.code ?? e?.message ?? e);
        if (msg.includes("23505") || /duplicate|unique/i.test(msg)) throw new Error("state-collision-retry");
        throw new Error("state-unavailable");
      }
      return state;
    });
  }

  /**
   * Consume one state. Exactly one concurrent caller can succeed per state
   * (single conditional UPDATE). Reasons carry NO state values.
   */
  async consume(supplied) {
    return this._locked(async () => {
      if (typeof supplied !== "string" || !STATE_FORMAT.test(supplied)) {
        return { ok: false, reason: "invalid-state" };
      }
      const h = hashState(supplied);
      const cutoff = this.now() - this.ttlMs;
      try {
        const claimed = await this.db.query(
          "UPDATE oauth_state SET consumed = true WHERE h = $1 AND consumed = false AND created_at > $2 RETURNING data",
          [h, cutoff],
        );
        if (claimed?.rows?.length > 0) {
          const data = claimed.rows[0]?.data;
          if (typeof data === "string" && data.length > 0) return { ok: true, data };
          return { ok: true };
        }
      } catch {
        return { ok: false, reason: "state-unavailable" };
      }
      // The claim lost: distinguish why without leaking values.
      let row = null;
      try {
        const res = await this.db.query("SELECT consumed, created_at FROM oauth_state WHERE h = $1", [h]);
        row = res?.rows?.[0] ?? null;
      } catch {
        return { ok: false, reason: "state-unavailable" };
      }
      if (!row) return { ok: false, reason: "unknown-state" };
      if (row.consumed === true) return { ok: false, reason: "already-consumed" };
      if (typeof row.created_at === "number" && row.created_at <= cutoff) {
        try {
          await this.db.query("DELETE FROM oauth_state WHERE h = $1", [h]);
        } catch {
          /* prune best-effort */
        }
        return { ok: false, reason: "expired-state" };
      }
      return { ok: false, reason: "unknown-state" };
    });
  }

  /** Drop expired records. Returns remaining count. */
  async cleanup() {
    return this._locked(async () => {
      try {
        await this.db.query("DELETE FROM oauth_state WHERE created_at < $1", [this.now() - this.ttlMs]);
        const res = await this.db.query("SELECT COUNT(*)::int AS n FROM oauth_state");
        return Number.isInteger(res?.rows?.[0]?.n) ? res.rows[0].n : 0;
      } catch {
        throw new Error("state-unavailable");
      }
    });
  }

  _locked(fn) {
    const run = this._tail.then(fn, fn);
    this._tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
