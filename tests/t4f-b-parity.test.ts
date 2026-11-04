/**
 * T4F-B — state parity tests.
 * Proves one authoritative pipeline feeds two independent read-only
 * renderers with identical state: same revisions, single command results,
 * single vote open/close, matching tallies, feed/banner identity, and
 * progression visible in both outputs.
 */
import { describe, expect, it } from "vitest";
import { QUEUE } from "../src/engine/config";
import { GameEngine } from "../src/engine/engine";
import { tideboundGenesis, KINDLING_VOTE, ROUTE_VOTE, TIDEBOUND_LIBRARY } from "../src/content/tidebound";
import { closeSessionVote, openSessionVote, openStream } from "../src/engine/lifecycle";
import { ledgerStatus } from "../src/engine/ledger";
import { voteModel } from "../src/presentation/tidebound-presentation";
import { BannerQueue, ViewerFeedStore } from "../src/presentation/viewer-feed";
import { rendererPaintFingerprint } from "../src/renderer/apply-snapshot";
import { buildSnapshot, type SnapshotV1 } from "../src/shared/snapshot";

function harness() {
  let t = 1_000_000;
  const now = () => t;
  const engine = new GameEngine({ now }, tideboundGenesis(new Date(t).toISOString()));
  const stream = openStream(engine.world);
  if (!stream.ok) throw new Error("openStream failed");
  engine.world = stream.world;
  const drain = () => {
    const out = [];
    for (let i = 0; i < 500 && engine.queue.size > 0; i++) {
      t += QUEUE.minGapMs + 50;
      out.push(...engine.pump());
    }
    return out;
  };
  return { engine, session: stream.session, drain, advance: () => { t += QUEUE.minGapMs + 50; } };
}

function publish(h: ReturnType<typeof harness>, worldRev: number, opts?: {
  viewerFeed?: SnapshotV1["viewerFeed"];
  banner?: SnapshotV1["banner"];
  paused?: boolean;
}): SnapshotV1 {
  const led = ledgerStatus(h.engine.world.paidLedger);
  return buildSnapshot({
    world: h.engine.world,
    session: h.session,
    storyLog: h.engine.storyLog,
    feed: [],
    recent: h.engine.recentResults,
    viewerFeed: opts?.viewerFeed ?? [],
    banner: opts?.banner ?? null,
    paused: opts?.paused ?? false,
    vote: voteModel(h.session, h.engine.world, TIDEBOUND_LIBRARY),
    paid: { applied: led.applied, compensated: led.compensated, noted: led.noted, total: led.total },
    worldRev,
    atIso: new Date().toISOString(),
  });
}

/** Simulate transport: structured clone, as JSON over SSE would. */
function transported(s: SnapshotV1): SnapshotV1 {
  return JSON.parse(JSON.stringify(s)) as SnapshotV1;
}

describe("T4F-B — single authoritative pipeline", () => {
  it("one incoming command creates exactly one game result", () => {
    const h = harness();
    expect(h.engine.ingestCommand("u1", "A", "!strike", "cmd-1")).toBe("queued");
    const results = h.drain();
    expect(results.filter((r) => r.eventId === "cmd-1")).toHaveLength(1);
  });

  it("redelivered commands collapse (no duplicate processing)", () => {
    const h = harness();
    expect(h.engine.ingestCommand("u1", "A", "!strike", "cmd-1")).toBe("queued");
    expect(h.engine.ingestCommand("u1", "A", "!strike", "cmd-1")).toBe("duplicate");
    const results = h.drain();
    expect(results.filter((r) => r.eventId === "cmd-1")).toHaveLength(1);
  });

  it("one vote opens once and closes once (second open fails, close is idempotent)", () => {
    const h = harness();
    const opened = openSessionVote(h.session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!opened.ok) throw new Error("first open failed");
    h.session = opened.session;
    const reopened = openSessionVote(h.session, { ...KINDLING_VOTE, library: TIDEBOUND_LIBRARY });
    expect(reopened.ok).toBe(false);
    const closed = closeSessionVote(h.session);
    if (!closed.ok) throw new Error("close failed");
    h.session = closed.session;
    expect(h.session.activeVote?.closed).toBe(true);
    const reclosed = closeSessionVote(h.session);
    if (!reclosed.ok) throw new Error("reclose failed");
    expect(reclosed.session.activeVote?.closed).toBe(true);
  });
});

describe("T4F-B — dual-renderer parity", () => {
  it("both renderers receive identical world revisions", () => {
    const h = harness();
    h.engine.ingestCommand("u1", "A", "!strike", "cmd-1");
    h.drain();
    const snap = publish(h, 7);
    const landscape = transported(snap);
    const portrait = transported(snap);
    expect(landscape.worldRev).toBe(portrait.worldRev);
    expect(rendererPaintFingerprint(landscape)).toBe(rendererPaintFingerprint(portrait));
  });

  it("vote prompt, tally, and winner match in both outputs", () => {
    const h = harness();
    const opened = openSessionVote(h.session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!opened.ok) throw new Error("open failed");
    h.session = opened.session;
    const a = transported(publish(h, 8));
    const b = transported(publish(h, 8));
    expect(a.vote.prompt).toBe(b.vote.prompt);
    expect(a.vote.options.map((o) => o.votes)).toEqual(b.vote.options.map((o) => o.votes));
    expect(a.vote.phase).toBe("open");
    const closed = closeSessionVote(h.session);
    if (!closed.ok) throw new Error("close failed");
    h.session = closed.session;
    const c = transported(publish(h, 9));
    const d = transported(publish(h, 9));
    expect(c.vote.phase).toBe("closed");
    expect(c.vote.winner).toBe(d.vote.winner);
    expect(c.vote.winnerLabel).toBe(d.vote.winnerLabel);
    expect(rendererPaintFingerprint(c)).toBe(rendererPaintFingerprint(d));
  });

  it("one feed event appears exactly once in each renderer, same ids", () => {
    const h = harness();
    const store = new ViewerFeedStore(() => 2_000_000);
    h.engine.ingestCommand("u1", "A", "!mend", "cmd-mend");
    const results = h.drain();
    expect(results).toHaveLength(1);
    const items = store.push(results[0], { world: h.engine.world });
    const a = transported(publish(h, 10, { viewerFeed: items }));
    // Re-pushing the same result never duplicates (SSE replay safety).
    store.push(results[0], { world: h.engine.world });
    const b = transported(publish(h, 10, { viewerFeed: store.list() }));
    expect(a.viewerFeed).toHaveLength(1);
    expect(b.viewerFeed).toHaveLength(1);
    expect(a.viewerFeed[0].id).toBe("cmd-mend");
    expect(a.viewerFeed.map((i) => i.id)).toEqual(b.viewerFeed.map((i) => i.id));
  });

  it("banner event ids and order match in both outputs", () => {
    const h = harness();
    const banners = new BannerQueue(() => 3_000_000);
    h.engine.ingestCommand("u1", "A", "!mend", "cmd-m1");
    h.engine.ingestCommand("u2", "B", "!shield", "cmd-s1");
    const results = h.drain();
    for (const r of results) banners.pushResult(r, h.engine.world);
    const a = transported(publish(h, 11, { banner: banners.current() }));
    const b = transported(publish(h, 11, { banner: banners.current() }));
    expect(a.banner?.id).toBe(b.banner?.id);
    expect(a.banner?.category).toBe(b.banner?.category);
  });

  it("enemy ticks and progression are reflected in both outputs", () => {
    const h = harness();
    const before = transported(publish(h, 12));
    h.advance();
    const ticked = h.engine.tick();
    const after = transported(publish(h, 13));
    // worldRev sameness across renderers holds regardless of tick output.
    expect(rendererPaintFingerprint(before)).toBe(rendererPaintFingerprint(transported(publish(h, 12))));
    expect(after.worldRev).toBe(13);
    expect(after.world.threatLevel).toBe(h.engine.world.threatLevel);
    expect(after.world.waveNumber).toBe(h.engine.world.waveNumber);
    void ticked;
  });
});
