import { describe, expect, it } from "vitest";
import { COMMANDS, QUEUE } from "../src/engine/config";
import { GameEngine } from "../src/engine/engine";
import type { CanonicalEvent } from "../src/engine/types";
import { mapYouTubeMessage, microsToMinor, YT_SOURCE } from "../server/youtube/mapper.mjs";
import { YouTubeAdapter, STATUS } from "../server/youtube/adapter.mjs";

function harness() {
  let t = 1_000_000;
  const now = () => t;
  const engine = new GameEngine({ now });
  const drain = () => {
    const out = [];
    for (let i = 0; i < 500 && engine.queue.size > 0; i++) {
      t += QUEUE.minGapMs + 50;
      out.push(...engine.pump());
    }
    return out;
  };
  return { engine, drain };
}

function textMsg(overrides = {}) {
  return {
    id: "MSG-1",
    snippet: {
      type: "textMessageEvent",
      liveChatId: "CHAT",
      authorChannelId: "UC-AAA",
      publishedAt: "2026-11-02T10:00:00Z",
      textMessageDetails: { messageText: "!strike" },
    },
    authorDetails: { channelId: "UC-AAA", displayName: "Kaushal" },
    ...overrides,
  };
}

function superChatMsg(overrides = {}) {
  return {
    id: "SC-1",
    snippet: {
      type: "superChatEvent",
      liveChatId: "CHAT",
      authorChannelId: "UC-BBB",
      publishedAt: "2026-11-02T10:01:00Z",
      superChatDetails: { amountMicros: "500000000", currency: "INR", userComment: "go go" },
    },
    authorDetails: { channelId: "UC-BBB", displayName: "Donor" },
    ...overrides,
  };
}

describe("YouTube adapter — mapping + engine boundary", () => {
  it("1. valid !strike message becomes chat_command", () => {
    const m = mapYouTubeMessage(textMsg());
    expect(m.outcome).toBe("command");
    if (m.outcome !== "command") throw new Error("expected command");
    expect(m.event).toMatchObject({
      kind: "chat_command",
      command: "!strike",
      actorName: "Kaushal",
      source: YT_SOURCE,
      platformEventId: "MSG-1",
    });
    expect(m.event.eventId).toBe("yt:MSG-1");
    expect(m.event.actorId).toBe("yt:UC-AAA");
  });

  it("2. valid !mend message becomes chat_command", () => {
    const m = mapYouTubeMessage(textMsg({ id: "MSG-2", snippet: { type: "textMessageEvent", authorChannelId: "UC-X", publishedAt: "2026-11-02T10:00:01Z", textMessageDetails: { messageText: "  !Mend please " } } }));
    expect(m.outcome).toBe("command");
    if (m.outcome !== "command") throw new Error("expected command");
    expect(m.event.command).toBe("!mend");
  });

  it("3. unknown !command is rejected at the engine boundary, harmlessly", () => {
    const { engine, drain } = harness();
    const m = mapYouTubeMessage(textMsg({ id: "MSG-9", snippet: { type: "textMessageEvent", authorChannelId: "UC-Z", publishedAt: "2026-11-02T10:00:02Z", textMessageDetails: { messageText: "!dance" } } }));
    expect(m.outcome).toBe("command"); // adapter forwards the candidate…
    expect("!dance" in COMMANDS).toBe(false); // …browser/client filters it…
    const hpBefore = engine.world.enemy.hp;
    // …and even a direct ingest is neutralized by the engine itself.
    expect(engine.ingest(m.event as CanonicalEvent)).toBe("queued");
    const results = drain();
    expect(results[0].action).toBe("rejected");
    expect(engine.world.enemy.hp).toBe(hpBefore);
  });

  it("4. ordinary chat never becomes a gameplay event", () => {
    for (const text of ["hello everyone", "attack the goblin", "!", " ! ", ""]) {
      const m = mapYouTubeMessage(
        textMsg({ id: `T-${text.length}-${text.slice(0, 4)}`, snippet: { type: "textMessageEvent", authorChannelId: "U", publishedAt: "2026-11-02T10:00:00Z", textMessageDetails: { messageText: text } } }),
      );
      expect(m.outcome).toBe("ignored");
      expect(m.event).toBeUndefined();
    }
    // A "!!" token IS !-prefixed, so the adapter forwards it as a candidate —
    // and the whitelist boundary (client + engine) rejects it. Two layers.
    const bang = mapYouTubeMessage(
      textMsg({ id: "T-BANG", snippet: { type: "textMessageEvent", authorChannelId: "U", publishedAt: "2026-11-02T10:00:00Z", textMessageDetails: { messageText: "!!" } } }),
    );
    expect(bang.outcome).toBe("command");
    expect("!!" in COMMANDS).toBe(false);
  });

  it("5+6. Super Chat becomes paid_event with amount/currency preserved", () => {
    const m = mapYouTubeMessage(superChatMsg());
    expect(m.outcome).toBe("paid");
    if (m.outcome !== "paid") throw new Error("expected paid");
    expect(m.event).toMatchObject({
      kind: "paid_event",
      eventId: "yt:SC-1",
      currency: "INR",
      source: YT_SOURCE,
      platformEventId: "SC-1",
    });
    // 500,000,000 micros INR == Rs 500 == 50000 paise.
    expect(m.event.amount).toBe(50000);
  });

  it("super sticker maps to paid; memberships/polls/gifts are ignored", () => {
    const sticker = mapYouTubeMessage({
      id: "ST-1",
      snippet: { type: "superStickerEvent", authorChannelId: "U", publishedAt: "2026-11-02T10:00:00Z", superStickerDetails: { amountMicros: 100000000, currency: "INR" } },
      authorDetails: { channelId: "U", displayName: "S" },
    });
    expect(sticker.outcome).toBe("paid");
    if (sticker.outcome !== "paid") throw new Error("expected paid");
    expect(sticker.event.amount).toBe(10000);
    for (const type of ["membershipGiftingEvent", "newSponsorEvent", "memberMilestoneChatEvent", "pollEvent", "tombstone", "chatEndedEvent"]) {
      expect(mapYouTubeMessage({ id: "X", snippet: { type, authorChannelId: "U" }, authorDetails: {} }).outcome).toBe("ignored");
    }
  });

  it("micros conversion honors zero-decimal currencies", () => {
    expect(microsToMinor("1000000", "JPY")).toBe(1); // ¥1
    expect(microsToMinor("1000000", "USD")).toBe(100); // $1.00 -> 100 cents
    expect(microsToMinor("abc", "INR")).toBe(0);
    expect(microsToMinor(-5, "INR")).toBe(0);
  });

  it("7+8. stable IDs: redelivery is a duplicate, processed once", () => {
    const { engine, drain } = harness();
    const a = mapYouTubeMessage(textMsg());
    const b = mapYouTubeMessage(structuredClone(textMsg()));
    expect(a.event!.eventId).toBe(b.event!.eventId);
    expect(engine.ingest(a.event as CanonicalEvent)).toBe("queued");
    expect(engine.ingest(b.event as CanonicalEvent)).toBe("duplicate");
    const hpBefore = engine.world.enemy.hp;
    drain();
    expect(engine.world.enemy.hp).toBe(hpBefore - 7); // exactly one attack
  });

  it("9. malformed payloads are safely rejected", () => {
    const { engine } = harness();
    for (const bad of [null, undefined, 42, "x", {}, { id: "N" }, { snippet: { type: "textMessageEvent" } }, { id: "N2", snippet: { type: "superChatEvent", authorChannelId: "U" }, authorDetails: {} }]) {
      expect(mapYouTubeMessage(bad as never).outcome).toBe("ignored");
    }
    expect(engine.ingest(null as never)).toBe("rejected-invalid");
    expect(engine.ingest({} as never)).toBe("rejected-invalid");
    expect(engine.queue.size).toBe(0);
  });

  it("10. adapter failure cannot crash or mutate the game engine", async () => {
    const { engine } = harness();
    const hpBefore = engine.world.enemy.hp;
    const adapter = new YouTubeAdapter({
      fetchImpl: async () => {
        throw new Error("network-down");
      },
      onEvents: () => {
        throw new Error("sink must never fire");
      },
    });
    adapter.tokens = { access_token: "x", expires_at: Date.now() + 3600000 };
    adapter.liveChatId = "CHAT";
    adapter.stopped = false;
    await adapter.pollOnce(); // must not throw
    expect([STATUS.RECONNECTING, STATUS.ERROR]).toContain(adapter.status);
    adapter.disconnect();
    expect(engine.world.enemy.hp).toBe(hpBefore);
    expect(engine.queue.size).toBe(0);
  });

  it("adapter polls, maps, and emits through the sink (mocked API)", async () => {
    const seen: CanonicalEvent[] = [];
    const adapter = new YouTubeAdapter({
      fetchImpl: (async (url: string) => {
        if (url.includes("/liveChat/messages")) {
          return { ok: true, status: 200, json: async () => ({ nextPageToken: "T2", pollingIntervalMillis: 120000, items: [textMsg(), superChatMsg()] }) };
        }
        throw new Error(`unexpected:${url}`);
      }) as typeof fetch,
      onEvents: (events) => {
        seen.push(...(events as CanonicalEvent[]));
      },
    });
    adapter.tokens = { access_token: "x", expires_at: Date.now() + 3600000 };
    adapter.liveChatId = "CHAT";
    adapter.stopped = false;
    await adapter.pollOnce();
    expect(adapter.status).toBe(STATUS.STREAMING);
    expect(seen.map((e) => e.kind)).toEqual(["chat_command", "paid_event"]);
    expect(adapter.diag).toMatchObject({ seen: 2, commands: 1, paid: 1 });
    adapter.disconnect();
  });

  it("super chat reaches the EXISTING paid pipeline (₹500 -> elite)", () => {
    const { engine, drain } = harness();
    const m = mapYouTubeMessage(superChatMsg());
    expect(engine.ingest(m.event as CanonicalEvent)).toBe("queued");
    drain();
    expect(engine.world.enemy.isElite).toBe(true);
    expect(engine.world.storyFlags["elite_threat_active"]).toBe(true);
  });

  it("11. simulation and youtube events share one canonical structure", () => {
    const { engine } = harness();
    const sim: CanonicalEvent = {
      kind: "chat_command", eventId: "cmd-1", actorId: "kaushal",
      actorName: "Kaushal", command: "!strike", receivedAt: "2026-11-02T10:00:00Z",
    };
    const yt = mapYouTubeMessage(textMsg({ id: "SAME-1" })).event as CanonicalEvent;
    const simKeys = Object.keys(sim).sort();
    for (const k of simKeys) expect(yt).toHaveProperty(k);
    expect(engine.ingest(sim)).toBe("queued");
    expect(engine.ingest(yt)).toBe("queued");
  });
});

describe("discovery request contract (liveBroadcasts.list filters)", () => {
  const OWN = { id: "B-OWN", snippet: { title: "My Stream", channelId: "UC-OWN", liveChatId: "CHAT-MINE" } };
  const FOREIGN = { id: "B-F", snippet: { title: "Stranger", channelId: "UC-OTHER", liveChatId: "CHAT-X" } };

  function discoveryStub(calls: string[], broadcasts: unknown[], channelId: string | null = "UC-OWN") {
    return (async (url: string) => {
      calls.push(url);
      if (url.includes("/channels")) {
        return { ok: true, status: 200, json: async () => ({ items: channelId ? [{ id: channelId }] : [] }) };
      }
      if (url.includes("/liveBroadcasts")) {
        return { ok: true, status: 200, json: async () => ({ items: broadcasts }) };
      }
      throw new Error(`unexpected:${url}`);
    }) as unknown as typeof fetch;
  }

  function authed(calls: string[], broadcasts: unknown[], channelId: string | null = "UC-OWN") {
    const a = new YouTubeAdapter({ fetchImpl: discoveryStub(calls, broadcasts, channelId) });
    a.tokens = { access_token: "x", expires_at: Date.now() + 3600000 };
    return a;
  }

  it("never combines mine with broadcastStatus; picks the owner's chat only", async () => {
    const calls: string[] = [];
    const found = await authed(calls, [FOREIGN, OWN]).discover();
    expect(found).toEqual({ liveChatId: "CHAT-MINE", title: "My Stream" });
    const bc = new URL(calls.find((u) => u.includes("/liveBroadcasts"))!);
    expect(bc.searchParams.get("broadcastStatus")).toBe("active");
    expect(bc.searchParams.get("broadcastType")).toBe("event");
    expect(bc.searchParams.has("mine")).toBe(false); // contract: never mine+broadcastStatus
    const ch = new URL(calls.find((u) => u.includes("/channels"))!);
    expect(ch.searchParams.get("mine")).toBe("true");
    expect(ch.searchParams.has("broadcastStatus")).toBe(false);
  });

  it("foreign-only results fail closed (no attach to another channel)", async () => {
    expect(await authed([], [FOREIGN]).discover()).toBeNull();
  });

  it("empty results mean no active broadcast (not an error)", async () => {
    expect(await authed([], []).discover()).toBeNull();
  });

  it("falls back to broadcastType=all only when event finds nothing", async () => {
    const calls: string[] = [];
    const a = authed(calls, []);
    // Re-stub: empty for event, own stream for all.
    a.fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.includes("/channels")) {
        return { ok: true, status: 200, json: async () => ({ items: [{ id: "UC-OWN" }] }) };
      }
      if (url.includes("/liveBroadcasts")) {
        const bt = new URL(url).searchParams.get("broadcastType");
        return { ok: true, status: 200, json: async () => ({ items: bt === "all" ? [OWN] : [] }) };
      }
      throw new Error(`unexpected:${url}`);
    }) as unknown as typeof fetch;
    const found = await a.discover();
    expect(found).toEqual({ liveChatId: "CHAT-MINE", title: "My Stream" });
    const types = calls.filter((u) => u.includes("/liveBroadcasts")).map((u) => new URL(u).searchParams.get("broadcastType"));
    expect(types).toEqual(["event", "all"]);
    expect(a.getState().discovery).toMatchObject({ broadcastType: "all", activeItems: 1, ownChannelMatch: 1 });
  });

  it("no fallback call when event query already finds the stream", async () => {
    const calls: string[] = [];
    await authed(calls, [OWN]).discover();
    expect(calls.filter((u) => u.includes("/liveBroadcasts"))).toHaveLength(1);
  });

  it("own channel id is cached across discovers (one channels call)", async () => {
    const calls: string[] = [];
    const a = authed(calls, [OWN]);
    await a.discover();
    await a.discover();
    expect(calls.filter((u) => u.includes("/channels"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("/liveBroadcasts"))).toHaveLength(2);
  });

  it("connect is idempotent while streaming (no second poll chain)", async () => {
    let broadcastsCalls = 0;
    const a = new YouTubeAdapter({
      client: { clientId: "id", clientSecret: "secret" },
      fetchImpl: (async (url: string) => {
        if (url.includes("/channels")) {
          return { ok: true, status: 200, json: async () => ({ items: [{ id: "UC-OWN" }] }) };
        }
        if (url.includes("/liveBroadcasts")) {
          broadcastsCalls += 1;
          return { ok: true, status: 200, json: async () => ({ items: [OWN] }) };
        }
        if (url.includes("/liveChat/messages")) {
          return { ok: true, status: 200, json: async () => ({ nextPageToken: "T", pollingIntervalMillis: 60000, items: [] }) };
        }
        throw new Error(`unexpected:${url}`);
      }) as unknown as typeof fetch,
    });
    a.tokens = { access_token: "x", expires_at: Date.now() + 3600000 };
    await a.connect();
    expect(a.status).toBe(STATUS.STREAMING);
    expect(broadcastsCalls).toBe(1);
    const again = await a.connect();
    expect(again.status).toBe(STATUS.STREAMING);
    expect(broadcastsCalls).toBe(1); // no re-discovery, no second chain
    await a.discoverAndStream(); // scheduled retry firing mid-stream
    expect(broadcastsCalls).toBe(1);
    a.disconnect();
  });

  it("unresolvable owner channel throws (backoff path, never misattach)", async () => {
    await expect(authed([], [OWN], null).discover()).rejects.toThrow("own-channel-unresolved");
  });
});

describe("paid retraction boundary (5G-1 — candidates only, no ledger)", () => {
  function retractedMsg(overrides = {}) {
    return {
      id: "RT-1",
      snippet: {
        type: "messageRetractedEvent",
        liveChatId: "CHAT",
        authorChannelId: "UC-AAA",
        publishedAt: "2026-11-02T10:02:00Z",
        messageRetractedDetails: { retractedMessageId: "SC-1" },
      },
      authorDetails: { channelId: "UC-AAA", displayName: "Kaushal" },
      ...overrides,
    };
  }

  function deletedMsg(overrides = {}) {
    return {
      id: "DEL-1",
      snippet: {
        type: "messageDeletedEvent",
        liveChatId: "CHAT",
        authorChannelId: "UC-MOD",
        publishedAt: "2026-11-02T10:03:00Z",
        messageDeletedDetails: { deletedMessageId: "SC-1" },
      },
      authorDetails: { channelId: "UC-MOD", displayName: "Mod" },
      ...overrides,
    };
  }

  it("1. messageRetractedEvent maps to a paid_retraction candidate", () => {
    const m = mapYouTubeMessage(retractedMsg());
    expect(m.outcome).toBe("retraction");
    if (m.outcome !== "retraction") throw new Error("expected retraction");
    expect(m.event).toMatchObject({
      kind: "paid_retraction",
      eventId: "yt:retraction:SC-1",
      refPlatformId: "SC-1",
      platformEventId: "RT-1",
      source: YT_SOURCE,
      receivedAt: "2026-11-02T10:02:00Z",
    });
  });

  it("2. messageDeletedEvent maps to the same canonical shape", () => {
    const m = mapYouTubeMessage(deletedMsg());
    expect(m.outcome).toBe("retraction");
    if (m.outcome !== "retraction") throw new Error("expected retraction");
    expect(m.event).toMatchObject({
      kind: "paid_retraction",
      eventId: "yt:retraction:SC-1",
      refPlatformId: "SC-1",
      platformEventId: "DEL-1",
      source: YT_SOURCE,
    });
  });

  it("3. retraction eventId is unique from the original paid eventId", () => {
    const paid = mapYouTubeMessage(superChatMsg());
    const ret = mapYouTubeMessage(retractedMsg());
    if (paid.outcome !== "paid" || ret.outcome !== "retraction") throw new Error("expected paid + retraction");
    expect(paid.event!.eventId).toBe("yt:SC-1");
    expect(ret.event!.eventId).toBe("yt:retraction:SC-1");
    expect(ret.event!.eventId).not.toBe(paid.event!.eventId);
  });

  it("4. refPlatformId is preserved exactly", () => {
    const ref = "SC_abc-123.xyz";
    const m = mapYouTubeMessage(
      retractedMsg({ snippet: { type: "messageRetractedEvent", liveChatId: "CHAT", publishedAt: "2026-11-02T10:02:00Z", messageRetractedDetails: { retractedMessageId: ref } } }),
    );
    expect(m.outcome).toBe("retraction");
    if (m.outcome !== "retraction") throw new Error("expected retraction");
    expect(m.event.refPlatformId).toBe(ref);
    expect(m.event.eventId).toBe(`yt:retraction:${ref}`);
  });

  it("6+7. missing reference ids are ignored, never fabricated", () => {
    for (const bad of [
      retractedMsg({ snippet: { type: "messageRetractedEvent", liveChatId: "CHAT", publishedAt: "2026-11-02T10:02:00Z", messageRetractedDetails: {} } }),
      retractedMsg({ snippet: { type: "messageRetractedEvent", liveChatId: "CHAT", publishedAt: "2026-11-02T10:02:00Z" } }),
      deletedMsg({ snippet: { type: "messageDeletedEvent", liveChatId: "CHAT", publishedAt: "2026-11-02T10:03:00Z", messageDeletedDetails: {} } }),
      deletedMsg({ snippet: { type: "messageDeletedEvent", liveChatId: "CHAT", publishedAt: "2026-11-02T10:03:00Z" } }),
    ]) {
      const m = mapYouTubeMessage(bad);
      expect(m.outcome).toBe("ignored");
      expect(m.event).toBeUndefined();
    }
  });

  it("8. malformed references are ignored safely", () => {
    for (const ref of ["", 42, null, "x".repeat(300)]) {
      for (const mk of [retractedMsg, deletedMsg]) {
        const base = mk();
        const key = base.snippet.type === "messageRetractedEvent" ? "messageRetractedDetails" : "messageDeletedDetails";
        const sub = key === "messageRetractedDetails" ? "retractedMessageId" : "deletedMessageId";
        const m = mapYouTubeMessage({
          ...base,
          snippet: { ...base.snippet, [key]: { [sub]: ref } },
        });
        expect(m.outcome).toBe("ignored");
        expect(m.event).toBeUndefined();
      }
    }
  });

  it("9. tombstone without a reference id fabricates nothing", () => {
    const m = mapYouTubeMessage({
      id: "T-1",
      snippet: { type: "tombstone", liveChatId: "CHAT", publishedAt: "2026-11-02T10:04:00Z" },
      authorDetails: {},
    });
    expect(m.outcome).toBe("ignored");
    expect(m.event).toBeUndefined();
  });

  it("10. unrelated deleted message is only a candidate — claims nothing paid", () => {
    const m = mapYouTubeMessage(
      deletedMsg({
        id: "DEL-9",
        snippet: { type: "messageDeletedEvent", liveChatId: "CHAT", publishedAt: "2026-11-02T10:03:00Z", messageDeletedDetails: { deletedMessageId: "MSG-1" } },
      }),
    );
    expect(m.outcome).toBe("retraction");
    if (m.outcome !== "retraction") throw new Error("expected retraction");
    expect(m.event.refPlatformId).toBe("MSG-1");
    expect(m.event).not.toHaveProperty("amount");
    expect(m.event).not.toHaveProperty("currency");
    expect(m.event).not.toHaveProperty("actorId");
    expect(m.event).not.toHaveProperty("actorName");
  });

  it("regression: paid + command mappings are unchanged", () => {
    const sc = mapYouTubeMessage(superChatMsg());
    expect(sc.outcome).toBe("paid");
    if (sc.outcome !== "paid") throw new Error("expected paid");
    expect(sc.event.amount).toBe(50000);
    const sticker = mapYouTubeMessage({
      id: "ST-9",
      snippet: { type: "superStickerEvent", authorChannelId: "U", publishedAt: "2026-11-02T10:00:00Z", superStickerDetails: { amountMicros: 100000000, currency: "INR" } },
      authorDetails: { channelId: "U", displayName: "S" },
    });
    expect(sticker.outcome).toBe("paid");
    const cmd = mapYouTubeMessage(textMsg());
    expect(cmd.outcome).toBe("command");
    const chat = mapYouTubeMessage(
      textMsg({ id: "T-PLAIN", snippet: { type: "textMessageEvent", authorChannelId: "U", publishedAt: "2026-11-02T10:00:00Z", textMessageDetails: { messageText: "hello everyone" } } }),
    );
    expect(chat.outcome).toBe("ignored");
  });

  it("engine boundary: retraction queues, processes, and mutates nothing", () => {
    const { engine, drain } = harness();
    const m = mapYouTubeMessage(retractedMsg());
    if (m.outcome !== "retraction") throw new Error("expected retraction");
    expect(engine.ingest(m.event as CanonicalEvent)).toBe("queued");
    // Duplicate delivery of the same retraction signal is a duplicate.
    expect(engine.ingest(structuredClone(m.event) as CanonicalEvent)).toBe("duplicate");
    const before = structuredClone(engine.world);
    const storyBefore = [...engine.storyLog];
    const results = drain();
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe("rejected");
    // 5G-2: an unresolvable signal is recorded as a bounded reference-only
    // ledger note — bookkeeping, not gameplay. All gameplay state is equal.
    const { paidLedger: _l1, ...gameBefore } = before;
    const { paidLedger: _l2, ...gameAfter } = engine.world;
    expect(gameAfter).toEqual(gameBefore);
    expect(engine.world.paidLedger).toHaveLength(1);
    expect(engine.world.paidLedger[0]).toMatchObject({
      status: "retraction-noted",
      platformEventId: "SC-1",
    });
    expect(engine.storyLog).toEqual(storyBefore);
    expect(engine.world.totalViewerActions).toBe(before.totalViewerActions);
    expect(engine.world.totalPaidEvents).toBe(before.totalPaidEvents);
    expect(engine.world.totalPaidMinorUnits).toBe(before.totalPaidMinorUnits);
  });

  it("engine boundary: malformed retraction candidates are rejected-invalid", () => {
    const { engine } = harness();
    const base = { kind: "paid_retraction", eventId: "yt:retraction:X", receivedAt: "2026-11-02T10:02:00Z" };
    expect(engine.ingest({ ...base, refPlatformId: "" } as never)).toBe("rejected-invalid");
    expect(engine.ingest({ ...base } as never)).toBe("rejected-invalid");
    expect(engine.queue.size).toBe(0);
  });

  it("adapter polls, maps, and emits retraction candidates (mocked API)", async () => {
    const seen: CanonicalEvent[] = [];
    const adapter = new YouTubeAdapter({
      fetchImpl: (async (url: string) => {
        if (url.includes("/liveChat/messages")) {
          return { ok: true, status: 200, json: async () => ({ nextPageToken: "T2", pollingIntervalMillis: 120000, items: [textMsg(), retractedMsg(), deletedMsg()] }) };
        }
        throw new Error(`unexpected:${url}`);
      }) as typeof fetch,
      onEvents: (events) => {
        seen.push(...(events as CanonicalEvent[]));
      },
    });
    adapter.tokens = { access_token: "x", expires_at: Date.now() + 3600000 };
    adapter.liveChatId = "CHAT";
    adapter.stopped = false;
    await adapter.pollOnce();
    expect(adapter.status).toBe(STATUS.STREAMING);
    expect(seen.map((e) => e.kind)).toEqual(["chat_command", "paid_retraction", "paid_retraction"]);
    expect(adapter.diag).toMatchObject({ seen: 3, commands: 1, retractions: 2, paid: 0 });
    adapter.disconnect();
  });
});
