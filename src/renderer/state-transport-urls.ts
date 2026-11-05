/**
 * T4F-C2.7-D1-F2 — state-transport base URL resolution (browser-only).
 *
 * The ONLY browser module allowed to read a Vite client env var. It reads
 * exactly one public value — `VITE_STATE_BASE_URL` (a backend origin, never
 * a credential) — so direct browser→Render snapshot/SSE traffic can bypass
 * the Vercel external rewrite, whose ~120 s proxy lifetime would otherwise
 * recycle every long-lived event stream. Dashboard mutations and every other
 * `/api/*` call stay on same-origin relative URLs through the rewrite.
 *
 * Security boundary (enforced by tests): no Node-style environment access,
 * no other `VITE_*` name, and no secret-shaped name (TOKEN/SECRET/KEY/DATABASE/
 * AUTHORITY/GOOGLE) may ever be referenced from browser source.
 */

export const STATE_SNAPSHOT_PATH = "/api/state/snapshot";
export const STATE_STREAM_PATH = "/api/state/stream";

/**
 * Normalize a configured base URL. Returns the origin root with trailing
 * slashes removed, or null when the value is absent or not an http(s)
 * origin (relative paths, other schemes, and bare hostnames fall back to
 * same-origin relative transport URLs).
 */
export function normalizeStateBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+/i.test(clean)) return null;
  return clean;
}

/** Read the configured base URL from the Vite client env (null when unset). */
export function configuredStateBaseUrl(): string | null {
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
    return normalizeStateBaseUrl(env?.VITE_STATE_BASE_URL ?? null);
  } catch {
    return null;
  }
}

export interface StateTransportUrls {
  snapshotUrl: string;
  streamUrl: string;
}

/**
 * Resolve the snapshot + SSE stream URLs. Absolute direct-to-backend URLs
 * when `VITE_STATE_BASE_URL` is configured; the historical relative
 * `/api/state/*` URLs otherwise (local dev and rewrite deployments).
 * Query parameters (`since`, `format`) are still appended by the transport
 * client, so the returned stream URL carries no query string of its own.
 */
export function resolveStateTransportUrls(base?: unknown): StateTransportUrls {
  const normalized = normalizeStateBaseUrl(base === undefined ? configuredStateBaseUrl() : base);
  if (!normalized) {
    return { snapshotUrl: STATE_SNAPSHOT_PATH, streamUrl: STATE_STREAM_PATH };
  }
  return {
    snapshotUrl: `${normalized}${STATE_SNAPSHOT_PATH}`,
    streamUrl: `${normalized}${STATE_STREAM_PATH}`,
  };
}
