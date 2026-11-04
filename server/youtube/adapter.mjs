// YouTube live-chat adapter. Responsibility ends at canonical events:
// connect/auth, discover the active broadcast, poll liveChatMessages.list,
// map messages (mapper.mjs), and hand canonical events to a sink (SSE).
// NO gameplay knowledge: no HP, no tiers, no cooldowns, no story, no queue.
import { YT } from "./config.mjs";
import { mapYouTubeMessage } from "./mapper.mjs";
import {
  buildAuthUrl,
  clearTokens,
  exchangeCode,
  loadTokens,
  refreshAccessToken,
  saveTokens,
} from "./oauth.mjs";

const API = "https://www.googleapis.com/youtube/v3";

export const STATUS = {
  DISCONNECTED: "DISCONNECTED",
  CONNECTING: "CONNECTING",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  CONNECTED: "CONNECTED",
  LIVE_CHAT_FOUND: "LIVE_CHAT_FOUND",
  STREAMING: "STREAMING",
  RECONNECTING: "RECONNECTING",
  STREAM_ENDED: "STREAM_ENDED",
  ERROR: "ERROR",
};

export class YouTubeAdapter {
  /**
   * @param opts.fetchImpl fetch-compatible (stubbed in tests)
   * @param opts.onEvents(events: CanonicalEvent[]) sink for mapped events
   * @param opts.onStatus(status) status listener
   * @param opts.client {clientId, clientSecret} | null until configured
   * @param opts.redirectUri loopback callback URL
   */
  constructor(opts) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onEvents = opts.onEvents ?? (() => {});
    this.onStatus = opts.onStatus ?? (() => {});
    this.client = opts.client ?? null;
    this.redirectUri = opts.redirectUri;
    this.cursorPath = opts.cursorPath ?? null;
    this.cursor = null;
    this.ownChannelId = null;
    this.lastApi = null;
    this.lastDiscovery = null;
    this.tokens = null;
    this.status = STATUS.DISCONNECTED;
    this.error = null;
    this.liveChatId = null;
    this.broadcastTitle = null;
    this.pageToken = null;
    this.timer = null;
    this.stopped = true;
    this.reconnects = 0;
    this.diag = { seen: 0, commands: 0, paid: 0, retractions: 0, ignored: 0, polls: 0, apiErrors: 0 };
    // T3 outbound announcements: delivery memory only (never gameplay).
    // `outbound` is tri-state: unknown until the first insert proves the
    // grant, ok after any accepted insert, insufficient after a scope
    // rejection. A readonly-only (pre-T3) grant keeps working for reads;
    // only sends fail closed as `insufficient-scope`.
    this.outbound = "unknown";
    /** eventId -> YouTube message id (or null); bounded, dedupes retries. */
    this.delivered = new Map();
    /** Epoch ms of insert attempts; rolling 60s window for throttling. */
    this.sendTimes = [];
    /** Serializes inserts so open-before-close ordering holds per chat. */
    this.sendChain = Promise.resolve();
  }

  setStatus(s, error = null) {
    this.status = s;
    this.error = error;
    this.onStatus(s);
  }

  getState() {
    return {
      status: this.status,
      error: this.error,
      configured: !!this.client,
      authenticated: !!this.tokens,
      liveChatId: this.liveChatId,
      broadcastTitle: this.broadcastTitle,
      reconnects: this.reconnects,
      lastApi: this.lastApi,
      discovery: this.lastDiscovery,
      cursor: this.cursor ? { liveChatId: this.cursor.liveChatId, platformId: this.cursor.platformId } : null,
      diag: { ...this.diag },
      // Outbound announcement capability (T3). Counts only — no ids, no text.
      outbound: this.outbound,
      deliveredAnnouncements: this.delivered.size,
    };
  }

  authUrl() {
    if (!this.client) return null;
    return buildAuthUrl({
      clientId: this.client.clientId,
      redirectUri: this.redirectUri,
      scopes: YT.scopes,
    });
  }

  async init(tokenPath) {
    this.tokenPath = tokenPath;
    this.tokens = await loadTokens(tokenPath);
    await this.loadCursor();
    if (this.tokens && !this.client) this.setStatus(STATUS.DISCONNECTED);
    else if (this.tokens) this.setStatus(STATUS.CONNECTED);
    else this.setStatus(this.client ? STATUS.AUTH_REQUIRED : STATUS.DISCONNECTED);
  }

  // Tiny restart guard: remember the newest observed platform message per
  // live chat so a sidecar restart doesn't re-forward recent history as new
  // gameplay. This is a cursor, not an event ledger — the engine still owns
  // all gameplay dedup within a session.
  async loadCursor() {
    if (!this.cursorPath) return;
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(this.cursorPath, "utf8");
      const c = JSON.parse(raw);
      if (c && typeof c.liveChatId === "string" && typeof c.platformId === "string") {
        this.cursor = c;
      }
    } catch {
      this.cursor = null;
    }
  }

  async saveCursor() {
    if (!this.cursorPath || !this.cursor) return;
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(this.cursorPath, JSON.stringify(this.cursor), { encoding: "utf8", mode: 0o600 });
    } catch {
      /* cursor is best-effort; polling must not die */
    }
  }

  /** Drop already-observed history after a (re)connect. */
  applyCursor(items) {
    if (!this.cursor || this.cursor.liveChatId !== this.liveChatId) return items;
    const idx = items.findIndex((it) => it && it.id === this.cursor.platformId);
    if (idx >= 0) return items.slice(idx + 1); // exact resume point
    const ts = this.cursor.publishedAt ?? "";
    return items.filter((it) => (it?.snippet?.publishedAt ?? "") > ts);
  }

  async handleCallback(code) {
    if (!this.client) throw new Error("oauth-not-configured");
    const fresh = await exchangeCode({
      clientId: this.client.clientId,
      clientSecret: this.client.clientSecret,
      redirectUri: this.redirectUri,
      code,
      fetchImpl: this.fetchImpl,
    });
    // Preserve an older refresh token if Google omits a new one.
    if (!fresh.refresh_token && this.tokens?.refresh_token) {
      fresh.refresh_token = this.tokens.refresh_token;
    }
    this.tokens = fresh;
    await saveTokens(this.tokenPath, fresh);
    this.outbound = "unknown"; // new grant: unproven until the first insert
    this.setStatus(STATUS.CONNECTED);
  }

  async logout() {
    this.disconnect();
    this.tokens = null;
    this.outbound = "unknown";
    await clearTokens(this.tokenPath);
    this.setStatus(this.client ? STATUS.AUTH_REQUIRED : STATUS.DISCONNECTED);
  }

  async accessToken() {
    if (!this.tokens) throw new Error("not-authenticated");
    if (Date.now() < (this.tokens.expires_at ?? 0)) return this.tokens.access_token;
    if (!this.tokens.refresh_token || !this.client) {
      this.tokens = null;
      this.setStatus(STATUS.AUTH_REQUIRED, "refresh-unavailable");
      throw new Error("refresh-unavailable");
    }
    try {
      const fresh = await refreshAccessToken({
        clientId: this.client.clientId,
        clientSecret: this.client.clientSecret,
        refreshToken: this.tokens.refresh_token,
        fetchImpl: this.fetchImpl,
      });
      this.tokens = { ...this.tokens, ...fresh };
      await saveTokens(this.tokenPath, this.tokens);
      return this.tokens.access_token;
    } catch (e) {
      this.tokens = null;
      this.setStatus(STATUS.AUTH_REQUIRED, String(e?.message ?? e));
      throw e;
    }
  }

  async api(path, params) {
    const token = await this.accessToken();
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await this.fetchImpl(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(YT.connectTimeoutMs),
    });
    // Sanitized diagnostics: endpoint + status only, never tokens or bodies.
    this.lastApi = { endpoint: path, status: res.status, at: new Date().toISOString() };
    if (res.status === 401) {
      this.tokens = null;
      this.setStatus(STATUS.AUTH_REQUIRED, "unauthorized");
      throw new Error("unauthorized");
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const detail = classifyError(body);
      const err = new Error(`youtube-api:GET ${path}:${res.status}:${detail}`);
      err.status = res.status;
      err.detail = detail;
      throw err;
    }
    return res.json();
  }

  /**
   * Discover the creator's OWN active broadcast -> liveChatId.
   * API contract: liveBroadcasts.list accepts EXACTLY ONE of
   * broadcastStatus | id | mine — never combine them. So we query
   * broadcastStatus=active (no mine) and verify ownership client-side
   * against channels.list(mine=true) — never attach to another channel's chat.
   * Event-type first (scheduled streams), then all (persistent "stream now"
   * keys) — read-only, one extra call only when the first finds nothing.
   */
  async discover() {
    const own = await this.ownChannel();
    for (const bt of ["event", "all"]) {
      const data = await this.api("/liveBroadcasts", {
        part: "snippet",
        broadcastStatus: "active",
        broadcastType: bt,
        maxResults: 10,
      });
      const items = Array.isArray(data.items) ? data.items : [];
      // Sanitized discovery counts (no ids/titles): distinguishes "nothing live"
      // from "live but not ours", and records which type matched.
      this.lastDiscovery = {
        at: new Date().toISOString(),
        broadcastType: bt,
        activeItems: items.length,
        withChat: items.filter((b) => b?.snippet?.liveChatId).length,
        ownChannelMatch: items.filter((b) => b?.snippet?.channelId === own).length,
      };
      const live = items.find(
        (b) => b?.snippet?.liveChatId && b.snippet.channelId === own,
      );
      if (live) return { liveChatId: live.snippet.liveChatId, title: live.snippet.title ?? "(untitled)" };
    }
    return null;
  }

  /** Authenticated user's channel id, cached. Read-only, ~1 quota unit. */
  async ownChannel() {
    if (this.ownChannelId) return this.ownChannelId;
    const data = await this.api("/channels", { part: "id", mine: "true", maxResults: 1 });
    const id = Array.isArray(data.items) ? data.items[0]?.id : null;
    if (typeof id !== "string" || !id) throw new Error("own-channel-unresolved");
    this.ownChannelId = id;
    return id;
  }

  async connect() {
    if (!this.client) {
      this.setStatus(STATUS.DISCONNECTED, "oauth-not-configured");
      return this.getState();
    }
    if (!this.tokens) {
      this.setStatus(STATUS.AUTH_REQUIRED);
      return this.getState();
    }
    // Idempotent: a live chain already owns the poll loop — never spawn a
    // second one (double Connect / retry overlap would double-poll quota).
    if (!this.stopped && (this.status === STATUS.STREAMING || this.status === STATUS.LIVE_CHAT_FOUND)) {
      return this.getState();
    }
    this.stopped = false;
    this.reconnects = 0;
    this.setStatus(STATUS.CONNECTING);
    await this.discoverAndStream();
    return this.getState();
  }

  disconnect() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.status !== STATUS.AUTH_REQUIRED && this.status !== STATUS.DISCONNECTED) {
      this.setStatus(STATUS.DISCONNECTED);
    }
  }

  async discoverAndStream() {
    // A healthy chain already owns the loop (e.g. scheduled retry firing
    // after a manual Connect) — do not spawn a duplicate.
    if (!this.stopped && (this.status === STATUS.STREAMING || this.status === STATUS.LIVE_CHAT_FOUND)) {
      return;
    }
    try {
      const found = await this.discover();
      if (this.stopped) return;
      if (!found) {
        this.liveChatId = null;
        this.setStatus(STATUS.STREAM_ENDED, "no-active-broadcast");
        this.schedule(() => void this.discoverAndStream(), 60000);
        return;
      }
      this.liveChatId = found.liveChatId;
      this.broadcastTitle = found.title;
      this.pageToken = null; // fresh page: only newest history, never older
      this.setStatus(STATUS.LIVE_CHAT_FOUND);
      await this.pollOnce();
    } catch (e) {
      if (this.stopped) return;
      this.diag.apiErrors += 1;
      this.onApiFailure(e);
    }
  }

  /** One poll of liveChatMessages.list. Public so tests can drive it. */
  async pollOnce() {
    if (this.stopped || !this.liveChatId) return;
    try {
      const params = {
        liveChatId: this.liveChatId,
        part: "id,snippet,authorDetails",
        maxResults: YT.maxResults,
      };
      if (this.pageToken) params.pageToken = this.pageToken;
      const data = await this.api("/liveChat/messages", params);
      this.diag.polls += 1;
      if (this.stopped) return;
      this.pageToken = data.nextPageToken ?? this.pageToken;
      const rawItems = Array.isArray(data.items) ? data.items : [];
      this.diag.seen += rawItems.length; // observed from the API (pre-cursor)
      // Restart guard: skip history already observed by a previous session.
      const items = this.applyCursor(rawItems);
      // Advance the cursor to the newest item of THIS page (observed, even if
      // ignored) so a restart resumes after it.
      if (rawItems.length > 0) {
        const newest = rawItems[rawItems.length - 1];
        if (newest && typeof newest.id === "string") {
          this.cursor = {
            liveChatId: this.liveChatId,
            platformId: newest.id,
            publishedAt: newest.snippet?.publishedAt ?? new Date().toISOString(),
          };
          await this.saveCursor();
        }
      }
      const events = [];
      for (const item of items) {
        let mapped;
        try {
          mapped = mapYouTubeMessage(item);
        } catch {
          this.diag.ignored += 1;
          continue;
        }
        if (mapped.outcome === "command") {
          this.diag.commands += 1;
          events.push(mapped.event);
        } else if (mapped.outcome === "paid") {
          this.diag.paid += 1;
          events.push(mapped.event);
        } else if (mapped.outcome === "retraction") {
          // 5G-1 candidate: forwarded as-is. The mapper never claims the
          // referenced message was paid; the ledger (5G-2) decides that.
          this.diag.retractions += 1;
          events.push(mapped.event);
        } else {
          this.diag.ignored += 1;
        }
      }
      this.reconnects = 0;
      this.setStatus(STATUS.STREAMING);
      if (events.length > 0) {
        try {
          this.onEvents(events);
        } catch {
          /* sink failure must not kill the poll loop */
        }
      }
      const wait = clampPoll(data.pollingIntervalMillis);
      // offlineAt present => stream ended.
      if (data.offlineAt) {
        this.setStatus(STATUS.STREAM_ENDED, "broadcast-offline");
        this.schedule(() => void this.discoverAndStream(), 60000);
        return;
      }
      this.schedule(() => void this.pollOnce(), wait);
    } catch (e) {
      if (this.stopped) return;
      this.diag.apiErrors += 1;
      this.onApiFailure(e);
    }
  }

  // ------------------------------------------------------------------
  // T3 outbound announcements: one insert per vote event.
  //
  // Contract (server side, never the browser):
  // - validate text (1..200 chars) and a safe event identity;
  // - require an authenticated token AND a connected live chat;
  // - dedupe by eventId (retries reuse the identity; already-delivered
  //   reports success with `duplicate: true`, never a second insert);
  // - throttle inserts per rolling minute (quota guard);
  // - serialize inserts so open-before-close ordering holds per chat;
  // - ambiguous timeouts report `uncertain` and record NOTHING — the
  //   operator reconciles (check chat) before any retry.
  // Returns typed results only; tokens and Google bodies never leave.
  // ------------------------------------------------------------------

  pruneSendTimes(now) {
    const cutoff = now - 60000;
    while (this.sendTimes.length > 0 && this.sendTimes[0] < cutoff) this.sendTimes.shift();
  }

  markDelivered(eventId, messageId) {
    this.delivered.set(eventId, messageId ?? null);
    while (this.delivered.size > YT.maxDeliveredEvents) {
      this.delivered.delete(this.delivered.keys().next().value);
    }
  }

  async sendChatMessage({ text, eventId }) {
    if (typeof text !== "string" || text.trim().length === 0) {
      return { ok: false, error: "invalid-text" };
    }
    if (Array.from(text).length > 200) return { ok: false, error: "too-long" };
    if (typeof eventId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(eventId)) {
      return { ok: false, error: "invalid-event" };
    }
    if (!this.tokens) return { ok: false, error: "auth-required" };
    if (this.stopped || !this.liveChatId) return { ok: false, error: "no-live-chat" };
    if (this.delivered.has(eventId)) {
      return { ok: true, duplicate: true, messageId: this.delivered.get(eventId) };
    }
    const run = this.sendChain.then(() => this.insertThrottled(text, eventId));
    // A failed insert must not break the chain for later announcements.
    this.sendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async insertThrottled(text, eventId) {
    // Re-check under the lock: a concurrent retry may have delivered first.
    if (this.delivered.has(eventId)) {
      return { ok: true, duplicate: true, messageId: this.delivered.get(eventId) };
    }
    const now = Date.now();
    this.pruneSendTimes(now);
    if (this.sendTimes.length >= YT.maxSendsPerMinute) {
      return { ok: false, error: "rate-limited" };
    }
    return this.insertMessage(text, eventId);
  }

  async insertMessage(text, eventId) {
    let token;
    try {
      token = await this.accessToken();
    } catch {
      // accessToken() already moved status to AUTH_REQUIRED on failure.
      return { ok: false, error: "auth-required" };
    }
    this.sendTimes.push(Date.now());
    let res;
    try {
      res = await this.fetchImpl(`${API}/liveChat/messages?part=snippet`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          snippet: {
            liveChatId: this.liveChatId,
            type: "textMessageEvent",
            textMessageDetails: { messageText: text },
          },
        }),
        signal: AbortSignal.timeout(YT.sendTimeoutMs),
      });
    } catch (e) {
      // Timeout: Google may or may not have accepted the message. Report
      // `uncertain` and record nothing — blind retry could double-post.
      if (e?.name === "AbortError") return { ok: false, error: "uncertain" };
      this.diag.apiErrors += 1;
      return { ok: false, error: "api-error" };
    }
    // Sanitized diagnostics: endpoint + status only, never tokens or bodies.
    this.lastApi = { endpoint: "/liveChat/messages:insert", status: res.status, at: new Date().toISOString() };
    if (res.status === 401) {
      this.tokens = null;
      this.setStatus(STATUS.AUTH_REQUIRED, "unauthorized");
      return { ok: false, error: "auth-required" };
    }
    if (res.ok) {
      let messageId = null;
      try {
        const data = await res.json();
        messageId = typeof data?.id === "string" ? data.id : null;
      } catch {
        /* id is best-effort */
      }
      this.markDelivered(eventId, messageId);
      this.outbound = "ok";
      return { ok: true, messageId };
    }
    const body = await res.text().catch(() => "");
    const detail = classifyError(body);
    const hay = `${detail} ${body.slice(0, 300)}`;
    this.diag.apiErrors += 1;
    // Missing insert permission (readonly-only grant): fail closed and
    // remember it so the dashboard can ask for re-consent.
    if (res.status === 403 && /insufficient/i.test(hay)) {
      this.outbound = "insufficient";
      return { ok: false, error: "insufficient-scope" };
    }
    if (/quotaExceeded/i.test(detail)) return { ok: false, error: "quota-exceeded" };
    if (res.status === 429 || /rateLimitExceeded|userRateLimitExceeded|rateLimit/i.test(detail)) {
      return { ok: false, error: "rate-limited" };
    }
    if (["liveChatEnded", "liveChatDisabled", "liveChatNotFound"].includes(detail)) {
      return { ok: false, error: "no-live-chat" };
    }
    return { ok: false, error: "api-error" };
  }

  onApiFailure(e) {
    const detail = e?.detail ?? String(e?.message ?? e);
    // Ended/disabled chat: stop polling chat, fall back to discovery.
    if (["liveChatEnded", "liveChatDisabled", "liveChatNotFound"].includes(detail)) {
      this.setStatus(STATUS.STREAM_ENDED, detail);
      this.schedule(() => void this.discoverAndStream(), 60000);
      return;
    }
    // Stale continuation token: restart from a fresh page (dedup stays safe).
    if (detail.includes("pageTokenInvalid") || e?.status === 400) {
      this.pageToken = null;
      this.setStatus(STATUS.RECONNECTING, detail);
      this.schedule(() => void this.pollOnce(), 5000);
      return;
    }
    // Transient: bounded exponential backoff.
    if (this.reconnects >= YT.maxReconnects) {
      this.setStatus(STATUS.ERROR, `reconnect-budget-exhausted:${detail}`);
      return;
    }
    this.reconnects += 1;
    const wait = Math.min(YT.backoffBaseMs * 2 ** (this.reconnects - 1), YT.backoffCapMs);
    this.setStatus(STATUS.RECONNECTING, detail);
    this.schedule(() => void this.pollOnce(), wait);
  }

  schedule(fn, ms) {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(fn, ms);
  }
}

export function clampPoll(serverMs) {
  const n = Number(serverMs);
  if (!Number.isFinite(n)) return YT.minPollMs;
  return Math.min(Math.max(n, YT.minPollMs), YT.maxPollMs);
}

function classifyError(body) {
  try {
    const parsed = JSON.parse(body);
    const reasons = parsed?.error?.errors?.map((x) => x.reason).filter(Boolean) ?? [];
    if (reasons.length > 0) return reasons.join(",");
    if (typeof parsed?.error?.message === "string") return parsed.error.message.slice(0, 80);
  } catch {
    /* not JSON */
  }
  return "unknown";
}
