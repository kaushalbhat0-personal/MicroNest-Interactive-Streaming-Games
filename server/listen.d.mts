// Types for server/listen.mjs (server-only).
export declare const LOOPBACK_HOSTS: string[];
export declare const PUBLIC_HOST: string;
export declare function resolveListenerConfig(args?: {
  defaultPort: number;
  env?: Record<string, unknown>;
  argvPort?: unknown;
  overrides?: { port?: unknown; host?: unknown };
}): { ok: true; host: string; port: number } | { ok: false; reason: string };
