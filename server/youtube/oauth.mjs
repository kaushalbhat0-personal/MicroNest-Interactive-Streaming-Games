// Minimal OAuth 2.0 for the local spike (installed-app loopback flow).
// No googleapis dependency: plain fetch against Google's OAuth endpoints.
// Secrets stay in this server process — never sent to the browser.
import { readFile, writeFile, unlink } from "node:fs/promises";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export function buildAuthUrl({ clientId, redirectUri, scopes }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
  });
  return `${AUTH_URL}?${q.toString()}`;
}

export async function exchangeCode({ clientId, clientSecret, redirectUri, code, fetchImpl = fetch }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!res.ok) throw new Error(`token-exchange-failed:${res.status}`);
  const tokens = await res.json();
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? null,
    expires_at: Date.now() + (Number(tokens.expires_in ?? 3600) - 60) * 1000,
  };
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) throw new Error(`token-refresh-failed:${res.status}`);
  const tokens = await res.json();
  return {
    access_token: tokens.access_token,
    expires_at: Date.now() + (Number(tokens.expires_in ?? 3600) - 60) * 1000,
  };
}

export async function loadTokens(path) {
  try {
    const raw = await readFile(path, "utf8");
    const t = JSON.parse(raw);
    if (t && t.access_token) return t;
  } catch {
    /* none */
  }
  return null;
}

/** Persist tokens with owner-only permissions. */
export async function saveTokens(path, tokens) {
  await writeFile(path, JSON.stringify(tokens), { encoding: "utf8", mode: 0o600 });
}

export async function clearTokens(path) {
  try {
    await unlink(path);
  } catch {
    /* already gone */
  }
}
