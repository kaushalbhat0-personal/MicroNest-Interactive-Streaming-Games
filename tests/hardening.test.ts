import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { QUEUE, formatPaidLabel, toTierUnits } from "../src/engine/config";
import { GameEngine } from "../src/engine/engine";
import { FeedAggregator } from "../src/engine/feed";
import type { CanonicalEvent } from "../src/engine/types";
import { mapYouTubeMessage } from "../server/youtube/mapper.mjs";
import { YouTubeAdapter, STATUS } from "../server/youtube/adapter.mjs";

function harness() {
  let t = 1_000_000;
  const now = () => t;
  const engine = new GameEngine({ now });
  const advance = (ms: number) => {
    t += ms;
  };
  const drain = () => {
    const out = [];
    for (let i = 0; i < 2000 && engine.queue.size > 0; i++) {
      advance(QUEUE.minGapMs + 50);
      out.push(...engine.pump());
    }
    return out;
  };
  return { engine, drain, advance };
}

const okPage = (items: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ nextPageToken: "T2", pollingIntervalMillis: 60000, items }),
});

const apiError = (status: number, reason: string) => ({
  ok: false,
  status,
  text: async () => JSON.stringify({ error: { errors: [{ reason }] } }),
});

function chatMsg(id: string, text: string, ts: string) {
  return {
    id,
    snippet: {
      type: "textMessageEvent",
      authorChannelId: "UC-X",
      publishedAt: ts,
      textMessageDetails: { messageText: text },
    },
    authorDetails: { channelId: "UC-X", displayName: "X" },
  };
}

describe("Phase 3 — currency hardening (no /100 assumption)", () => {
  it("zero-decimal currencies scale to tier units; INR unchanged", () => {
    expect(toTierUnits(50000, "INR")).toBe(50000); // Rs 500 -> elite threshold
    expect(toTierUnits(500, "JPY")).toBe(50000); // ¥500 -> same tier meaning
    expect(toTierUnits(5000, "USD")).toBe(5000);
    expect(toTierUnits(50000, "inr")).toBe(50000); // case-insensitive
  });

  it("labels preserve the actual currency; INR display unchanged", () => {
    expect(formatPaidLabel(50000, "INR")).toBe("₹500 INR");
    expect(formatPaidLabel(500, "JPY")).toBe("500 JPY");
    expect(formatPaidLabel(500, "USD")).toBe("5 USD");
  });

  it("JPY ¥500 super chat reaches elite via the existing tiers", () => {
    const { engine, drain } = harness();
    const m = mapYouTubeMessage({
      id: "JPY-1",
      snippet: {
        type: "superChatEvent",
        authorChannelId: "U",
        publishedAt: "2026-11-02T10:00:00Z",
        superChatDetails: { amountMicros: "500000000", currency: "JPY" }, // ¥500
      },
      authorDetails: { channelId: "U", displayName: "Y" },
    });
    expect(m.outcome).toBe("paid");
    if (m.outcome !== "paid") throw new Error("expected paid");
    expect(m.event.amount).toBe(500); // minor units, NOT divided by 100
    expect(engine.ingest(m.event as CanonicalEvent)).toBe("queued");
    const [r] = drain();
    expect(r.action).toBe("paid_elite");
    expect(engine.world.enemy.isElite).toBe(true);
  });

  it("small JPY/USD amounts map to the strike tier, like INR ₹50", () => {
    for (const [micros, cur, minor] of [
      ["50000000", "JPY", 50],
      ["5000000", "USD", 500],
      ["50000000", "INR", 5000],
    ] as const) {
      const { engine, drain } = harness();
      const m = mapYouTubeMessage({
        id: `C-${cur}`,
        snippet: {
          type: "superChatEvent",
          authorChannelId: "U",
          publishedAt: "2026-11-02T10:00:00Z",
          superChatDetails: { amountMicros: micros, currency: cur },
        },
        authorDetails: { channelId: "U", displayName: "Y" },
      });
      expect(m.outcome).toBe("paid");
      if (m.outcome !== "paid") throw new Error("expected paid");
      expect(m.event.amount).toBe(minor);
      engine.ingest(m.event as CanonicalEvent);
      const [r] = drain();
      expect(r.action).toBe("paid_strike");
    }
  });
});

describe("Phase 3 — restart cursor (no duplicate gameplay after sidecar restart)", () => {
  const history = () => [
    chatMsg("M1", "!strike", "2026-11-02T10:00:00Z"),
    chatMsg("M2", "hello chat", "2026-11-02T10:00:01Z"),
    {
      id: "M3",
      snippet: {
        type: "superChatEvent",
        authorChannelId: "U",
        publishedAt: "2026-11-02T10:00:02Z",
        superChatDetails: { amountMicros: "5000000", currency: "USD" },
      },
      authorDetails: { channelId: "U", displayName: "Donor" },
    },
  ];

  it("a restarted adapter replays zero already-observed events", async () => {
    const cursorPath = join(tmpdir(), `yt-cursor-${Date.now()}.json`);
    try {
      const mk = (onEvents: (e: unknown[]) => void) =>
        new YouTubeAdapter({
          fetchImpl: (async () => okPage(history())) as unknown as typeof fetch,
          onEvents,
          cursorPath,
        });
      // Session 1: fresh, forwards command + paid.
      const seen1: unknown[] = [];
      const a1 = mk((e) => seen1.push(...e));
      a1.tokens = { access_token: "x", expires_at: Date.now() + 3600000 };
      a1.liveChatId = "CHAT";
      a1.stopped = false;
      await a1.pollOnce();
      a1.disconnect();
      expect(seen1).toHaveLength(2);

      // Session 2 (restart): same history from YouTube, forwards nothing.
      const seen2: unknown[] = [];
      const a2 = mk((e) => seen2.push(...e));
      a2.tokens = { access_token: "x", expires_at: Date.now() + 3600000 };
      await a2.loadCursor();
      a2.liveChatId = "CHAT";
      a2.stopped = false;
      await a2.pollOnce();
      a2.disconnect();
      expect(seen2).toHaveLength(0);
      expect(a2.diag.seen).toBe(3); // observed, but all at-or-before cursor
    } finally {
      await unlink(cursorPath).catch(() => {});
    }
  });

  it("cursor advances past ignored messages too (no infinite re-scan)", async () => {
    const cursorPath = join(tmpdir(), `yt-cursor2-${Date.now()}.json`);
    try {
      const a = new YouTubeAdapter({
        fetchImpl: (async () => okPage([chatMsg("N1", "hi", "2026-11-02T10:00:00Z")])) as unknown as typeof fetch,
        cursorPath,
      });
      a.tokens = { access_token: "x", expires_at: Date.now() + 3600000 };
      a.liveChatId = "CHAT";
      a.stopped = false;
      await a.pollOnce();
      a.disconnect();
      expect(a.getState().cursor).toMatchObject({ liveChatId: "CHAT", platformId: "N1" });
    } finally {
      await unlink(cursorPath).catch(() => {});
    }
  });
});

describe("Phase 3 — stream end, reconnect, token refresh", () => {
  it("liveChatEnded -> STREAM_ENDED (no crash, no spin, discovery rescheduled)", async () => {
    const a = new YouTubeAdapter({
      fetchImpl: (async (url: string) => {
        if (url.includes("/liveChat/messages")) return apiError(403, "liveChatEnded");
        throw new Error(`unexpected:${url}`);
      }) as unknown as typeof fetch,
    });
    a.tokens = { access_token: "x", expires_at: Date.now() + 3600000 };
    a.liveChatId = "CHAT";
    a.stopped = false;
    await a.pollOnce();
    expect(a.status).toBe(STATUS.STREAM_ENDED);
    expect(a.diag.apiErrors).toBe(1);
    a.disconnect(); // clears the 60s discovery timer
    expect(a.status).toBe(STATUS.DISCONNECTED);
  });

  it("offlineAt -> STREAM_ENDED with broadcast-offline reason", async () => {
    const a = new YouTubeAdapter({
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ nextPageToken: "T", pollingIntervalMillis: 60000, items: [], offlineAt: "2026-11-02T11:00:00Z" }),
      })) as unknown as typeof fetch,
    });
    a.tokens = { access_token: "x", expires_at: Date.now() + 3600000 };
    a.liveChatId = "CHAT";
    a.stopped = false;
    await a.pollOnce();
    expect(a.status).toBe(STATUS.STREAM_ENDED);
    a.disconnect();
  });

  it("expired access token refreshes transparently, then polls", async () => {
    const TOKEN = "https://oauth2.googleapis.com/token";
    const tokenPath = join(tmpdir(), `yt-tokens-${Date.now()}.json`);
    try {
      const a = new YouTubeAdapter({
        fetchImpl: (async (url: string) => {
          if (url === TOKEN) {
            return { ok: true, status: 200, json: async () => ({ access_token: "new-token", expires_in: 3600 }) };
          }
          if (url.includes("/liveChat/messages")) return okPage([]);
          throw new Error(`unexpected:${url}`);
        }) as unknown as typeof fetch,
      });
      a.tokens = { access_token: "old", expires_at: Date.now() - 1000, refresh_token: "rt" };
      // stub client so refresh has credentials
      (a as unknown as { client: unknown }).client = { clientId: "id", clientSecret: "secret" };
      (a as unknown as { tokenPath: unknown }).tokenPath = tokenPath;
      a.liveChatId = "CHAT";
      a.stopped = false;
      await a.pollOnce();
      expect(a.tokens.access_token).toBe("new-token");
      expect(a.status).toBe(STATUS.STREAMING);
      a.disconnect();
    } finally {
      await unlink(tokenPath).catch(() => {});
    }
  });
});

describe("Phase 3 — load / spam: queue stays bounded, paid keeps priority", () => {
  it("100-command burst + 5 paid: bounded, prioritized, batched, responsive", () => {
    const { engine, drain } = harness();
    const feed = new FeedAggregator();
    let dropped = 0;
    for (let i = 0; i < 100; i++) {
      const o = engine.ingestCommand(`v${i}`, `V${i}`, "!strike", `burst-${i}`);
      if (o === "dropped-full") dropped += 1;
      expect(engine.queue.size).toBeLessThanOrEqual(QUEUE.maxSize);
    }
    const paidOutcomes = [];
    for (let i = 0; i < 5; i++) {
      paidOutcomes.push(engine.ingestPaid("donor", "Donor", 5000, "INR", `burst-paid-${i}`));
    }
    // Queue held 100; the 5 paid overflow -> dropped, never unbounded.
    expect(engine.queue.size).toBeLessThanOrEqual(QUEUE.maxSize);
    expect(paidOutcomes).toContain("dropped-full");
    expect(dropped + paidOutcomes.filter((o) => o === "dropped-full").length).toBe(5);

    const t0 = performance.now();
    const results = drain();
    const dt = performance.now() - t0;
    expect(engine.queue.size).toBe(0);
    expect(dt).toBeLessThan(5000); // responsive, no spin
    for (const r of results) feed.push(r);
    const top = feed.list()[0];
    // All accepted attacks merged into one readable line.
    expect(top.action).toBe("attack");
    expect(top.count).toBe(100);
  });

  it("paid events overtake a full normal queue lane", () => {
    const { engine, advance } = harness();
    for (let i = 0; i < QUEUE.maxSize; i++) {
      engine.ingestCommand(`v${i}`, `V${i}`, "!strike", `fill-${i}`);
    }
    // Free one slot, then a paid event must jump the whole normal lane.
    engine.queue.dequeue();
    engine.ingestPaid("donor", "Donor", 5000, "INR", "priority-paid");
    advance(QUEUE.minGapMs + 50);
    const [first] = engine.pump();
    expect(first.action).toBe("paid_strike");
  });
});

describe("Phase 3 — pipeline latency + simulation parity", () => {
  it("local pipeline (map -> ingest -> process) completes in milliseconds", () => {
    const { engine, advance } = harness();
    const m = mapYouTubeMessage({
      id: "LAT-1",
      snippet: { type: "textMessageEvent", authorChannelId: "U", publishedAt: "2026-11-02T10:00:00Z", textMessageDetails: { messageText: "!strike" } },
      authorDetails: { channelId: "U", displayName: "L" },
    });
    if (m.outcome !== "command") throw new Error("expected command");
    const t0 = performance.now();
    engine.ingest(m.event as CanonicalEvent);
    advance(QUEUE.minGapMs + 50);
    const [r] = engine.pump();
    const dt = performance.now() - t0;
    expect(r.action).toBe("attack");
    expect(dt).toBeLessThan(500); // local budget; poll interval dominates live
  });

  it("simulation !strike and youtube !strike cause the identical consequence", () => {
    const mk = () => harness();
    const a = mk();
    a.engine.ingestCommand("kaushal", "Kaushal", "!strike", "sim-1");
    const ra = a.drain()[0];
    const b = mk();
    const m = mapYouTubeMessage({
      id: "YT-1",
      snippet: { type: "textMessageEvent", authorChannelId: "UC-K", publishedAt: "2026-11-02T10:00:00Z", textMessageDetails: { messageText: "!strike" } },
      authorDetails: { channelId: "UC-K", displayName: "Kaushal" },
    });
    if (m.outcome !== "command") throw new Error("expected command");
    b.engine.ingest(m.event as CanonicalEvent);
    const rb = b.drain()[0];
    expect(ra.action).toBe(rb.action);
    expect(a.engine.world.enemy.hp).toBe(b.engine.world.enemy.hp);
  });

  it("simulation ₹500 and youtube Super Chat ₹500 both summon the elite", () => {
    const a = harness();
    a.engine.ingestPaid("d", "D", 50000, "INR", "sim-paid");
    const b = harness();
    const m = mapYouTubeMessage({
      id: "YT-SC",
      snippet: {
        type: "superChatEvent", authorChannelId: "U", publishedAt: "2026-11-02T10:00:00Z",
        superChatDetails: { amountMicros: "500000000", currency: "INR" },
      },
      authorDetails: { channelId: "U", displayName: "D" },
    });
    if (m.outcome !== "paid") throw new Error("expected paid");
    b.engine.ingest(m.event as CanonicalEvent);
    const [ra] = a.drain();
    const [rb] = b.drain();
    expect(ra.action).toBe("paid_elite");
    expect(rb.action).toBe("paid_elite");
    expect(a.engine.world.enemy.isElite).toBe(true);
    expect(b.engine.world.enemy.isElite).toBe(true);
  });
});
