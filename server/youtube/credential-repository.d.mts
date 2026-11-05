// Types for credential-repository.mjs (encrypted YouTube credential store).
export declare const ENVELOPE_VERSION: number;
export declare const ENVELOPE_ALG: string;

export interface ChannelIdentity {
  id?: string;
  handle?: string;
  title?: string;
  [k: string]: unknown;
}

export interface YoutubeCredentials {
  access_token: string;
  refresh_token?: string | null;
  expires_at?: number;
  scopes?: string[];
  channel?: ChannelIdentity | null;
  obtainedAt?: number;
  updatedAt?: number;
  [k: string]: unknown;
}

export declare function validateCredentials(c: unknown): boolean;
export declare function decodeEncryptionKey(key: unknown): Buffer;

export declare class CredentialStoreError extends Error {
  code: string;
  constructor(code: string, detail?: string);
}

export interface CredentialRepositoryOpts {
  path: string;
  key: unknown;
  randomBytesImpl?: (n: number) => Uint8Array;
}

export declare class CredentialRepository {
  constructor(opts?: CredentialRepositoryOpts);
  path: string;
  load(): Promise<YoutubeCredentials | null>;
  hasCredentials(): Promise<boolean>;
  save(credentials: unknown): Promise<{ ok: boolean }>;
  clear(): Promise<{ ok: boolean }>;
}
