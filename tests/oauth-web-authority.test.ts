import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = Buffer.alloc(32, 0x3a);
const dirs: string[] = [];
const handles: Array<{ stop: () => Promise<void> }> = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop() as { stop: () => Promise<void> };
    await h.stop().catch(() => undefined);
  }
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true }).catch(() => undefined);
});
async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "tb-oautha-"));
  dirs.push(d);
  return d;
}
async function readToken(dir: string): Promise<string> {
  const raw = await readFile(join(dir, "authority-token.json"), "utf8");
  return (JSON.parse(raw) as { token: string }).token;
}

interface MockOpts {
  channelId?: string;
  includeRefresh?: boolean;
  exchanges: { n: number };
}
function googleMock(opts: MockOpts) {
  return (async (url: unknown, init?: { method?: string }) => {
    const u = String(url);
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      opts.exchanges.n += 1;
      const n = opts.exchanges.n;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: `CANARY-AT-${n}`,
          ...(opts.includeRefresh === false ? {} : { refresh_token: `CANARY-RT-${n}` }),
          expires_in: 3600,
        }),
      };
    }
    if (u.includes("/youtube/v3/channels")) {
      const id = opts.channelId ?? "UC-CH-1";
      return { ok: true, status: 200, json: async () => ({ items: [{ id, snippet: { title: `Title ${id}`, customUrl: `@${id.toLowerCase()}` } }] }) };
    }
    if (u.includes("/youtube/v3/liveBroadcasts")) {
      const id = opts.channelId ?? "UC-CH-1";
      return { ok: true, status: 200, json: async () => ({ items: [{ snippet: { liveChatId: "CHAT-1", channelId: id, title: "Live" } }] }) };
    }
    if (u.includes("/youtube/v3/liveChat/messages") && (!init || (init.method ?? "GET") === "GET")) {
      return { ok: true, status: 200, json: async () => ({ items: [], nextPageToken: "p1", pollingIntervalMillis: 15000 }) };
    }
    if (u.includes("/youtube/v3/liveChat/messages")) {
      return { ok: true, status: 200, json: async () => ({ id: "MSG-1" }) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

async function boot(port: number, dir: string, mockOpts: MockOpts, oauthOver: Record<string, unknown> = {}) {
  const mod = await import("../server/authority-server");
  const h = await mod.startAuthority({
    port,
    dataDir: dir,
    stateUrl: "http://127.0.0.1:9",
    ytUrl: "http://127.0.0.1:9",
    fetchImpl: googleMock(mockOpts),
    oauth: {
      clientId: "test-client.apps.googleusercontent.com",
      clientSecret: "test-secret",
      redirectUri: `http://127.0.0.1:${port}/api/youtube/oauth-callback`,
      allowHttpLoopback: true,
      encryptionKey: KEY,
      dashboardUrl: "https://dash.example.test/",
      ...oauthOver,
    },
  });
  handles.push(h);
  const token = await readToken(dir);
  const base = `http://127.0.0.1:${port}`;
  return { h, token, base };
}

async function postStart(base: string, token: string) {
  return fetch(`${base}/api/authority/youtube/oauth/start`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    redirect: "manual",
  });
}

describe("oauth-web authority integration (T4F-C2.7-C)", () => {
  it("start requires the bearer; success sets a cookie and redirects to Google", async () => {
    const dir = await freshDir();
    const { base, token } = await boot(3241, dir, { exchanges: { n: 0 } });
    const anon = await postStart(base, "wrong-token");
    expect(anon.status).toBe(401);
    const res = await postStart(base, token);
    expect(res.status).toBe(303);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("yt-oauth-corr=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure"); // loopback dev only
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    expect(location).toContain(encodeURIComponent(`http://127.0.0.1:3241/api/youtube/oauth-callback`));
    expect(location).not.toContain("test-secret");
  });

  it("full callback succeeds, initializes one reader, and reuses the grant after restart", async () => {
    const dir = await freshDir();
    const exchanges = { n: 0 };
    const first = await boot(3242, dir, { exchanges });
    const start = await postStart(first.base, first.token);
    const location = start.headers.get("location") ?? "";
    const state = new URL(location).searchParams.get("state") as string;
    const cookiePair = (start.headers.get("set-cookie") ?? "").split(";")[0];
    const cb = await fetch(`${first.base}/api/youtube/oauth-callback?code=CANARY-CODE-1&state=${state}`, { headers: { cookie: cookiePair }, redirect: "manual" });
    expect(cb.status).toBe(200);
    expect(cb.headers.get("cache-control")).toBe("no-store");
    expect(cb.headers.get("content-security-policy")).toBe("default-src 'none'");
    const html = await cb.text();
    for (const canary of ["CANARY-CODE-1", state, "CANARY-AT-1", "CANARY-RT-1", "test-secret"]) {
      expect(html).not.toContain(canary);
    }
    expect(exchanges.n).toBe(1);
    const statusRes = await fetch(`${first.base}/api/authority/youtube/oauth/status`, { headers: { authorization: `Bearer ${first.token}` } });
    const status = (await statusRes.json()) as Record<string, unknown>;
    expect(status).toMatchObject({ configured: true, connected: true, outbound: "unknown", channel: { id: "UC-CH-1" } });
    expect(JSON.stringify(status)).not.toContain("CANARY-AT-1");

    // Replay of the same callback: generic failure, no second exchange.
    const replay = await fetch(`${first.base}/api/youtube/oauth-callback?code=CANARY-CODE-1&state=${state}`, { headers: { cookie: cookiePair } });
    expect(replay.status).toBe(200);
    expect((await replay.text())).not.toContain("CANARY-AT-1");
    expect(exchanges.n).toBe(1);

    // Connect initializes exactly one reader; repeat connects do not duplicate.
    const auth = { authorization: `Bearer ${first.token}`, "content-type": "application/json" };
    await fetch(`${first.base}/api/authority/source`, { method: "POST", headers: auth, body: JSON.stringify({ source: "youtube" }) });
    const dash1 = (await (await fetch(`${first.base}/api/authority/dashboard`, { headers: auth })).json()) as { yt: { lastStatus: Record<string, unknown> } };
    expect(dash1.yt.lastStatus).toMatchObject({ status: "STREAMING", liveChatId: "CHAT-1" });
    await fetch(`${first.base}/api/authority/youtube/connect`, { method: "POST", headers: auth, body: "{}" });
    const dash2 = (await (await fetch(`${first.base}/api/authority/dashboard`, { headers: auth })).json()) as { yt: { lastStatus: Record<string, unknown> } };
    expect(dash2.yt.lastStatus).toMatchObject({ status: "STREAMING", liveChatId: "CHAT-1" });
    // Disconnect stops polling but preserves the grant.
    await fetch(`${first.base}/api/authority/youtube/disconnect`, { method: "POST", headers: auth, body: "{}" });
    const statusAfter = (await (await fetch(`${first.base}/api/authority/youtube/oauth/status`, { headers: auth })).json()) as Record<string, unknown>;
    expect(statusAfter).toMatchObject({ connected: true, channel: { id: "UC-CH-1" } });

    // Restart resumes the grant with no new exchange.
    await first.h.stop();
    handles.pop();
    const second = await boot(3243, dir, { exchanges });
    const statusRestart = (await (await fetch(`${second.base}/api/authority/youtube/oauth/status`, { headers: { authorization: `Bearer ${second.token}` } })).json()) as Record<string, unknown>;
    expect(statusRestart).toMatchObject({ configured: true, connected: true, channel: { id: "UC-CH-1" } });
    expect(exchanges.n).toBe(1);
  });

  it("T3 outbound announcements flow through the embedded adapter after OAuth", async () => {
    const dir = await freshDir();
    const { base, token } = await boot(3244, dir, { exchanges: { n: 0 } });
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const start = await postStart(base, token);
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") as string;
    const cookiePair = (start.headers.get("set-cookie") ?? "").split(";")[0];
    await fetch(`${base}/api/youtube/oauth-callback?code=C&state=${state}`, { headers: { cookie: cookiePair } });
    await fetch(`${base}/api/authority/source`, { method: "POST", headers: auth, body: JSON.stringify({ source: "youtube" }) });
    const opened = (await (await fetch(`${base}/api/authority/vote/open`, { method: "POST", headers: auth, body: JSON.stringify({ which: "route" }) })).json()) as { outcome: string };
    expect(opened.outcome).toBe("opened-route-vote");
    const dash = (await (await fetch(`${base}/api/authority/dashboard`, { headers: auth })).json()) as { announce: Record<string, { status: string }> };
    const openEntry = Object.entries(dash.announce).find(([k]) => k.endsWith(":open"));
    expect(openEntry?.[1].status).toBe("sent");
  });

  it("channel mismatch stages pending and requires explicit confirmation", async () => {
    const dir = await freshDir();
    const mockOpts: MockOpts = { exchanges: { n: 0 }, channelId: "UC-CH-1" };
    const { base, token } = await boot(3245, dir, mockOpts);
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    async function doFlow(code: string): Promise<{ html: string; status: number }> {
      const start = await postStart(base, token);
      const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") as string;
      const cookiePair = (start.headers.get("set-cookie") ?? "").split(";")[0];
      const cb = await fetch(`${base}/api/youtube/oauth-callback?code=${code}&state=${state}`, { headers: { cookie: cookiePair } });
      return { html: await cb.text(), status: cb.status };
    }
    expect((await doFlow("c1")).status).toBe(200);
    // Second authorization for a DIFFERENT channel: no silent switch.
    mockOpts.channelId = "UC-CH-2";
    const mismatch = await doFlow("c2");
    expect(mismatch.status).toBe(200);
    expect(mismatch.html).not.toContain("UC-CH-2");
    const st = (await (await fetch(`${base}/api/authority/youtube/oauth/status`, { headers: auth })).json()) as {
      channel: { id: string };
      pendingChannel: { previousChannelId: string; newChannel: { id: string } };
    };
    expect(st.channel).toMatchObject({ id: "UC-CH-1" });
    expect(st.pendingChannel).toMatchObject({ previousChannelId: "UC-CH-1", newChannel: { id: "UC-CH-2" } });
    // Cancel discards the pending switch.
    const cancel = (await (await fetch(`${base}/api/authority/youtube/oauth/confirm-channel`, { method: "POST", headers: auth, body: JSON.stringify({ confirm: false }) })).json()) as { outcome: string };
    expect(cancel.outcome).toBe("channel-cancelled");
    const st2 = (await (await fetch(`${base}/api/authority/youtube/oauth/status`, { headers: auth })).json()) as { pendingChannel: unknown; channel: { id: string } };
    expect(st2.pendingChannel).toBeNull();
    expect(st2.channel).toMatchObject({ id: "UC-CH-1" });
    // Confirm moves the staged grant live.
    mockOpts.channelId = "UC-CH-2";
    await doFlow("c3");
    const confirm = (await (await fetch(`${base}/api/authority/youtube/oauth/confirm-channel`, { method: "POST", headers: auth, body: JSON.stringify({ confirm: true }) })).json()) as { outcome: string };
    expect(confirm.outcome).toBe("channel-confirmed");
    const st3 = (await (await fetch(`${base}/api/authority/youtube/oauth/status`, { headers: auth })).json()) as { channel: { id: string }; pendingChannel: unknown };
    expect(st3.channel).toMatchObject({ id: "UC-CH-2" });
    expect(st3.pendingChannel).toBeNull();
    // Nothing to confirm afterwards.
    const empty = (await (await fetch(`${base}/api/authority/youtube/oauth/confirm-channel`, { method: "POST", headers: auth, body: JSON.stringify({ confirm: true }) })).json()) as { reason: string };
    expect(empty.reason).toBe("no-pending-channel");
  });

  it("unconfigured authority exposes no OAuth surface", async () => {
    const dir = await freshDir();
    const mod = await import("../server/authority-server");
    const h = await mod.startAuthority({ port: 3246, dataDir: dir, stateUrl: "http://127.0.0.1:9", ytUrl: "http://127.0.0.1:9" });
    handles.push(h);
    const token = await readToken(dir);
    const base = "http://127.0.0.1:3246";
    const start = await postStart(base, token);
    expect(start.status).toBe(503);
    const st = await fetch(`${base}/api/authority/youtube/oauth/status`, { headers: { authorization: `Bearer ${token}` } });
    expect(((await st.json()) as { configured: boolean }).configured).toBe(false);
  });
});
