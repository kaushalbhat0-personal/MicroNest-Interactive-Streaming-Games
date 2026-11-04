/**
 * Type declarations for ../authority-token.mjs (see server/youtube/adapter.d.mts precedent).
 * The token value is a credential: it is typed as an opaque string and this
 * module exposes no logging or serialization of it.
 */
export declare const TOKEN_FILE: string;
export declare const TOKEN_BYTES: number;
export declare function resolveAuthorityToken(dataDir: string): Promise<{
  token: string;
  generated: boolean;
  source: "env" | "file";
}>;
export declare function bearerToken(req: { headers?: Record<string, unknown> }): string | null;
export declare function tokensEqual(presented: unknown, actual: unknown): boolean;
