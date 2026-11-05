// T4F-C2.7-C — server-side YouTube OAuth Web Server flow (no HTTP in this module).
//
// Responsibility: configuration validation, authorization-URL construction,
// browser-correlation helpers, authorization-code exchange, channel-identity
// lookup, callback orchestration, and the neutral landing page. HTTP route
// wiring lives in server/authority-server.ts; persistence in
// credential-repository.mjs; nonces in oauth-state-store.mjs.
//
// Security boundaries (see the T4F-C2.7 Phase 1 audit):
// - Client secret + encryption key never leave this process (URL builders
//   take only the client ID; nothing here returns secrets).
// - State is single-use and consumed BEFORE any Google contact, so two
//   concurrent callbacks can never cause two exchanges.
// - Browser correlation (a high-entropy secret whose hash is bound to the
//   state record) is validated BEFORE any Google contact. Missing/wrong
//   correlation fails without an exchange; the spent state forces re-Connect.
// - The shared authority bearer is operator authentication, NOT browser
//   correlation, and is never accepted as the correlation secret.
// - T3 scopes are imported from server/youtube/config.mjs (single source
//   of truth) — never restated here.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { YT } from "./config.mjs";

export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const CHANNELS_ENDPOINT = "https://www.googleapis.com/youtube/v3/channels";
export const EXCHANGE_TIMEOUT_MS = 15000;
export const IDENTITY_TIMEOUT_MS = 15000;
export const CORRELATION_BYTES = 32;
export const CORRELATION_MAX_AGE_SEC = 600;

/** Exact T3 scopes. Re-exported from the single source of truth. */
export const OAUTH_SCOPES = [...YT.scopes];

// ---------------------------------------------------------------------------
// Configuration boundary
// ---------------------------------------------------------------------------

/**
 * Validate server-side OAuth configuration. Reads NOTHING itself — the
 * caller passes values (env in production, fixtures in tests).
 * Returns {ok:true, config} or {ok:false, reason}. Reasons never echo values.
 * Cloud/production mode requires an exact HTTPS redirect URI; an explicit
 * opt-in allows http://127.0.0.1 loopback for local development only.
 */
export function loadOAuthConfig(input = {}) {
  const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
  const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret : "";
  const redirectUri = typeof input.redirectUri === "string" ? input.redirectUri.trim() : "";
  const encryptionKey = input.encryptionKey;
  const dashboardUrl = typeof input.dashboardUrl === "string" ? input.dashboardUrl.trim() : "";
  if (!clientId || clientId.length > 512) return { ok: false, reason: "oauth-client-misconfigured" };
  if (!clientSecret || clientSecret.length > 1024) return { ok: false, reason: "oauth-client-misconfigured" };
  let redirect;
  try {
    redirect = new URL(redirectUri);
  } catch {
    return { ok: false, reason: "oauth-redirect-misconfigured" };
  }
  const allowLoopback = input.allowHttpLoopback === true;
  const isLoopback = (redirect.protocol === "http:" && (redirect.hostname === "127.0.0.1" || redirect.hostname === "localhost"));
  if (redirect.protocol === "https:") {
    if (redirect.hash || redirect.username || redirect.password) return { ok: false, reason: "oauth-redirect-misconfigured" };
  } else if (allowLoopback && isLoopback) {
    /* explicit local-dev only */
  } else {
    return { ok: false, reason: "oauth-redirect-misconfigured" };
  }
  if (!encryptionKey) return { ok: false, reason: "oauth-encryption-misconfigured" };
  if (dashboardUrl) {
    try {
      const d = new URL(dashboardUrl);
      if (d.protocol !== "https:" && d.protocol !== "http:") return { ok: false, reason: "oauth-dashboard-misconfigured" };
    } catch {
      return { ok: false, reason: "oauth-dashboard-misconfigured" };
    }
  }
  let redirectPath;
  try {
    redirectPath = redirect.pathname || "/";
  } catch {
    return { ok: false, reason: "oauth-redirect-misconfigured" };
  }
  return {
    ok: true,
    config: {
      clientId,
      clientSecret,
      redirectUri: redirect.toString(),
      redirectPath,
      encryptionKey,
      dashboardUrl: dashboardUrl || null,
      isProd: redirect.protocol === "https:",
    },
  };
}

// ---------------------------------------------------------------------------
// Browser correlation (NOT the authority bearer)
// ---------------------------------------------------------------------------

export function mintCorrelationSecret(randomBytesImpl = randomBytes) {
  const buf = randomBytesImpl(CORRELATION_BYTES);
  if (!buf || buf.length !== CORRELATION_BYTES) throw new Error("correlation-randomness-unavailable");
  return Buffer.from(buf).toString("base64url");
}

export function hashCorrelation(secret) {
  return createHash("sha256").update(String(secret), "utf8").digest("hex");
}

export function correlationCookieName(secure) {
  // __Host- prefix (no Domain, Path=/, Secure) when the channel is HTTPS.
  // Plain name for explicit http-loopback development only.
  return secure ? "__Host-yt-oauth-corr" : "yt-oauth-corr";
}

export function buildCorrelationSetCookie(secret, { secure }) {
  const name = correlationCookieName(secure);
  const parts = [`${name}=${secret}`, "Path=/", `Max-Age=${CORRELATION_MAX_AGE_SEC}`, "HttpOnly", "SameSite=Lax"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Extract the correlation secret from a Cookie header. Null when absent/malformed. */
export function parseCorrelationCookie(header, { secure }) {
  if (typeof header !== "string" || header.length === 0 || header.length > 8192) return null;
  const name = correlationCookieName(secure);
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const value = part.slice(idx + 1).trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) return null;
    return value;
  }
  return null;
}

function correlationMatches(presented, expectedHash) {
  if (typeof presented !== "string" || typeof expectedHash !== "string") return false;
  let a, b;
  try {
    a = Buffer.from(hashCorrelation(presented), "hex");
    b = Buffer.from(expectedHash, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Authorization URL (server-built; the browser never constructs it)
// ---------------------------------------------------------------------------

export function buildWebAuthUrl({ config, state }) {
  if (!config || typeof config.clientId !== "string" || typeof config.redirectUri !== "string") {
    throw new Error("oauth-not-configured");
  }
  if (typeof state !== "string" || state.length === 0) throw new Error("oauth-state-required");
  const q = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  });
  return `${AUTH_ENDPOINT}?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// Google server-to-server calls (fetchImpl injected; mocked in tests)
// ---------------------------------------------------------------------------

function timeoutSignal(ms) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

/**
 * Exchange an authorization code (Web Server grant). Single attempt — the
 * code may already be consumed server-side, so blind retry is forbidden.
 * Returns {ok:true, tokens} or {ok:false, reason}.
 */
export async function exchangeAuthCode({ config, code, fetchImpl = fetch, timeoutMs = EXCHANGE_TIMEOUT_MS }) {
  let res;
  try {
    res = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      }).toString(),
      signal: timeoutSignal(timeoutMs),
    });
  } catch (e) {
    return { ok: false, reason: e && e.name === "AbortError" ? "exchange-timeout" : "exchange-failed" };
  }
  if (!res || !res.ok) return { ok: false, reason: "exchange-failed" };
  let body = null;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: "invalid-token-response" };
  }
  if (!body || typeof body.access_token !== "string" || body.access_token.length === 0) {
    return { ok: false, reason: "invalid-token-response" };
  }
  return {
    ok: true,
    tokens: {
      access_token: body.access_token,
      refresh_token: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
      expires_at: Date.now() + (Number(body.expires_in ?? 3600) - 60) * 1000,
    },
  };
}

/**
 * Read the authorized channel identity (non-secret fields only).
 * Returns {ok:true, channel:{id,title,handle?}} or {ok:false, reason}.
 * Never invents missing values.
 */
export async function fetchChannelIdentity({ accessToken, fetchImpl = fetch, timeoutMs = IDENTITY_TIMEOUT_MS }) {
  let res;
  try {
    const url = new URL(CHANNELS_ENDPOINT);
    url.searchParams.set("part", "id,snippet");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", "1");
    res = await fetchImpl(url.toString(), {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: timeoutSignal(timeoutMs),
    });
  } catch {
    return { ok: false, reason: "identity-unavailable" };
  }
  if (!res || !res.ok) return { ok: false, reason: "identity-unavailable" };
  let body = null;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: "identity-unavailable" };
  }
  const item = Array.isArray(body?.items) ? body.items[0] : null;
  const id = item && typeof item.id === "string" && item.id ? item.id : null;
  const title = item?.snippet && typeof item.snippet.title === "string" && item.snippet.title ? item.snippet.title : null;
  if (!id) return { ok: false, reason: "identity-unavailable" };
  const channel = { id };
  if (title) channel.title = title;
  const customUrl = item?.snippet && typeof item.snippet.customUrl === "string" ? item.snippet.customUrl : null;
  if (customUrl) channel.handle = customUrl;
  return { ok: true, channel };
}

// ---------------------------------------------------------------------------
// Callback orchestration (no HTTP; the route layer is thin)
// ---------------------------------------------------------------------------

/**
 * Full server-side callback handling. Order of gates:
 *  1. error/missing/contradictory parameters (no state touched)
 *  2. atomic state consumption (single-use; concurrent callbacks: one wins)
 *  3. browser-correlation validation (before ANY Google contact)
 *  4. code exchange (single attempt)
 *  5. channel identity (fail closed)
 *  6. mismatch vs existing grant (stage pending, never silently switch)
 *  7. encrypted persistence (prior grant intact on failure)
 *
 * current: {refresh_token, obtainedAt, channel:{id}|null} | null — non-secret
 * summary of the stored grant, for retention + mismatch decisions.
 */
export async function handleOAuthCallback(deps) {
  const {
    config,
    stateStore,
    query = {},
    cookieSecret = null,
    fetchImpl = fetch,
    now = Date.now,
    current = null,
    persistGrant,
    stagePendingGrant,
  } = deps || {};
  if (!config || !stateStore || typeof persistGrant !== "function" || typeof stagePendingGrant !== "function") {
    return { ok: false, reason: "oauth-not-configured" };
  }
  const { code, state, error } = query;
  if (typeof error === "string" && error) {
    if (typeof code === "string" && code) return { ok: false, reason: "callback-error" };
    if (error === "access_denied") return { ok: false, reason: "access-denied" };
    return { ok: false, reason: "callback-error" };
  }
  if (typeof code !== "string" || !code || code.length > 2048) return { ok: false, reason: "missing-code" };
  if (typeof state !== "string" || !state) return { ok: false, reason: "missing-state" };

  // Gate 2: atomic single-use consumption before anything else observable.
  let consumed;
  try {
    consumed = await stateStore.consume(state);
  } catch {
    return { ok: false, reason: "state-unavailable" };
  }
  if (!consumed || !consumed.ok) return { ok: false, reason: consumed?.reason ?? "unknown-state" };

  // Gate 3: browser correlation before ANY Google contact.
  if (!correlationMatches(cookieSecret, consumed.data ?? null)) {
    return { ok: false, reason: cookieSecret == null ? "correlation-missing" : "correlation-mismatch" };
  }

  // Gate 4: single code-exchange attempt.
  const exchanged = await exchangeAuthCode({ config, code, fetchImpl });
  if (!exchanged.ok) return { ok: false, reason: exchanged.reason };

  // Refresh-token retention: keep the stored grant's token when Google
  // omits a replacement; adopt Google's when it issues a new one.
  const refresh_token = exchanged.tokens.refresh_token ?? current?.refresh_token ?? null;
  const obtainedAt =
    typeof current?.obtainedAt === "number" && Number.isFinite(current.obtainedAt) ? current.obtainedAt : now();

  // Gate 5: channel identity, fail closed (never invent).
  const identity = await fetchChannelIdentity({ accessToken: exchanged.tokens.access_token, fetchImpl });
  if (!identity.ok) return { ok: false, reason: identity.reason };

  // Gate 6: never silently rebind a different channel.
  const previousId = current?.channel && typeof current.channel.id === "string" ? current.channel.id : null;
  if (previousId && previousId !== identity.channel.id) {
    const creds = {
      access_token: exchanged.tokens.access_token,
      refresh_token,
      expires_at: exchanged.tokens.expires_at,
      scopes: [...OAUTH_SCOPES],
      channel: identity.channel,
      obtainedAt,
      updatedAt: now(),
    };
    try {
      await stagePendingGrant({ creds, newChannel: identity.channel, previousChannelId: previousId });
    } catch {
      return { ok: false, reason: "persistence-failed" };
    }
    return {
      ok: false,
      reason: "channel-mismatch",
      pendingChannel: { previousChannelId: previousId, newChannel: identity.channel },
    };
  }

  // Gate 7: encrypted persistence (full valid grant only).
  const creds = {
    access_token: exchanged.tokens.access_token,
    refresh_token,
    expires_at: exchanged.tokens.expires_at,
    scopes: [...OAUTH_SCOPES],
    channel: identity.channel,
    obtainedAt,
    updatedAt: now(),
  };
  try {
    await persistGrant(creds);
  } catch {
    return { ok: false, reason: "persistence-failed" };
  }
  return { ok: true, channel: identity.channel };
}

// ---------------------------------------------------------------------------
// Neutral landing page + headers (no untrusted reflection)
// ---------------------------------------------------------------------------

export const OAUTH_SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const GENERIC_MESSAGE = {
  ok: "YouTube authorization completed. You can close this tab and return to the dashboard.",
  "access-denied": "Authorization was not completed. You can close this tab and return to the dashboard.",
  "channel-mismatch":
    "A different YouTube channel was authorized than the one already connected. Nothing was changed. Confirm the channel switch in the dashboard to proceed.",
  other: "Authorization did not complete. You can close this tab and return to the dashboard.",
};

function landingMessage(outcome) {
  if (outcome && outcome.ok) return GENERIC_MESSAGE.ok;
  if (outcome?.reason === "access-denied") return GENERIC_MESSAGE["access-denied"];
  if (outcome?.reason === "channel-mismatch") return GENERIC_MESSAGE["channel-mismatch"];
  return GENERIC_MESSAGE.other;
}

export function renderLandingPage(outcome, dashboardUrl) {
  const message = landingMessage(outcome);
  const link =
    typeof dashboardUrl === "string" && dashboardUrl
      ? `<p><a href="${escapeAttr(dashboardUrl)}">Return to the dashboard</a></p>`
      : "";
  return (
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
    "<title>Tidebound YouTube authorization</title></head>" +
    `<body><main><h1>YouTube authorization</h1><p>${escapeHtml(message)}</p>${link}</main></body></html>`
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#96;");
}
