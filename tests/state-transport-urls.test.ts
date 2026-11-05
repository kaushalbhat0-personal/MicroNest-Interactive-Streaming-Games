/**
 * T4F-C2.7-D1-F2 — direct Render state-transport URL wiring.
 *
 * `VITE_STATE_BASE_URL` (public backend origin, never a credential) lets
 * browser snapshot/SSE traffic bypass the Vercel external rewrite's ~120 s
 * proxy lifetime. Unset/invalid values preserve the historical relative
 * `/api/state/*` URLs. Dashboard mutations stay same-origin (see below).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalBackendOrigin,
  normalizeStateBaseUrl,
  OAUTH_START_PATH,
  resolveOAuthStartUrl,
  resolveStateTransportUrls,
  STATE_SNAPSHOT_PATH,
  STATE_STREAM_PATH,
} from "../src/renderer/state-transport-urls";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RENDER = "https://tidebound-api.onrender.com";
const OAUTH_CALLBACK = "https://tidebound-api.onrender.com/api/youtube/oauth-callback";

describe("D1-F2 state-transport base URL resolution", () => {
  it("configured base yields direct snapshot + SSE URLs", () => {
    expect(resolveStateTransportUrls(RENDER)).toEqual({
      snapshotUrl: `${RENDER}/api/state/snapshot`,
      streamUrl: `${RENDER}/api/state/stream`,
    });
  });

  it("returned stream URL composes with the transport client's query params", () => {
    const { streamUrl } = resolveStateTransportUrls(RENDER);
    expect(streamUrl).not.toContain("?");
    // openStream appends `?since=&format=`; the composition must parse and
    // preserve every parameter (cursor + format routing intact).
    const composed = new URL(`${streamUrl}?since=41&format=landscape`);
    expect(composed.searchParams.get("since")).toBe("41");
    expect(composed.searchParams.get("format")).toBe("landscape");
    expect(composed.origin + composed.pathname).toBe(`${RENDER}/api/state/stream`);
  });

  it("falls back to relative URLs when unconfigured or invalid", () => {
    const relative = { snapshotUrl: STATE_SNAPSHOT_PATH, streamUrl: STATE_STREAM_PATH };
    expect(STATE_SNAPSHOT_PATH).toBe("/api/state/snapshot");
    expect(STATE_STREAM_PATH).toBe("/api/state/stream");
    for (const bad of [undefined, null, "", "   ", "not-a-url", "/relative/path", "ftp://x.example.com/file", "https://", "tidebound-api.onrender.com"]) {
      expect(resolveStateTransportUrls(bad)).toEqual(relative);
    }
  });

  it("normalizes trailing slashes and surrounding whitespace deterministically", () => {
    expect(normalizeStateBaseUrl(`${RENDER}/`)).toBe(RENDER);
    expect(normalizeStateBaseUrl(`${RENDER}///`)).toBe(RENDER);
    expect(normalizeStateBaseUrl(`  ${RENDER}/  `)).toBe(RENDER);
    const once = resolveStateTransportUrls(`${RENDER}/`);
    const twice = resolveStateTransportUrls(`${RENDER}//`);
    expect(once).toEqual(twice);
    expect(once.snapshotUrl).toBe(`${RENDER}/api/state/snapshot`);
  });
});

describe("D1-F2 both renderer entry paths receive the configuration", () => {
  const rendererSrc = readFileSync(join(ROOT, "src", "renderer", "renderer.ts"), "utf8");
  const mainSrc = readFileSync(join(ROOT, "src", "main.ts"), "utf8");

  it("overlay (renderer.ts) resolves transport URLs into the transport opts", () => {
    expect(rendererSrc).toContain("resolveStateTransportUrls");
    expect(rendererSrc).toMatch(/connectRendererTransport\(\{[^}]*\},\s*\{\s*format,\s*\.\.\.resolveStateTransportUrls\(\)/);
  });

  it("dashboard preview (main.ts) resolves transport URLs into the transport opts", () => {
    expect(mainSrc).toContain("resolveStateTransportUrls");
    expect(mainSrc).toMatch(/connectRendererTransport\(\{[^}]*\},\s*\{\s*format:\s*"landscape",\s*\.\.\.resolveStateTransportUrls\(\)/);
  });

  it("entry paths hardcode no backend host; only the env module touches VITE_", () => {
    for (const src of [rendererSrc, mainSrc]) {
      expect(src).not.toContain("onrender.com");
      expect(src).not.toContain("VITE_");
    }
    const urlsSrc = readFileSync(join(ROOT, "src", "renderer", "state-transport-urls.ts"), "utf8");
    expect(urlsSrc).toContain("VITE_STATE_BASE_URL");
    expect(urlsSrc).not.toContain("onrender.com");
  });

  it("dashboard mutations stay same-origin relative (rewrite, not direct)", () => {
    const runtimeSrc = readFileSync(join(ROOT, "src", "dashboard", "server-runtime.ts"), "utf8");
    expect(runtimeSrc).not.toContain("snapshotUrl");
    expect(runtimeSrc).not.toContain("streamUrl");
    expect(runtimeSrc).not.toContain("VITE_");
    // Spot-check: control-plane + mutation paths remain relative /api/*.
    expect(runtimeSrc).toContain('"/api/authority/dashboard"');
    expect(runtimeSrc).toContain('"/api/authority/command"');
  });
});

describe("D2.6 canonical backend origin for direct-to-Render OAuth start", () => {
  it("configured Render origin yields the absolute OAuth start URL", () => {
    expect(OAUTH_START_PATH).toBe("/api/authority/youtube/oauth/start");
    expect(resolveOAuthStartUrl(RENDER)).toBe(`${RENDER}/api/authority/youtube/oauth/start`);
  });

  it("start URL hostname matches the callback hostname (cookie-host alignment)", () => {
    const start = new URL(resolveOAuthStartUrl(RENDER) as string);
    const callback = new URL(OAUTH_CALLBACK);
    expect(start.protocol).toBe("https:");
    expect(start.hostname).toBe(callback.hostname);
  });

  it("rejects insecure HTTP origins (production __Host- requires Secure)", () => {
    expect(canonicalBackendOrigin("http://127.0.0.1:3004")).toBeNull();
    expect(canonicalBackendOrigin("http://tidebound-api.onrender.com")).toBeNull();
    expect(resolveOAuthStartUrl("http://127.0.0.1:3004")).toBeNull();
  });

  it("fails visibly (null) when missing or invalid — never a silent relative fallback", () => {
    for (const bad of [undefined, null, "", "   ", "not-a-url", "/relative/path", "ftp://x.example.com/file", "https://", "tidebound-api.onrender.com"]) {
      expect(canonicalBackendOrigin(bad)).toBeNull();
      expect(resolveOAuthStartUrl(bad)).toBeNull();
    }
  });

  it("rejects unexpected path, query, fragment, and userinfo components", () => {
    for (const bad of [
      `${RENDER}/api`,
      `${RENDER}/api/`,
      `${RENDER}?x=1`,
      `${RENDER}#frag`,
      "https://user:pass@tidebound-api.onrender.com",
      "https://user@tidebound-api.onrender.com",
    ]) {
      expect(canonicalBackendOrigin(bad)).toBeNull();
      expect(resolveOAuthStartUrl(bad)).toBeNull();
    }
  });

  it("normalizes trailing slashes deterministically and carries no query string", () => {
    expect(canonicalBackendOrigin(`${RENDER}/`)).toBe(RENDER);
    const start = resolveOAuthStartUrl(`${RENDER}//`) as string;
    expect(start).toBe(`${RENDER}/api/authority/youtube/oauth/start`);
    expect(start).not.toContain("?");
  });

  it("existing state-transport behavior is unchanged", () => {
    expect(resolveStateTransportUrls(RENDER)).toEqual({
      snapshotUrl: `${RENDER}/api/state/snapshot`,
      streamUrl: `${RENDER}/api/state/stream`,
    });
    expect(resolveStateTransportUrls(undefined)).toEqual({
      snapshotUrl: STATE_SNAPSHOT_PATH,
      streamUrl: STATE_STREAM_PATH,
    });
  });
});
