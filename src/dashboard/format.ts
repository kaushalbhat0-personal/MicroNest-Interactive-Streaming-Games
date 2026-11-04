/**
 * T4E — viewer overlay format selection (PURE except guarded storage).
 *
 * Landscape 16:9 (1920×1080, default) vs portrait 9:16 (1080×1920).
 * The overlay composition is chosen at page load via `?format=portrait`
 * (fixed-resolution Phaser design — one GameScene, one Game); the console
 * never resizes the live canvas. Zero imports, like the other dashboard
 * modules. No engine rules, no art, no network, no OAuth scopes.
 */

export type OverlayFormat = "landscape" | "portrait";

export const OVERLAY_FORMATS: readonly OverlayFormat[] = ["landscape", "portrait"] as const;

export interface FormatDims {
  width: number;
  height: number;
  aspect: string;
}

/** Authoritative canvas/source dimensions per format (T4B wireframes). */
export const FORMAT_DIMS: Record<OverlayFormat, FormatDims> = {
  landscape: { width: 1920, height: 1080, aspect: "16:9" },
  portrait: { width: 1080, height: 1920, aspect: "9:16" },
};

export const PORTRAIT_QUERY = "?format=portrait";
export const OVERLAY_ROUTE = "/overlay.html";

/**
 * Parse a raw `?format=` query value. Anything that is not exactly
 * `portrait` falls back to landscape (existing default; direct
 * `overlay.html` URLs keep working).
 */
export function parseOverlayFormat(raw: unknown): OverlayFormat {
  return raw === "portrait" ? "portrait" : "landscape";
}

/**
 * Build the overlay URL for a format from the actual application origin.
 * Empty when no safe http(s) origin is available (caller shows manual
 * guidance). Never hardcodes a production host.
 */
export function overlayUrl(origin: string, format: OverlayFormat): string {
  const clean = typeof origin === "string" ? origin.replace(/\/$/, "") : "";
  if (!clean || (!clean.startsWith("http://") && !clean.startsWith("https://"))) return "";
  return format === "portrait" ? `${clean}${OVERLAY_ROUTE}${PORTRAIT_QUERY}` : `${clean}${OVERLAY_ROUTE}`;
}

export const STORED_FORMAT_KEY = "tidebound.overlay.format";

function storage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } | null {
  try {
    const g = globalThis as unknown as { localStorage?: unknown };
    const ls = g.localStorage as { getItem?: unknown; setItem?: unknown } | undefined;
    if (!ls || typeof ls.getItem !== "function" || typeof ls.setItem !== "function") return null;
    return ls as { getItem(k: string): string | null; setItem(k: string, v: string): void };
  } catch {
    return null;
  }
}

/**
 * Restore the creator's format preference. Defaults to landscape when
 * nothing (or nothing valid) was stored, or when storage is unavailable
 * (private mode, SSR, test env). Never throws.
 */
export function getStoredFormat(): OverlayFormat {
  try {
    const ls = storage();
    if (!ls) return "landscape";
    return parseOverlayFormat(ls.getItem(STORED_FORMAT_KEY));
  } catch {
    return "landscape";
  }
}

/**
 * Persist the creator's format preference. Returns false (and stores
 * nothing) for invalid values. Never throws.
 */
export function setStoredFormat(format: unknown): boolean {
  if (format !== "landscape" && format !== "portrait") return false;
  try {
    const ls = storage();
    if (!ls) return false;
    ls.setItem(STORED_FORMAT_KEY, format);
    return true;
  } catch {
    return false;
  }
}

/** Human line for the active-format status (text, never color-alone). */
export function activeFormatLine(format: OverlayFormat): string {
  const d = FORMAT_DIMS[format];
  return format === "portrait"
    ? `Active overlay format: Portrait — 9:16 · ${d.width}×${d.height}`
    : `Active overlay format: Landscape — 16:9 · ${d.width}×${d.height}`;
}
