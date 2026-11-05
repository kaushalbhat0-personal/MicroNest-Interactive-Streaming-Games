// Types for oauth-state-store.mjs (server-side OAuth state primitive).
export declare const STATE_TTL_MS: number;
export declare const STATE_RANDOM_BYTES: number;
export declare const MAX_STATE_RECORDS: number;

export type ConsumeResult = { ok: true; data?: string } | { ok: false; reason: string };

export interface StateCreateOpts {
  /** Optional opaque binding (e.g. a correlation-secret hash). */
  data?: string;
}

export interface StateStoreOpts {
  path: string;
  ttlMs?: number;
  now?: () => number;
  randomBytesImpl?: (n: number) => Uint8Array;
  maxRecords?: number;
}

export declare class OAuthStateStore {
  constructor(opts?: StateStoreOpts);
  path: string;
  ttlMs: number;
  maxRecords: number;
  storageCorrupt: boolean;
  loaded: boolean;
  init(): Promise<{ ok: boolean; restored: number; corrupt?: boolean }>;
  recordCount(): number;
  create(opts?: StateCreateOpts): Promise<string>;
  consume(supplied: unknown): Promise<ConsumeResult>;
  cleanup(): Promise<number>;
}
