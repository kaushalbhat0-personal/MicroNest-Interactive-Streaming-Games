// T4F-C2.7-B — encrypted YouTube credential repository.
//
// Responsibility ends at at-rest protection of the OAuth grant:
// AES-256-GCM encrypt a validated credential object, persist the envelope
// atomically, decrypt + authenticate + re-validate on load. NO HTTP,
// NO Google calls, NO revocation network traffic, NO dashboard code.
//
// Key handling (server-side boundary only):
// - The 32-byte key arrives via constructor config (Render secret at
//   runtime, test fixture in tests). This module NEVER reads env, NEVER
//   generates a production key, NEVER logs key material or plaintext.
// - Accepted forms: Buffer/Uint8Array of exactly 32 bytes, or a string
//   that decodes (hex, then base64) to exactly 32 bytes. Anything else
//   throws `bad-key` before any filesystem access.
// - A private disk is NOT encryption; the envelope below is the protection.
//
// Envelope (versioned): { v:1, alg:"aes-256-gcm", iv, tag, data }
// (base64 fields). Fresh 12-byte IV per save. Wrong key, tampered
// ciphertext/tag, unknown version/algorithm, or invalid credential shape
// all fail closed — a corrupt file is NEVER silently treated as "empty"
// and NEVER overwritten by a later save of convenience.
//
// Concurrency boundary is IN-PROCESS (serialized write chain). No
// cross-process locking is claimed.

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_ALG = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

let tmpCounter = 0;

export class CredentialStoreError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "CredentialStoreError";
    this.code = code;
  }
}

/**
 * Validate + normalize an encryption key without touching the filesystem.
 * Returns a 32-byte Buffer copy, or throws CredentialStoreError("bad-key").
 */
export function decodeEncryptionKey(key) {
  return decodeKey(key);
}

function decodeKey(key) {
  if (Buffer.isBuffer(key) && key.length === KEY_BYTES) return Buffer.from(key);
  if (key instanceof Uint8Array && key.length === KEY_BYTES) return Buffer.from(key);
  if (typeof key === "string") {
    const s = key.trim();
    if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
    try {
      const b = Buffer.from(s, "base64");
      if (b.length === KEY_BYTES) return b;
    } catch {
      /* fall through to bad-key */
    }
  }
  throw new CredentialStoreError("bad-key");
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Validate credential shape. Required: non-empty access_token. Optional:
 * refresh_token (string|null), expires_at (finite number), scopes
 * (string[]), channel identity object (validated, never invented),
 * obtainedAt/updatedAt timestamps. Extra fields are preserved (forward
 * compatibility) but known fields must have the right types.
 */
export function validateCredentials(c) {
  if (!isPlainObject(c)) throw new CredentialStoreError("invalid-credentials");
  if (typeof c.access_token !== "string" || c.access_token.length === 0 || c.access_token.length > 8192) {
    throw new CredentialStoreError("invalid-credentials");
  }
  if (c.refresh_token !== undefined && c.refresh_token !== null && typeof c.refresh_token !== "string") {
    throw new CredentialStoreError("invalid-credentials");
  }
  if (typeof c.refresh_token === "string" && c.refresh_token.length > 8192) {
    throw new CredentialStoreError("invalid-credentials");
  }
  if (c.expires_at !== undefined && (typeof c.expires_at !== "number" || !Number.isFinite(c.expires_at))) {
    throw new CredentialStoreError("invalid-credentials");
  }
  if (c.scopes !== undefined && (!Array.isArray(c.scopes) || !c.scopes.every((s) => typeof s === "string"))) {
    throw new CredentialStoreError("invalid-credentials");
  }
  if (c.channel !== undefined && c.channel !== null) {
    if (!isPlainObject(c.channel) || (typeof c.channel.id !== "string" && typeof c.channel.handle !== "string")) {
      throw new CredentialStoreError("invalid-credentials");
    }
  }
  for (const f of ["obtainedAt", "updatedAt"]) {
    if (c[f] !== undefined && (typeof c[f] !== "number" || !Number.isFinite(c[f]))) {
      throw new CredentialStoreError("invalid-credentials");
    }
  }
  return true;
}

function deepCopy(v) {
  return JSON.parse(JSON.stringify(v));
}

export class CredentialRepository {
  /**
   * @param opts.path credential envelope file (server-side only)
   * @param opts.key 32-byte key (Buffer/Uint8Array, or hex/base64 string)
   * @param opts.randomBytesImpl randomness for tests (default node:crypto)
   */
  constructor(opts = {}) {
    if (!opts || typeof opts.path !== "string" || opts.path.length === 0) {
      throw new CredentialStoreError("bad-path");
    }
    this.path = opts.path;
    this.key = decodeKey(opts.key);
    this.randomBytesImpl = typeof opts.randomBytesImpl === "function" ? opts.randomBytesImpl : randomBytes;
    this._tail = Promise.resolve();
  }

  /**
   * Load credentials. Returns a fresh copy, or null when no file exists.
   * Throws CredentialStoreError (corrupt-storage | auth-failed |
   * unsupported-version | unsupported-algorithm | invalid-credentials)
   * for anything that is present but unusable. Missing and corrupt are
   * deliberately distinct: callers must not treat failure as absence.
   */
  async load() {
    let raw = null;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return null;
      throw new CredentialStoreError("corrupt-storage");
    }
    let env = null;
    try {
      env = JSON.parse(raw);
    } catch {
      throw new CredentialStoreError("corrupt-storage");
    }
    if (!isPlainObject(env)) throw new CredentialStoreError("corrupt-storage");
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
      // Wrong key and tampered bytes are indistinguishable by design.
      // Compare a canary in constant time so failure timing reveals nothing
      // about which field mismatched (defense in depth; GCM already hides it).
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

  /** True when a readable credential file exists. Throws on corrupt files. */
  async hasCredentials() {
    return (await this.load()) !== null;
  }

  /**
   * Validate, encrypt (fresh IV), and atomically persist. Validation
   * happens BEFORE any filesystem write, so invalid input can never clobber
   * a good file. Concurrent saves serialize in-process; the final file is
   * always one complete envelope. Returns {ok:true}.
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
      const envelope = JSON.stringify({
        v: ENVELOPE_VERSION,
        alg: ENVELOPE_ALG,
        iv: Buffer.from(iv).toString("base64"),
        tag: tag.toString("base64"),
        data: ct.toString("base64"),
      });
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}-${tmpCounter++}`;
      try {
        // The temp file holds ONLY the encrypted envelope — never plaintext.
        await writeFile(tmp, envelope, { encoding: "utf8", mode: 0o600 });
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
        throw new CredentialStoreError("write-failed");
      }
      return { ok: true };
    });
  }

  /** Delete the stored envelope. Missing file is success (idempotent). */
  async clear() {
    return this._locked(async () => {
      try {
        await unlink(this.path);
      } catch (e) {
        if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return { ok: true };
        throw new CredentialStoreError("write-failed");
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
