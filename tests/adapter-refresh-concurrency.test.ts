import { describe, expect, it } from "vitest";
import { YouTubeAdapter } from "../server/youtube/adapter.mjs";

const CLIENT = { clientId: "test-id", clientSecret: "test-secret" };
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function expiredTokens() {
  return { access_token: "OLD-AT", refresh_token: "OLD-RT", expires_at: Date.now() - 1000 };
}

function adapterWith(fetchImpl: typeof fetch, persistCalls: unknown[]) {
  const a = new YouTubeAdapter({
    fetchImpl,
    client: CLIENT,
    redirectUri: "http://127.0.0.1:9/cb",
    onEvents: () => {},
    onStatus: () => {},
    persistTokens: async (t: unknown) => void persistCalls.push(t),
  });
  a.tokens = expiredTokens();
  a.liveChatId = "CHAT-1";
  a.stopped = false;
  return a;
}

function refreshFetch(opts: { calls: { n: number }; newRefresh?: string | null; fail?: unknown; delayMs?: number }) {
  return (async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    if (u === TOKEN_URL) {
      opts.calls.n += 1;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw opts.fail;
      const params = new URLSearchParams(String(init?.body ?? ""));
      expect(params.get("refresh_token")).toBe("OLD-RT");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: `NEW-AT-${opts.calls.n}`,
          ...(opts.newRefresh === null ? {} : { refresh_token: opts.newRefresh ?? `NEW-RT-${opts.calls.n}` }),
          expires_in: 3600,
        }),
      };
    }
    if (u.includes("/liveChat/messages") && (!init || (init.method ?? "GET") === "GET")) {
      return { ok: true, status: 200, json: async () => ({ items: [], pollingIntervalMillis: 15000 }) };
    }
    if (u.includes("/liveChat/messages")) {
      return { ok: true, status: 200, json: async () => ({ id: "MSG-1" }) };
    }
    throw new Error(`unexpected: ${u}`);
  }) as unknown as typeof fetch;
}

describe("adapter refresh single-flight (T4F-C2.7-D0)", () => {
  it("1/2. concurrent callers trigger one refresh and share the token", async () => {
    const calls = { n: 0 };
    const persisted: unknown[] = [];
    const a = adapterWith(refreshFetch({ calls, delayMs: 30 }), persisted);
    const results = await Promise.all(Array.from({ length: 10 }, () => a.accessToken()));
    expect(calls.n).toBe(1);
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe("NEW-AT-1");
  });

  it("3. refresh-token rotation persists once", async () => {
    const calls = { n: 0 };
    const persisted: Array<{ access_token: string; refresh_token: string }> = [];
    const a = adapterWith(refreshFetch({ calls }), persisted as unknown[]);
    await Promise.all([a.accessToken(), a.accessToken(), a.accessToken()]);
    expect(calls.n).toBe(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ access_token: "NEW-AT-1", refresh_token: "NEW-RT-1" });
  });

  it("4. omitted refresh token preserves the old value", async () => {
    const calls = { n: 0 };
    const persisted: Array<{ refresh_token: string }> = [];
    const a = adapterWith(refreshFetch({ calls, newRefresh: null }), persisted as unknown[]);
    expect(await a.accessToken()).toBe("NEW-AT-1");
    expect(persisted[0].refresh_token).toBe("OLD-RT");
  });

  it("5. failure rejects all waiters safely with AUTH_REQUIRED semantics", async () => {
    const calls = { n: 0 };
    const persisted: unknown[] = [];
    const statuses: string[] = [];
    const a = adapterWith(refreshFetch({ calls, fail: new Error("token-refresh-failed:500") }), persisted);
    a.onStatus = (s: string) => void statuses.push(s);
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => a.accessToken()));
    expect(calls.n).toBe(1);
    expect(outcomes.every((o) => o.status === "rejected")).toBe(true);
    expect(a.tokens).toBeNull();
    expect(a.status).toBe("AUTH_REQUIRED");
    expect(persisted).toHaveLength(0);
    expect(statuses).toContain("AUTH_REQUIRED");
  });

  it("6. a later retry can succeed after re-auth", async () => {
    const calls = { n: 0 };
    const persisted: unknown[] = [];
    let fail = true;
    const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
      if (String(url) === TOKEN_URL) {
        calls.n += 1;
        if (fail) throw new Error("token-refresh-failed:500");
        return { ok: true, status: 200, json: async () => ({ access_token: "RETRY-AT", refresh_token: "RETRY-RT", expires_in: 3600 }) };
      }
      throw new Error("unexpected");
    }) as unknown as typeof fetch;
    const a = adapterWith(fetchImpl, persisted);
    await expect(a.accessToken()).rejects.toThrow();
    expect(a.tokens).toBeNull();
    // Re-auth establishes a new grant; a later request succeeds with one refresh.
    a.applyCredentials({ access_token: "GRANT-AT", refresh_token: "GRANT-RT", expires_at: Date.now() - 10 });
    fail = false;
    const again = await Promise.all([a.accessToken(), a.accessToken()]);
    expect(new Set(again).size).toBe(1);
    expect(again[0]).toBe("RETRY-AT");
    expect(calls.n).toBe(2);
  });

  it("7. no stale access token is returned after expiry", async () => {
    const calls = { n: 0 };
    const a = adapterWith(refreshFetch({ calls }), []);
    const token = await a.accessToken();
    expect(token).not.toBe("OLD-AT");
    expect(token).toBe("NEW-AT-1");
  });

  it("8. concurrent send and poll paths share the same refresh", async () => {
    const calls = { n: 0 };
    const a = adapterWith(refreshFetch({ calls, delayMs: 30 }), []);
    const [sendOut, pollOut] = await Promise.all([
      a.sendChatMessage({ text: "hello", eventId: "vote:s:v:open" }),
      a.api("/liveChat/messages", { liveChatId: "CHAT-1", part: "id", maxResults: 1 }),
    ]);
    expect(calls.n).toBe(1);
    expect(sendOut).toMatchObject({ ok: true });
    expect(pollOut).toBeDefined();
  });

  it("re-auth during an in-flight refresh never clobbers the newer grant", async () => {
    const calls = { n: 0 };
    const persisted: Array<{ access_token: string; refresh_token?: string }> = [];
    const a = adapterWith(refreshFetch({ calls, delayMs: 50 }), persisted as unknown[]);
    const pending = a.accessToken();
    // Re-authorize (new grant) while the old refresh is still in flight.
    a.applyCredentials({ access_token: "FRESH-GRANT-AT", refresh_token: "FRESH-GRANT-RT", expires_at: Date.now() + 3600_000 });
    const served = await pending;
    expect(served).toBe("FRESH-GRANT-AT");
    expect(a.tokens).toMatchObject({ access_token: "FRESH-GRANT-AT", refresh_token: "FRESH-GRANT-RT" });
    expect(calls.n).toBe(1);
    // The stale refresh result was discarded, never persisted.
    expect(persisted).toHaveLength(0);
  });
});
