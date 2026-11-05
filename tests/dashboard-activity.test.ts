/**
 * UX-005 — Activity workspace: data semantics, filters, summaries, markup.
 * Static + pure logic: no Phaser, no DOM, no network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_FILTERS,
  CATEGORY_LABELS,
  FILTER_EMPTY,
  FILTER_LABELS,
  RETENTION,
  TIMELINE_DEED_CAP,
  TIMELINE_LEDGER_CAP,
  buildTimeline,
  classifyResult,
  filterTimeline,
  formatTime,
  ledgerSummary,
  pickLedgerFields,
  queueSummary,
  stripStoryPrefix,
  voteMentioned,
  type ActivityFilter,
  type TimelineInput,
} from "../src/dashboard/activity";

const ROOT = join(__dirname, "..");
const INDEX_HTML = readFileSync(join(ROOT, "index.html"), "utf8");
const APP_TS = readFileSync(join(ROOT, "src", "app.ts"), "utf8");
const MAIN_TS = readFileSync(join(ROOT, "src", "main.ts"), "utf8");
const ACTIVITY_TS = readFileSync(join(ROOT, "src", "dashboard", "activity.ts"), "utf8");
const PACKAGE_JSON = readFileSync(join(ROOT, "package.json"), "utf8");

function countId(html: string, id: string): number {
  return html.split(`id="${id}"`).length - 1;
}

function baseInput(over: Partial<TimelineInput> = {}): TimelineInput {
  return {
    results: [],
    storyLog: [],
    deeds: [],
    ledger: [],
    voteLive: null,
    expandDeeds: false,
    expandLedger: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Data semantics: queued vs processed, recorded vs applied, unknowns.
// ---------------------------------------------------------------------------

describe("UX-005 result classification", () => {
  it("command actions classify as processed commands, never warnings", () => {
    for (const action of ["attack", "heal", "search", "shield", "ring", "hide", "tribute", "defy", "help"]) {
      const c = classifyResult({ eventId: "e", action, actorName: "K", summary: "did a thing" });
      expect(c.category).toBe("command");
      expect(c.warning).toBe(false);
      expect(c.outcome).toBe("processed");
    }
  });

  it("paid catalyst actions classify as paid/applied", () => {
    for (const action of ["paid_strike", "paid_supply", "paid_elite", "paid_story"]) {
      const c = classifyResult({ eventId: "e", action, actorName: "Donor", summary: "GALE CALL" });
      expect(c.category).toBe("paid");
      expect(c.outcome).toBe("applied");
    }
  });

  it("vote ballots are vote notes, not warnings or failures", () => {
    const c = classifyResult({
      eventId: "e",
      action: "rejected",
      actorName: "Voter",
      summary: "Voter: the assembly has not been called.",
    });
    expect(c.category).toBe("vote-mention");
    expect(c.voteRelated).toBe(true);
    expect(c.warning).toBe(false);
  });

  it("rejected/cooldown/duplicate viewer outcomes are warnings AND commands", () => {
    const r = classifyResult({ eventId: "e", action: "rejected", actorName: "K", summary: "Unknown command !x." });
    expect(r.category).toBe("command");
    expect(r.warning).toBe(true);
    expect(classifyResult({ eventId: "e", action: "cooldown", actorName: "K", summary: "on cooldown" }).warning).toBe(
      true,
    );
    expect(classifyResult({ eventId: "e", action: "duplicate", actorName: "K", summary: "dup" }).warning).toBe(true);
  });

  it("world-actor notes are ledger notes, never command failures", () => {
    const c = classifyResult({
      eventId: "e",
      action: "rejected",
      actorName: "world",
      summary: "Retraction of X noted — no matching paid event yet.",
    });
    expect(c.category).toBe("ledger-note");
    expect(c.warning).toBe(false);
  });

  it("unknown actions are preserved as Other, never dropped", () => {
    const c = classifyResult({ eventId: "e", action: "future-action", actorName: "K", summary: "?" });
    expect(c.category).toBe("other");
    expect(CATEGORY_LABELS.other).toBe("Other activity");
  });
});

describe("UX-005 story prefix + vote mentions", () => {
  it("parses engine arc/chapter tags; null when absent", () => {
    expect(stripStoryPrefix("[Arc 2·Ch 3] The bell tolls")).toEqual({ arc: 2, chapter: 3, text: "The bell tolls" });
    expect(stripStoryPrefix("no tag here")).toBe(null);
    expect(stripStoryPrefix("")).toBe(null);
  });

  it("voteMentioned matches system prose case-insensitively", () => {
    expect(voteMentioned("The assembly chose Parley")).toBe(true);
    expect(voteMentioned("Burn the KINDLING")).toBe(true);
    expect(voteMentioned("The flame leaned toward scouts")).toBe(true);
    expect(voteMentioned("A quiet night on the Pale")).toBe(false);
  });
});

describe("UX-005 timeline assembly", () => {
  const results = [
    { eventId: "r1", action: "attack", actorName: "K", summary: "K struck" },
    { eventId: "r2", action: "paid_supply", actorName: "D", summary: "convoy" },
    { eventId: "r3", action: "cooldown", actorName: "K", summary: "cooldown" },
  ];

  it("orders vote-live → processed → story → deeds → ledger without global time claims", () => {
    const built = buildTimeline(
      baseInput({
        results,
        storyLog: ["[Arc 1·Ch 1] A scout returned"],
        deeds: ["An old deed"],
        ledger: [{ eventId: "l1", status: "applied", tierKey: "paid_strike", appliedAtIso: "2026-01-01T00:00:00.000Z", appliedAtStream: 2 }],
        voteLive: { phase: "open", prompt: "Which road?", totalBallots: 3, commandsProcessed: 4, maxCommands: 10, closingSoon: false, winnerLabel: null },
      }),
    );
    const streams = built.items.map((i) => i.stream);
    expect(streams[0]).toBe("vote");
    expect(streams.slice(1, 4)).toEqual(["processed", "processed", "processed"]);
    expect(streams).toContain("story");
    expect(streams).toContain("deed");
    expect(streams).toContain("ledger");
    expect(built.items.every((i) => i.timeMs === null || Number.isFinite(i.timeMs))).toBe(true);
  });

  it("dedupes deeds already adopted into the story; keeps persisted-only history", () => {
    const built = buildTimeline(
      baseInput({
        storyLog: ["[Arc 1·Ch 1] The lantern holds"],
        deeds: ["The lantern holds", "Older persisted deed"],
      }),
    );
    const deeds = built.items.filter((i) => i.stream === "deed");
    expect(deeds.map((d) => d.title)).toEqual(["Older persisted deed"]);
  });

  it("no timestamps are fabricated: results/story/deeds carry null time", () => {
    const built = buildTimeline(
      baseInput({
        results,
        storyLog: ["[Arc 1·Ch 1] x"],
        deeds: ["y"],
        voteLive: { phase: "open", prompt: "p", totalBallots: 0, commandsProcessed: 0, maxCommands: 5, closingSoon: false, winnerLabel: null },
      }),
    );
    for (const i of built.items.filter((x) => x.stream !== "ledger")) {
      expect(i.timeMs).toBe(null);
    }
  });

  it("ledger entries sort newest-first by real timestamps; unknown statuses survive", () => {
    const built = buildTimeline(
      baseInput({
        ledger: [
          { eventId: "old", status: "applied", appliedAtIso: "2025-01-01T00:00:00.000Z" },
          { eventId: "new", status: "retraction-noted", notedAtIso: "2026-06-01T00:00:00.000Z" },
          { eventId: "weird", status: "mystery" },
        ],
        expandLedger: true,
      }),
    );
    const led = built.items.filter((i) => i.stream === "ledger");
    expect(led[0].id).toContain("new");
    expect(led.map((i) => i.category)).toContain("other");
    expect(led.find((i) => i.category === "ledger-noted")!.warning).toBe(true);
  });

  it("deed/ledger caps truncate with totals; expansion lifts them", () => {
    const deeds = Array.from({ length: TIMELINE_DEED_CAP + 5 }, (_, n) => `persisted deed ${n}`);
    const small = buildTimeline(baseInput({ deeds }));
    expect(small.deedsTruncated).toBe(true);
    expect(small.deedsTotal).toBe(TIMELINE_DEED_CAP + 5);
    expect(small.items.filter((i) => i.stream === "deed")).toHaveLength(TIMELINE_DEED_CAP);
    const big = buildTimeline(baseInput({ deeds, expandDeeds: true }));
    expect(big.deedsTruncated).toBe(false);
    expect(big.items.filter((i) => i.stream === "deed")).toHaveLength(TIMELINE_DEED_CAP + 5);
  });

  it("closed vote pins a decided item; no vote pins nothing", () => {
    const closed = buildTimeline(
      baseInput({
        voteLive: { phase: "closed", prompt: "Which road?", totalBallots: 5, commandsProcessed: 10, maxCommands: 10, closingSoon: false, winnerLabel: "Parley" },
      }),
    );
    expect(closed.items[0].category).toBe("vote-live");
    expect(closed.items[0].title).toBe("Which road?");
    expect(buildTimeline(baseInput()).items).toEqual([]);
  });

  it("formatTime renders real times and blanks unknowns", () => {
    expect(formatTime(null)).toBe("");
    expect(formatTime(Date.parse("2026-03-04T05:06:07.000Z"))).toMatch(/^\d\d:\d\d:\d\d$/);
  });
});

// ---------------------------------------------------------------------------
// Filters: membership, empties, no source mutation.
// ---------------------------------------------------------------------------

describe("UX-005 filters", () => {
  const input = baseInput({
    results: [
      { eventId: "c1", action: "attack", actorName: "K", summary: "struck" },
      { eventId: "c2", action: "cooldown", actorName: "K", summary: "cooldown" },
      { eventId: "p1", action: "paid_strike", actorName: "D", summary: "gale" },
      { eventId: "w1", action: "rejected", actorName: "world", summary: "Retraction noted" },
      { eventId: "v1", action: "rejected", actorName: "V", summary: "the assembly has not been called" },
    ],
    storyLog: ["[Arc 1·Ch 1] The assembly chose Parley", "[Arc 1·Ch 1] A quiet night"],
    deeds: ["An old deed"],
    ledger: [{ eventId: "l1", status: "applied", tierKey: "paid_supply", appliedAtIso: "2026-01-01T00:00:00.000Z", appliedAtStream: 1 }],
    voteLive: { phase: "open", prompt: "Which road?", totalBallots: 1, commandsProcessed: 1, maxCommands: 10, closingSoon: false, winnerLabel: null },
  });

  it("each filter selects its documented membership", () => {
    const all = buildTimeline(input).items;
    const ids = (f: ActivityFilter) => filterTimeline(all, f).map((i) => i.id);
    expect(ids("all")).toHaveLength(all.length);
    expect(ids("commands")).toEqual(expect.arrayContaining(["result:c1", "result:c2", "result:v1"]));
    expect(ids("commands")).not.toContain("result:p1");
    expect(ids("paid")).toEqual(expect.arrayContaining(["result:p1", "result:w1", "ledger:l1:applied"]));
    expect(ids("votes").length).toBeGreaterThanOrEqual(3);
    expect(ids("votes")).toEqual(expect.arrayContaining(["vote-live", "result:v1"]));
    expect(ids("warnings")).toEqual(["result:c2"]);
  });

  it("warnings contain rejections + pending notes, never clean history", () => {
    const all = buildTimeline(input).items;
    const warns = filterTimeline(all, "warnings").map((i) => i.id);
    expect(warns).toContain("result:c2");
    expect(warns).not.toContain("result:c1");
    expect(warns).not.toContain("result:p1");
    const withNote = buildTimeline(
      baseInput({ ledger: [{ eventId: "n1", status: "retraction-noted", notedAtIso: "2026-01-01T00:00:00.000Z" }] }),
    ).items;
    expect(filterTimeline(withNote, "warnings").map((i) => i.id)).toContain("ledger:n1:retraction-noted");
    expect(filterTimeline(withNote, "commands")).toEqual([]);
  });

  it("unknown categories are not silently lost (all + other path)", () => {
    const all = buildTimeline(
      baseInput({ results: [{ eventId: "x", action: "future", actorName: "K", summary: "?" }] }),
    ).items;
    expect(all.map((i) => i.category)).toContain("other");
    expect(filterTimeline(all, "all")).toHaveLength(1);
  });

  it("empty states exist per filter; labels defined for all five", () => {
    expect(Object.keys(FILTER_LABELS).sort()).toEqual([...ACTIVITY_FILTERS].sort());
    for (const f of ACTIVITY_FILTERS) {
      expect(FILTER_EMPTY[f].length).toBeGreaterThan(0);
      expect(filterTimeline([], f)).toEqual([]);
    }
  });

  it("filtering never mutates source state", () => {
    const frozen = baseInput({
      results: [{ eventId: "c1", action: "attack", actorName: "K", summary: "s" }],
      storyLog: ["[Arc 1·Ch 1] t"],
      deeds: ["d"],
      ledger: [{ eventId: "l", status: "applied" }],
    });
    const before = JSON.stringify(frozen);
    const built = buildTimeline(frozen);
    for (const f of ACTIVITY_FILTERS) filterTimeline(built.items, f);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(JSON.stringify(built.items)).toBe(JSON.stringify(buildTimeline(frozen).items));
  });
});

// ---------------------------------------------------------------------------
// Queue + ledger summaries: precise meanings, boundaries.
// ---------------------------------------------------------------------------

describe("UX-005 queue and ledger summaries", () => {
  it("queue distinguishes empty/waiting/full without processed claims", () => {
    expect(queueSummary(0, 100).line).toContain("empty");
    expect(queueSummary(0, 100).full).toBe(false);
    expect(queueSummary(3, 100).line).toContain("3/100");
    expect(queueSummary(3, 100).line).toContain("not yet processed");
    const full = queueSummary(100, 100);
    expect(full.full).toBe(true);
    expect(full.line).toContain("dropped");
    expect(queueSummary(99, 100).full).toBe(false);
  });

  it("ledger distinguishes recorded vs applied; overflow reported", () => {
    expect(ledgerSummary(0, 0, 0, 0, false).line).toContain("empty");
    const s = ledgerSummary(2, 1, 1, 4, false);
    expect(s.line).toContain("2 applied");
    expect(s.line).toContain("recorded only");
    expect(s.overflow).toBe(false);
    const o = ledgerSummary(200, 5, 3, 208, true);
    expect(o.line).toContain("OVERFLOW");
    expect(o.line).toContain("causality preserved");
  });

  it("pickLedgerFields drops amounts/actors/currency/platform ids by construction", () => {
    const picked = pickLedgerFields({
      eventId: "e",
      status: "applied",
      actorId: "secret",
      amount: 999,
      currency: "INR",
      platformEventId: "plat",
      tierKey: "paid_strike",
      appliedAtIso: "2026-01-01T00:00:00.000Z",
      appliedAtStream: 2,
    });
    expect(picked).toMatchObject({ eventId: "e", status: "applied", tierKey: "paid_strike" });
    expect(picked).not.toHaveProperty("amount");
    expect(picked).not.toHaveProperty("actorId");
    expect(picked).not.toHaveProperty("currency");
    expect(picked).not.toHaveProperty("platformEventId");
    expect(pickLedgerFields(null)).toBe(null);
    expect(pickLedgerFields({ status: "applied" })).toBe(null);
    expect(pickLedgerFields({ eventId: "e" })).toBe(null);
  });

  it("retention constants match engine caps", () => {
    expect(RETENTION).toEqual({ results: 30, story: 40, feed: 12 });
    expect(TIMELINE_DEED_CAP).toBeLessThanOrEqual(40);
    expect(TIMELINE_LEDGER_CAP).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Markup + architecture audits.
// ---------------------------------------------------------------------------

const AC_IDS = [
  "ac-sum-processed", "ac-sum-lifetime", "ac-sum-queue", "ac-sum-ledger", "ac-sum-warnings",
  "ac-filter-all", "ac-filter-commands", "ac-filter-paid", "ac-filter-votes", "ac-filter-warnings",
  "ac-timeline", "ac-timeline-empty", "ac-more-row", "ac-more-deeds", "ac-more-ledger",
  "ac-queue-summary", "ac-queue-list", "ac-ledger-summary", "ac-diag",
  "ac-sum-h", "ac-filter-h", "ac-timeline-h", "ac-queue-h", "ac-ledger-h", "ac-diag-h",
];

describe("UX-005 activity markup audit", () => {
  it.each(AC_IDS)("activity #%s present exactly once", (id) => {
    expect(countId(INDEX_HTML, id)).toBe(1);
  });

  it("all five filters exist with pressed semantics; All starts active", () => {
    expect(INDEX_HTML).toContain('role="group" aria-label="Activity timeline filters"');
    expect(INDEX_HTML).toContain('id="ac-filter-all" aria-pressed="true"');
    for (const f of ["commands", "paid", "votes", "warnings"]) {
      expect(INDEX_HTML).toContain(`id="ac-filter-${f}" aria-pressed="false"`);
    }
  });

  it("timeline uses list semantics without a live region", () => {
    expect(INDEX_HTML).toContain('<ul id="ac-timeline" aria-label="Activity timeline">');
    const region = INDEX_HTML.slice(INDEX_HTML.indexOf('id="view-activity"'));
    expect(region).not.toContain("aria-live");
  });

  it("no duplicate id attributes anywhere in the dashboard", () => {
    const ids = [...INDEX_HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("Activity placeholder is gone; queue/ledger/diag sections present", () => {
    const region = INDEX_HTML.slice(INDEX_HTML.indexOf('id="view-activity"'), INDEX_HTML.indexOf('id="view-settings"'));
    expect(region).not.toContain("Upcoming in a later milestone");
    expect(region).not.toContain("tb-view-note");
    expect(INDEX_HTML).toContain("Command queue · live state");
    expect(INDEX_HTML).toContain("Paid ledger · recorded history");
    expect(INDEX_HTML).toContain("Diagnostics · current state");
  });
});

describe("UX-005 architecture audit", () => {
  it("activity module has zero imports and no DOM access (isolation preserved)", () => {
    const imports = [...ACTIVITY_TS.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual([]);
    expect(ACTIVITY_TS).not.toContain("document");
    expect(ACTIVITY_TS).not.toContain("window");
  });

  it("no new polling loop; render path constructs nothing", () => {
    // T4F-C1 migration: the 250ms simulation pump and the 1s canvas re-sync
    // moved to the authority server (src/main.ts owns boot; the server owns
    // the loop). app.ts keeps exactly the 1s panel refresh — same shape,
    // fewer loops, still no construction in the render path.
    expect((APP_TS.match(/setInterval\(/g) ?? []).length).toBe(1);
    const body = APP_TS.slice(APP_TS.indexOf("export function renderPanelState"));
    expect(body).not.toContain("setInterval(");
    expect(body).not.toMatch(/new (EventQueue|FeedAggregator|WorldStore|YouTubeSource|GameEngine)\(/);
    // T4F-C1 migration: the single Phaser.Game (console preview) is created
    // in the dashboard boot entry (src/main.ts), not in app.ts. Still
    // exactly one game for the whole dashboard bundle.
    expect((APP_TS.match(/new Phaser\.Game\(\{/g) ?? []).length).toBe(0);
    expect((MAIN_TS.match(/new Phaser\.Game\(\{/g) ?? []).length).toBe(1);
  });

  it("no new engine/YouTube/persistence APIs; no new dependencies", () => {
    expect(APP_TS).toContain("rt.engine.recentResults.map(");
    expect(APP_TS).toContain("rt.engine.queue.peekAll()");
    expect(APP_TS).toContain("pickLedgerFields(e)");
    expect(APP_TS).not.toContain("fetch(");
    const pkg = JSON.parse(PACKAGE_JSON) as { dependencies?: Record<string, string> };
    // D1-C authorizes exactly one server-only dependency: pg (node-postgres,
    // pooled TLS driver for Neon; lazily imported server-side, never in the
    // browser bundle). No other runtime dependencies are permitted.
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["pg", "phaser"]);
  });

  it("Overview previews and Control Room wiring remain intact", () => {
    expect(APP_TS).toContain("nextActionModel({");
    expect(APP_TS).toContain("askOverride(rt, 0, ev)");
    expect(APP_TS).toContain("rehearsalAvailability(");
    expect(INDEX_HTML).toContain('href="#activity"');
  });
});
