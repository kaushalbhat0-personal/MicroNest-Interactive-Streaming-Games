// Types for server/persistence/migrate.mjs (server-only).
export declare const CURRENT_SCHEMA_VERSION: number;
export declare const MIGRATION_FILES: string[];
export interface DbClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>;
}
export declare function loadMigrationSql(name: string): Promise<string>;
export declare function getSchemaVersion(db: DbClient): Promise<{ ok: true; version: number } | { ok: false; reason: string; detail?: string }>;
export declare function ensureMigrated(
  db: DbClient,
): Promise<{ ok: true; version: number; applied: boolean } | { ok: false; reason: string; detail?: string; version?: number }>;
