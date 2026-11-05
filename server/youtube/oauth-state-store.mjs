// T4F-C2.7-B — server-side OAuth state store (CSRF/replay primitive).
//
// Responsibility ends at nonce storage: mint URL-safe single-use states,
// persist them so a restart cannot silently validate a forgotten
// authorization, and consume them atomically. NO HTTP, NO Google calls,
// NO token exchange, NO credentials — this file never sees secrets.
//
// Design notes (also see the T4F-C2.7 Phase 1 audit):
// - State = base64url(randomBytes(32)) (43 chars). Only a SHA-256 hash of
//   each state is persisted, so the store file holds no usable state value.
// - Lookup compares hashes with timingSafeEqual (hashes are fixed length,
//   so the comparison itself is constant-time per candidate).
// - Concurrency boundary is IN-PROCESS: mutations serialize through an
//   internal promise chain. Cross-process safety is NOT claimed; the
//   authority single-instance lock (data/authority.lock) is what prevents
//   a second writer. Documented, not assumed.
// - Restart: records persist with absolute timestamps. Unexpired,
//   unconsumed records stay valid; consumed records stay consumed; expired
//   records are pruned. If the file is missing/corrupt, every pre-restart
//   state is rejected (explicit `unknown-state`) and the operator retries
//   Connect. A restart never mints validity it cannot prove.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export const STATE_TTL_MS = 10 * 60 * 1000;
export const STATE_RANDOM_BYTES = 32;
export const MAX_STATE_RECORDS = 100;
const STORE_VERSION = 1;

/** Accepts the exact strings this store mints (base64url, 32..128 chars). */
const STATE_FORMAT = /^[A-Za-z0-9_-]{32,128}$/;

function hashState(state) {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function isRecordShape(r) {
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.h === "string" &&
    /^[0-9a-f]{64}$/.test(r.h) &&
    typeof r.createdAt === "number" &&
    Number.isFinite(r.createdAt) &&
    typeof r.consumed === "boolean" &&
    (r.data === undefined || (typeof r.data === "string" && r.data.length <= 256))
  );
}

let tmpCounter = 0;

export class OAuthStateStore {
  /**
   * @param opts.path state file (server-side, never served to browsers)
   * @param opts.ttlMs state lifetime (default 10 min)
   * @param opts.now clock for tests (default Date.now)
   * @param opts.randomBytesImpl randomness for tests (default node:crypto randomBytes)
   * @param opts.maxRecords bound on stored records (default 100)
   */
  constructor(opts = {}) {
    if (!opts || typeof opts.path !== "string" || opts.path.length === 0) {
      throw new Error("state-store-requires-path");
    }
    this.path = opts.path;
    this.ttlMs = typeof opts.ttlMs === "number" && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : STATE_TTL_MS;
    this.now = typeof opts.now === "function" ? opts.now : Date.now;
    this.randomBytesImpl = typeof opts.randomBytesImpl === "function" ? opts.randomBytesImpl : randomBytes;
    this.maxRecords = Number.isInteger(opts.maxRecords) && opts.maxRecords > 0 ? opts.maxRecords : MAX_STATE_RECORDS;
    /** @type {Map<string, {createdAt:number, consumed:boolean, data?:string}>} hash -> record */
    this.records = new Map();
    /** True when the backing file was missing/unreadable/corrupt at load. */
    this.storageCorrupt = false;
    this.loaded = false;
    this._tail = Promise.resolve();
  }

  /** Load persisted records. Missing file = empty store (not an error). */
  async init() {
    let raw = null;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      this.records = new Map();
      this.storageCorrupt = false;
      this.loaded = true;
      return { ok: true, restored: 0 };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object" || parsed.v !== STORE_VERSION || !Array.isArray(parsed.records)) {
      this.records = new Map();
      this.storageCorrupt = true;
      this.loaded = true;
      return { ok: true, restored: 0, corrupt: true };
    }
    const next = new Map();
    for (const r of parsed.records) {
      if (isRecordShape(r) && !next.has(r.h)) {
        const rec = { createdAt: r.createdAt, consumed: r.consumed };
        if (r.data !== undefined) rec.data = r.data;
        next.set(r.h, rec);
      }
      if (next.size >= this.maxRecords) break;
    }
    this.records = next;
    this.storageCorrupt = false;
    this.loaded = true;
    await this._pruneLocked();
    return { ok: true, restored: this.records.size };
  }

  /** Number of records currently held (for tests/diagnostics; no values). */
  recordCount() {
    return this.records.size;
  }

  /**
   * Mint one URL-safe state and persist its hash. Returns the state string.
   * @param opts.data optional opaque binding (e.g. a correlation-secret
   *   hash). Persisted alongside the record and returned on consume. Never
   *   a credential — hashes only.
   */
  async create(opts = {}) {
    const data = opts && opts.data !== undefined ? opts.data : undefined;
    if (data !== undefined && (typeof data !== "string" || data.length === 0 || data.length > 256)) {
      throw new Error("state-data-invalid");
    }
    return this._locked(async () => {
      await this._pruneLocked();
      if (this.records.size >= this.maxRecords) throw new Error("state-store-full");
      let buf;
      try {
        buf = this.randomBytesImpl(STATE_RANDOM_BYTES);
      } catch {
        throw new Error("state-randomness-unavailable");
      }
      if (!buf || buf.length !== STATE_RANDOM_BYTES) throw new Error("state-randomness-unavailable");
      const state = Buffer.from(buf).toString("base64url");
      const h = hashState(state);
      if (this.records.has(h)) throw new Error("state-collision-retry");
      const rec = { createdAt: this.now(), consumed: false };
      if (data !== undefined) rec.data = data;
      this.records.set(h, rec);
      await this._persistLocked();
      return state;
    });
  }

  /**
   * Consume one state. Exactly one concurrent caller can succeed per state.
   * Returns {ok:true[, data]} or {ok:false, reason}. Reasons carry NO state values:
   *  invalid-state   — not a string or not URL-safe shape
   *  unknown-state   — missing file record / mismatch (no distinction leaked)
   *  already-consumed — replay of a spent state
   *  expired-state   — past TTL (record is dropped)
   */
  async consume(supplied) {
    return this._locked(async () => {
      if (typeof supplied !== "string" || !STATE_FORMAT.test(supplied)) {
        return { ok: false, reason: "invalid-state" };
      }
      const target = Buffer.from(hashState(supplied), "hex");
      let foundKey = null;
      for (const key of this.records.keys()) {
        const candidate = Buffer.from(key, "hex");
        if (candidate.length !== target.length) continue;
        if (timingSafeEqual(candidate, target)) {
          foundKey = key;
          break;
        }
      }
      if (foundKey === null) return { ok: false, reason: "unknown-state" };
      const rec = this.records.get(foundKey);
      if (rec.consumed) return { ok: false, reason: "already-consumed" };
      if (this.now() - rec.createdAt > this.ttlMs) {
        this.records.delete(foundKey);
        await this._persistLocked();
        return { ok: false, reason: "expired-state" };
      }
      rec.consumed = true;
      await this._persistLocked();
      // `data` is only present when the record was created with a binding;
      // omitting it otherwise keeps the historical {ok:true} shape intact.
      if (rec.data !== undefined) return { ok: true, data: rec.data };
      return { ok: true };
    });
  }

  /** Drop expired records and persist the result. Returns remaining count. */
  async cleanup() {
    return this._locked(async () => this._pruneLocked());
  }

  // ---- internals (caller must hold the chain) ----

  /** Serialize mutations so concurrent consume() calls cannot both succeed. */
  _locked(fn) {
    const run = this._tail.then(fn, fn);
    // A rejection must not break the chain for later operations.
    this._tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async _pruneLocked() {
    const now = this.now();
    let changed = false;
    for (const [h, r] of this.records) {
      if (now - r.createdAt > this.ttlMs) {
        this.records.delete(h);
        changed = true;
      }
    }
    if (changed) await this._persistLocked();
    return this.records.size;
  }

  async _persistLocked() {
    const payload = JSON.stringify({
      v: STORE_VERSION,
      records: [...this.records.entries()].map(([h, r]) => {
        const o = { h, createdAt: r.createdAt, consumed: r.consumed };
        if (r.data !== undefined) o.data = r.data;
        return o;
      }),
    });
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${tmpCounter++}`;
    try {
      await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
      try {
        await chmod(tmp, 0o600);
      } catch {
        /* best-effort on filesystems without modes */
      }
      await rename(tmp, this.path);
    } catch (e) {
      try {
        await unlink(tmp);
      } catch {
        /* cleanup best-effort */
      }
      throw e;
    }
    this.storageCorrupt = false;
  }
}
