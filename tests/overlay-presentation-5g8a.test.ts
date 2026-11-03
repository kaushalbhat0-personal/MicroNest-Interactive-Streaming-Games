/**
 * Phase 5G-8A — viewer overlay presentation contracts (DOM strings only).
 * No gameplay, vote, meter, template, or persistence rules are touched here:
 * every test renders the read-only overlay projection and asserts the words
 * and structure the audience sees.
 */
import { describe, expect, it } from "vitest";
import { GameEngine } from "../src/engine/engine";
import { FeedAggregator } from "../src/engine/feed";
import { tideboundGenesis, KINDLING_VOTE, ROUTE_VOTE, TIDEBOUND_LIBRARY } from "../src/content/tidebound";
import { openSessionVote, castSessionVote, closeSessionVote, openStream } from "../src/engine/lifecycle";
import { openStreamAndFire, closeVoteAndFire } from "../src/runtime/progression";
import { renderOverlay } from "../src/presentation/hud";

function harness() {
  const engine = new GameEngine({ onResult: () => {} }, tideboundGenesis());
  const feed = new FeedAggregator();
  const opened = openStreamAndFire(engine.world, TIDEBOUND_LIBRARY);
  if (!opened.ok) throw new Error("expected open");
  engine.world = opened.world;
  return { engine, feed, session: opened.session };
}

function render(input: Parameters<typeof renderOverlay>[1]): string {
  const el = { innerHTML: "" } as unknown as HTMLElement;
  renderOverlay(el, input);
  return el.innerHTML;
}

describe("5G-8A viewer hierarchy", () => {
  it("story now leads; world state recedes; commands are grouped by meaning", () => {
    const { engine, feed, session } = harness();
    const html = render({
      world: engine.world,
      session,
      storyLog: engine.storyLog,
      feed: feed.list(),
      recent: engine.recentResults,
      paused: false,
    });
    // Level 1 — story now is a live status section, ahead of the vote/world.
    expect(html).toContain("Story now");
    expect(html.indexOf("Story now")).toBeLessThan(html.indexOf("World state"));
    // Level 2 — grouped command guide, canonical tokens only.
    expect(html).toContain("Act");
    expect(html).toContain("Explore");
    expect(html).toContain("Decide");
    for (const c of ["!strike", "!mend", "!scout", "!shield", "!ring", "!hide", "!tribute", "!defy", "!voteA", "!voteB"]) {
      expect(html).toContain(c);
    }
    expect(html).not.toContain("!voteC");
    // No internal ids leak to viewers.
    expect(html).not.toContain("vote-which-road");
    expect(html).not.toContain("vote-kindling");
  });

  it("an open vote asks what we are deciding, names the leader, and shows the clock", () => {
    const { engine, feed, session } = harness();
    const o = openSessionVote(session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!o.ok) throw new Error("expected open");
    const c1 = castSessionVote(o.session, "a", 0);
    if (!c1.ok) throw new Error("expected cast");
    const c2 = castSessionVote(c1.session, "b", 0);
    if (!c2.ok) throw new Error("expected cast");
    const html = render({
      world: engine.world,
      session: c2.session,
      storyLog: ["The assembly gathers."],
      feed: feed.list(),
      recent: engine.recentResults,
      paused: false,
    });
    expect(html).toContain("What are we deciding?");
    expect(html).toContain("Which road through the Pale?");
    expect(html).toContain("Leading");
    expect(html).toContain("Assembly command clock");
  });

  it("a closed vote names the audience choice; a fired vote lives on as deed", () => {
    const { engine, feed, session } = harness();
    const o = openSessionVote(session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
    if (!o.ok) throw new Error("expected open");
    const c = castSessionVote(o.session, "a", 1);
    if (!c.ok) throw new Error("expected cast");
    const closed = closeSessionVote(c.session);
    if (!closed.ok) throw new Error("expected close");
    const html = render({
      world: engine.world,
      session: closed.session,
      storyLog: engine.storyLog,
      feed: feed.list(),
      recent: engine.recentResults,
      paused: false,
    });
    expect(html).toContain("The assembly chose");
    expect(html).toContain("Parley with Ilya of Highspire");

    // Fired path: the deed is the announcement (no template-id notification).
    const k = openSessionVote(session, { ...KINDLING_VOTE, library: TIDEBOUND_LIBRARY });
    if (!k.ok) throw new Error("expected open");
    let s = k.session;
    for (let i = 0; i < 30; i++) {
      const casted = castSessionVote(s, `v${i}`, 0);
      if (casted.ok) s = casted.session;
    }
    const fired = closeVoteAndFire(s, engine.world, TIDEBOUND_LIBRARY);
    const html2 = render({
      world: fired.world,
      session: fired.session,
      storyLog: fired.newDeeds.length > 0 ? fired.newDeeds : engine.storyLog,
      feed: feed.list(),
      recent: engine.recentResults,
      paused: false,
    });
    expect(fired.newDeeds.join(" ")).toContain("Tam");
    expect(html2).toContain("The world remembers");
    expect(html2).not.toContain("burn-tams-warning");
  });

  it("meters read as collective progress with a status word", () => {
    const { engine, feed, session } = harness();
    const w = {
      ...engine.world,
      storyFlags: { ...engine.world.storyFlags, "chart-pale-ready": true },
      eventCounters: { ...engine.world.eventCounters, "meter.pale-chart": 7 },
    };
    const html = render({
      world: w,
      session,
      storyLog: ["Wren marks the seventh sounding."],
      feed: feed.list(),
      recent: engine.recentResults,
      paused: false,
    });
    expect(html).toContain("7 / 10");
    expect(html).toContain("Building");
  });

  it("paid catalysts are game-native: title and tagline, never payer or amount", () => {
    const engine = new GameEngine({ onResult: () => {} }, tideboundGenesis());
    engine.ingestPaid("donor", "Donor", 75000, "INR", "P-1");
    engine.pump();
    const opened = openStream(engine.world);
    if (!opened.ok) throw new Error("expected open");
    const html = render({
      world: engine.world,
      session: opened.session,
      storyLog: engine.storyLog,
      feed: [],
      recent: engine.recentResults,
      paused: false,
    });
    expect(html).toContain("Herald's Attention");
    expect(html).toContain("Someone drew the Herald's gaze");
    expect(html).not.toContain("75000");
    expect(html).not.toContain("Donor");
  });
});
