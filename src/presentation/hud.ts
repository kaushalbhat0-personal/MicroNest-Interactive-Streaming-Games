/**
 * Phase 5F — viewer OBS overlay HUD (DOM over the Phaser canvas).
 * Read-only projection: no buttons, no debug, no internal ids.
 * Transparent-friendly: the root adds no background of its own.
 */

import "../presentation/tidebound.css";
import { COMMANDS } from "../engine/config";
import { TIDEBOUND_LIBRARY } from "../content/tidebound";
import type { FeedEntry } from "../engine/feed";
import type { StreamSession } from "../engine/lifecycle";
import type { GameResult, WorldState } from "../engine/types";
import {
  beaconOilModel,
  catalystModel,
  classifyMoment,
  commandGuide,
  headerModel,
  locationModels,
  momentLabel,
  objectiveModel,
  paleChartModel,
  recapModel,
  resolveModel,
  threatModel,
  vexModel,
  voteModel,
  worldRemembers,
} from "./tidebound-presentation";

export interface OverlayInput {
  world: WorldState;
  session: StreamSession;
  storyLog: string[];
  feed: FeedEntry[];
  recent: GameResult[];
  paused: boolean;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderOverlay(root: HTMLElement, input: OverlayInput): void {
  const { world, session, storyLog, feed, recent, paused } = input;
  const h = headerModel(world);
  const threat = threatModel(world);
  const resolve = resolveModel(world);
  const locs = locationModels(world);
  const vex = vexModel(world);
  const vote = voteModel(session, world, TIDEBOUND_LIBRARY);
  const m1 = paleChartModel(world);
  const m2 = beaconOilModel(world);
  const recap = recapModel(world);
  const deeds = worldRemembers(world, 3);
  const cmds = commandGuide(COMMANDS as unknown as Record<string, { does: string }>);
  const momentLine = storyLog[0] ?? "The lantern holds, for now…";
  const lastReal = recent.find((r) => r.actorName !== "world" && !r.eventId.startsWith("tick-"));
  const momentKind = lastReal ? classifyMoment(lastReal.action, !!lastReal.visual.majorStory) : "action";

  // Paid catalysts render game-native: title + tagline ("Someone called
  // the storm…"), never purchaser, amount, or currency. The keeper console
  // keeps full engine summaries for operation; the overlay speaks fiction.
  const items = recent
    .filter((r) => !(r.action === "rejected" && r.actorName === "world"))
    .slice(0, 3)
    .map((r) => {
      const kind = classifyMoment(r.action, !!r.visual.majorStory);
      const cat = catalystModel(r.action);
      const text = cat ? `${cat.title} — ${cat.tagline}` : esc(r.summary);
      return `<div class="tb-item"><span class="tb-kind tb-kind-${kind}">${momentLabel(kind)}</span>${text}</div>`;
    })
    .join("");

  const feedFallback =
    items ||
    feed
      .slice(0, 3)
      .map((e) => `<div class="tb-item"><span class="tb-kind tb-kind-action">ACTION</span>${esc(e.text)}</div>`)
      .join("");

  // Grouped by meaning (canonical commands only): what can the audience do?
  const SHORT: Record<string, string> = {
    "!strike": "Strike the vessel",
    "!mend": "Mend the crew",
    "!shield": "Ward the beacon",
    "!tribute": "Honor a faction",
    "!defy": "Defy a faction",
    "!scout": "Scout the Pale",
    "!ring": "Sound the bell",
    "!hide": "Douse the lantern",
    "!voteA": "Vote · first path",
    "!voteB": "Vote · second path",
  };
  const GROUPS: Array<{ label: string; cmds: string[] }> = [
    { label: "Act", cmds: ["!strike", "!mend", "!shield", "!tribute", "!defy"] },
    { label: "Explore", cmds: ["!scout", "!ring", "!hide"] },
    { label: "Decide", cmds: ["!voteA", "!voteB"] },
  ];
  const KNOWN = new Set(cmds.map((c) => c.command));
  const cmdGroups = GROUPS.map(
    (g) =>
      `<div class="tb-cmdgroup"><span class="tb-grouplabel">${g.label}</span>${g.cmds
        .filter((c) => KNOWN.has(c))
        .map((c) => `<span><b>${esc(c)}</b> ${esc(SHORT[c] ?? "")}</span>`)
        .join("")}</div>`,
  ).join("");
  const cmdHelp = KNOWN.has("!help")
    ? `<div class="tb-cmdhelp">New here? Type !help in chat · votes count only while the assembly calls one</div>`
    : "";

  const voteCard =
    vote.phase === "none"
      ? `<div class="tb-panel tb-vote dormant"><h3>Assembly</h3><div class="tb-item">The assembly has not been called. Routes and burnings are decided here.</div></div>`
      : `<div class="tb-panel tb-vote ${vote.phase}" role="status" aria-live="polite" aria-label="Assembly vote, ${vote.phase}">` +
        `<h3>Assembly · ${vote.phase === "closed" ? "decided" : "open"}</h3>
        <div class="tb-decide">What are we deciding?</div>
        <div class="tb-prompt">${esc(vote.prompt)}</div>
        ${vote.options
          .map(
            (o, i) =>
              `<div class="tb-opt${o.leading ? " leading" : ""}"><span class="tb-optkey">${"ABC"[i] ?? "·"}</span><span class="lbl">${esc(o.label)}</span>${o.leading ? `<span class="tb-lead">Leading</span>` : ""}<span class="cmd">${esc(o.command)}</span><span class="n">${o.votes}</span></div>`,
          )
          .join("")}
        <div class="tb-clock" role="progressbar" aria-label="Assembly command clock" aria-valuenow="${vote.commandsProcessed}" aria-valuemax="${vote.maxCommands}"><i style="width:${Math.round(vote.clockProgress * 100)}%"></i></div>
        ${
          vote.phase === "closed"
            ? `<div class="tb-verdict">${
                vote.winner
                  ? `The assembly chose <span class="tb-winner">${esc(vote.winnerLabel ?? "")}</span>${vote.winnerReason ? ` <span class="tb-item">(${esc(vote.winnerReason)})</span>` : ""}`
                  : `No winner — the tide stays its course${vote.winnerReason ? ` (${esc(vote.winnerReason)})` : ""}.`
              }</div>`
            : `<div class="tb-tally">${vote.totalBallots} voice(s) · closes after ${vote.maxCommands} commands (${vote.maxCommands - vote.commandsProcessed} left)${vote.closingSoon ? ' · <span class="tb-soon">closing soon</span>' : ""}</div>`
        }
      </div>`;

  const meterCard = (
    m: { title: string; current: number; target: number; unitText: string; progress: number; status: string; hint: string },
    fill: string,
  ) =>
    `<div class="tb-panel tb-meter ${m.status}"><h3>${esc(m.title)}</h3>
      <div class="tb-mrow"><span class="tb-n">${m.current} / ${m.target} ${esc(m.unitText)}</span><span class="tb-status">${m.status === "active" ? "Building" : m.status === "complete" ? "Complete" : "Dormant"}</span></div>
      <div class="tb-bar" role="progressbar" aria-label="${esc(m.title)}" aria-valuenow="${m.current}" aria-valuemax="${m.target}"><i class="${fill}" style="width:${Math.round(m.progress * 100)}%"></i></div>
      <div class="tb-hint">${esc(m.hint)}</div></div>`;

  // DOM order follows the story hierarchy (story → vote → memory →
  // world → commands) for screen readers; absolute positioning keeps the
  // OBS visual layout unchanged.
  root.innerHTML = `
  <div class="tb-hud" aria-label="Tidebound live overlay">
    <div class="tb-panel tb-topbar">
      <div class="tb-world">${esc(h.worldName)}</div>
      <div class="tb-arc">${esc(h.arcLabel)}</div>
      <div class="tb-chapter">${esc(h.chapterLabel)}</div>
      <div><span class="tb-stream">${esc(h.streamLabel)}</span></div>
    </div>
    ${paused ? `<div class="tb-paused" role="status">PAUSED</div>` : ""}
    <div class="tb-right">
      <section class="tb-panel tb-story" role="status" aria-live="polite" aria-label="Story now">
        <div class="tb-kicker">Story now · ${momentLabel(momentKind)}</div>
        <div class="tb-moment">${esc(momentLine)}</div>
        <div class="tb-next"><span class="tb-next-label">Next · </span>${esc(objectiveModel(world))}</div>
      </section>
      ${vex.banner ? `<div class="tb-panel tb-vex${vex.stage === "driven-off" ? " driven" : ""}" role="status">${esc(vex.banner)}</div>` : ""}
      ${voteCard}
      <div class="tb-panel tb-feed">
        <div class="tb-kicker">The tide turns · action becomes consequence</div>
        ${feedFallback || `<div class="tb-item">Awaiting the first act…</div>`}
      </div>
      <div class="tb-panel tb-deeds">
        <div class="tb-kicker">The world remembers</div>
        ${deeds.length > 0 ? deeds.map((d) => `<div class="tb-deed">${esc(d)}</div>`).join("") : `<div class="tb-deed">No deeds yet — this stream will be the first.</div>`}
      </div>
      <div class="tb-panel tb-recap">
        <div class="tb-kicker">Previously, in Tidebound…</div>
        ${recap.lines.length > 0 ? recap.lines.slice(0, 2).map((l) => `<div>✦ ${esc(l)}</div>`).join("") : `<div>The story begins tonight.</div>`}
        <div style="margin-top:4px"><strong>${esc(recap.placeLine)}</strong> · ${esc(recap.tensionLine)}</div>
      </div>
    </div>
    <div class="tb-left">
      <div class="tb-panel">
        <div class="tb-kicker">World state</div>
        <div class="tb-stat"><span>Threat ${threat.level}/100</span><span class="tb-bar"><i class="tb-threat-${threat.tone}" style="width:${threat.level}%"></i></span></div>
        <div class="tb-item" style="font-size:13px;color:var(--tb-dim)">${esc(threat.text)}</div>
        <div class="tb-stat"><span>Resolve ${resolve.value}</span><span class="tb-bar"><i class="tb-resolve-fill" style="width:${Math.min(100, resolve.value)}%"></i></span></div>
        <div class="tb-item" style="font-size:13px;color:var(--tb-dim)">${esc(resolve.text)}</div>
        <div class="tb-stat"><span>◆ Supplies ${world.resources}</span></div>
        ${locs.map((l) => `<div class="tb-loc tb-loc-${l.condition}"><span class="glyph-${l.condition}">${l.glyph}</span> ${esc(l.name)} — <strong>${esc(l.condition.toUpperCase())}</strong> · ${esc(l.note)}</div>`).join("")}
      </div>
      ${meterCard(m1, "tb-fill-chart")}
      ${meterCard(m2, "tb-fill-oil")}
    </div>
    <div class="tb-panel tb-bottom" aria-label="What the audience can do">
      <div class="tb-commands">${cmdGroups}${cmdHelp}</div>
    </div>
  </div>`;
}
