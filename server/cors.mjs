// T4F-C2.7-D1-D — narrow CORS allowlist (server-only, never browser).
//
// Replaces the local-dev wildcard (`*`) with an explicit origin allowlist
// for the Render deployment. The browser dashboard (Vercel) and overlays
// reach the API same-origin via Vercel rewrites or directly; either way the
// browser sends an Origin that must be allowlisted here.
//
// - Local dev stays configurable: unset CORS_ORIGINS defaults to the Vite
//   dev origins (existing workflows preserved).
// - Production (NODE_ENV=production) requires explicit CORS_ORIGINS —
//   missing/invalid fails boot instead of silently opening or closing.
// - Auth travels in the Authorization header (operator bearer); no cookies,
//   so no `allow-credentials` is needed or sent.
// - Unknown origins are REJECTED (403, no ACAO headers) on both preflight
//   and actual requests — never silently served cross-origin.
// - Requests without an Origin header (curl, Render health checks,
//   same-origin navigations) proceed without CORS headers.
// - Nothing here logs origins beyond echoing an allowed value back to its
//   own browser (never secrets — origins contain no credentials).

export const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/** Parse + validate a comma-separated origin list. Null on any invalid entry. */
export function parseOrigins(raw) {
  if (typeof raw !== "string") return null;
  const list = raw
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => s.length > 0);
  if (list.length === 0) return null;
  const seen = new Set();
  for (const o of list) {
    if (!ORIGIN_RE.test(o) || seen.has(o)) return null;
    seen.add(o);
  }
  return [...seen];
}

export function resolveCorsConfig(env = process.env) {
  const nodeEnv = typeof env?.NODE_ENV === "string" ? env.NODE_ENV : "";
  const raw = typeof env?.CORS_ORIGINS === "string" ? env.CORS_ORIGINS : "";
  if (!raw || raw.trim().length === 0) {
    if (nodeEnv === "production") return { ok: false, reason: "cors-origins-required" };
    return { ok: true, origins: [...DEV_ORIGINS] };
  }
  const origins = parseOrigins(raw);
  if (!origins) return { ok: false, reason: "cors-origins-invalid" };
  return { ok: true, origins };
}

function originOf(req) {
  const h = req?.headers?.origin;
  if (typeof h !== "string" || h.length === 0 || h.length > 512) return null;
  return h.trim().replace(/\/+$/, "");
}

/**
 * Apply CORS policy. Sets `Vary: Origin` always. Returns {handled:true}
 * when the response was completed here (allowed preflight 204, or rejected
 * unknown origin 403). Otherwise {handled:false} and the host proceeds
 * (ACAO/ACAM/ACAH set when the origin is allowlisted).
 */
export function applyCors(req, res, origins) {
  try {
    res.setHeader("vary", "Origin");
  } catch {
    /* header best-effort */
  }
  const origin = originOf(req);
  if (!origin) return { handled: false };
  const allowed = Array.isArray(origins) && origins.includes(origin);
  if (!allowed) {
    // Unknown origin: rejected explicitly (no ACAO — the browser blocks).
    try {
      res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "origin-not-allowed" }));
    } catch {
      /* rejection best-effort */
    }
    return { handled: true };
  }
  try {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
  } catch {
    /* header best-effort */
  }
  if (req.method === "OPTIONS") {
    try {
      res.writeHead(204).end();
    } catch {
      /* preflight best-effort */
    }
    return { handled: true };
  }
  return { handled: false };
}
