// T4F-C2.7-D1-C — database metadata store (cursors + pending-channel meta).
//
// Allowlisted key/value rows only. Values are small JSON objects; shapes are
// validated on read AND write so corrupt storage fails closed instead of
// silently resetting dedup state.
//
// Keys (see db-config.mjs METADATA_KEYS):
// - "authority-cursor":        { lastYtEventId: string | null }
// - "youtube-adapter-cursor":  { liveChatId: string, platformId: string, publishedAt?: string }
// - "youtube-pending-channel": { newChannel: object, previousChannelId: string, at: string }
//
// Chat event identity and replay semantics are UNCHANGED: these rows are
// resume pointers (the engine still owns gameplay dedup). Losing a cursor
// is recoverable (bounded re-forward, deduped downstream); losing the world
// or the credential grant is not — hence the stricter handling there.

import { METADATA_KEYS } from "./db-config.mjs";

function isRecord(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function validValue(key, value) {
  if (value === null) return false;
  if (!isRecord(value)) return false;
  if (key === "authority-cursor") {
    return value.lastYtEventId === null || typeof value.lastYtEventId === "string";
  }
  if (key === "youtube-adapter-cursor") {
    return typeof value.liveChatId === "string" && typeof value.platformId === "string";
  }
  if (key === "youtube-pending-channel") {
    return (
      isRecord(value.newChannel) &&
      typeof value.previousChannelId === "string" &&
      typeof value.at === "string"
    );
  }
  return false;
}

export class DbMetadataStore {
  /** @param opts.db injected database client {query(text, params)} */
  constructor(opts = {}) {
    if (!opts || typeof opts.db?.query !== "function") throw new Error("metadata-store-requires-db");
    this.db = opts.db;
  }

  assertKey(key) {
    if (typeof key !== "string" || !METADATA_KEYS.includes(key)) {
      throw new Error("metadata-key-not-allowed");
    }
  }

  /** Missing row -> null. Outage/corrupt -> throws (never silent). */
  async get(key) {
    this.assertKey(key);
    let rows;
    try {
      const res = await this.db.query("SELECT value FROM authority_metadata WHERE key = $1", [key]);
      rows = res?.rows ?? [];
    } catch {
      throw new Error("db-unavailable");
    }
    if (rows.length === 0) return null;
    const value = rows[0]?.value;
    let parsed = value;
    try {
      parsed = typeof value === "string" ? JSON.parse(value) : JSON.parse(JSON.stringify(value));
    } catch {
      throw new Error("corrupt-storage");
    }
    if (!validValue(key, parsed)) throw new Error("corrupt-storage");
    return parsed;
  }

  async set(key, value) {
    this.assertKey(key);
    if (!validValue(key, value)) throw new Error("metadata-value-invalid");
    try {
      await this.db.query(
        `INSERT INTO authority_metadata (key, value, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    } catch {
      throw new Error("db-unavailable");
    }
    return { ok: true };
  }

  async delete(key) {
    this.assertKey(key);
    try {
      await this.db.query("DELETE FROM authority_metadata WHERE key = $1", [key]);
    } catch {
      throw new Error("db-unavailable");
    }
    return { ok: true };
  }
}
