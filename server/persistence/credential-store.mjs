// T4F-C2.7-D1-C — database-backed encrypted credential repository.
//
// Encryption and key handling stay on the C2.7-B boundary: the AES-256-GCM
// envelope parameters are IMPORTED from credential-repository.mjs (single
// source of truth — never restated), keys are decoded by its decoder, and
// credential shapes are validated by its validator. This module only swaps
// the persistence medium (one DB row instead of one file). The database
// holds the encrypted envelope object only — never plaintext tokens, never
// the encryption key.
//
// Outage semantics (fail closed, never silent):
// - missing row -> null (genuinely absent grant; operator must authorize)
// - database error -> throws CredentialStoreError("db-unavailable")
//   (callers must NOT treat it as absence/deletion)
// - wrong key / tampered envelope / bad version -> same codes as the file
//   repository ("auth-failed", "unsupported-version", ...)

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import {
  CredentialStoreError,
  decodeEncryptionKey,
  validateCredentials,
  ENVELOPE_ALG,
  ENVELOPE_VERSION,
} from "../youtube/credential-repository.mjs";
import { CREDENTIAL_IDS } from "./db-config.mjs";

export { CredentialStoreError };

const IV_BYTES = 12;

function deepCopy(v) {
  return JSON.parse(JSON.stringify(v));
}

function envelopeToRow(env) {
  return { v: env.v, alg: env.alg, iv: env.iv, tag: env.tag, data: env.data };
}

export class DbCredentialRepository {
  /**
   * @param opts.db injected database client {query(text, params)}
   * @param opts.id stable row id ("youtube-credentials" | "youtube-pending-grant")
   * @param opts.key 32-byte key (same forms as the file repository)
   * @param opts.randomBytesImpl randomness for tests
   */
  constructor(opts = {}) {
    if (!opts || typeof opts.db?.query !== "function") throw new CredentialStoreError("bad-path");
    if (typeof opts.id !== "string" || !CREDENTIAL_IDS.includes(opts.id)) {
      throw new CredentialStoreError("bad-path");
    }
    this.db = opts.db;
    this.id = opts.id;
    this.key = decodeEncryptionKey(opts.key);
    this.randomBytesImpl = typeof opts.randomBytesImpl === "function" ? opts.randomBytesImpl : randomBytes;
    this._tail = Promise.resolve();
  }

  /** Load credentials. Null when no row exists. Throws on corrupt/outage. */
  async load() {
    let rows;
    try {
      const res = await this.db.query("SELECT envelope FROM authority_credentials WHERE id = $1", [this.id]);
      rows = res?.rows ?? [];
    } catch {
      throw new CredentialStoreError("db-unavailable");
    }
    if (rows.length === 0) return null;
    const env = rows[0]?.envelope;
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      throw new CredentialStoreError("corrupt-storage");
    }
    if (env.v !== ENVELOPE_VERSION) {
      throw new CredentialStoreError(env.v === undefined ? "corrupt-storage" : "unsupported-version");
    }
    if (env.alg !== ENVELOPE_ALG) {
      throw new CredentialStoreError(typeof env.alg === "string" ? "unsupported-algorithm" : "corrupt-storage");
    }
    let iv, tag, data;
    try {
      iv = Buffer.from(String(env.iv ?? ""), "base64");
      tag = Buffer.from(String(env.tag ?? ""), "base64");
      data = Buffer.from(String(env.data ?? ""), "base64");
    } catch {
      throw new CredentialStoreError("corrupt-storage");
    }
    if (iv.length !== IV_BYTES || tag.length !== 16 || data.length === 0) {
      throw new CredentialStoreError("corrupt-storage");
    }
    let plain;
    try {
      const decipher = createDecipheriv(ENVELOPE_ALG, this.key, iv);
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch {
      timingSafeEqual(Buffer.from("auth-failed"), Buffer.from("auth-failed"));
      throw new CredentialStoreError("auth-failed");
    }
    let creds = null;
    try {
      creds = JSON.parse(plain);
    } catch {
      throw new CredentialStoreError("corrupt-storage");
    }
    try {
      validateCredentials(creds);
    } catch (e) {
      if (e instanceof CredentialStoreError) throw e;
      throw new CredentialStoreError("invalid-credentials");
    }
    return deepCopy(creds);
  }

  async hasCredentials() {
    return (await this.load()) !== null;
  }

  /**
   * Validate, encrypt (fresh IV), atomically upsert. Validation runs BEFORE
   * any database write; concurrent saves serialize in-process AND collapse
   * to a single-row atomic upsert server-side, so the final row is always
   * one complete envelope. Refresh-token rotation is one save (atomic).
   */
  async save(credentials) {
    validateCredentials(credentials);
    const snapshot = deepCopy(credentials);
    return this._locked(async () => {
      let iv;
      try {
        iv = this.randomBytesImpl(IV_BYTES);
      } catch {
        throw new CredentialStoreError("randomness-unavailable");
      }
      if (!iv || iv.length !== IV_BYTES) throw new CredentialStoreError("randomness-unavailable");
      const cipher = createCipheriv(ENVELOPE_ALG, this.key, Buffer.from(iv));
      const ct = Buffer.concat([cipher.update(JSON.stringify(snapshot), "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      const envelope = envelopeToRow({
        v: ENVELOPE_VERSION,
        alg: ENVELOPE_ALG,
        iv: Buffer.from(iv).toString("base64"),
        tag: tag.toString("base64"),
        data: ct.toString("base64"),
      });
      try {
        await this.db.query(
          `INSERT INTO authority_credentials (id, envelope, updated_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (id) DO UPDATE SET envelope = EXCLUDED.envelope, updated_at = now()`,
          [this.id, JSON.stringify(envelope)],
        );
      } catch {
        throw new CredentialStoreError("db-unavailable");
      }
      return { ok: true };
    });
  }

  /** Delete the row. Missing row is success (idempotent). */
  async clear() {
    return this._locked(async () => {
      try {
        await this.db.query("DELETE FROM authority_credentials WHERE id = $1", [this.id]);
      } catch {
        throw new CredentialStoreError("db-unavailable");
      }
      return { ok: true };
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
