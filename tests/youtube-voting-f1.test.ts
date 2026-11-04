/**
 * F1 — real YouTube assembly voting integration.
 *
 * Defect: YouTube `!voteA`/`!voteB` reached the engine and advanced the vote
 * clock, but ballots were only cast on the simulation-panel path, so chat
 * votes never entered the tally. Fix: the browser transport forwards
 * whitelisted vote tokens through the SAME authoritative operation
 * (`castSessionVote`) the simulation path uses; the engine stays
 * session-agnostic (its `!votea/!voteb` cases remain deliberately inert).
 *
 * No gameplay, polling, OAuth, SSE, or persistence behavior is touched here.
 */
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../src/engine/config";
import { GameEngine } from "../src/engine/engine";
import {
  castSessionVote,
  openSessionVote,
  resolveSessionVote,
  type StreamSession,
} from "../src/engine/lifecycle";
import { tallyVote } from "../src/engine/vote";
import { KINDLING_VOTE, ROUTE_VOTE, TIDEBOUND_LIBRARY, tideboundGenesis } from "../src/content/tidebound";
import { closeVoteAndFire, handleProcessedResult } from "../src/runtime/progression";
import { mapYouTubeMessage } from "../server/youtube/mapper.mjs";
import { voteOptionIndex, YouTubeSource } from "../src/youtube/client";

function ytTextMessage(id: string, channelId: string, displayName: string, text: string): unknown {
  return {
    id,
    snippet: {
      type: "textMessageEvent",
      textMessageDetails: { messageText: text },
      publishedAt: new Date(1_700_000_000_000).toISOString(),
      authorChannelId: channelId,
    },
    authorDetails: { channelId, displayName },
  };
}

/** Mirror of the app-shell wiring (app.ts): ballots ride alongside ingestion. */
function wireAppShellBallots(source: YouTubeSource, ref: { session: StreamSession }): void {
  source.onVoteCommand = (actorId, optionIndex) => {
    const casted = castSessionVote(ref.session, actorId, optionIndex);
    if (casted.ok) ref.session = casted.session;
  };
}

function openRouteVote(session: StreamSession): StreamSession {
  const opened = openSessionVote(session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
  if (!opened.ok) throw new Error(`expected open: ${opened.reason}`);
  return opened.session;
}

function countsOf(session: StreamSession): number[] {
  const t = tallyVote(session.activeVote);
  if (!t.ok) throw new Error("expected tally");
  return t.counts;
}

describe("F1 vote token mapping", () => {
  it("voteOptionIndex maps exactly the three whitelisted vote tokens", () => {
    expect(voteOptionIndex("!votea")).toBe(0);
    expect(voteOptionIndex("!voteb")).toBe(1);
    expect(voteOptionIndex("!votec")).toBe(2);
    for (const other of ["!help", "!strike", "", "!VOTEA", "!vote"]) {
      expect(voteOptionIndex(other)).toBeNull();
    }
  });

  it("mapper lowercases vote tokens and pins identity to the channel id", () => {
    const m = mapYouTubeMessage(ytTextMessage("m1", "UC_WATCHER_1", "SomeName", "!voteA go left"));
    expect(m.outcome).toBe("command");
    if (m.outcome !== "command") throw new Error("expected command");
    expect(m.event.command).toBe("!votea");
    expect(m.event.actorId).toBe("yt:UC_WATCHER_1");
    expect(m.event.actorId).not.toContain("SomeName");
    expect(m.event.eventId).toBe("yt:m1");
  });

  it("!voteC maps through the shared ballot path (T4C Option 1)", () => {
    expect("!votec" in COMMANDS).toBe(true);
    expect(voteOptionIndex("!votec")).toBe(2);
    const m = mapYouTubeMessage(ytTextMessage("m9", "UC_C", "Cid", "!voteC take third"));
    expect(m.outcome).toBe("command");
    if (m.outcome !== "command") throw new Error("expected command");
    expect(m.event.command).toBe("!votec");
  });
});

describe("F1 YouTube ballots use the shared operation", () => {
  function wiredEngine() {
    const engine = new GameEngine({ onResult: () => {} }, tideboundGenesis());
    const source = new YouTubeSource(engine);
    const ref = { session: openRouteVote(freshSession()) };
    wireAppShellBallots(source, ref);
    // Full browser path: raw YouTube payload → mapper → whitelist/hook/queue.
    const ingest = (msg: unknown) => {
      const mapped = mapYouTubeMessage(msg) as
        | { outcome: "command"; event: { command: string; actorId: string } & Record<string, unknown> }
        | { outcome: string };
      if (mapped.outcome !== "command" || !("event" in mapped) || !mapped.event) {
        throw new Error(`expected mappable command, got ${mapped.outcome}`);
      }
      (source as unknown as { ingestOne(ev: unknown, id: string): void }).ingestOne(mapped.event, "sse-1");
    };
    return { engine, source, ref, ingest };
  }

  it("YouTube !voteA is accepted when a vote is open", () => {
    const { ref, ingest, source } = wiredEngine();
    ingest(ytTextMessage("m1", "UC_A", "Ann", "!voteA"));
    expect(countsOf(ref.session)).toEqual([1, 0]);
    expect(source.diag).toMatchObject({ received: 1, queued: 1, duplicate: 0 });
  });

  it("YouTube !voteB from another channel counts as a separate voter", () => {
    const { ref, ingest } = wiredEngine();
    ingest(ytTextMessage("m1", "UC_A", "Ann", "!voteA"));
    ingest(ytTextMessage("m2", "UC_B", "Bo", "!voteB"));
    expect(countsOf(ref.session)).toEqual([1, 1]);
  });

  it("repeat messages from one channel collapse to a single latest-wins ballot", () => {
    const { ref, ingest } = wiredEngine();
    ingest(ytTextMessage("m1", "UC_A", "Ann", "!voteA"));
    ingest(ytTextMessage("m2", "UC_A", "Ann", "!voteA"));
    expect(countsOf(ref.session)).toEqual([1, 0]);
    ingest(ytTextMessage("m3", "UC_A", "Ann", "!voteB"));
    expect(countsOf(ref.session)).toEqual([0, 1]);
  });

  it("duplicate delivery of the same message never duplicates a ballot", () => {
    const { ref, source } = wiredEngine();
    const mapped = mapYouTubeMessage(ytTextMessage("m1", "UC_A", "Ann", "!voteA")) as {
      outcome: string;
      event?: Record<string, unknown>;
    };
    if (mapped.outcome !== "command" || !mapped.event) throw new Error("expected command");
    const direct = source as unknown as { ingestOne(ev: unknown, id: string): void };
    direct.ingestOne(mapped.event, "sse-1");
    direct.ingestOne(mapped.event, "sse-1");
    // Second delivery re-casts the identical ballot (harmless) but the
    // engine dedups by eventId, so only one command ever processes.
    expect(source.diag).toMatchObject({ received: 2, queued: 1, duplicate: 1 });
    expect(countsOf(ref.session)).toEqual([1, 0]);
  });

  it("votes are rejected when no assembly vote is open", () => {
    const engine = new GameEngine({ onResult: () => {} }, tideboundGenesis());
    const source = new YouTubeSource(engine);
    const ref: { session: StreamSession } = {
      session: {
        sessionId: "stream-1",
        streamNumber: 1,
        phase: "open",
        activeVote: null,
        meterContributors: {},
      },
    };
    wireAppShellBallots(source, ref);
    const raw = ytTextMessage("m1", "UC_A", "Ann", "!voteA");
    const mapped = mapYouTubeMessage(raw) as { outcome: string; event?: Record<string, unknown> };
    if (mapped.outcome !== "command" || !mapped.event) throw new Error("expected command");
    (source as unknown as { ingestOne(ev: unknown, id: string): void }).ingestOne(mapped.event, "sse-1");
    // The chat command still queues (inert engine result), but no ballot exists.
    expect(ref.session.activeVote).toBeNull();
    expect(source.diag.queued).toBe(1);
  });

  it("votes are rejected once the vote is closed", () => {
    const { ref, ingest, source } = wiredEngine();
    ingest(ytTextMessage("m1", "UC_A", "Ann", "!voteA"));
    const closed = closeVoteAndFire(ref.session, tideboundGenesis(), TIDEBOUND_LIBRARY);
    ref.session = closed.session;
    const before = countsOf(ref.session);
    ingest(ytTextMessage("m2", "UC_B", "Bo", "!voteB"));
    expect(countsOf(ref.session)).toEqual(before);
    expect(source.diag.queued).toBe(2);
  });

  it("YouTube and simulation ballots follow identical rules in one tally", () => {
    const { ref, ingest } = wiredEngine();
    // Simulation path equivalent: same operation, plain actor id.
    const sim = castSessionVote(ref.session, "kaushal", 0);
    if (!sim.ok) throw new Error("expected sim cast");
    ref.session = sim.session;
    ingest(ytTextMessage("m1", "UC_A", "Ann", "!voteB"));
    expect(countsOf(ref.session)).toEqual([1, 1]);
  });

  it("YouTube !voteC ballots to option index 2 and participates in latest-wins", () => {
    const engine = new GameEngine({ onResult: () => {} }, tideboundGenesis());
    const source = new YouTubeSource(engine);
    const ref = { session: freshSession() };
    const opened = openSessionVote(ref.session, { ...KINDLING_VOTE, library: TIDEBOUND_LIBRARY });
    if (!opened.ok) throw new Error(`expected open: ${opened.reason}`);
    ref.session = opened.session;
    wireAppShellBallots(source, ref);
    const ingest = (msg: unknown) => {
      const mapped = mapYouTubeMessage(msg) as { outcome: string; event?: Record<string, unknown> };
      if (mapped.outcome !== "command" || !mapped.event) throw new Error("expected mappable command");
      (source as unknown as { ingestOne(ev: unknown, id: string): void }).ingestOne(mapped.event, "sse-1");
    };
    ingest(ytTextMessage("m1", "UC_A", "Ann", "!voteC"));
    expect(countsOf(ref.session)).toEqual([0, 0, 1]);
    // Latest-wins: same actor moves from C to A.
    ingest(ytTextMessage("m2", "UC_A", "Ann", "!voteA"));
    expect(countsOf(ref.session)).toEqual([1, 0, 0]);
    // Out-of-range on a 2-option vote is rejected (Route has no idx 2).
    const routeRef = { session: openRouteVote(freshSession()) };
    wireAppShellBallots(source, routeRef);
    const bad = castSessionVote(routeRef.session, "UC_X", 2);
    expect(bad.ok).toBe(false);
  });

  it("a YouTube vote command still advances the vote clock exactly once", () => {
    const { engine, ref, ingest } = wiredEngine();
    ingest(ytTextMessage("m1", "UC_A", "Ann", "!voteA"));
    const pumped = engine.pump();
    expect(pumped).toHaveLength(1);
    // Engine stays session-agnostic: the vote token itself is inert …
    expect(pumped[0].action).toBe("rejected");
    const before = ref.session.activeVote?.commandsProcessed ?? -1;
    const handled = handleProcessedResult(engine, ref.session, pumped[0], TIDEBOUND_LIBRARY);
    ref.session = handled.session;
    expect((ref.session.activeVote?.commandsProcessed ?? -1) - before).toBe(1);
  });

  it("!voteC advances the vote clock exactly once and is inert outside a vote", () => {
    const { engine, ref, ingest } = wiredEngine();
    ingest(ytTextMessage("m1", "UC_A", "Ann", "!voteC"));
    const pumped = engine.pump();
    expect(pumped).toHaveLength(1);
    expect(pumped[0].action).toBe("rejected");
    const before = ref.session.activeVote?.commandsProcessed ?? -1;
    const handled = handleProcessedResult(engine, ref.session, pumped[0], TIDEBOUND_LIBRARY);
    ref.session = handled.session;
    expect((ref.session.activeVote?.commandsProcessed ?? -1) - before).toBe(1);
    // Outside a vote: still queues (inert result) but casts no ballot.
    const lonely = new GameEngine({ onResult: () => {} }, tideboundGenesis());
    const lonelySource = new YouTubeSource(lonely);
    const lonelyRef: { session: StreamSession } = {
      session: { sessionId: "stream-1", streamNumber: 1, phase: "open", activeVote: null, meterContributors: {} },
    };
    wireAppShellBallots(lonelySource, lonelyRef);
    const mapped = mapYouTubeMessage(ytTextMessage("m9", "UC_Z", "Zed", "!voteC")) as {
      outcome: string;
      event?: Record<string, unknown>;
    };
    if (mapped.outcome !== "command" || !mapped.event) throw new Error("expected command");
    (lonelySource as unknown as { ingestOne(ev: unknown, id: string): void }).ingestOne(mapped.event, "sse-9");
    expect(lonelyRef.session.activeVote).toBeNull();
    expect(lonelySource.diag.queued).toBe(1);
  });

  it("quorum from mixed YouTube + simulation ballots fires deterministically", () => {
    let t = 1_000_000;
    const engine = new GameEngine({ now: () => (t += 1000), onResult: () => {} }, tideboundGenesis());
    const source = new YouTubeSource(engine);
    const ref = { session: openRouteVote(freshSession()) };
    wireAppShellBallots(source, ref);
    // Same browser path as wiredEngine: raw payload → mapper → hook/queue.
    const ingest = (msg: unknown) => {
      const mapped = mapYouTubeMessage(msg) as { outcome: string; event?: Record<string, unknown> };
      if (mapped.outcome !== "command" || !mapped.event) throw new Error("expected mappable command");
      (source as unknown as { ingestOne(ev: unknown, id: string): void }).ingestOne(mapped.event, "sse-1");
    };
    // Parley (index 1) is eligible at genesis and takes a 2–1 majority.
    ingest(ytTextMessage("m1", "UC_A", "Ann", "!voteB"));
    ingest(ytTextMessage("m2", "UC_B", "Bo", "!voteB"));
    const sim = castSessionVote(ref.session, "sim-viewer", 0);
    if (!sim.ok) throw new Error("expected sim cast");
    ref.session = sim.session;
    // Drive the shared command clock to quorum with ordinary traffic.
    let fired: string | null = null;
    for (let i = 0; i < ROUTE_VOTE.maxCommands && fired === null; i++) {
      engine.ingestCommand(`u${i}`, `U${i}`, "!strike");
      for (const r of engine.pump()) {
        const h = handleProcessedResult(engine, ref.session, r, TIDEBOUND_LIBRARY);
        ref.session = h.session;
        if (h.fired !== null) fired = h.fired;
      }
    }
    expect(fired).toBe("route-parley-with-ilya");
    expect(engine.world.deeds.join("\n")).toContain("parley");
  });

  it("ties resolve to the lowest index, for YouTube ballots too", () => {
    const { ref, ingest } = wiredEngine();
    ingest(ytTextMessage("m1", "UC_A", "Ann", "!voteA"));
    ingest(ytTextMessage("m2", "UC_B", "Bo", "!voteB"));
    const eligible = { ...tideboundGenesis(), storyFlags: { ...tideboundGenesis().storyFlags, "chart-pale-ready": true } };
    const resolved = resolveSessionVote(ref.session, eligible, TIDEBOUND_LIBRARY);
    if (!resolved.ok) throw new Error("expected resolve");
    expect(resolved.winner).toBe("route-dredge-map");
  });
});

// Minimal session anchor for vote tests: ephemera only, never the world.
function freshSession(): StreamSession {
  return {
    sessionId: "stream-1",
    streamNumber: 1,
    phase: "open",
    activeVote: null,
    meterContributors: {},
  };
}
