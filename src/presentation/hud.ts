/**
 * T4D — viewer OBS overlay HUD (DOM over the Phaser canvas).
 * Read-only projection: no buttons, no debug, no internal ids.
 * Transparent-friendly: the root adds no background of its own.
 *
 * T4D: authoritative ViewerFeedItem feed (5 landscape / 3 portrait rows,
 * +N others aggregation, +N more overflow), single event-banner surface
 * (portrait slot + landscape wrap), refined HP chips, static cooldown hints.
 * Pure string builder; event-driven state (feed store, banner queue) lives
 * in the app shell and is passed in — routine polling never replays banners.
 */

import "../presentation/tidebound.css";
import { COMMANDS } from "../engine/config";
import { TIDEBOUND_LIBRARY } from "../content/tidebound";
import type { FeedEntry } from "../engine/feed";
import type { StreamSession } from "../engine/lifecycle";
import type { GameResult, WorldState } from "../engine/types";
import {
  aggregateFeedItems,
  buildViewerFeedItem,
  cooldownHints,
  hpChipModels,
  VISIBLE_LANDSCAPE,
  VISIBLE_PORTRAIT,
  type BannerItem,
  type DisplayRow,
  type ViewerFeedItem,
  type VoteFeedCtx,
} from "./viewer-feed";
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
  type VoteModel,
  worldRemembers,
} from "./tidebound-presentation";

export interface OverlayInput {
  world: WorldState;
  session: StreamSession;
  storyLog: string[];
  feed: FeedEntry[];
  recent: GameResult[];
  paused: boolean;
  /** T4C format selection (default landscape for existing callers/tests). */
  format?: "landscape" | "portrait";
  /** T4D: prebuilt authoritative feed (stable stamps from ViewerFeedStore). */
  viewerFeedItems?: ViewerFeedItem[];
  /** T4D: single visible event banner (from BannerQueue.current()). */
  banner?: BannerItem | null;
  /**
   * T4F-B: prebuilt public vote projection from the authoritative snapshot.
   * When present it wins over recomputation from `session` (the private
   * ballot map never leaves the authority). Absent by default — all existing
   * callers keep computing from session exactly as before.
   */
  vote?: VoteModel | null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderOverlay(root: HTMLElement, input: OverlayInput): void {
  const { world, session, storyLog, recent, paused } = input;
  const format = input.format ?? "landscape";
  const isPortrait = format === "portrait";
  const h = headerModel(world);
  const threat = threatModel(world);
  const resolve = resolveModel(world);
  const locs = locationModels(world);
  const vex = vexModel(world);
  // T4F-B: renderers pass the authority's public vote model (ballots never
  // leave the authority); all existing callers omit it and recompute.
  const vote = input.vote ?? voteModel(session, world, TIDEBOUND_LIBRARY);
  const m1 = paleChartModel(world);
  const m2 = beaconOilModel(world);
  const recap = recapModel(world);
  // T4E-F1: when the vote is open it is the temporary focus (T4B L2 over L5
  // memory). Deeds collapse to one and the recap card yields entirely so
  // five feed rows fit the 800px right rail; history is never discarded
  // (world.deeds intact, console retains everything).
  const voteOpen = vote.phase === "open";
  const deeds = worldRemembers(world, voteOpen ? 1 : 3);
  const cmds = commandGuide(COMMANDS as unknown as Record<string, { does: string }>);
  const momentLine = storyLog[0] ?? "The lantern holds, for now…";
  const lastReal = recent.find((r) => r.actorName !== "world" && !r.eventId.startsWith("tick-"));
  const momentKind = lastReal ? classifyMoment(lastReal.action, !!lastReal.visual.majorStory) : "action";

  // T4D authoritative feed: prebuilt store items win (stable stamps);
  // otherwise build deterministically from recent (fallback for existing
  // callers/tests). Never parses raw chat; never exposes actorId/yt ids,
  // amounts, or internal ids (builder drops them by construction).
  const voteCtx: VoteFeedCtx | null =
    session.activeVote !== null
      ? {
          phase: vote.phase,
          totalBallots: vote.totalBallots,
          ballots: { ...session.activeVote.ballots },
          options: vote.options.map((o) => ({ label: o.label, command: o.command })),
        }
      : input.vote && input.vote.phase !== "none"
        ? {
            // T4F-B renderer path: attribution is baked into the prebuilt
            // viewerFeed items; ballots stay empty by design (private).
            phase: input.vote.phase,
            totalBallots: input.vote.totalBallots,
            ballots: {},
            options: input.vote.options.map((o) => ({ label: o.label, command: o.command })),
          }
        : null;
  const nowMs = Date.now();
  const builtFromRecent: ViewerFeedItem[] = (input.viewerFeedItems ?? recent.map((r, idx) => {
    const built = buildViewerFeedItem(r, { world, vote: voteCtx, at: nowMs - idx * 100 });
    return built;
  }).filter((b): b is ViewerFeedItem => b !== null));
  // Clamp to bounded history (newest-first) — full attribution preserved
  // in the store; the HUD shows a capped persistent surface, never a log.
  const feedItems = builtFromRecent.slice(0, 30);
  const visibleRows = isPortrait ? VISIBLE_PORTRAIT : VISIBLE_LANDSCAPE;
  const aggregated = aggregateFeedItems(feedItems, visibleRows);

  function renderRow(row: DisplayRow): string {
    if (row.kind === "single") {
      const it = row.item;
      const full = `${it.actor} ${it.verb} ${it.target} — ${it.outcome}${it.delta ? ` (${it.delta})` : ""}`;
      // Paid catalysts keep game-native fiction (title + tagline) so the
      // overlay speaks fiction, never payer/amount/currency. Structured
      // verb/target stay in the aria-label for attribution.
      if (it.action.startsWith("paid_")) {
        const cat = catalystModel(it.action);
        const fiction = cat ? `${cat.title} — ${cat.tagline}` : full;
        const paidText = `${esc(it.actor)} — ${esc(fiction)}${it.delta ? ` (${esc(it.delta)})` : ""}`;
        return `<div class="tb-feed-item tb-feed-act" title="${esc(full)}" aria-label="${esc(full)}"><span class="tb-feed-actor">${esc(it.actor)}</span> <span class="tb-feed-desc">${paidText}</span></div>`;
      }
      const harm = it.action === "ring" || it.action === "defy";
      const cls = it.status === "applied" ? "tb-feed-act" : it.status === "cooldown" ? "tb-feed-cooldown" : "tb-feed-muted";
      const suffix = harm ? ` <span class="tb-harm">· harm</span>` : "";
      return `<div class="tb-feed-item ${cls}" title="${esc(full)}" aria-label="${esc(full)}"><span class="tb-feed-actor">${esc(it.actor)}</span> <span class="tb-feed-desc">${esc(it.verb)} ${esc(it.target)} — ${esc(it.outcome)}${it.delta ? ` (${esc(it.delta)})` : ""}${suffix}</span></div>`;
    }
    const full = `${row.leadActor} +${row.othersCount} others ${row.verb} ${row.target} — ${row.outcome}${row.delta ? ` (${row.delta})` : ""}`;
    const actors = row.items.map((m) => m.actor).join(", ");
    return `<div class="tb-feed-item tb-feed-aggregate" title="${esc(full)}" aria-label="${esc(full)} (voices: ${esc(actors)})"><span class="tb-feed-actor">${esc(row.leadActor)} <span class="tb-others">+${row.othersCount} others</span></span> <span class="tb-feed-desc">${esc(row.verb)} ${esc(row.target)} — ${esc(row.outcome)}${row.delta ? ` (${esc(row.delta)})` : ""}</span></div>`;
  }
  const feedRows = aggregated.rows.map(renderRow).join("");
  const feedMore =
    aggregated.overflow > 0 ? `<div class="tb-feed-more" aria-hidden="true">+${aggregated.overflow} more acts</div>` : "";
  const feedBody = feedRows + feedMore || `<div class="tb-feed-item tb-feed-empty">Awaiting the first act…</div>`;

  // Grouped by meaning (canonical commands only): what can the audience do?
  // T4C Option 1: Decide row shows all three vote tokens exactly once.
  // T4D: static authoritative cooldown durations (Ns) from COMMANDS —
  // no personalized countdown exists (no actor identity on the viewer
  // surface; engine cooldowns are in-memory per-viewer only).
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
    "!voteC": "Vote · third path",
  };
  const GROUPS: Array<{ label: string; cmds: string[] }> = isPortrait
    ? [
        { label: "Decide", cmds: ["!voteA", "!voteB", "!voteC"] },
        { label: "Act", cmds: ["!strike", "!mend", "!shield", "!tribute", "!defy"] },
        { label: "Explore", cmds: ["!scout", "!ring", "!hide"] },
      ]
    : [
        { label: "Act", cmds: ["!strike", "!mend", "!shield", "!tribute", "!defy"] },
        { label: "Explore", cmds: ["!scout", "!ring", "!hide"] },
        { label: "Decide", cmds: ["!voteA", "!voteB", "!voteC"] },
      ];
  const KNOWN = new Set(cmds.map((c) => c.command));
  const coolByCmd = new Map(cooldownHints().map((c) => [c.command, c.label]));
  const cmdGroups = GROUPS.map(
    (g) =>
      `<div class="tb-cmdgroup"><span class="tb-grouplabel">${g.label}</span>${g.cmds
        .filter((c) => KNOWN.has(c))
        .map((c) => `<span><b>${esc(c)}</b> ${esc(SHORT[c] ?? "")} <span class="tb-cool">${esc(coolByCmd.get(c) ?? "")}</span></span>`)
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

  // DOM HP chips (T4D refined): authoritative world-state values, tabular
  // numerals, clear labels + readable status words (never color-alone).
  // Same numbers as the canvas bars (reinforcement, not prose duplication).
  const chips = hpChipModels(world);
  const hpAria = `Health: ${chips.map((c) => c.aria).join(", ")}`;
  const hpChips = `<div class="tb-hp" aria-label="${esc(hpAria)}">${chips
    .map(
      (c) =>
        `<span class="tb-hp-chip" data-hp="${c.key}" title="${esc(c.aria)}">${esc(c.text)}${c.status ? ` <span class="tb-hp-status">· ${esc(c.status)}</span>` : ""}</span>`,
    )
    .join(`<span class="tb-hp-sep"> · </span>`)}</div>`;
  // T4D single event banner (authoritative queue, 5s hold by timestamp —
  // never animation). Vote-result carries the decisive outcome only; the
  // vote card retains the tally. Major-hit never repeats the feed sentence.
  const bannerItem: BannerItem | null = input.banner ?? null;
  const bannerHtml = bannerItem
    ? `<div class="tb-banner tb-banner-${esc(bannerItem.category)}" role="status" aria-live="assertive" aria-label="${esc(bannerItem.title)}: ${esc(bannerItem.sub)}"><div class="tb-banner-title">${esc(bannerItem.title)}</div><div class="tb-banner-sub">${esc(bannerItem.sub)}</div></div>`
    : "";
  // First-join premise (copy only, until the first deed).
  const showPremise = deeds.length === 0;
  const premiseLine = `<div class="tb-premise">A lantern-crew holds the drowned light against the Gloam.</div>`;

  // DOM order follows the story hierarchy (story → vote → memory →
  // world → commands) for screen readers; absolute positioning keeps the
  // OBS visual layout unchanged. Portrait uses a stacked composition with
  // the same projections; memory (deeds/recap/standalone vex) is hidden
  // in portrait (console retains full history; vex merges into banner slot).
  const topbarLive = paused
    ? `<span class="tb-live tb-live-paused" role="status">PAUSED</span>`
    : `<span class="tb-live" aria-label="Live"><span class="tb-live-dot" aria-hidden="true">●</span> LIVE</span>`;
  const topbar = `
    <div class="tb-panel tb-topbar">
      <div class="tb-world">${esc(h.worldName)}</div>
      ${topbarLive}
      <div class="tb-arc">${esc(h.arcLabel)}</div>
      <div class="tb-chapter">${esc(h.chapterLabel)}</div>
      <div><span class="tb-stream">${esc(h.streamLabel)}</span></div>
    </div>`;
  const storySection = `
      <section class="tb-panel tb-story" role="status" aria-live="polite" aria-label="Story now">
        <div class="tb-kicker">Story now · ${momentLabel(momentKind)}</div>
        <div class="tb-moment">${esc(momentLine)}</div>
        <div class="tb-next"><span class="tb-next-label">Next · </span>${esc(objectiveModel(world))}</div>
        ${showPremise ? premiseLine : ""}
      </section>`;
  const vexSection = vex.banner
    ? `<div class="tb-panel tb-vex${vex.stage === "driven-off" ? " driven" : ""}" role="status">${esc(vex.banner)}</div>`
    : "";
  const feedSection = `
      <div class="tb-panel tb-feed" role="status" aria-live="polite" aria-atomic="false" aria-label="Viewer activity, newest first">
        <div class="tb-kicker">The tide turns · action becomes consequence</div>
        ${feedBody}
      </div>`;
  const deedsSection = `
      <div class="tb-panel tb-deeds">
        <div class="tb-kicker">The world remembers</div>
        ${deeds.length > 0 ? deeds.map((d) => `<div class="tb-deed">${esc(d)}</div>`).join("") : `<div class="tb-deed">No deeds yet — this stream will be the first.</div>`}
      </div>`;
  const recapSection = voteOpen
    ? ""
    : `
      <div class="tb-panel tb-recap">
        <div class="tb-kicker">Previously, in Tidebound…</div>
        ${recap.lines.length > 0 ? recap.lines.slice(0, 2).map((l) => `<div>✦ ${esc(l)}</div>`).join("") : `<div>The story begins tonight.</div>`}
        <div style="margin-top:4px"><strong>${esc(recap.placeLine)}</strong> · ${esc(recap.tensionLine)}</div>
      </div>`;
  const worldSection = `
      <div class="tb-panel">
        <div class="tb-kicker">World state</div>
        ${hpChips}
        <div class="tb-stat"><span>Threat ${threat.level}/100</span><span class="tb-bar"><i class="tb-threat-${threat.tone}" style="width:${threat.level}%"></i></span></div>
        <div class="tb-item" style="font-size:13px;color:var(--tb-dim)">${esc(threat.text)}</div>
        <div class="tb-stat"><span>Resolve ${resolve.value}</span><span class="tb-bar"><i class="tb-resolve-fill" style="width:${Math.min(100, resolve.value)}%"></i></span></div>
        <div class="tb-item" style="font-size:13px;color:var(--tb-dim)">${esc(resolve.text)}</div>
        <div class="tb-stat"><span>◆ Supplies ${world.resources}</span></div>
        ${locs.map((l) => `<div class="tb-loc tb-loc-${l.condition}"><span class="glyph-${l.condition}">${l.glyph}</span> ${esc(l.name)} — <strong>${esc(l.condition.toUpperCase())}</strong> · ${esc(l.note)}</div>`).join("")}
      </div>
      ${meterCard(m1, "tb-fill-chart")}
      ${meterCard(m2, "tb-fill-oil")}`;
  const commandsSection = `
    <div class="tb-panel tb-bottom" aria-label="What the audience can do">
      <div class="tb-commands">${cmdGroups}${cmdHelp}</div>
    </div>`;

  if (isPortrait) {
    // Portrait stacked composition (1080×1920 ref): identity → story →
    // world (+HP chips) → vote → feed (3) → commands. Memory hidden.
    // Vex merges into the banner slot (no standalone vex card).
    root.innerHTML = `
  <div class="tb-hud tb-portrait" aria-label="Tidebound live overlay" data-format="portrait">
    ${topbar}
    ${paused ? `<div class="tb-paused" role="status">PAUSED</div>` : ""}
    <div class="tb-pstack">
      ${storySection}
      <div class="tb-worldwrap">
        <div class="tb-hpwrap">${hpChips}</div>
        <div class="tb-threatline">${esc(threat.text)} · Threat ${threat.level}/100</div>
      </div>
      ${voteCard}
      ${feedSection}
      ${commandsSection}
      ${bannerHtml ? `<div class="tb-banner-slot">${bannerHtml}</div>` : `<div class="tb-banner-slot" aria-hidden="true"></div>`}
    </div>
  </div>`;
    return;
  }

  root.innerHTML = `
  <div class="tb-hud" aria-label="Tidebound live overlay" data-format="landscape">
    ${topbar}
    ${paused ? `<div class="tb-paused" role="status">PAUSED</div>` : ""}
    ${bannerHtml ? `<div class="tb-banner-wrap">${bannerHtml}</div>` : ""}
    <div class="tb-right">
      ${storySection}
      ${vexSection}
      ${voteCard}
      ${feedSection}
      ${deedsSection}
      ${recapSection}
    </div>
    <div class="tb-left">
      ${worldSection}
    </div>
    ${commandsSection}
  </div>`;
}
