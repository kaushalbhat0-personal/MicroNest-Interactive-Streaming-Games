import { describe, expect, it, vi } from "vitest";
import { YouTubeAdapter } from "../server/youtube/adapter.mjs";

/** Adapter with controllable connection state and a stubbed transport. */
type TestTokens = { access_token: string; expires_at: number; refresh_token?: string | null } | null;
function adapterWith(fetchImpl: (...args: never[]) => Promise<unknown>, { tokens = { access_token: "AT", expires_at: Date.now() + 3600000 }, liveChatId = "CHAT", stopped = false }: { tokens?: TestTokens; liveChatId?: string | null; stopped?: boolean } = {}) {
  const a = new YouTubeAdapter({ fetchImpl: fetchImpl as unknown as typeof fetch, onEvents: () => {}, onStatus: () => {} });
  a.tokens = tokens;
  a.liveChatId = liveChatId;
  a.stopped = stopped;
  return a;
}

const okInsert = (id = "MSG-1") =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id }) }));

function errInsert(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: false, status, text: async () => JSON.stringify(body) }));
}

const SCOPE_BODY = { error: { errors: [{ reason: "forbidden", message: "Request had insufficient authentication scopes." }], code: 403 } };

describe("outbound announcements (server-only)", () => {
  it("validates text, length, event id, auth and chat before any fetch", async () => {
    const f = okInsert();
    const a = adapterWith(f);
    expect(await a.sendChatMessage({ text: "  ", eventId: "vote:s:v:open" })).toMatchObject({ ok: false, error: "invalid-text" });
    expect(await a.sendChatMessage({ text: "x".repeat(201), eventId: "vote:s:v:open" })).toMatchObject({ ok: false, error: "too-long" });
    expect(await a.sendChatMessage({ text: "hi", eventId: "bad id!" })).toMatchObject({ ok: false, error: "invalid-event" });
    expect(await adapterWith(f, { tokens: null }).sendChatMessage({ text: "hi", eventId: "vote:s:v:open" })).toMatchObject({
      ok: false,
      error: "auth-required",
    });
    expect(await adapterWith(f, { liveChatId: null }).sendChatMessage({ text: "hi", eventId: "vote:s:v:open" })).toMatchObject({
      ok: false,
      error: "no-live-chat",
    });
    expect(await adapterWith(f, { stopped: true }).sendChatMessage({ text: "hi", eventId: "vote:s:v:open" })).toMatchObject({
      ok: false,
      error: "no-live-chat",
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("posts the insert payload and records delivery", async () => {
    const seen: { url: string; opts: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
    const f = vi.fn(async (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      seen.push({ url, opts: opts ?? {} });
      return { ok: true, status: 200, json: async () => ({ id: "MSG-9" }) };
    });
    const a = adapterWith(f);
    const out = await a.sendChatMessage({ text: "TIDEBOUND VOTE: go? A) X !voteA | B) Y !voteB", eventId: "vote:s:v:open" });
    expect(out).toMatchObject({ ok: true, messageId: "MSG-9" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("/liveChat/messages?part=snippet");
    expect(seen[0].opts.method).toBe("POST");
    expect(JSON.parse(seen[0].opts.body ?? "{}")).toMatchObject({
      snippet: { liveChatId: "CHAT", type: "textMessageEvent", textMessageDetails: { messageText: expect.any(String) } },
    });
    // No tokens in the wire body; auth header only.
    expect(seen[0].opts.body ?? "").not.toMatch(/refresh|secret/i);
    expect(a.getState().outbound).toBe("ok");
  });

  it("deduplicates by event id without a second insert", async () => {
    const f = okInsert();
    const a = adapterWith(f);
    await a.sendChatMessage({ text: "hello", eventId: "vote:s:v:close" });
    const again = await a.sendChatMessage({ text: "hello", eventId: "vote:s:v:close" });
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("maps insufficient scope and remembers reauth need (read path untouched)", async () => {
    const f = errInsert(403, SCOPE_BODY);
    const a = adapterWith(f);
    const out = await a.sendChatMessage({ text: "hello", eventId: "vote:s:v:open" });
    expect(out).toMatchObject({ ok: false, error: "insufficient-scope" });
    expect(a.getState().outbound).toBe("insufficient");
    // Polling still uses the same token — reads are unaffected by the flag.
    expect(a.tokens).not.toBeNull();
  });

  it("maps quota, rate-limit, ended-chat, auth and generic errors", async () => {
    const mk = (status: number, body: unknown) => adapterWith(errInsert(status, body));
    expect(
      await mk(403, { error: { errors: [{ reason: "quotaExceeded" }] } }).sendChatMessage({ text: "h", eventId: "e1" }),
    ).toMatchObject({ ok: false, error: "quota-exceeded" });
    expect(
      await mk(429, { error: { errors: [{ reason: "rateLimitExceeded" }] } }).sendChatMessage({ text: "h", eventId: "e2" }),
    ).toMatchObject({ ok: false, error: "rate-limited" });
    expect(
      await mk(400, { error: { errors: [{ reason: "liveChatEnded" }] } }).sendChatMessage({ text: "h", eventId: "e3" }),
    ).toMatchObject({ ok: false, error: "no-live-chat" });
    expect(
      await mk(401, { error: { message: "unauthorized" } }).sendChatMessage({ text: "h", eventId: "e4" }),
    ).toMatchObject({ ok: false, error: "auth-required" });
    expect(
      await mk(500, { error: { message: "backendError" } }).sendChatMessage({ text: "h", eventId: "e5" }),
    ).toMatchObject({ ok: false, error: "api-error" });
  });

  it("throttles inserts per rolling minute", async () => {
    const f = okInsert();
    const a = adapterWith(f);
    a.sendTimes = Array.from({ length: 6 }, () => Date.now());
    expect(await a.sendChatMessage({ text: "h", eventId: "vote:s:v:open" })).toMatchObject({
      ok: false,
      error: "rate-limited",
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("reports uncertain on timeout and records nothing", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const f = vi.fn(async () => {
      throw abort;
    });
    const a = adapterWith(f);
    expect(await a.sendChatMessage({ text: "h", eventId: "vote:s:v:uncertain" })).toMatchObject({
      ok: false,
      error: "uncertain",
    });
    expect(a.delivered.has("vote:s:v:uncertain")).toBe(false);
  });

  it("serializes concurrent inserts (open before close)", async () => {
    const order: string[] = [];
    const f = vi.fn(async (url: string, opts?: { body?: string }) => {
      const text = JSON.parse(opts?.body ?? "{}").snippet.textMessageDetails.messageText as string;
      order.push(`start:${text}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end:${text}`);
      return { ok: true, status: 200, json: async () => ({ id: text }) };
    });
    const a = adapterWith(f);
    const [r1, r2] = await Promise.all([
      a.sendChatMessage({ text: "OPEN", eventId: "vote:s:v:open" }),
      a.sendChatMessage({ text: "CLOSE", eventId: "vote:s:v:close" }),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    expect(order).toEqual(["start:OPEN", "end:OPEN", "start:CLOSE", "end:CLOSE"]);
  });

  it("never exposes tokens in state, errors or diagnostics", async () => {
    const f = errInsert(500, { error: { message: "backendError" } });
    const a = adapterWith(f, { tokens: { access_token: "SECRET-AT", refresh_token: "SECRET-RT", expires_at: Date.now() + 1 } });
    const out = await a.sendChatMessage({ text: "h", eventId: "vote:s:v:open" });
    const dump = JSON.stringify({ out, state: a.getState(), lastApi: a.lastApi });
    expect(dump).not.toContain("SECRET-AT");
    expect(dump).not.toContain("SECRET-RT");
  });
});
