// T4F-C1 — shared authority-token helper (Node builtins only).
// Used by BOTH server/state-server.mjs (gates POST /api/state/publish)
// and server/authority-server.ts (issues + gates the control API).
// The token is provisioned out-of-band: explicit `AUTHORITY_TOKEN` env for
// tests/ephemeral setups, else a generated value persisted at
// data/authority-token.json (mode 0600, gitignored via data/*.json).
// This module NEVER logs or returns the token to callers that print it;
// callers print only "generated" / "loaded" facts.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";

export const TOKEN_FILE = "authority-token.json";
export const TOKEN_BYTES = 32;

/** Resolve the authority token. Returns the value + whether it was generated. */
export async function resolveAuthorityToken(dataDir) {
  const fromEnv = process.env.AUTHORITY_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.length >= 16) {
    return { token: fromEnv, generated: false, source: "env" };
  }
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, TOKEN_FILE);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.token === "string" && parsed.token.length >= 16) {
      return { token: parsed.token, generated: false, source: "file" };
    }
  } catch {
    /* missing/corrupt -> generate below */
  }
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  await writeFile(path, JSON.stringify({ token }, null, 2), { mode: 0o600, encoding: "utf8" });
  try {
    await chmod(path, 0o600);
  } catch {
    /* best-effort on filesystems without modes */
  }
  return { token, generated: true, source: "file" };
}

/** Parse `Authorization: Bearer <token>` (header only — never query). */
export function bearerToken(req) {
  const h = req.headers?.authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer ([A-Za-z0-9._~+/-]{8,256}=*)$/.exec(h.trim());
  return m ? m[1] : null;
}

/**
 * Constant-time token comparison. Length mismatch short-circuits on
 * buffers of the PUBLIC length only (never the secret), then compares.
 */
export function tokensEqual(presented, actual) {
  if (typeof presented !== "string" || typeof actual !== "string") return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
