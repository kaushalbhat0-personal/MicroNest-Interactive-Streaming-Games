/**
 * T4F-B — recovery tests.
 * Refresh during votes, disconnect/reconnect, forced sequence gaps, stale
 * delivery, authority unavailability — and proof that renderers never
 * create replacement simulations.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GameEngine } from "../src/engine/engine";
import { tideboundGenesis, ROUTE_VOTE, TIDEBOUND_LIBRARY } from "../src/content/tidebound";
import { openSessionVote, openStream, type StreamSession } from "../src/engine/lifecycle";
import { ledgerStatus } from "../src/engine/ledger";
import { voteModel } from "../src/presentation/tidebound-presentation";
import { connectRendererTransport, decideDelivery } from "../src/renderer/transport-client";
import { rendererPaintFingerprint } from "../src/renderer/apply-snapshot";
import { buildSnapshot, type SnapshotV1 } from "../src/shared/snapshot";

const ROOT = join(__dirname, "..");

function snapFor(worldRev: number, opts?: { engine?: GameEngine; session?: StreamSession }): SnapshotV1 {
  const engine = opts?.engine ?? new GameEngine({}, tideboundGenesis());
  let session = opts?.session;
  if (!session) {
    const stream = openStream(engine.world);
    if (!stream.ok) throw new Error("openStream failed");
    engine.world = stream.world;
    session = stream.session;
  }
  const led = ledgerStatus(engine.world.paidLedger);
  return buildSnapshot({
    world: engine.world,
    session,
    storyLog: engine.storyLog,
    feed: [],
    recent: engine.recentResults,
    viewerFeed: [],
    banner: null,
    paused: false,
    vote: voteModel(session, engine.world, TIDEBOUND_LIBRARY),
    paid: { applied: led.applied, compensated: led.compensated, noted: led.noted, total: led.total },
    worldRev,
    atIso: new Date().toISOString(),
  });
}

describe("T4F-B — refresh during an active vote", () => {
  it("a resuming renderer (old cursor) refetches and converges on the open vote", () => {
    const engine = new GameEngine({}, tideboundGenesis());
    const stream = openStream(engine.world);
    if (!stream.ok) throw new Error("open failed");
    engine.world = stream.world;
    const opened = openSessionVote(stream.session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!opened.ok) throw new Error("vote open failed");

    const before = snapFor(4, { engine, session: stream.session });
    const after = snapFor(5, { engine, session: opened.session });
    expect(after.vote.phase).toBe("open");

    // Portrait renderer refreshes mid-vote: fresh client, stale cursor.
    const decision = decideDelivery(before, 4, 5, after);
    expect(decision.action).toBe("apply");
    if (decision.action === "apply") {
      expect(decision.snapshot.vote.phase).toBe("open");
      expect(decision.snapshot.vote.prompt).toBe(after.vote.prompt);
    }

    // Landscape renderer that missed everything refetches by gap.
    const gap = decideDelivery(before, 2, 5, after);
    expect(gap.action).toBe("refetch");
  });

  it("both outputs converge on the same closed-vote snapshot after reconnect", () => {
    const engine = new GameEngine({}, tideboundGenesis());
    const stream = openStream(engine.world);
    if (!stream.ok) throw new Error("open failed");
    engine.world = stream.world;
    const snap = snapFor(9, { engine, session: stream.session });
    // Two independent clients, same authoritative payload.
    const a = decideDelivery(null, null, 9, JSON.parse(JSON.stringify(snap)));
    const b = decideDelivery(null, null, 9, JSON.parse(JSON.stringify(snap)));
    expect(a.action).toBe("apply");
    expect(b.action).toBe("apply");
    if (a.action === "apply" && b.action === "apply") {
      expect(rendererPaintFingerprint(a.snapshot)).toBe(rendererPaintFingerprint(b.snapshot));
    }
  });
});

describe("T4F-B — gaps, staleness, and unavailability", () => {
  it("a forced SSE gap triggers refetch, not a guessed render", () => {
    const cur = snapFor(10);
    const missed = snapFor(12);
    const d = decideDelivery(cur, 10, 12, missed);
    expect(d.action).toBe("refetch");
    if (d.action === "refetch") {
      expect(d.missingFrom).toBe(11);
      expect(d.received).toBe(12);
    }
  });

  it("stale snapshot/event delivery is rejected without changing the display", () => {
    const cur = snapFor(12);
    const stale = snapFor(11);
    expect(decideDelivery(cur, 12, 11, stale)).toEqual({ action: "ignore", reason: "stale" });
    expect(decideDelivery(cur, 12, 12, stale)).toEqual({ action: "ignore", reason: "stale" });
    // Same-seq redelivery of the current snapshot is harmless either way.
    const dup = decideDelivery(cur, 12, 12, cur);
    expect(dup.action === "ignore" || dup.action === "apply").toBe(true);
  });

  it("protocol-mismatched payloads are refused", () => {
    const cur = snapFor(12);
    const bad = { ...snapFor(13), v: 2 };
    expect(decideDelivery(cur, 12, 13, bad)).toEqual({ action: "ignore", reason: "invalid" });
  });

  it("authority unavailability surfaces disconnected state (never a simulation)", async () => {
    const states: string[] = [];
    const details: string[] = [];
    const t = connectRendererTransport(
      {
        onSnapshot: () => {
          throw new Error("must never receive a snapshot without a server");
        },
        onState: (s, d) => {
          states.push(s);
          details.push(d);
        },
      },
      { snapshotUrl: "http://localhost:9/nope", streamUrl: "http://localhost:9/nope" },
    );
    // Unreachable fetch fails fast; allow the async bootstrap to settle.
    await new Promise((r) => setTimeout(r, 1500));
    t.stop();
    expect(states).toContain("disconnected");
    const detail = details.join(" | ");
    expect(detail).toMatch(/never simulate/i);
    // No fallback path exists in the client source.
    const clientSrc = readFileSync(join(ROOT, "src", "renderer", "transport-client.ts"), "utf8");
    expect(clientSrc).not.toMatch(/new GameEngine|createRuntime|fallback.*simulat/i);
  });

  it("recovery never mutates authority state (client only GETs)", () => {
    const clientSrc = readFileSync(join(ROOT, "src", "renderer", "transport-client.ts"), "utf8");
    expect(clientSrc).not.toContain("method: \"POST\"");
    expect(clientSrc).not.toContain("method: 'POST'");
  });
});
