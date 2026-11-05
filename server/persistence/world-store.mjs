// T4F-C2.7-D1-C — database world-state repository.
//
// The persistence layer is NOT a second game authority: it stores one
// validated WorldState row and returns it. Validation and serialization stay
// in src/persistence/store.ts (injected here so this .mjs module never
// imports TypeScript directly; the authority passes its own imports).
//
// Error taxonomy (explicit, never conflated):
// - {status:"no-save"}      genuinely absent initial state (fresh genesis OK)
// - {status:"unavailable"}  database temporarily unreachable (NEVER empty)
// - {status:"corrupt"}      stored bytes fail validation (fail safely)
// A database outage must never be interpreted as an empty world.

const WORLD_ROW_ID = 1;

function isDbUnavailableError(e) {
  // pg codes for connection/timeout live here; anything thrown by the
  // transport is treated as an outage (safe direction: never empty-world).
  return true;
}

export class DbWorldStore {
  /**
   * @param opts.db injected database client {query(text, params)}
   * @param opts.normalizeWorld (parsedJson) => WorldState|null (from src/persistence/store)
   * @param opts.serialize (world) => string (from src/persistence/store)
   */
  constructor(opts = {}) {
    if (!opts || typeof opts.db?.query !== "function") throw new Error("world-store-requires-db");
    if (typeof opts.normalizeWorld !== "function") throw new Error("world-store-requires-validator");
    if (typeof opts.serialize !== "function") throw new Error("world-store-requires-serializer");
    this.db = opts.db;
    this.normalizeWorld = opts.normalizeWorld;
    this.serialize = opts.serialize;
  }

  /** Load the latest committed world. Validated; never invented. */
  async load() {
    let rows;
    try {
      const res = await this.db.query("SELECT payload, revision FROM world_state WHERE id = $1", [WORLD_ROW_ID]);
      rows = res?.rows ?? [];
    } catch (e) {
      return { status: "unavailable", error: String(e?.message ?? e).slice(0, 160) };
    }
    if (rows.length === 0) return { status: "no-save" };
    const row = rows[0];
    let world = null;
    try {
      // JSONB arrives parsed; round-trip through the same boundary the
      // file path uses (parse(normalize)) so validation is identical.
      const parsed = typeof row.payload === "string" ? JSON.parse(row.payload) : JSON.parse(JSON.stringify(row.payload));
      world = this.normalizeWorld(parsed);
    } catch {
      world = null;
    }
    if (!world) return { status: "corrupt", error: "world-payload-invalid" };
    const revision = Number.isInteger(row.revision) ? row.revision : 1;
    return { status: "ok", world, revision };
  }

  /**
   * Atomically replace the world. Invalid input is rejected BEFORE any
   * database touch, so a bad save can never clobber the last good row.
   * The single-row upsert runs in a transaction; failure rolls back and
   * the previous valid state is preserved byte-for-byte.
   */
  async save(world) {
    let normalized = null;
    try {
      normalized = this.normalizeWorld(JSON.parse(this.serialize(world)));
    } catch {
      normalized = null;
    }
    if (!normalized) return { ok: false, reason: "invalid-save" };
    const payloadText = this.serialize(normalized);
    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      return { ok: false, reason: "invalid-save" };
    }
    try {
      await this.db.query("BEGIN");
      try {
        const res = await this.db.query(
          `INSERT INTO world_state (id, payload, revision, updated_at)
           VALUES ($1, $2::jsonb, 1, now())
           ON CONFLICT (id) DO UPDATE SET
             payload = EXCLUDED.payload,
             revision = world_state.revision + 1,
             updated_at = now()
           RETURNING revision`,
          [WORLD_ROW_ID, JSON.stringify(payload)],
        );
        const revision = res?.rows?.[0]?.revision;
        await this.db.query("COMMIT");
        return { ok: true, revision: Number.isInteger(revision) ? revision : 1 };
      } catch (e) {
        try {
          await this.db.query("ROLLBACK");
        } catch {
          /* rollback best-effort */
        }
        throw e;
      }
    } catch (e) {
      void isDbUnavailableError;
      return { ok: false, reason: "db-unavailable", detail: String(e?.message ?? e).slice(0, 160) };
    }
  }
}
