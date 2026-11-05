// T4F-C2.7-D1-C — versioned migration runner (explicit, no ORM).
//
// Responsibility ends at schema-version enforcement: apply pending SQL,
// record the version, refuse to boot on mismatch. NO game logic, NO secrets.
//
// Startup contract (see storage.mjs): validate env -> connect -> validate
// schema version -> load world -> load credentials -> restore cursors.
// Readiness is exposed only after this chain succeeds; a version mismatch
// (database newer than this code) fails boot instead of running degraded.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CURRENT_SCHEMA_VERSION = 1;
export const MIGRATION_FILES = ["001_init.sql"];

function migrationsDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "migrations");
}

export async function loadMigrationSql(name) {
  return readFile(join(migrationsDir(), name), "utf8");
}

/** Current applied version, or null when no migration has run yet. */
export async function getSchemaVersion(db) {
  let rows;
  try {
    const res = await db.query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1");
    rows = res?.rows ?? [];
  } catch (e) {
    const msg = String(e?.code ?? e?.message ?? e);
    // Undefined-table means "no migration yet" — distinct from an outage.
    if (msg.includes("42P01") || /relation .* does not exist/i.test(msg)) return { ok: true, version: 0 };
    return { ok: false, reason: "db-unavailable", detail: msg.slice(0, 120) };
  }
  if (rows.length === 0) return { ok: true, version: 0 };
  const v = rows[0]?.version;
  if (!Number.isInteger(v) || v < 0) return { ok: false, reason: "migration-corrupt" };
  return { ok: true, version: v };
}

/**
 * Apply pending migrations idempotently. Each file is itself idempotent
 * (IF NOT EXISTS + ON CONFLICT DO NOTHING), so re-running is safe.
 * Returns the resulting version. A database NEWER than this code is a hard
 * failure (refuse to run against an unknown schema).
 */
export async function ensureMigrated(db) {
  const current = await getSchemaVersion(db);
  if (!current.ok) return current;
  if (current.version > CURRENT_SCHEMA_VERSION) {
    return { ok: false, reason: "migration-version-mismatch", version: current.version };
  }
  if (current.version >= CURRENT_SCHEMA_VERSION && current.version > 0) {
    return { ok: true, version: current.version, applied: false };
  }
  for (const file of MIGRATION_FILES) {
    let sql;
    try {
      sql = await loadMigrationSql(file);
    } catch {
      return { ok: false, reason: "migration-unreadable" };
    }
    try {
      await db.query(sql);
    } catch (e) {
      return { ok: false, reason: "migration-failed", detail: String(e?.message ?? e).slice(0, 160) };
    }
  }
  const after = await getSchemaVersion(db);
  if (!after.ok) return after;
  if (after.version !== CURRENT_SCHEMA_VERSION) {
    return { ok: false, reason: "migration-failed", detail: `expected-${CURRENT_SCHEMA_VERSION}-got-${after.version}` };
  }
  return { ok: true, version: after.version, applied: true };
}
