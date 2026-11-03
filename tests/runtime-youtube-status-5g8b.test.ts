/**
 * Phase 5G-8B — runtime vs YouTube Live status UX contracts.
 * Pure presentation projections only: no engine, runtime, YouTube adapter,
 * auth, polling, or persistence behavior is touched or asserted here.
 */
import { describe, expect, it } from "vitest";
import {
  runtimeStatusModel,
  youtubeDisplayModel,
  type YouTubeStatusLike,
} from "../src/presentation/tidebound-presentation";
import { renderOverlay } from "../src/presentation/hud";
import { GameEngine } from "../src/engine/engine";
import { FeedAggregator } from "../src/engine/feed";
import { tideboundGenesis, TIDEBOUND_LIBRARY } from "../src/content/tidebound";
import { openStreamAndFire } from "../src/runtime/progression";

const yt = (s: YouTubeStatusLike["status"], extra: Partial<YouTubeStatusLike> = {}): YouTubeStatusLike => ({
  status: s,
  ...extra,
});

describe("5G-8B runtime status", () => {
  it("running runtime never renders an ambiguous YouTube LIVE status", () => {
    const m = runtimeStatusModel(false);
    expect(m.paused).toBe(false);
    expect(m.label).toContain("Runtime");
    expect(m.label).toContain("Running");
    expect(m.label).not.toMatch(/\blive\b/i);
    expect(m.label).not.toContain("YouTube");
  });

  it("paused runtime renders the paused state, still runtime-scoped", () => {
    const m = runtimeStatusModel(true);
    expect(m.paused).toBe(true);
    expect(m.label).toContain("Runtime");
    expect(m.label).toContain("Paused");
    expect(m.label).toContain("events held");
    expect(m.label).not.toMatch(/\byoutube\b/i);
  });
});

describe("5G-8B YouTube status (fail closed)", () => {
  it("simulation and YouTube Live remain distinct input-source options", () => {
    const sim = youtubeDisplayModel("simulation", yt("STREAMING", { broadcastTitle: "Show" }));
    // Even if the sidecar was streaming, simulation selected means not connected.
    expect(sim.state).toBe("Not connected");
    expect(sim.note).toContain("Simulation");
    const selected = youtubeDisplayModel("youtube", yt("STREAMING", { broadcastTitle: "Show" }));
    expect(selected.state).toBe("Receiving chat");
  });

  it("authorization is never presented as a chat connection", () => {
    const m = youtubeDisplayModel("youtube", yt("AUTH_REQUIRED"));
    expect(m.state).toBe("Needs authorization");
    expect(m.state).not.toContain("Connected");
    expect(m.note).toContain("Authorize with Google");
  });

  it("an authenticated sidecar without live chat is connected, not receiving", () => {
    const m = youtubeDisplayModel("youtube", yt("CONNECTED"));
    expect(m.state).toBe("Connected");
    expect(m.state).not.toContain("Receiving");
    expect(m.note).toContain("no live chat found yet");
  });

  it("each transitional and terminal state reads distinctly", () => {
    expect(youtubeDisplayModel("youtube", yt("off")).state).toBe("Not connected");
    expect(youtubeDisplayModel("youtube", yt("DISCONNECTED")).state).toBe("Disconnected");
    expect(youtubeDisplayModel("youtube", yt("DISCONNECTED", { error: "sidecar-unreachable" })).note).toContain(
      "youtube sidecar",
    );
    expect(youtubeDisplayModel("youtube", yt("CONNECTING")).state).toBe("Connecting…");
    expect(youtubeDisplayModel("youtube", yt("RECONNECTING", { reconnects: 2 })).state).toBe("Reconnecting…");
    expect(youtubeDisplayModel("youtube", yt("RECONNECTING", { reconnects: 2 })).note).toContain("2");
    const found = youtubeDisplayModel("youtube", yt("LIVE_CHAT_FOUND", { broadcastTitle: "Friday Siege" }));
    expect(found.state).toBe("Live chat found");
    expect(found.note).toContain("Friday Siege");
    const live = youtubeDisplayModel("youtube", yt("STREAMING", { broadcastTitle: "Friday Siege" }));
    expect(live.state).toBe("Receiving chat");
    expect(live.note).toContain("Friday Siege");
    expect(youtubeDisplayModel("youtube", yt("STREAM_ENDED")).state).toBe("Stream ended");
    expect(youtubeDisplayModel("youtube", yt("ERROR", { error: "boom" })).state).toBe("Error");
  });

  it("unknown adapter states fail closed and no platform ids leak", () => {
    const m = youtubeDisplayModel("youtube", {
      status: "SOMETHING_NEW",
      error: null,
      broadcastTitle: null,
    } as unknown as YouTubeStatusLike);
    expect(m.state).toBe("Not connected");
    const withIds: YouTubeStatusLike = {
      status: "LIVE_CHAT_FOUND",
      broadcastTitle: "Show",
    };
    const rendered = youtubeDisplayModel("youtube", withIds);
    // liveChatId / cursor ids must never appear; only the human title may.
    expect(JSON.stringify(rendered)).not.toContain("UC");
    expect(JSON.stringify(rendered)).not.toContain("liveChatId");
  });
});

describe("5G-8B viewer contracts unchanged", () => {
  it("overlay carries no runtime or YouTube status", () => {
    const engine = new GameEngine({ onResult: () => {} }, tideboundGenesis());
    const feed = new FeedAggregator();
    const opened = openStreamAndFire(engine.world, TIDEBOUND_LIBRARY);
    if (!opened.ok) throw new Error("expected open");
    engine.world = opened.world;
    const el = { innerHTML: "" } as unknown as HTMLElement;
    renderOverlay(el, {
      world: engine.world,
      session: opened.session,
      storyLog: engine.storyLog,
      feed: feed.list(),
      recent: engine.recentResults,
      paused: false,
    });
    const html = el.innerHTML;
    expect(html).toContain("Tidebound live overlay");
    expect(html).not.toContain("Runtime ·");
    expect(html).not.toContain("YouTube");
    expect(html).not.toContain("Pause runtime");
    expect(html).toContain("Story now");
  });
});
