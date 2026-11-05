// Types for server/persistence/credential-store.mjs (server-only).
import type { YoutubeCredentials } from "../youtube/credential-repository";
export declare class CredentialStoreError extends Error {
  code: string;
  constructor(code: string, detail?: string);
}
export interface DbClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>;
}
export interface DbCredentialRepositoryOpts {
  db: DbClient;
  id: "youtube-credentials" | "youtube-pending-grant";
  key: unknown;
  randomBytesImpl?: (n: number) => Uint8Array;
}
export declare class DbCredentialRepository {
  constructor(opts?: DbCredentialRepositoryOpts);
  id: string;
  load(): Promise<YoutubeCredentials | null>;
  hasCredentials(): Promise<boolean>;
  save(credentials: unknown): Promise<{ ok: boolean }>;
  clear(): Promise<{ ok: boolean }>;
}
