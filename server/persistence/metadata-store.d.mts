// Types for server/persistence/metadata-store.mjs (server-only).
export interface DbClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>;
}
export type MetadataKey = "authority-cursor" | "youtube-adapter-cursor" | "youtube-pending-channel";
export declare class DbMetadataStore {
  constructor(opts?: { db: DbClient });
  get(key: MetadataKey): Promise<Record<string, unknown> | null>;
  set(key: MetadataKey, value: Record<string, unknown>): Promise<{ ok: boolean }>;
  delete(key: MetadataKey): Promise<{ ok: boolean }>;
}
