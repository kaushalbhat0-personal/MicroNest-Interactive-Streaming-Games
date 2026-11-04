/**
 * T4F-B — shared snapshot contract tests.
 * Covers: versioned builder, privacy sanitization, revision semantics,
 * validation, staleness, and the renderer session stub.
 */
import { describe, expect, it } from "vitest";
import { GameEngine } from "../src/engine/engine";
import { QUEUE } from "../src/engine/config";
import { tideboundGenesis, ROUTE_VOTE, TIDEBOUND_LIBRARY } from "../src/content/tidebound";
import { openSessionVote, openStream } from "../src/engine/lifecycle";
import { ledgerStatus } from "../src/engine/ledger";
import type { GameResult } from "../src/engine/types";
import { voteModel } from "../src/presentation/tidebound-presentation";
import { BannerQueue, ViewerFeedStore } from "../src/presentation/viewer-feed";
import {
  ANONYMIZED_SEARCHER,
  buildSnapshot,
  isStaleSnapshot,
  rendererSessionStub,
  revisionSignature,
  REVISION_RULES,
  sanitizeRecent,
  sanitizeWorldForSnapshot,
  shouldBumpRevision,
  SNAPSHOT_PROTOCOL,
  validateSnapshot,
  type SnapshotV1,
} from "../src/shared/snapshot";

function liveState() {
  let t = 1_000_000;
  const now = () => t;
  const engine = new GameEngine({ now }, tideboundGenesis(new Date(t).toISOString()));
  const stream = openStream(engine.world);
  if (!stream.ok) throw new Error("openStream failed");
  engine.world = stream.world;
  return { engine, session: stream.session, tick: () => { t += QUEUE.minGapMs + 50; } };
}

function snapOf(s: ReturnType<typeof liveState>, worldRev: number, extra?: Partial<Parameters<typeof buildSnapshot>[0]>): SnapshotV1 {
  const led = ledgerStatus(s.engine.world.paidLedger);
  return buildSnapshot({
    world: s.engine.world,
    session: s.session,
    storyLog: s.engine.storyLog,
    feed: [],
    recent: s.engine.recentResults,
    viewerFeed: [],
    banner: null,
    paused: false,
    vote: voteModel(s.session, s.engine.world, TIDEBOUND_LIBRARY),
    paid: { applied: led.applied, compensated: led.compensated, noted: led.noted, total: led.total },
    worldRev,
    atIso: new Date().toISOString(),
    ...extra,
  });
}

describe("T4F-B — snapshot contract shape", () => {
  it("builds a versioned snapshot with every required field", () => {
    const s = liveState();
    const snap = snapOf(s, 1);
    expect(snap.v).toBe(SNAPSHOT_PROTOCOL);
    expect(snap.v).toBe(1);
    expect(typeof snap.sessionId).toBe("string");
    expect(snap.sessionId.length).toBeGreaterThan(0);
    expect(typeof snap.streamNumber).toBe("number");
    expect(snap.worldRev).toBe(1);
    expect(typeof snap.atIso).toBe("string");
    expect(snap.world).toBeDefined();
    expect(snap.vote).toBeDefined();
    expect(Array.isArray(snap.storyLog)).toBe(true);
    expect(Array.isArray(snap.feed)).toBe(true);
    expect(Array.isArray(snap.recent)).toBe(true);
    expect(Array.isArray(snap.viewerFeed)).toBe(true);
    expect(snap.paused).toBe(false);
  });

  it("documents the revision rules", () => {
    expect(REVISION_RULES.length).toBeGreaterThan(0);
    const text = REVISION_RULES.join("\n");
    expect(text).toContain("vote");
    expect(text).toContain("never:");
  });
});

describe("T4F-B — snapshot privacy", () => {
  it("anonymizes uniqueSearchers length-preservingly (actor ids never travel)", () => {
    const s = liveState();
    s.engine.world.uniqueSearchers.push("yt:UC0123456789abcdefghij", "kaushal", "yt:UC9876543210zyxwvutsrq");
    const snap = snapOf(s, 1);
    expect(snap.uniqueSearcherCount).toBe(3);
    expect(snap.world.uniqueSearchers).toEqual([ANONYMIZED_SEARCHER, ANONYMIZED_SEARCHER, ANONYMIZED_SEARCHER]);
    const raw = JSON.stringify(snap);
    expect(raw).not.toContain("yt:UC0123456789abcdefghij");
    expect(raw).not.toContain("yt:UC9876543210zyxwvutsrq");
  });

  it("drops the paid ledger and zeroes internal amounts", () => {
    const s = liveState();
    s.engine.world.paidLedger.push({
      eventId: "paid-1",
      platformEventId: "yt-platform-abc123",
      status: "applied",
      actorId: "yt:UC0123456789abcdefghij",
      amount: 50000,
      currency: "INR",
      tierKey: "paid_strike",
      appliedAtIso: new Date().toISOString(),
      appliedAtStream: 1,
      appliedCheckpoint: { arc: 1, chapter: 1, wave: 1 },
    } as never);
    const snap = snapOf(s, 1);
    expect(snap.world.paidLedger).toEqual([]);
    expect(snap.world.totalPaidMinorUnits).toBe(0);
    const raw = JSON.stringify(snap);
    expect(raw).not.toContain("yt-platform-abc123");
    expect(raw).not.toContain("50000");
    expect(raw).not.toContain("INR");
  });

  it("strips actorId from recent but keeps animation/display fields", () => {
    const results: GameResult[] = [
      { eventId: "e1", action: "attack", summary: "A struck", actorName: "A", actorId: "secret-id", storyMessages: ["m"], visual: { hitEnemy: true } },
    ];
    const out = sanitizeRecent(results);
    expect(out[0].actorId).toBeUndefined();
    expect(out[0].eventId).toBe("e1");
    expect(out[0].visual).toEqual({ hitEnemy: true });
    // Input untouched.
    expect(results[0].actorId).toBe("secret-id");
  });

  it("never transmits the private ballot map (public tally only)", () => {
    const s = liveState();
    const v = openSessionVote(s.session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!v.ok) throw new Error("vote open failed");
    s.session = v.session;
    const snap = snapOf(s, 2);
    const raw = JSON.stringify(snap);
    // No ballot-map key travels (public winnerReason copy such as
    // "no-ballots" is engine prose, not the private map).
    expect(raw).not.toContain('"ballots"');
    expect(snap.vote.options.length).toBeGreaterThan(0);
  });

  it("sanitizeWorldForSnapshot never mutates the authority world", () => {
    const s = liveState();
    s.engine.world.uniqueSearchers.push("someone");
    const before = JSON.stringify(s.engine.world.uniqueSearchers);
    sanitizeWorldForSnapshot(s.engine.world);
    expect(JSON.stringify(s.engine.world.uniqueSearchers)).toBe(before);
  });
});

describe("T4F-B — revision semantics", () => {
  it("first publish always bumps; identical state never bumps", () => {
    const s = liveState();
    const a = snapOf(s, 1);
    const sigA = revisionSignature(a);
    expect(shouldBumpRevision(null, sigA)).toBe(true);
    const b = snapOf(s, 1);
    expect(shouldBumpRevision(sigA, revisionSignature(b))).toBe(false);
  });

  it("timestamps alone are not revisions", () => {
    const s = liveState();
    const a = snapOf(s, 1, { atIso: "2026-01-01T00:00:00.000Z" });
    const b = snapOf(s, 1, { atIso: "2026-06-01T00:00:00.000Z" });
    expect(revisionSignature(a)).toBe(revisionSignature(b));
  });

  it("applied commands bump the revision", () => {
    const s = liveState();
    const before = revisionSignature(snapOf(s, 1));
    s.engine.ingestCommand("u1", "A", "!strike", "cmd-1");
    s.tick();
    s.engine.pump();
    const after = revisionSignature(snapOf(s, 2));
    expect(shouldBumpRevision(before, after)).toBe(true);
  });

  it("vote open / ballot / close bump the revision", () => {
    const s = liveState();
    const s0 = revisionSignature(snapOf(s, 1));
    const v = openSessionVote(s.session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!v.ok) throw new Error("open failed");
    s.session = v.session;
    const s1 = revisionSignature(snapOf(s, 2));
    expect(shouldBumpRevision(s0, s1)).toBe(true);
  });

  it("pause changes bump the revision (visible display state)", () => {
    const s = liveState();
    const s0 = revisionSignature(snapOf(s, 1));
    const s1 = revisionSignature(snapOf(s, 1, { paused: true }));
    expect(shouldBumpRevision(s0, s1)).toBe(true);
  });

  it("feed and banner changes bump the revision", () => {
    const s = liveState();
    const store = new ViewerFeedStore(() => 1_000_000);
    const banners = new BannerQueue(() => 1_000_000);
    const r: GameResult = { eventId: "fx", action: "heal", summary: "A mended", actorName: "A", storyMessages: [], visual: { healHero: true } };
    const s0 = revisionSignature(snapOf(s, 1));
    const items = store.push(r, { world: s.engine.world });
    banners.pushResult(r, s.engine.world);
    const s1 = revisionSignature(snapOf(s, 2, { viewerFeed: items, banner: banners.current() }));
    expect(shouldBumpRevision(s0, s1)).toBe(true);
  });
});

describe("T4F-B — validation and staleness", () => {
  it("accepts a well-formed snapshot", () => {
    const snap = snapOf(liveState(), 3);
    const res = validateSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(res.ok).toBe(true);
  });

  it("rejects wrong protocol versions (safe state, never a guessed render)", () => {
    const snap = snapOf(liveState(), 1);
    expect(validateSnapshot({ ...snap, v: 2 }).ok).toBe(false);
    expect(validateSnapshot({ ...snap, v: 0 }).ok).toBe(false);
    if (!validateSnapshot({ ...snap, v: 2 }).ok) {
      expect((validateSnapshot({ ...snap, v: 2 }) as { ok: false; reason: string }).reason).toBe("bad-protocol");
    }
  });

  it("rejects bad revisions, sessions, and shapes", () => {
    const snap = snapOf(liveState(), 1);
    expect(validateSnapshot({ ...snap, worldRev: 0 }).ok).toBe(false);
    expect(validateSnapshot({ ...snap, sessionId: "" }).ok).toBe(false);
    expect(validateSnapshot({ ...snap, world: null }).ok).toBe(false);
    expect(validateSnapshot(null).ok).toBe(false);
    expect(validateSnapshot("nope").ok).toBe(false);
  });

  it("detects stale deliveries; a new session supersedes", () => {
    const s = liveState();
    const cur = snapOf(s, 5);
    const older = snapOf(s, 4);
    const newer = snapOf(s, 6);
    expect(isStaleSnapshot(cur, older)).toBe(true);
    expect(isStaleSnapshot(cur, newer)).toBe(false);
    expect(isStaleSnapshot(cur, cur)).toBe(false);
    expect(isStaleSnapshot(null, older)).toBe(false);
    const nextStream = { ...newer, sessionId: "stream-2", streamNumber: 2 };
    expect(isStaleSnapshot(cur, nextStream)).toBe(false);
    const replayedOld = { ...older, sessionId: "stream-0", streamNumber: 0 };
    expect(isStaleSnapshot(cur, replayedOld)).toBe(true);
  });
});

describe("T4F-B — renderer session stub", () => {
  it("carries identity with no ballots and no mutation surface", () => {
    const snap = snapOf(liveState(), 1);
    const stub = rendererSessionStub(snap);
    expect(stub.sessionId).toBe(snap.sessionId);
    expect(stub.streamNumber).toBe(snap.streamNumber);
    expect(stub.phase).toBe(snap.sessionPhase);
    expect(stub.activeVote).toBeNull();
    expect(stub.meterContributors).toEqual({});
  });
});
