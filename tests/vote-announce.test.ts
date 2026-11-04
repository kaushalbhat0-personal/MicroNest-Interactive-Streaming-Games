import { describe, expect, it } from "vitest";
import {
  ANNOUNCE_MAX_CHARS,
  announceStatusLine,
  closeEventId,
  composeVoteOpen,
  composeVoteResult,
  isValidEventId,
  openEventId,
} from "../src/presentation/vote-announce";

const ROUTE = {
  prompt: "Which road through the Pale?",
  options: [
    { label: "Dredge the sunken channel", command: "!voteA" },
    { label: "Parley with Ilya of Highspire", command: "!voteB" },
  ],
  maxCommands: 25,
};

describe("vote announcement composer", () => {
  it("composes the route open announcement within the chat limit", () => {
    const r = composeVoteOpen(ROUTE);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.text).toContain("TIDEBOUND VOTE:");
    expect(r.text).toContain("Which road through the Pale?");
    expect(r.text).toContain("A) Dredge the sunken channel !voteA");
    expect(r.text).toContain("B) Parley with Ilya of Highspire !voteB");
    expect(r.text).toContain("closes after 25 commands");
    expect(Array.from(r.text).length).toBeLessThanOrEqual(ANNOUNCE_MAX_CHARS);
  });

  it("composes the 3-option kindling open announcement within the limit", () => {
    const r = composeVoteOpen({
      prompt: "The Kindling — what does the flame take?",
      options: [
        { label: "Burn Tam's warning", command: "!voteA" },
        { label: "Burn Wren's first chart", command: "!voteB" },
        { label: "Burn Rho's first peal", command: "!voteC" },
      ],
      maxCommands: 30,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r));
    expect(Array.from(r.text).length).toBeLessThanOrEqual(ANNOUNCE_MAX_CHARS);
  });

  it("drops the close-rule parenthetical before failing on length", () => {
    const long = "L".repeat(150);
    const r = composeVoteOpen({ prompt: long, options: [{ label: "Go", command: "!voteA" }], maxCommands: 25 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.text).not.toContain("closes after");
  });

  it("reports too-long instead of truncating", () => {
    const r = composeVoteOpen({
      prompt: "P".repeat(190),
      options: [{ label: "L".repeat(60), command: "!voteA" }],
      maxCommands: 0,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected fail");
    expect(r.reason).toBe("too-long");
  });

  it("rejects empty prompt, missing options and bad options", () => {
    expect(composeVoteOpen({ prompt: "  ", options: ROUTE.options, maxCommands: 1 }).ok).toBe(false);
    expect(composeVoteOpen({ prompt: "Q?", options: [], maxCommands: 1 })).toMatchObject({ ok: false, reason: "no-options" });
    expect(
      composeVoteOpen({ prompt: "Q?", options: [{ label: "", command: "!voteA" }], maxCommands: 1 }),
    ).toMatchObject({ ok: false, reason: "bad-option" });
    expect(
      composeVoteOpen({ prompt: "Q?", options: [{ label: "Go", command: "voteA" }], maxCommands: 1 }),
    ).toMatchObject({ ok: false, reason: "bad-option" });
  });

  it("never invents content: labels and commands pass through verbatim", () => {
    const r = composeVoteOpen(ROUTE);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    for (const o of ROUTE.options) {
      expect(r.text).toContain(o.label);
      expect(r.text).toContain(o.command);
    }
  });

  it("composes winner results with ballot counts", () => {
    const r = composeVoteResult({ prompt: ROUTE.prompt, totalBallots: 7, winnerLabel: "Dredge the sunken channel" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.text).toContain("TIDEBOUND RESULT:");
    expect(r.text).toContain("Dredge the sunken channel");
    expect(r.text).toContain("7 voices");
  });

  it("composes tie/no-winner results with the engine reason", () => {
    const r = composeVoteResult({ prompt: ROUTE.prompt, totalBallots: 2, winnerLabel: null, winnerReason: "winner-ineligible" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.text).toContain("no winner (winner-ineligible)");
    expect(r.text).toContain("The tide stays its course.");
  });

  it("event identities are stable, safe and shared across close paths", () => {
    expect(openEventId("s1", "vote-which-road")).toBe("vote:s1:vote-which-road:open");
    expect(closeEventId("s1", "vote-which-road")).toBe("vote:s1:vote-which-road:close");
    expect(openEventId("s1", "vote-which-road")).toBe(openEventId("s1", "vote-which-road"));
    expect(openEventId("a/b c", "v!x")).toBe("vote:a_b_c:v_x:open");
    expect(isValidEventId("vote:s1:v:close")).toBe(true);
    expect(isValidEventId("")).toBe(false);
    expect(isValidEventId("vote s1")).toBe(false);
    expect(isValidEventId("x".repeat(129))).toBe(false);
  });

  it("status lines never leak secrets and stay actionable", () => {
    expect(announceStatusLine("na-simulation")).toContain("Simulation");
    expect(announceStatusLine("sent")).toContain("Sent");
    expect(announceStatusLine("reauth-required")).toContain("Authorize");
    expect(announceStatusLine("failed", "quota-exceeded")).toContain("quota-exceeded");
  });
});
