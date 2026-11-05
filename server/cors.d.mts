// Types for server/cors.mjs (server-only, never browser).
export declare const DEV_ORIGINS: string[];
export declare function parseOrigins(raw: unknown): string[] | null;
export declare function resolveCorsConfig(
  env?: Record<string, unknown>,
): { ok: true; origins: string[] } | { ok: false; reason: string };
export declare function applyCors(
  req: { method?: string; headers?: Record<string, unknown> },
  res: { setHeader: Function; writeHead: Function; end: Function },
  origins: string[],
): { handled: boolean };
