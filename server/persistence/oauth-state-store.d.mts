// Types for server/persistence/oauth-state-store.mjs (server-only).
export declare const STATE_TTL_MS: number;
export declare const STATE_RANDOM_BYTES: number;
export declare const MAX_STATE_RECORDS: number;
export type ConsumeResult = { ok: true; data?: string } | { ok: false; reason: string };
export interface DbClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>;
}
export declare class PgOAuthStateStore {
  constructor(opts?: { db: DbClient; ttlMs?: number; now?: () => number; randomBytesImpl?: (n: number) => Uint8Array; maxRecords?: number });
  ttlMs: number;
  maxRecords: number;
  storageCorrupt: boolean;
  loaded: boolean;
  init(): Promise<{ ok: boolean; restored?: number; reason?: string }>;
  count(): Promise<number>;
  create(opts?: { data?: string }): Promise<string>;
  consume(supplied: unknown): Promise<ConsumeResult>;
  cleanup(): Promise<number>;
}
