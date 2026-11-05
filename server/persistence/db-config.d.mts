// Types for server/persistence/db-config.mjs (server-only, never browser).
export declare const PERSISTENCE_BACKENDS: string[];
export declare const CREDENTIAL_IDS: string[];
export declare const METADATA_KEYS: string[];
export declare const DEFAULT_POOL: {
  max: number;
  min: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
};
export declare const STATEMENT_TIMEOUT_MS: number;
export declare function redactDatabaseUrl(url: unknown): string;
export interface FilePersistenceConfig {
  backend: "file";
}
export interface PostgresPersistenceConfig {
  backend: "postgres";
  databaseUrl: string;
  host: string;
  requireTls: boolean;
  pool: { max: number; min: number; idleTimeoutMillis: number; connectionTimeoutMillis: number };
  statementTimeoutMs: number;
}
export declare function resolvePersistenceConfig(
  env?: Record<string, unknown>,
): { ok: true; config: FilePersistenceConfig | PostgresPersistenceConfig } | { ok: false; reason: string };
export declare function poolOptionsFor(config: PostgresPersistenceConfig): Record<string, unknown>;
export declare function createPgPool(
  config: PostgresPersistenceConfig,
  opts?: { importImpl?: (spec: string) => Promise<unknown> },
): Promise<{ ok: true; pool: { query: Function; end: () => Promise<void>; on: Function } } | { ok: false; reason: string }>;
export declare function requireAuthorityTokenEnv(env?: Record<string, unknown>): { ok: true; token: string } | { ok: false; reason: string };
