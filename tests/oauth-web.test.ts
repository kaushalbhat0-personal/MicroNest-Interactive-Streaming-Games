import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthStateStore } from "../server/youtube/oauth-state-store.mjs";
import { CredentialRepository } from "../server/youtube/credential-repository.mjs";
import {
  OAUTH_SCOPES,
  buildCorrelationSetCookie,
  buildWebAuthUrl,
  exchangeAuthCode,
  fetchChannelIdentity,
  handleOAuthCallback,
  hashCorrelation,
  loadOAuthConfig,
  mintCorrelationSecret,
  parseCorrelationCookie,
  renderLandingPage,
} from "../server/youtube/oauth-web.mjs";

const KEY = Buffer.alloc(32, 0x3a);
const AT = "CANARY-WEB-ACCESS-aa11";
const RT = "CANARY-WEB-REFRESH-bb22";
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true }).catch(() => undefined);
});
async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "tb-web-"));
  dirs.push(d);
  return d;
}
function testConfig(over: Record<string, unknown> = {}) {
  const loaded = loadOAuthConfig({
    clientId: "test-client-id.apps.googleusercontent.com",
    clientSecret: "test-client-secret",
    redirectUri: "https://auth.example.test/api/youtube/oauth-callback",
    encryptionKey: KEY,
    dashboardUrl: "https://dash.example.test/",
    ...over,
  });
  if (!loaded.ok) throw new Error(`bad fixture config: ${(loaded as { reason?: string }).reason}`);
  return (loaded as { config: Parameters<typeof buildWebAuthUrl>[0]["config"] }).config;
}
async function harness(over: { current?: unknown; tokenBody?: unknown; channelBody?: unknown; exchangeCalls?: { n: number } } = {}) {
  const d = await freshDir();
  const stateStore = new OAuthStateStore({ path: join(d, "state.json") });
  await stateStore.init();
  const repo = new CredentialRepository({ path: join(d, "creds.enc.json"), key: KEY });
  const staged: unknown[] = [];
  const exchangeCalls = over.exchangeCalls ?? { n: 0 };
  const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com/token")) {
      exchangeCalls.n += 1;
      const body = over.tokenBody !== undefined ? over.tokenBody : { access_token: AT, refresh_token: RT, expires_in: 3600 };
      if (body instanceof Error) throw body;
      return { ok: true, json: async () => body };
    }
    if (u.includes("/youtube/v3/channels")) {
      const body = over.channelBody !== undefined ? over.channelBody : { items: [{ id: "UC-CH-1", snippet: { title: "Chan One", customUrl: "@chanone" } }] };
      return { ok: true, json: async () => body };
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
  const secret = mintCorrelationSecret();
  const state = await stateStore.create({ data: hashCorrelation(secret) });
  const run = (query: Record<string, unknown>, cookieSecret: unknown = secret) =>
    handleOAuthCallback({
      config: testConfig(),
      stateStore,
      query,
      cookieSecret: cookieSecret as string | null,
      fetchImpl,
      current: (over.current ?? null) as never,
      persistGrant: (c: unknown) => repo.save(c),
      stagePendingGrant: async (s: unknown) => void staged.push(s),
    });
  return { d, stateStore, repo, staged, exchangeCalls, secret, state, run, fetchImpl };
}

describe("oauth-web config boundary (T4F-C2.7-C)", () => {
  it("15. missing/malformed configuration fails safely without echoing values", () => {
    expect(loadOAuthConfig({})).toMatchObject({ ok: false });
    expect(loadOAuthConfig({ clientId: "", clientSecret: "s", redirectUri: "https://h/cb", encryptionKey: KEY })).toMatchObject({ ok: false });
    expect(loadOAuthConfig({ clientId: "id", clientSecret: "", redirectUri: "https://h/cb", encryptionKey: KEY })).toMatchObject({ ok: false });
    expect(loadOAuthConfig({ clientId: "id", clientSecret: "s", redirectUri: "http://h/cb", encryptionKey: KEY })).toMatchObject({ ok: false });
    expect(loadOAuthConfig({ clientId: "id", clientSecret: "s", redirectUri: "not-a-url", encryptionKey: KEY })).toMatchObject({ ok: false });
    expect(loadOAuthConfig({ clientId: "id", clientSecret: "s", redirectUri: "https://h/cb" })).toMatchObject({ ok: false, reason: "oauth-encryption-misconfigured" });
    const bad = loadOAuthConfig({ clientId: "SECRET-ID", clientSecret: "s", redirectUri: "https://h/cb" });
    expect(bad).toMatchObject({ ok: false });
    expect(JSON.stringify(bad)).not.toContain("SECRET-ID");
    // Explicit http-loopback opt-in is isolated to development.
    expect(loadOAuthConfig({ clientId: "id", clientSecret: "s", redirectUri: "http://127.0.0.1:3004/api/youtube/oauth-callback", encryptionKey: KEY, allowHttpLoopback: true }).ok).toBe(true);
  });

  it("14. arbitrary dashboard return URLs are rejected", () => {
    expect(loadOAuthConfig({ clientId: "id", clientSecret: "s", redirectUri: "https://h/cb", encryptionKey: KEY, dashboardUrl: "javascript:alert(1)" }).ok).toBe(false);
  });
});

describe("oauth-web authorization URL (T4F-C2.7-C)", () => {
  it("10/11/12/13. exact redirect, exact T3 scopes, offline+consent, no secret in URL", () => {
    const config = testConfig();
    const state = "s".repeat(43);
    const u = new URL(buildWebAuthUrl({ config, state }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("redirect_uri")).toBe("https://auth.example.test/api/youtube/oauth-callback");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("include_granted_scopes")).toBe("false");
    expect(u.searchParams.get("state")).toBe(state);
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.force-ssl");
    expect(OAUTH_SCOPES).toEqual(["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.force-ssl"]);
    expect(u.toString()).not.toContain("test-client-secret");
  });
});

describe("oauth-web browser correlation (T4F-C2.7-C)", () => {
  it("8. correlation cookie has expected security attributes", () => {
    const prod = buildCorrelationSetCookie("s".repeat(43), { secure: true });
    expect(prod).toContain("__Host-yt-oauth-corr=");
    expect(prod).toContain("Secure");
    expect(prod).toContain("HttpOnly");
    expect(prod).toContain("SameSite=Lax");
    expect(prod).toContain("Path=/");
    expect(prod).toContain("Max-Age=600");
    const dev = buildCorrelationSetCookie("s".repeat(43), { secure: false });
    expect(dev).not.toContain("Secure");
    expect(dev).not.toContain("__Host-");
    expect(dev).toContain("HttpOnly");
    expect(parseCorrelationCookie(prod, { secure: true })).toBe("s".repeat(43));
    expect(parseCorrelationCookie("other=1; yt-oauth-corr=" + "t".repeat(43), { secure: false })).toBe("t".repeat(43));
    expect(parseCorrelationCookie(null, { secure: true })).toBeNull();
    expect(parseCorrelationCookie("__Host-yt-oauth-corr=bad!!", { secure: true })).toBeNull();
  });
});

describe("oauth-web callback (T4F-C2.7-C)", () => {
  it("1. valid state and matching correlation succeeds and persists encrypted credentials", async () => {
    const h = await harness();
    const out = await h.run({ code: "authcode-1", state: h.state });
    expect(out).toMatchObject({ ok: true, channel: { id: "UC-CH-1" } });
    expect(h.exchangeCalls.n).toBe(1);
    expect(h.staged).toEqual([]);
    const stored = await readFile(join(h.d, "creds.enc.json"), "utf8");
    expect(stored).not.toContain(AT);
    expect(stored).not.toContain(RT);
    const loaded = await h.repo.load();
    expect(loaded).toMatchObject({ access_token: AT, refresh_token: RT, channel: { id: "UC-CH-1" } });
    expect(loaded?.scopes).toEqual(OAUTH_SCOPES);
  });

  it("2. valid state but missing cookie fails before Google exchange", async () => {
    const h = await harness();
    expect(await h.run({ code: "c", state: h.state }, null)).toMatchObject({ ok: false, reason: "correlation-missing" });
    expect(h.exchangeCalls.n).toBe(0);
  });

  it("3. valid state but wrong cookie fails before Google exchange", async () => {
    const h = await harness();
    expect(await h.run({ code: "c", state: h.state }, mintCorrelationSecret())).toMatchObject({ ok: false, reason: "correlation-mismatch" });
    expect(h.exchangeCalls.n).toBe(0);
  });

  it("4. expired state fails before Google exchange", async () => {
    const d = await freshDir();
    const stateStore = new OAuthStateStore({ path: join(d, "s.json"), ttlMs: 1000 });
    await stateStore.init();
    const secret = mintCorrelationSecret();
    const state = await stateStore.create({ data: hashCorrelation(secret) });
    await new Promise((r) => setTimeout(r, 1100));
    const out = await handleOAuthCallback({
      config: testConfig(),
      stateStore,
      query: { code: "c", state },
      cookieSecret: secret,
      fetchImpl: (async () => { throw new Error("must not exchange"); }) as unknown as typeof fetch,
      current: null,
      persistGrant: async () => undefined,
      stagePendingGrant: async () => undefined,
    });
    expect(out).toMatchObject({ ok: false, reason: "expired-state" });
  });

  it("5/6. replayed and concurrent callbacks allow only one exchange", async () => {
    const h = await harness();
    const results = await Promise.all([
      h.run({ code: "c", state: h.state }),
      h.run({ code: "c", state: h.state }),
      h.run({ code: "c", state: h.state }),
    ]);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).length).toBe(2);
    expect(h.exchangeCalls.n).toBe(1);
    // Spent/expired flows cannot be reused afterwards.
    expect(await h.run({ code: "c", state: h.state })).toMatchObject({ ok: false, reason: "already-consumed" });
    expect(h.exchangeCalls.n).toBe(1);
  });

  it("7. malformed and contradictory parameters never reach Google", async () => {
    const h = await harness();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "missing-code"],
      [{ state: h.state }, "missing-code"],
      [{ code: "c" }, "missing-state"],
      [{ code: "c", state: h.state, error: "access_denied" }, "callback-error"],
      [{ error: "access_denied" }, "access-denied"],
      [{ error: "weird_thing" }, "callback-error"],
      [{ code: "", state: h.state }, "missing-code"],
      [{ code: "c", state: "!!!" }, "invalid-state"],
      [{ code: "c", state: "x".repeat(43) }, "unknown-state"],
    ];
    for (const [query, reason] of cases) {
      expect(await h.run(query)).toMatchObject({ ok: false, reason });
    }
    expect(h.exchangeCalls.n).toBe(0);
  });

  it("17. existing refresh token is retained when Google omits a replacement", async () => {
    const h = await harness({ current: { refresh_token: "OLD-RT", obtainedAt: 111, channel: { id: "UC-CH-1" } }, tokenBody: { access_token: AT, expires_in: 3600 } });
    const out = await h.run({ code: "c", state: h.state });
    expect(out.ok).toBe(true);
    expect((await h.repo.load())?.refresh_token).toBe("OLD-RT");
    expect((await h.repo.load())?.obtainedAt).toBe(111);
  });

  it("18. a new refresh token replaces the old one", async () => {
    const h = await harness({ current: { refresh_token: "OLD-RT", obtainedAt: 111, channel: { id: "UC-CH-1" } } });
    expect((await h.run({ code: "c", state: h.state })).ok).toBe(true);
    expect((await h.repo.load())?.refresh_token).toBe(RT);
  });

  it("19. invalid token responses are rejected", async () => {
    for (const body of [{}, { access_token: "" }, { refresh_token: "x" }, null]) {
      const h = await harness({ tokenBody: body });
      expect(await h.run({ code: "c", state: h.state })).toMatchObject({ ok: false, reason: "invalid-token-response" });
    }
  });

  it("20. exchange failure leaves prior valid credentials intact", async () => {
    const d = await freshDir();
    const stateStore = new OAuthStateStore({ path: join(d, "s.json") });
    await stateStore.init();
    const repo = new CredentialRepository({ path: join(d, "c.enc.json"), key: KEY });
    await repo.save({ access_token: "PRIOR-AT", refresh_token: "PRIOR-RT", expires_at: 999, scopes: [...OAUTH_SCOPES] });
    const failingFetch = (async () => ({ ok: false, status: 400, json: async () => ({}) })) as unknown as typeof fetch;
    const secret = mintCorrelationSecret();
    const state = await stateStore.create({ data: hashCorrelation(secret) });
    const out = await handleOAuthCallback({
      config: testConfig(), stateStore, query: { code: "c", state }, cookieSecret: secret, fetchImpl: failingFetch,
      current: { refresh_token: "PRIOR-RT" }, persistGrant: (c: unknown) => repo.save(c), stagePendingGrant: async () => undefined,
    });
    expect(out).toMatchObject({ ok: false, reason: "exchange-failed" });
    expect(await repo.load()).toMatchObject({ access_token: "PRIOR-AT", refresh_token: "PRIOR-RT" });
  });

  it("21. uncertain timeout does not blindly retry", async () => {
    let calls = 0;
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const flaky = (async () => { calls += 1; throw abort; }) as unknown as typeof fetch;
    const d = await freshDir();
    const stateStore = new OAuthStateStore({ path: join(d, "s.json") });
    await stateStore.init();
    const secret = mintCorrelationSecret();
    const state = await stateStore.create({ data: hashCorrelation(secret) });
    const out = await handleOAuthCallback({
      config: testConfig(), stateStore, query: { code: "c", state }, cookieSecret: secret, fetchImpl: flaky,
      current: null, persistGrant: async () => undefined, stagePendingGrant: async () => undefined,
    });
    expect(out).toMatchObject({ ok: false, reason: "exchange-timeout" });
    expect(calls).toBe(1);
  });

  it("channel mismatch stages pending instead of silently switching", async () => {
    const h = await harness({
      current: { refresh_token: "OLD-RT", obtainedAt: 111, channel: { id: "UC-OLD" } },
      channelBody: { items: [{ id: "UC-NEW", snippet: { title: "New", customUrl: "@new" } }] },
    });
    const out = await h.run({ code: "c", state: h.state });
    expect(out).toMatchObject({ ok: false, reason: "channel-mismatch" });
    expect((out as { pendingChannel?: unknown }).pendingChannel).toMatchObject({ previousChannelId: "UC-OLD", newChannel: { id: "UC-NEW" } });
    expect(h.staged).toHaveLength(1);
    // Live repository untouched (no grant yet in this harness).
    expect(await h.repo.load()).toBeNull();
  });

  it("identity failure fails closed without persisting", async () => {
    const h = await harness({ channelBody: { items: [] } });
    expect(await h.run({ code: "c", state: h.state })).toMatchObject({ ok: false, reason: "identity-unavailable" });
    expect(await h.repo.load()).toBeNull();
  });

  it("22/29. outcomes and landing pages contain no sensitive values", async () => {
    const h = await harness();
    const secret = h.secret;
    const out = await h.run({ code: "authcode-1", state: h.state });
    const dump = JSON.stringify(out);
    for (const canary of [AT, RT, secret, "authcode-1", h.state, "test-client-secret"]) {
      expect(dump).not.toContain(canary);
    }
    const landing = renderLandingPage(out, "https://dash.example.test/");
    for (const canary of [AT, RT, secret, "authcode-1", h.state, "test-client-secret"]) {
      expect(landing).not.toContain(canary);
    }
    const denied = renderLandingPage({ ok: false, reason: "exchange-failed" }, "https://dash.example.test/");
    expect(denied).not.toContain("exchange-failed");
    expect(denied).toContain("Return to the dashboard");
    expect(denied).toContain("https://dash.example.test/");
    // No untrusted reflection: attacker-controlled error text never appears.
    const evil = renderLandingPage({ ok: false, reason: "<script>alert(1)</script>" }, null);
    expect(evil).not.toContain("<script>");
  });

  it("exchangeAuthCode and fetchChannelIdentity units", async () => {
    const cfg = testConfig();
    const okFetch = (async () => ({ ok: true, json: async () => ({ access_token: "A", refresh_token: "R", expires_in: 100 }) })) as unknown as typeof fetch;
    expect(await exchangeAuthCode({ config: cfg, code: "c", fetchImpl: okFetch })).toMatchObject({ ok: true });
    const idFetch = (async () => ({ ok: true, json: async () => ({ items: [{ id: "UC-9", snippet: { title: "Nine" } }] }) })) as unknown as typeof fetch;
    expect(await fetchChannelIdentity({ accessToken: "A", fetchImpl: idFetch })).toMatchObject({ ok: true, channel: { id: "UC-9", title: "Nine" } });
  });

  it("33. browser sources and server modules stay on their sides of the trust boundary", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const browserFiles = ["src/app.ts", "src/dashboard/server-runtime.ts", "src/youtube/client.ts", "src/dashboard/settings.ts"];
    for (const f of browserFiles) {
      const src = await readFile(join(root, f), "utf8");
      for (const secret of ["client_secret", "refresh_token", "GOOGLE_", "oauth2.googleapis.com/token", "authorization_code", "refresh_token"]) {
        expect(src, `${f} must not contain ${secret}`).not.toContain(secret);
      }
    }
    // No OAuth parameter is echoed or logged by application code: no console
    // statement may reference request-derived identifiers.
    for (const f of ["server/authority-server.ts", "server/youtube/oauth-web.mjs"]) {
      const src = await readFile(join(root, f), "utf8");
      for (const m of src.matchAll(/console\.(log|error|warn)\(([^;]*)\);?/g)) {
        const call = m[2] ?? "";
        for (const leaked of ["req.url", "searchParams", "cookie", "bodyToken", "secret", "googleUrl", "params.get", "query"]) {
          expect(call, `${f} console call must not reference ${leaked}`).not.toContain(leaked);
        }
      }
      expect(src).not.toContain("console.log(req");
      expect(src).not.toContain("console.error(req");
    }
    // Server-only modules are never imported by browser sources.
    for (const f of browserFiles) {
      const src = await readFile(join(root, f), "utf8");
      expect(src).not.toContain("youtube/oauth-web");
      expect(src).not.toContain("youtube/credential-repository");
      expect(src).not.toContain("youtube/oauth-state-store");
    }
  });
});
