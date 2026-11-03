import Phaser from "phaser";
import { tideboundGenesis, KINDLING_VOTE, ROUTE_VOTE, TIDEBOUND_LIBRARY } from "./content/tidebound";
import { COMMANDS } from "./engine/config";
import { GameEngine, makeEventId } from "./engine/engine";
import { FeedAggregator } from "./engine/feed";
import { ledgerStatus } from "./engine/ledger";
import { WorldStore } from "./persistence/store";
import { GameScene } from "./phaser/GameScene";
import { YouTubeSource } from "./youtube/client";
import {
  castSessionVote,
  openSessionVote,
  type StreamSession,
} from "./engine/lifecycle";
import {
  closeStreamAndFire,
  closeVoteAndFire,
  fireRite,
  handleProcessedResult,
  openStreamAndFire,
  overrideVoteAndFire,
} from "./runtime/progression";
import {
  beaconOilModel,
  commandGuide,
  headerModel,
  locationModels,
  objectiveModel,
  paleChartModel,
  recapModel,
  resolveModel,
  runtimeStatusModel,
  threatModel,
  vexModel,
  voteModel,
  worldRemembers,
  youtubeDisplayModel,
  type InputSource,
} from "./presentation/tidebound-presentation";
import { renderOverlay } from "./presentation/hud";

export interface Runtime {
  engine: GameEngine;
  feed: FeedAggregator;
  store: WorldStore;
  scene: GameScene;
  yt: YouTubeSource;
  session: StreamSession;
  readonly paused: boolean;
  sendCommand: (actorId: string, actorName: string, command: string) => string;
  sendPaid: (actorId: string, actorName: string, amountMinor: number, currency: string) => string;
  save: () => Promise<void>;
  reload: () => Promise<void>;
  reset: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  openRouteVote: () => string;
  openKindlingVote: () => string;
  closeActiveVote: () => string;
  overrideVote: (optionIndex: number) => string;
  fireRite: (templateId: string) => string;
  endStream: () => string;
}

function commandKeys(): string[] {
  return Object.keys(COMMANDS);
}

/** Shared runtime: event ingestion → queue → engine → world/story → Phaser + HUD. */
export async function createRuntime(opts: { withPanel: boolean }): Promise<Runtime> {
  const params = new URLSearchParams(location.search);
  const transparent = params.get("transparent") === "1";

  const store = new WorldStore();
  const feed = new FeedAggregator();
  const engine = new GameEngine(
    {
      onResult: (r) => {
        feed.push(r);
        scene?.playResult(r);
        // Single wiring point for collective story advancement (see
        // handleProcessedResult): meters → assembly reaction (at most one
        // vote firing on close) → ambient threshold reaction (at most one
        // firing). Paid catalysts can trip thresholds but never touch votes
        // or meters; world-internal noise advances nothing.
        const h = handleProcessedResult(engine, runtime.session, r, TIDEBOUND_LIBRARY);
        runtime.session = h.session;
        refresh();
      },
    },
    tideboundGenesis(),
  );

  // Restore persisted world BEFORE first render (never reset if a save exists).
  const { state, from } = await store.load();
  if (state) {
    engine.loadWorld(state);
    engine.storyLog.unshift(`World restored (${from}). Tidebound remembers.`);
  } else {
    engine.loadWorld(tideboundGenesis());
  }

  // Session ephemera: one open stream per page lifetime. Never persisted.
  // If the saved world is somehow unloadable as a session anchor, fall back
  // to a genesis-anchored session rather than blocking the stream.
  let session: StreamSession;
  {
    const opened = openStreamAndFire(engine.world, TIDEBOUND_LIBRARY);
    if (opened.ok) {
      engine.world = opened.world;
      for (const d of opened.newDeeds) engine.pushStory(d);
      session = opened.session;
    } else {
      engine.loadWorld(tideboundGenesis());
      const retry = openStreamAndFire(engine.world, TIDEBOUND_LIBRARY);
      if (!retry.ok) throw new Error("could not open stream session");
      engine.world = retry.world;
      for (const d of retry.newDeeds) engine.pushStory(d);
      session = retry.session;
    }
  }

  let paused = false;

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: "game",
    width: 1920,
    height: 1080,
    transparent,
    backgroundColor: transparent ? "rgba(0,0,0,0)" : "#1a1033",
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: [GameScene],
  });
  const scene = game.scene.getScene("game") as GameScene;

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleAutosave = () => {
    if (!opts.withPanel) return; // overlay never writes
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void store.save(engine.world), 2000);
  };

  function refresh(): void {
    // The HUD/panel must never depend on the canvas scene: a throttled or
    // failed WebGL context must not blank the stream overlay or console.
    if (scene.scene.isActive()) {
      scene.syncWorld(engine.world, engine.storyLog, feed.list());
    }
    if (opts.withPanel) {
      renderPanelState(runtime);
    } else {
      const el = document.getElementById("hud");
      if (el) {
        renderOverlay(el, {
          world: engine.world,
          session: runtime.session,
          storyLog: engine.storyLog,
          feed: feed.list(),
          recent: engine.recentResults,
          paused: runtime.paused,
        });
      }
    }
    scheduleAutosave();
  }

  // Main loop: pump queue + tick simulation — held while paused.
  setInterval(() => {
    if (runtime.paused) {
      if (scene.scene.isActive()) {
        scene.syncWorld(engine.world, engine.storyLog, feed.list());
        if (!opts.withPanel) {
          const el = document.getElementById("hud");
          if (el) {
            renderOverlay(el, {
              world: engine.world,
              session: runtime.session,
              storyLog: engine.storyLog,
              feed: feed.list(),
              recent: engine.recentResults,
              paused: true,
            });
          }
        } else {
          renderPanelState(runtime);
        }
      }
      return;
    }
    const results = engine.pump();
    const ticked = engine.tick();
    if (results.length > 0 || ticked.length > 0) refresh();
    else if (scene.scene.isActive()) {
      scene.syncWorld(engine.world, engine.storyLog, feed.list());
      if (!opts.withPanel) {
        const el = document.getElementById("hud");
        if (el) {
          renderOverlay(el, {
            world: engine.world,
            session: runtime.session,
            storyLog: engine.storyLog,
            feed: feed.list(),
            recent: engine.recentResults,
            paused: false,
          });
        }
      }
    }
  }, 250);

  // Keep shield indicator accurate even between events.
  setInterval(() => {
    if (!runtime.paused && scene.scene.isActive()) scene.syncWorld(engine.world, engine.storyLog, feed.list());
  }, 1000);

  const runtime: Runtime = {
    engine,
    feed,
    store,
    scene,
    yt: new YouTubeSource(engine),
    session,
    get paused() {
      return paused;
    },
    sendCommand: (actorId, actorName, command) => {
      const token = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (!commandKeys().includes(token)) return "rejected-invalid";
      // Ballots ride alongside ingestion: latest vote wins per actor. Paid
      // events never touch a vote (no amount parameter exists by design).
      if ((token === "!votea" || token === "!voteb") && runtime.session.activeVote !== null) {
        const idx = token === "!votea" ? 0 : 1;
        const casted = castSessionVote(runtime.session, actorId, idx);
        if (casted.ok) runtime.session = casted.session;
      }
      return engine.ingestCommand(actorId, actorName, token, makeEventId("cmd"));
    },
    sendPaid: (actorId, actorName, amountMinor, currency) =>
      engine.ingestPaid(actorId, actorName, amountMinor, currency, makeEventId("paid")),
    save: async () => {
      await store.save(engine.world);
      refreshPanel();
    },
    reload: async () => {
      const loaded = await store.load();
      if (loaded.state) {
        engine.loadWorld(loaded.state);
        engine.storyLog.unshift(`World reloaded (${loaded.from}).`);
        const opened = openStreamAndFire(engine.world, TIDEBOUND_LIBRARY);
        if (opened.ok) {
          engine.world = opened.world;
          runtime.session = opened.session;
          for (const d of opened.newDeeds) engine.pushStory(d);
        }
      }
      refresh();
      refreshPanel();
    },
    reset: async () => {
      engine.loadWorld(tideboundGenesis());
      const opened = openStreamAndFire(engine.world, TIDEBOUND_LIBRARY);
      if (opened.ok) {
        engine.world = opened.world;
        runtime.session = opened.session;
        for (const d of opened.newDeeds) engine.pushStory(d);
      }
      await store.save(engine.world);
      refresh();
      refreshPanel();
    },
    pause: () => {
      paused = true;
      refresh();
    },
    resume: () => {
      paused = false;
      refresh();
    },
    openRouteVote: () => {
      const r = openSessionVote(runtime.session, { ...ROUTE_VOTE, library: TIDEBOUND_LIBRARY });
      if (!r.ok) return r.reason;
      runtime.session = r.session;
      refresh();
      return "opened-route-vote";
    },
    openKindlingVote: () => {
      const r = openSessionVote(runtime.session, { ...KINDLING_VOTE, library: TIDEBOUND_LIBRARY });
      if (!r.ok) return r.reason;
      runtime.session = r.session;
      refresh();
      return "opened-kindling-vote";
    },
    closeActiveVote: () => {
      const r = closeVoteAndFire(runtime.session, engine.world, TIDEBOUND_LIBRARY);
      runtime.session = r.session;
      engine.world = r.world;
      for (const d of r.newDeeds) engine.pushStory(d);
      refresh();
      if (!r.didClose) return r.reason ?? "closed-vote";
      return r.fired ? `closed-vote:fired:${r.fired}` : `closed-vote:${r.reason ?? "no-winner"}`;
    },
    overrideVote: (optionIndex: number) => {
      const r = overrideVoteAndFire(runtime.session, engine.world, TIDEBOUND_LIBRARY, optionIndex);
      if (r.winner === null) return r.reason ?? "override-failed";
      engine.world = r.world;
      runtime.session = r.session;
      for (const d of r.newDeeds) engine.pushStory(d);
      refresh();
      refreshPanel();
      return r.fired ? `override:${r.winner}:fired` : `override:${r.winner}:no-fire:${r.reason ?? "unknown"}`;
    },
    fireRite: (templateId: string) => {
      const r = fireRite(engine.world, TIDEBOUND_LIBRARY, templateId);
      if (!r.ok) return r.reason ?? "rite-failed";
      engine.world = r.world;
      for (const d of r.newDeeds) engine.pushStory(d);
      refresh();
      refreshPanel();
      return `rite-fired:${r.fired}`;
    },
    endStream: () => {
      const f = closeStreamAndFire(engine.world, runtime.session, TIDEBOUND_LIBRARY);
      if (!f.ok) return f.reason;
      engine.world = f.world;
      for (const d of f.newDeeds) engine.pushStory(d);
      engine.loadWorld(engine.world);
      const opened = openStreamAndFire(engine.world, TIDEBOUND_LIBRARY);
      if (!opened.ok) return opened.reason;
      engine.world = opened.world;
      runtime.session = opened.session;
      for (const d of opened.newDeeds) engine.pushStory(d);
      void store.save(engine.world);
      refresh();
      refreshPanel();
      return `stream-closed:${f.world.streamCount}`;
    },
  };

  if (opts.withPanel) wirePanel(runtime, refreshPanel);
  else {
    // Synchronous first paint: the overlay must show the world on load even
    // if timers are throttled (background tab, OBS pre-load). Interval and
    // ready/timeout refreshes keep it live afterwards.
    const el = document.getElementById("hud");
    if (el) {
      renderOverlay(el, {
        world: engine.world,
        session: runtime.session,
        storyLog: engine.storyLog,
        feed: feed.list(),
        recent: engine.recentResults,
        paused: false,
      });
    }
  }
  // First paint once the scene is ready.
  game.events.once("ready", refresh);
  setTimeout(refresh, 800);
  setTimeout(refresh, 2000);

  function refreshPanel(): void {
    if (opts.withPanel) renderPanelState(runtime);
  }

  return runtime;
}

// ---------------------------------------------------------------------------
// Creator console (dev/creator page only — never in overlay/OBS).
// ---------------------------------------------------------------------------

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function wirePanel(rt: Runtime, refreshPanel: () => void): void {
  ($("btn-command") as HTMLButtonElement).onclick = () => {
    const name = ($("viewer-name") as HTMLInputElement).value.trim() || "Viewer1";
    const id = ($("viewer-id") as HTMLInputElement).value.trim() || name.toLowerCase();
    const cmd = ($("command") as HTMLSelectElement).value;
    const outcome = rt.sendCommand(id, name, cmd);
    flashOutcome(outcome);
    refreshPanel();
  };
  ($("btn-paid") as HTMLButtonElement).onclick = () => {
    const name = ($("viewer-name") as HTMLInputElement).value.trim() || "Viewer1";
    const id = ($("viewer-id") as HTMLInputElement).value.trim() || name.toLowerCase();
    const preset = ($("paid-preset") as HTMLSelectElement).value;
    const custom = Number(($("paid-custom") as HTMLInputElement).value);
    const major = preset === "custom" ? custom : Number(preset);
    if (!Number.isFinite(major) || major <= 0) {
      flashOutcome("rejected-invalid");
      return;
    }
    const outcome = rt.sendPaid(id, name, Math.round(major * 100), "INR");
    flashOutcome(outcome);
    refreshPanel();
  };
  // ---- Approved creator controls (safe boundary: no raw state mutation) ----
  ($("btn-open-v1") as HTMLButtonElement).onclick = () => flashOutcome(rt.openRouteVote());
  ($("btn-open-v2") as HTMLButtonElement).onclick = () => flashOutcome(rt.openKindlingVote());
  ($("btn-close-vote") as HTMLButtonElement).onclick = () => flashOutcome(rt.closeActiveVote());
  ($("btn-override-0") as HTMLButtonElement).onclick = () => flashOutcome(rt.overrideVote(0));
  ($("btn-override-1") as HTMLButtonElement).onclick = () => flashOutcome(rt.overrideVote(1));
  ($("btn-override-2") as HTMLButtonElement).onclick = () => {
    flashOutcome(rt.overrideVote(2));
  };
  ($("btn-rite-sable") as HTMLButtonElement).onclick = () => flashOutcome(rt.fireRite("sable-mending-rite"));
  ($("btn-rite-tide") as HTMLButtonElement).onclick = () => flashOutcome(rt.fireRite("tide-prayer"));
  ($("btn-rite-ilya") as HTMLButtonElement).onclick = () => flashOutcome(rt.fireRite("ilya-duel"));
  ($("btn-rite-rekindle") as HTMLButtonElement).onclick = () => flashOutcome(rt.fireRite("cinderholm-rekindle"));
  ($("btn-rite-rho") as HTMLButtonElement).onclick = () => flashOutcome(rt.fireRite("rho-plain-speech"));
  ($("btn-pause") as HTMLButtonElement).onclick = () => {
    rt.pause();
    flashOutcome("runtime paused — incoming events held");
    refreshPanel();
  };
  ($("btn-resume") as HTMLButtonElement).onclick = () => {
    rt.resume();
    flashOutcome("runtime resumed — events flowing");
    refreshPanel();
  };
  ($("btn-save") as HTMLButtonElement).onclick = () => void rt.save();
  ($("btn-reload") as HTMLButtonElement).onclick = () => void rt.reload();
  ($("btn-end-stream") as HTMLButtonElement).onclick = () => {
    if (confirm("Close this stream? The world persists; a fresh stream opens.")) {
      flashOutcome(rt.endStream());
    }
  };
  ($("btn-reset") as HTMLButtonElement).onclick = () => {
    if (confirm("Reset Tidebound to its beginning?")) void rt.reset();
  };
  ($("btn-export") as HTMLButtonElement).onclick = () => rt.store.exportFile(rt.engine.world);
  // ---- Input source: Simulation vs YouTube Live ----
  const srcSim = $("src-sim") as HTMLInputElement;
  const srcYt = $("src-yt") as HTMLInputElement;
  const useYouTube = () => {
    rt.yt.start();
    void rt.yt.refreshStatus();
  };
  srcSim.onchange = () => {
    if (srcSim.checked) rt.yt.stop();
  };
  srcYt.onchange = () => {
    if (srcYt.checked) useYouTube();
  };
  ($("btn-yt-auth") as HTMLButtonElement).onclick = async () => {
    const url = await rt.yt.authUrl();
    if (url) window.open(url, "_blank", "width=520,height=640");
    else flashOutcome("youtube sidecar not configured");
  };
  ($("btn-yt-connect") as HTMLButtonElement).onclick = async () => {
    if (!srcYt.checked) {
      srcYt.checked = true;
      useYouTube();
    }
    await rt.yt.connect();
    refreshPanel();
  };
  ($("btn-yt-disconnect") as HTMLButtonElement).onclick = async () => {
    await rt.yt.disconnectServer();
    refreshPanel();
  };
  rt.yt.onStatus(() => refreshPanel());
  setInterval(refreshPanel, 1000);
  // Static command guide (canonical vocabulary only, grouped by meaning).
  // Grouping is presentation-only: commandGuide() still returns the flat
  // canonical 11 and the engine still accepts exactly those tokens.
  const guide = commandGuide(COMMANDS as unknown as Record<string, { does: string }>);
  const byCmd = new Map(guide.map((g) => [g.command, g.does]));
  const cmdGroups: Array<{ label: string; cmds: string[] }> = [
    { label: "Act", cmds: ["!strike", "!mend", "!shield", "!tribute", "!defy"] },
    { label: "Explore", cmds: ["!scout", "!ring", "!hide"] },
    { label: "Decide", cmds: ["!voteA", "!voteB"] },
  ];
  ($("cc-commands") as HTMLElement).innerHTML =
    cmdGroups
      .map(
        (g) =>
          `<h3>${g.label}</h3>` +
          g.cmds
            .filter((c) => byCmd.has(c))
            .map((c) => `<div><b>${c}</b> — ${byCmd.get(c)}</div>`)
            .join(""),
      )
      .join("") +
    (byCmd.has("!help") ? `<h3>Help</h3><div><b>!help</b> — ${byCmd.get("!help")}</div>` : "");
  refreshPanel();
}

function flashOutcome(outcome: string): void {
  const el = $("outcome");
  el.textContent = `→ ${outcome}`;
  el.classList.remove("flash");
  void (el as HTMLElement).offsetWidth;
  el.classList.add("flash");
}

function bar(el: HTMLElement, current: number, target: number): void {
  el.style.width = `${target > 0 ? Math.round((Math.min(current, target) / target) * 100) : 0}%`;
}

export function renderPanelState(rt: Runtime): void {
  const w = rt.engine.world;
  const set = (id: string, v: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  const h = headerModel(w);
  const threat = threatModel(w);
  const resolve = resolveModel(w);
  const locs = locationModels(w);
  const vex = vexModel(w);
  const m1 = paleChartModel(w);
  const m2 = beaconOilModel(w);
  const vote = voteModel(rt.session, w, TIDEBOUND_LIBRARY);
  const recap = recapModel(w);

  // 5G-8B: runtime and YouTube are two separate facts. The top-level pill
  // reports ONLY event processing (never the broadcast); the Input Source
  // card reports ONLY the chat connection (never the runtime).
  const rs = runtimeStatusModel(rt.paused);
  set("cc-status", rs.label);
  const statusEl = document.getElementById("cc-status");
  if (statusEl) statusEl.classList.toggle("paused", rt.paused);
  set("cc-arc", `${h.arcLabel}`);
  set("cc-chapter", `${h.chapterLabel} · ${h.streamLabel}`);
  set("cc-threat", `Threat ${threat.level}/100 — ${threat.text}`);
  set("cc-resolve", `Resolve ${resolve.value} — ${resolve.text}`);
  set("cc-supplies", `Supplies ${w.resources} · Hero ${w.heroHp}/${w.maxHeroHp} · Keep ${w.keepHp}/${w.maxKeepHp}`);
  set("cc-location", locs.map((l) => `${l.glyph} ${l.name}: ${l.condition.toUpperCase()}`).join("  ·  "));
  const standing = ["keepers", "gloam", "sable", "wren", "rho", "ilya"]
    .map((f) => `${f} ${w.factionState[f] ?? 0}`)
    .join(" · ");
  set("cc-standing", `Standing — ${standing}`);
  set("cc-objective", objectiveModel(w));
  set("cc-moment", w ? (rt.engine.storyLog[0] ?? "The lantern holds, for now…") : "");
  if (vex.banner) set("cc-vex", `Herald pressure — ${vex.banner}`);
  else set("cc-vex", "The deep is quiet — no herald pressure.");

  // Vote card (generic; options render from live session state).
  // Hierarchy: prompt first, then options with counts, then the
  // command-clock, then the verdict. "The assembly chose" keeps the
  // audience-action → world-response → memory chain in keeper language.
  const voteEl = document.getElementById("cc-vote");
  if (voteEl) {
    if (vote.phase === "none") {
      voteEl.innerHTML = `<div>No vote is running. Open the route vote or the Kindling when the story calls for it.</div>`;
    } else {
      const pct = vote.maxCommands > 0 ? Math.round((vote.commandsProcessed / vote.maxCommands) * 100) : 0;
      voteEl.innerHTML =
        `<div class="vote-prompt">${vote.prompt}</div>` +
        `<div class="dim">${vote.phase === "closed" ? "decided" : "open — what are we deciding?"}${vote.closingSoon && vote.phase === "open" ? " · closing soon" : ""}</div>` +
        vote.options
          .map(
            (o) =>
              `<div class="vote-opt"><span>${o.leading ? "◆" : "◇"} ${o.label}</span>${o.leading ? `<span class="lead-tag">Leading</span>` : ""}<span>${o.command}</span><span class="n">${o.votes}</span></div>`,
          )
          .join("") +
        `<div class="meterbar" role="progressbar" aria-label="Assembly command clock" aria-valuenow="${vote.commandsProcessed}" aria-valuemax="${vote.maxCommands}"><i id="cc-vote-fill" style="width:${pct}%"></i></div>` +
        `<div class="dim">${vote.totalBallots} voice(s) · ${vote.commandsProcessed}/${vote.maxCommands} commands</div>` +
        (vote.phase === "closed"
          ? vote.winner
            ? `<div class="vote-verdict">The assembly chose <strong>${vote.winnerLabel}</strong>${vote.winnerReason ? ` (${vote.winnerReason})` : ""} — the deed enters the story below.</div>`
            : `<div class="vote-verdict">No winner — the tide stays its course${vote.winnerReason ? ` (${vote.winnerReason})` : ""}.</div>`
          : "");
    }
  }
  set("cc-m1", `${m1.title}: ${m1.current}/${m1.target} ${m1.unitText} — ${m1.status}. ${m1.hint}`);
  set("cc-m2", `${m2.title}: ${m2.current}/${m2.target} ${m2.unitText} — ${m2.status}. ${m2.hint}`);
  const m1f = document.getElementById("cc-m1-fill");
  const m2f = document.getElementById("cc-m2-fill");
  if (m1f) bar(m1f as HTMLElement, m1.current, m1.target);
  if (m2f) bar(m2f as HTMLElement, m2.current, m2.target);

  const deedsEl = document.getElementById("cc-deeds");
  if (deedsEl) {
    const deeds = worldRemembers(w, 5);
    deedsEl.innerHTML =
      deeds.length > 0 ? deeds.map((d) => `<div>✦ ${d}</div>`).join("") : "<div>No deeds yet.</div>";
  }
  const recapEl = document.getElementById("cc-recap");
  if (recapEl) {
    recapEl.innerHTML =
      (recap.lines.length > 0 ? recap.lines.map((l) => `<div>✦ ${l}</div>`).join("") : "<div>The story begins tonight.</div>") +
      `<div style="margin-top:4px"><strong>${recap.placeLine}</strong> · ${recap.tensionLine}</div>`;
  }

  // YouTube source state (elements exist only on the creator page).
  // Displayed state/note come from youtubeDisplayModel: a pure projection
  // of the selected input source + the sidecar's own status. The pill keeps
  // the raw wire status in data-s for quiet tone styling; the words never
  // claim more than the adapter actually knows (fail closed).
  const ytStatus = document.getElementById("yt-status");
  if (ytStatus) {
    const s = rt.yt.lastStatus;
    const d = rt.yt.diag;
    const srcYt = document.getElementById("src-yt") as HTMLInputElement | null;
    const source: InputSource = srcYt?.checked ? "youtube" : "simulation";
    const model = youtubeDisplayModel(source, s);
    ytStatus.textContent = model.state;
    ytStatus.setAttribute("data-s", s.status);
    const note = document.getElementById("yt-note");
    if (note) note.textContent = model.note;
    const detail = document.getElementById("yt-detail");
    if (detail) {
      detail.textContent =
        `sidecar: ${s.error ?? "ok"} · broadcast: ${s.broadcastTitle ?? "—"}\n` +
        `server: seen ${s.diag?.seen ?? 0} · cmd ${s.diag?.commands ?? 0} · paid ${s.diag?.paid ?? 0} · ignored ${s.diag?.ignored ?? 0} · polls ${s.diag?.polls ?? 0} · apiErr ${s.diag?.apiErrors ?? 0}\n` +
        `browser: received ${d.received} · queued ${d.queued} · duplicate ${d.duplicate} · rejected ${d.rejected}`;
    }
  }
  const queueEl = document.getElementById("queue-list");
  if (queueEl) {
    queueEl.textContent =
      rt.engine.queue
        .peekAll()
        .map((e) =>
          e.kind === "chat_command"
            ? `${e.actorName}: ${e.command}`
            : e.kind === "paid_event"
              ? `${e.actorName}: paid ${e.amount}`
              : `retraction noted: ${e.refPlatformId}`,
        )
        .join("\n") || "(empty)";
  }
  // Paid-ledger census (5G-4 diagnostic only: status counts, never amounts,
  // payers, tiers, or platform ids — "what happened to the world", not accounting).
  const ledgerEl = document.getElementById("cc-ledger");
  if (ledgerEl) {
    const s = ledgerStatus(rt.engine.world.paidLedger);
    ledgerEl.textContent =
      `Paid history: ${s.applied} applied · ${s.compensated} compensated · ${s.noted} noted` +
      (s.overflow ? ` · OVERFLOW (${s.total} entries — causality preserved)` : "");
  }
  const storyEl = document.getElementById("story-log");
  if (storyEl) storyEl.textContent = rt.engine.storyLog.join("\n") || "(no story yet)";
  const feedEl = document.getElementById("feed-list");
  if (feedEl) {
    feedEl.textContent = rt.feed.list().map((e) => e.text).join("\n") || "(no events yet)";
  }
}
