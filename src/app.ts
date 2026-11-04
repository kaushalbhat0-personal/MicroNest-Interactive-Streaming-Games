import { TIDEBOUND_LIBRARY } from "./content/tidebound";
import { COMMANDS, QUEUE } from "./engine/config";
import type { CanonicalEvent, GameResult, WorldState } from "./engine/types";
import type { FeedEntry } from "./engine/feed";
import { PAID_LEDGER_MAX_ENTRIES, ledgerStatus } from "./engine/ledger";
import type { WorldStore } from "./persistence/store";
import type { GameScene } from "./phaser/GameScene";
import type { YtStatus } from "./youtube/client";
import type { StreamSession } from "./engine/lifecycle";
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
import { activeFormatLine, getStoredFormat, overlayUrl, setStoredFormat } from "./dashboard/format";
import type { BannerQueue, ViewerFeedStore } from "./presentation/viewer-feed";
import { isEligibleTemplate, isRepeatEligible } from "./engine/templates";
import { escapeHtml, initShell, syncShellStatus } from "./dashboard/shell";
import {
  endStreamCopy,
  overrideCopy,
  rehearsalAvailability,
  resetCopy,
  riteAvailability,
  sessionAvailability,
  voteAvailability,
  type Availability,
  type ConfirmCopy,
} from "./dashboard/control";
import {
  ACTIVITY_FILTERS,
  CATEGORY_LABELS,
  FILTER_EMPTY,
  FILTER_LABELS,
  RETENTION,
  buildTimeline,
  filterTimeline,
  formatTime,
  ledgerSummary,
  pickLedgerFields,
  queueSummary,
  type ActivityFilter,
  type TimelineItem,
} from "./dashboard/activity";
import {
  connectionSteps,
  obsConfig,
  persistStateLine,
  recoverySteps,
  sourceLine,
  stepLabel,
} from "./dashboard/settings";
import {
  meterAria,
  nextActionModel,
  paidLine,
  persistLine,
  queueLine,
  voteLine,
} from "./dashboard/overview";
import {
  announceStatusLine,
  closeEventId,
  openEventId,
  type AnnounceStatus,
} from "./presentation/vote-announce";

/**
 * T4F-C1 read-only engine view. The GameEngine lives in the authority
 * server process; the dashboard receives a structural view over the latest
 * control-plane payload. Constructing a GameEngine here is forbidden
 * (boundary test enforces it).
 */
export interface EngineView {
  world: WorldState;
  storyLog: string[];
  recentResults: GameResult[];
  queue: { readonly size: number; peekAll(): CanonicalEvent[] };
}

/** Read-only feed view over the latest control-plane payload. */
export interface FeedView {
  list(): FeedEntry[];
}

/** Ingest counters mirroring the authority's YouTubeSource diag. */
export interface YtDiag {
  received: number;
  queued: number;
  duplicate: number;
  rejected: number;
}

/**
 * T4F-C1 control-plane YouTube view. The single sidecar subscription is
 * owned by the authority server; these methods POST control actions and
 * read the server's status cache. Never an EventSource owner.
 */
export interface YtView {
  lastStatus: YtStatus;
  diag: YtDiag;
  start(): Promise<void>;
  stop(): Promise<void>;
  refreshStatus(): Promise<YtStatus>;
  connect(): Promise<void>;
  disconnectServer(): Promise<void>;
  authUrl(): Promise<string | null>;
  onStatus(fn: (s: YtStatus) => void): () => void;
}

export interface Runtime {
  engine: EngineView;
  feed: FeedView;
  /** T4D authoritative viewer feed (bounded, attributed, stable stamps). */
  viewerFeed: ViewerFeedStore;
  /** T4D single-visible event banner queue (bounded, priority, dedupe). */
  banners: BannerQueue;
  store: WorldStore;
  /** Live scene when booted, else null (scenes boot async — never throws). */
  readonly scene: GameScene | null;
  yt: YtView;
  session: StreamSession;
  readonly paused: boolean;
  /**
   * T3 outbound announcement delivery state, keyed by vote event id
   * (`vote:<session>:<vote>:open|close`). Engine truth stays in
   * `session`/`world`; this records only what chat was told. Never
   * persisted (session ephemera, like the vote itself).
   */
  announce: Record<string, AnnounceState>;
  sendCommand: (actorId: string, actorName: string, command: string) => Promise<string>;
  sendPaid: (actorId: string, actorName: string, amountMinor: number, currency: string) => Promise<string>;
  save: () => Promise<void>;
  reload: () => Promise<void>;
  reset: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  openRouteVote: () => Promise<string>;
  openKindlingVote: () => Promise<string>;
  closeActiveVote: () => Promise<string>;
  overrideVote: (optionIndex: number) => Promise<string>;
  /**
   * T3: retry a failed/uncertain/unconnected announcement with its stored
   * text and original event identity. Never reopens or alters the vote.
   */
  retryAnnounce: (eventId: string) => Promise<void>;  fireRite: (templateId: string) => Promise<string>;
  endStream: () => Promise<string>;
}

/** T3 delivery record for one vote announcement (open or close). */
export interface AnnounceState {
  kind: "open" | "close";
  status: AnnounceStatus;
  /** Typed server reason for failed/uncertain states (never secrets). */
  reason?: string;
  /** Composed chat text (preview in simulation, retried verbatim). */
  text?: string;
  attempts: number;
}

/** T4F-C1: persistence source is fed by the authority control plane. */
export function setPersistFrom(from: "file" | "local" | "none" | "file-error"): void {
  persistFrom = from === "file-error" ? "none" : from;
}

// UX-003 persistence signal: last observed WorldStore destination. Recorded
// from save()/load() return values only — save semantics never change, and
// "local" is reported as info (browser-only), never as failure.
let persistFrom: "file" | "local" | "none" = "none";

// UX-003 sticky-preview offset cache: #game sticks below the sticky
// header+alert wrapper whose height varies with the banner. Rewritten only
// when the value changes (matchMedia-guarded so mobile is never shifted).
let lastGameTop = "";
// UX-007A: cached desktop query — creating a MediaQueryList every render is
// pure overhead with identical results between resizes (the query object
// itself stays live and re-evaluates .matches on access).
let desktopQuery: MediaQueryList | null = null;

// UX-003 activity-preview diff caches: previews rewrite only on new content.
let lastDeedsSig = "";
let lastFeedSig = "";

// UX-005 activity workspace state: filter + timeline expansion. Read-only
// views over existing sources; no new store, no new listeners per event.
let activityFilter: ActivityFilter = "all";
let expandDeeds = false;
let expandLedger = false;
let lastTimelineSig: string | null = null;
let lastQueueSig: string | null = null;
// UX-006 settings recovery diff cache: guidance rewrites only on change.
let lastRecoverySig: string | null = null;

// ---------------------------------------------------------------------------
// Creator console (dev/creator page only — never in overlay/OBS).
// T4F-C1: the dashboard is a server-backed control client. wirePanel and
// renderPanelState are pure DOM over a Runtime view; the ServerRuntime
// implementation lives in dashboard/server-runtime.ts (the only place
// allowed to fetch the control API). This module constructs no engines,
// queues, YouTube sources, or timers beyond the panel refresh.
// ---------------------------------------------------------------------------

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

export function wirePanel(rt: Runtime, refreshPanel: () => void): void {
  // UX-002 shell: hash navigation + alert-dismiss delegation (idempotent,
  // once per page — never per runtime event, never re-creates Phaser/YT).
  initShell();
  ($("btn-command") as HTMLButtonElement).onclick = () => {
    const name = ($("viewer-name") as HTMLInputElement).value.trim() || "Viewer1";
    const id = ($("viewer-id") as HTMLInputElement).value.trim() || name.toLowerCase();
    const cmd = ($("command") as HTMLSelectElement).value;
    // T4F-C1: control actions are confirmed by the authority server — the
    // outcome is flashed only after the server answers (never fabricated).
    void (async () => {
      flashOutcome(await rt.sendCommand(id, name, cmd));
      refreshPanel();
    })();
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
    void (async () => {
      flashOutcome(await rt.sendPaid(id, name, Math.round(major * 100), "INR"));
      refreshPanel();
    })();
  };
  // ---- Approved creator controls (safe boundary: no raw state mutation) ----
  ($("btn-open-v1") as HTMLButtonElement).onclick = () => void (async () => flashOutcome(await rt.openRouteVote()))();
  ($("btn-open-v2") as HTMLButtonElement).onclick = () => void (async () => flashOutcome(await rt.openKindlingVote()))();
  ($("btn-close-vote") as HTMLButtonElement).onclick = () => void (async () => flashOutcome(await rt.closeActiveVote()))();
  // T3: announcement retry rides the stored event identity (never reopens
  // or alters the vote). Delegated: the vote card re-renders every refresh.
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const btn = t.closest("[data-announce-retry]");
    if (!(btn instanceof HTMLElement)) return;
    const id = btn.getAttribute("data-announce-retry");
    if (id) void rt.retryAnnounce(id);
  });
  ($("btn-override-0") as HTMLButtonElement).onclick = (ev) => askOverride(rt, 0, ev);
  ($("btn-override-1") as HTMLButtonElement).onclick = (ev) => askOverride(rt, 1, ev);
  ($("btn-override-2") as HTMLButtonElement).onclick = (ev) => {
    askOverride(rt, 2, ev);
  };
  ($("btn-rite-sable") as HTMLButtonElement).onclick = () => void (async () => flashOutcome(await rt.fireRite("sable-mending-rite")))();
  ($("btn-rite-tide") as HTMLButtonElement).onclick = () => void (async () => flashOutcome(await rt.fireRite("tide-prayer")))();
  ($("btn-rite-ilya") as HTMLButtonElement).onclick = () => void (async () => flashOutcome(await rt.fireRite("ilya-duel")))();
  ($("btn-rite-rekindle") as HTMLButtonElement).onclick = () => void (async () => flashOutcome(await rt.fireRite("cinderholm-rekindle")))();
  ($("btn-rite-rho") as HTMLButtonElement).onclick = () => void (async () => flashOutcome(await rt.fireRite("rho-plain-speech")))();
  ($("btn-pause") as HTMLButtonElement).onclick = () => {
    void (async () => {
      await rt.pause();
      flashOutcome("runtime paused — incoming events held");
      refreshPanel();
    })();
  };
  ($("btn-resume") as HTMLButtonElement).onclick = () => {
    void (async () => {
      await rt.resume();
      flashOutcome("runtime resumed — events flowing");
      refreshPanel();
    })();
  };
  ($("btn-save") as HTMLButtonElement).onclick = () => void rt.save();
  ($("btn-reload") as HTMLButtonElement).onclick = () => void rt.reload();
  ($("btn-end-stream") as HTMLButtonElement).onclick = (ev) => {
    const invoker = ev.currentTarget instanceof HTMLElement ? ev.currentTarget : null;
    openConfirm(endStreamCopy(), () => void (async () => flashOutcome(await rt.endStream()))(), invoker);
  };
  ($("btn-reset") as HTMLButtonElement).onclick = (ev) => {
    const invoker = ev.currentTarget instanceof HTMLElement ? ev.currentTarget : null;
    openConfirm(resetCopy(), () => {
      void rt.reset();
    }, invoker);
  };
  ($("btn-export") as HTMLButtonElement).onclick = () => rt.store.exportFile(rt.engine.world);
  // ---- Input source: Simulation vs YouTube Live (server-owned switch) ----
  const srcSim = $("src-sim") as HTMLInputElement;
  const srcYt = $("src-yt") as HTMLInputElement;
  const useYouTube = () => {
    void (async () => {
      await rt.yt.start();
      await rt.yt.refreshStatus();
      refreshPanel();
    })();
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
  // UX-004: single confirmation dialog wiring (once per page). Cancel and
  // Escape abandon the pending action; only the explicit confirm button
  // runs it, exactly once. Backdrop clicks intentionally do nothing.
  const dlg = $("cr-confirm");
  if (dlg instanceof HTMLDialogElement) {
    ($("cr-confirm-cancel") as HTMLButtonElement).onclick = () => {
      pendingConfirm = null;
      dlg.close("cancel");
    };
    ($("cr-confirm-ok") as HTMLButtonElement).onclick = () => {
      const run = pendingConfirm;
      pendingConfirm = null;
      dlg.close("ok");
      if (run) run();
    };
    dlg.addEventListener("cancel", () => {
      pendingConfirm = null;
    });
    dlg.addEventListener("close", () => {
      restoreConfirmFocus();
    });
    dlg.addEventListener("click", (ev) => {
      if (ev.target === dlg) {
        // Backdrop click: deliberate no-op, never a confirmation.
        ev.preventDefault();
      }
    });
  }
  // UX-005: activity filter + timeline expansion (wired once; render
  // happens in renderPanelState through the existing 1s lifecycle).
  for (const f of ACTIVITY_FILTERS) {
    const btn = document.getElementById(`ac-filter-${f}`);
    if (btn instanceof HTMLButtonElement) {
      btn.onclick = () => {
        activityFilter = f;
        refreshPanel();
      };
    }
  }
  const moreDeeds = document.getElementById("ac-more-deeds");
  if (moreDeeds instanceof HTMLButtonElement) {
    moreDeeds.onclick = () => {
      expandDeeds = true;
      refreshPanel();
    };
  }
  const moreLedger = document.getElementById("ac-more-ledger");
  if (moreLedger instanceof HTMLButtonElement) {
    moreLedger.onclick = () => {
      expandLedger = true;
      refreshPanel();
    };
  }
  // UX-006: OBS overlay URL (static per origin; set once, never re-derived
  // per poll). Read-only input keeps a manual-copy fallback available.
  try {
    const urlEl = document.getElementById("st-obs-url");
    if (urlEl instanceof HTMLInputElement) {
      const cfg = obsConfig(typeof location !== "undefined" ? location.origin : "");
      urlEl.value = cfg.url;
      if (!cfg.url) urlEl.placeholder = "Open overlay.html from this same server, then copy its address.";
    }
  } catch {
    /* obs url init must never break panel wiring */
  }
  const obsCopy = document.getElementById("st-obs-copy");
  if (obsCopy instanceof HTMLButtonElement) {
    obsCopy.onclick = () => {
      const done = document.getElementById("st-obs-done");
      const say = (msg: string) => {
        if (done) done.textContent = msg;
      };
      try {
        const urlEl = document.getElementById("st-obs-url");
        const url = urlEl instanceof HTMLInputElement ? urlEl.value : "";
        if (!url) {
          say("No URL yet — open overlay.html from this same server first.");
          return;
        }
        const clip = (navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } }).clipboard;
        if (!clip) {
          if (urlEl instanceof HTMLInputElement) urlEl.select();
          say("Copy unavailable here — the URL is selected; copy it manually.");
          return;
        }
        void clip.writeText(url).then(
          () => say("Copied to clipboard."),
          () => say("Copy failed — select the URL manually."),
        );
      } catch {
        say("Copy failed — select the URL manually.");
      }
    };
  }
  // T4E: portrait overlay URL + format selection (wired once per page).
  // The console keeps its single landscape game canvas; the selector only
  // chooses which overlay page OBS loads. Switching loads the other overlay
  // URL — a full overlay reload with the world save kept and the stream
  // session restarting — never a second game here, never a world reset
  // caused by a display choice.
  try {
    const pUrlEl = document.getElementById("st-obs-url-portrait");
    if (pUrlEl instanceof HTMLInputElement) {
      const pUrl = overlayUrl(typeof location !== "undefined" ? location.origin : "", "portrait");
      pUrlEl.value = pUrl;
      if (!pUrl) pUrlEl.placeholder = "Open overlay.html from this same server, then copy its address.";
    }
  } catch {
    /* portrait url init must never break panel wiring */
  }
  const obsCopyP = document.getElementById("st-obs-copy-portrait");
  if (obsCopyP instanceof HTMLButtonElement) {
    obsCopyP.onclick = () => {
      const done = document.getElementById("st-obs-done-portrait");
      const say = (msg: string) => {
        if (done) done.textContent = msg;
      };
      try {
        const urlEl = document.getElementById("st-obs-url-portrait");
        const url = urlEl instanceof HTMLInputElement ? urlEl.value : "";
        if (!url) {
          say("No URL yet — open overlay.html from this same server first.");
          return;
        }
        const clip = (navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } }).clipboard;
        if (!clip) {
          if (urlEl instanceof HTMLInputElement) urlEl.select();
          say("Copy unavailable here — the URL is selected; copy it manually.");
          return;
        }
        void clip.writeText(url).then(
          () => say("Copied to clipboard."),
          () => say("Copy failed — select the URL manually."),
        );
      } catch {
        say("Copy failed — select the URL manually.");
      }
    };
  }
  const fmtLandscape = document.getElementById("st-format-landscape");
  const fmtPortrait = document.getElementById("st-format-portrait");
  const sayFormat = (f: "landscape" | "portrait") => {
    const done = document.getElementById("st-format-done");
    if (done) done.textContent = activeFormatLine(f);
  };
  try {
    const stored = getStoredFormat();
    if (fmtLandscape instanceof HTMLInputElement) fmtLandscape.checked = stored === "landscape";
    if (fmtPortrait instanceof HTMLInputElement) fmtPortrait.checked = stored === "portrait";
    sayFormat(stored);
  } catch {
    /* format restore must never break panel wiring */
  }
  const onFormatChange = () => {
    const selected = fmtPortrait instanceof HTMLInputElement && fmtPortrait.checked ? ("portrait" as const) : ("landscape" as const);
    setStoredFormat(selected);
    sayFormat(selected);
  };
  // Source-radio switching stays assignment-based (the existing relocation
  // test pins exactly two such handlers); the display-format preference
  // below uses addEventListener so the input-source contract is untouched.
  if (fmtLandscape instanceof HTMLInputElement) fmtLandscape.addEventListener("change", onFormatChange);
  if (fmtPortrait instanceof HTMLInputElement) fmtPortrait.addEventListener("change", onFormatChange);
  const openPreview = (format: "landscape" | "portrait") => {
    const done = document.getElementById("st-format-done");
    try {
      const url = overlayUrl(typeof location !== "undefined" ? location.origin : "", format);
      if (!url) {
        if (done) done.textContent = "No URL yet — open overlay.html from this same server first.";
        return;
      }
      const win = window.open(url, "_blank", "noopener");
      if (!win && done) done.textContent = "Preview blocked — allow popups, or copy the URL from the OBS card below.";
    } catch {
      if (done) done.textContent = "Preview failed — copy the URL from the OBS card below.";
    }
  };
  const openL = document.getElementById("st-format-open-landscape");
  if (openL instanceof HTMLButtonElement) openL.onclick = () => openPreview("landscape");
  const openP = document.getElementById("st-format-open-portrait");
  if (openP instanceof HTMLButtonElement) openP.onclick = () => openPreview("portrait");
  rt.yt.onStatus(() => refreshPanel());
  setInterval(refreshPanel, 1000);
  // Static command guide (canonical vocabulary only, grouped by meaning).
  // Grouping is presentation-only: commandGuide() still returns the flat
  // canonical 12 and the engine still accepts exactly those tokens.
  const guide = commandGuide(COMMANDS as unknown as Record<string, { does: string }>);
  const byCmd = new Map(guide.map((g) => [g.command, g.does]));
  const cmdGroups: Array<{ label: string; cmds: string[] }> = [
    { label: "Act", cmds: ["!strike", "!mend", "!shield", "!tribute", "!defy"] },
    { label: "Explore", cmds: ["!scout", "!ring", "!hide"] },
    { label: "Decide", cmds: ["!voteA", "!voteB", "!voteC"] },
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

// ---------------------------------------------------------------------------
// UX-004 destructive/override confirmation: one native <dialog>, dynamic
// copy, single pending action. Wired once in wirePanel; never re-created.
// Native showModal provides focus containment, Escape handling, and a
// top-layer backdrop that never confirms on click.
// ---------------------------------------------------------------------------

let pendingConfirm: (() => void) | null = null;
let confirmInvoker: HTMLElement | null = null;

function restoreConfirmFocus(): void {
  try {
    if (confirmInvoker && document.contains(confirmInvoker)) confirmInvoker.focus();
  } catch {
    /* non-browser test env */
  }
  confirmInvoker = null;
}

function openConfirm(copy: ConfirmCopy, run: () => void, invoker?: HTMLElement | null): void {
  const dlg = document.getElementById("cr-confirm");
  if (!(dlg instanceof HTMLDialogElement)) {
    // Dialog node missing (should never happen): fall back to native
    // confirm so the deliberate step is preserved, never skipped.
    if (confirm(`${copy.title}\n\n${copy.body}`)) run();
    return;
  }
  if (dlg.open) return; // a confirmation is already pending — ignore repeats
  const title = document.getElementById("cr-confirm-title");
  if (title) title.textContent = copy.title;
  const body = document.getElementById("cr-confirm-body");
  if (body) body.textContent = copy.body;
  const okBtn = document.getElementById("cr-confirm-ok");
  if (okBtn) okBtn.textContent = copy.confirmLabel;
  pendingConfirm = run;
  confirmInvoker =
    invoker instanceof HTMLElement
      ? invoker
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  dlg.showModal();
  const cancel = document.getElementById("cr-confirm-cancel");
  if (cancel instanceof HTMLElement) cancel.focus();
}

function bar(el: HTMLElement, current: number, target: number): void {
  el.style.width = `${target > 0 ? Math.round((Math.min(current, target) / target) * 100) : 0}%`;
}

// UX-004: override confirmation. Same underlying call (rt.overrideVote),
// interposed deliberation: the dialog names the chosen path before firing.
function askOverride(rt: Runtime, optionIndex: number, ev: { currentTarget: unknown }): void {
  const invoker = ev.currentTarget instanceof HTMLElement ? ev.currentTarget : null;
  const options = voteModel(rt.session, rt.engine.world, TIDEBOUND_LIBRARY).options;
  const label = options[optionIndex]?.label ?? `option ${optionIndex + 1}`;
  openConfirm(overrideCopy(label), () => void (async () => flashOutcome(await rt.overrideVote(optionIndex)))(), invoker);
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
        `<div class="meterbar" role="progressbar" aria-label="Assembly command clock" aria-valuemin="0" aria-valuenow="${vote.commandsProcessed}" aria-valuemax="${vote.maxCommands}"><i id="cc-vote-fill" style="width:${pct}%"></i></div>` +
        `<div class="dim">${vote.totalBallots} voice(s) · ${vote.commandsProcessed}/${vote.maxCommands} commands</div>` +
        (vote.phase === "closed"
          ? vote.winner
            ? `<div class="vote-verdict">The assembly chose <strong>${vote.winnerLabel}</strong>${vote.winnerReason ? ` (${vote.winnerReason})` : ""} — the deed enters the story below.</div>`
            : `<div class="vote-verdict">No winner — the tide stays its course${vote.winnerReason ? ` (${vote.winnerReason})` : ""}.</div>`
          : "");
    }
    // T3: announcement delivery is independent of the engine vote phase.
    // The card never says "announced" unless YouTube confirmed the send;
    // simulation shows the composed text as a rehearsal preview instead.
    try {
      const sid = rt.session.sessionId;
      if (vote.id) {
        const lines: string[] = [];
        const show = (eventId: string, label: string) => {
          const a = rt.announce[eventId];
          if (!a) return;
          lines.push(`<div class="dim">${label}: ${escapeHtml(announceStatusLine(a.status, a.reason ?? null))}</div>`);
          if (a.status === "na-simulation" && a.text) {
            lines.push(`<div class="dim">Chat preview (not sent): ${escapeHtml(a.text)}</div>`);
          }
          if (
            (a.status === "failed" ||
              a.status === "uncertain" ||
              a.status === "not-connected" ||
              a.status === "reauth-required") &&
            a.text
          ) {
            lines.push(
              `<div class="btn-row"><button class="ghost" data-announce-retry="${escapeHtml(eventId)}">Retry announcement</button></div>`,
            );
          }
        };
        show(openEventId(sid, vote.id), "Chat announcement (open)");
        if (vote.phase === "closed") show(closeEventId(sid, vote.id), "Chat announcement (result)");
        if (lines.length > 0) voteEl.innerHTML += lines.join("");
      }
    } catch {
      /* announcement readout must never break the vote card */
    }
  }
  set("cc-m1", `${m1.title}: ${m1.current}/${m1.target} ${m1.unitText} — ${m1.status}. ${m1.hint}`);
  set("cc-m2", `${m2.title}: ${m2.current}/${m2.target} ${m2.unitText} — ${m2.status}. ${m2.hint}`);
  const m1f = document.getElementById("cc-m1-fill");
  const m2f = document.getElementById("cc-m2-fill");
  if (m1f) bar(m1f as HTMLElement, m1.current, m1.target);
  if (m2f) bar(m2f as HTMLElement, m2.current, m2.target);
  // UX-003: accessible meter ranges (values unchanged, engine untouched).
  const m1a = meterAria(m1.current, m1.target);
  const m1bar = document.getElementById("cc-m1-bar");
  if (m1bar) {
    m1bar.setAttribute("aria-valuemin", String(m1a.min));
    m1bar.setAttribute("aria-valuemax", String(m1a.max));
    m1bar.setAttribute("aria-valuenow", String(m1a.now));
  }
  const m2a = meterAria(m2.current, m2.target);
  const m2bar = document.getElementById("cc-m2-bar");
  if (m2bar) {
    m2bar.setAttribute("aria-valuemin", String(m2a.min));
    m2bar.setAttribute("aria-valuemax", String(m2a.max));
    m2bar.setAttribute("aria-valuenow", String(m2a.now));
  }

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
    // UX-003: compact connection mirror for the Overview card (same model,
    // same fail-closed wording as the header pill and drawer note).
    const ovYtState = document.getElementById("ov-yt-state");
    if (ovYtState) ovYtState.textContent = model.state;
    const ovYtNote = document.getElementById("ov-yt-note");
    if (ovYtNote) ovYtNote.textContent = model.note;
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
    // T4D privacy: waiting-line amounts stay out of any surface that could
    // be screen-captured (fiction only — keeper detail lives in diagnostics).
    queueEl.textContent =
      rt.engine.queue
        .peekAll()
        .map((e) =>
          e.kind === "chat_command"
            ? `${e.actorName}: ${e.command}`
            : e.kind === "paid_event"
              ? `${e.actorName}: paid catalyst`
              : `retraction noted: ${e.refPlatformId}`,
        )
        .join("\n") || "Queue empty — the world is caught up.";
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

  // UX-003 overview: summary cards fed from the same authoritative models.
  // All nodes below are readouts; every control stays mounted below.
  // syncShellStatus diffs internally, so the 1s poll causes no DOM churn.
  try {
    const srcYt = document.getElementById("src-yt") as HTMLInputElement | null;
    const source: InputSource = srcYt?.checked ? "youtube" : "simulation";
    const led = ledgerStatus(rt.engine.world.paidLedger);
    const setOv = (id: string, v: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    const action = nextActionModel({
      paused: rt.paused,
      votePhase: vote.phase,
      voteClosingSoon: vote.closingSoon,
      source,
      ytStatus: rt.yt.lastStatus.status,
      ytError: rt.yt.lastStatus.error ?? null,
      queueSize: rt.engine.queue.size,
      queueMax: QUEUE.maxSize,
      ledgerOverflow: led.overflow,
      threatTone: threat.tone,
      cinderholmLost: w.locationState["cinderholm"] === "lost",
      persistFrom,
    });
    setOv("ov-persist", persistLine(persistFrom));
    setOv("ov-queue-line", queueLine(rt.engine.queue.size, QUEUE.maxSize));
    setOv(
      "ov-paid-line",
      paidLine(led.applied, led.compensated, led.noted),
    );
    setOv(
      "ov-vote-line",
      voteLine({
        phase: vote.phase,
        prompt: vote.prompt,
        totalBallots: vote.totalBallots,
        commandsProcessed: vote.commandsProcessed,
        maxCommands: vote.maxCommands,
        closingSoon: vote.closingSoon,
        winnerLabel: vote.winnerLabel,
      }),
    );
    // Previews rewrite only on new content (links stay outside these nodes).
    const deeds5 = worldRemembers(w, 5);
    const deedsSig = deeds5.join("\n");
    const deedsPrev = document.getElementById("ov-deeds-preview");
    if (deedsPrev && deedsSig !== lastDeedsSig) {
      lastDeedsSig = deedsSig;
      deedsPrev.innerHTML =
        deeds5.length > 0
          ? deeds5.map((d) => `<div>✦ ${escapeHtml(d)}</div>`).join("")
          : "<div>No deeds yet — they appear after the first rite or vote.</div>";
    }
    const feed8 = rt.feed.list().slice(0, 8);
    const feedSig = feed8.map((e) => `${e.action}|${e.count}|${e.text}`).join("\n");
    const feedPrev = document.getElementById("ov-feed-preview");
    if (feedPrev && feedSig !== lastFeedSig) {
      lastFeedSig = feedSig;
      feedPrev.innerHTML =
        feed8.length > 0
          ? feed8
              .map(
                (e) =>
                  `<div>✦ ${escapeHtml(e.text)}${e.count > 1 ? ` <span class="dim">×${e.count}</span>` : ""}</div>`,
              )
              .join("")
          : "<div>No audience events yet.</div>";
    }
    // Sticky-preview offset tracks the sticky header+alert wrapper height so
    // an expanded banner never covers the preview. Cleared on mobile where
    // the preview is not sticky (inline top would override the media query).
    // One offsetHeight read per render forces a single reflow of a small
    // sticky subtree — measured negligible next to the innerHTML writes this
    // function already performs; the write itself is change-gated.
    const gameEl = document.getElementById("game");
    const sticky = document.querySelector(".tb-sticky");
    if (gameEl instanceof HTMLElement && sticky instanceof HTMLElement) {
      if (
        desktopQuery === null &&
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function"
      ) {
        desktopQuery = window.matchMedia("(min-width: 1100px)");
      }
      const want = desktopQuery?.matches ? `${sticky.offsetHeight + 12}px` : "";
      if (want !== lastGameTop) {
        lastGameTop = want;
        gameEl.style.top = want;
      }
    }
    syncShellStatus({
      source,
      ytStatus: rt.yt.lastStatus.status,
      ytError: rt.yt.lastStatus.error ?? null,
      reconnects: rt.yt.lastStatus.reconnects,
      broadcastTitle: rt.yt.lastStatus.broadcastTitle ?? null,
      paused: rt.paused,
      queueSize: rt.engine.queue.size,
      queueMax: QUEUE.maxSize,
      ledgerOverflow: led.overflow,
      ledgerTotal: led.total,
      ledgerBound: PAID_LEDGER_MAX_ENTRIES,
      next: action,
    });
  } catch {
    /* shell must never break panel rendering */
  }

  // UX-004 control room: availability, reasons, gating. Readouts and
  // disabled/hidden states only — handlers above are untouched and the
  // engine re-validates every call, so UI mistakes cannot force actions.
  try {
    const applyAvail = (id: string, a: Availability) => {
      const el = document.getElementById(id);
      if (el instanceof HTMLButtonElement) el.disabled = !a.available;
    };
    const setWhy = (id: string, reason: string | null) => {
      const el = document.getElementById(id);
      if (el) el.textContent = reason ?? "";
    };
    // Session toggle: one visible action, both nodes mounted + wired.
    const sav = sessionAvailability(rt.paused, rt.engine.queue.size);
    const pauseBtn = document.getElementById("btn-pause");
    if (pauseBtn instanceof HTMLButtonElement) pauseBtn.hidden = !sav.showPause;
    const resumeBtn = document.getElementById("btn-resume");
    if (resumeBtn instanceof HTMLButtonElement) resumeBtn.hidden = !sav.showResume;
    set("cr-session-state", sav.stateLine);
    // Votes: open/close/override availability with grounded reasons.
    const vav = voteAvailability({
      votePhase: vote.phase,
      sessionOpen: rt.session.phase === "open",
      optionCount: vote.options.length,
    });
    applyAvail("btn-open-v1", vav.open);
    applyAvail("btn-open-v2", vav.open);
    applyAvail("btn-close-vote", vav.close);
    const overrideIds = ["btn-override-0", "btn-override-1", "btn-override-2"] as const;
    vav.overrides.forEach((o, i) => applyAvail(overrideIds[i], o));
    setWhy(
      "cr-vote-why",
      vote.phase === "open"
        ? vav.open.reason
        : vote.phase === "closed"
          ? vav.close.reason
          : vav.open.available
            ? null
            : vav.open.reason,
    );
    setWhy("cr-override-why", vav.overrides.find((o) => !o.available)?.reason ?? null);
    // Rites: condition → repeat → supplies → resolve (mirrors fireTemplate
    // order; fireRite still validates, so the engine stays authoritative).
    const library = TIDEBOUND_LIBRARY as unknown[];
    const riteRows: Array<[buttonId: string, templateId: string, whyId: string]> = [
      ["btn-rite-sable", "sable-mending-rite", "cr-rite-sable-why"],
      ["btn-rite-tide", "tide-prayer", "cr-rite-tide-why"],
      ["btn-rite-ilya", "ilya-duel", "cr-rite-ilya-why"],
      ["btn-rite-rekindle", "cinderholm-rekindle", "cr-rite-rekindle-why"],
      ["btn-rite-rho", "rho-plain-speech", "cr-rite-rho-why"],
    ];
    for (const [buttonId, templateId, whyId] of riteRows) {
      const template = library.find(
        (t): t is { id?: unknown; cost?: unknown; repeat?: unknown } & Record<string, unknown> =>
          typeof t === "object" && t !== null && (t as { id?: unknown }).id === templateId,
      );
      const cond = template ? isEligibleTemplate(template, w) : { ok: false as const, reason: "unknown-template" };
      const rep = template ? isRepeatEligible(template, w) : { ok: false as const, reason: "unknown-template" };
      const cost = (template?.cost ?? {}) as { supplies?: unknown; resolve?: unknown };
      const repeat = (template?.repeat ?? {}) as { kind?: unknown };
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
      const counters = w.eventCounters ?? {};
      const countOf = (k: string) => (typeof counters[k] === "number" && Number.isFinite(counters[k]) ? counters[k] : 0);
      const av = riteAvailability({
        templateId,
        conditionOk: cond.ok && cond.eligible,
        repeatOk: rep.ok && rep.eligible,
        repeatKind: typeof repeat.kind === "string" ? repeat.kind : null,
        suppliesCost: num(cost.supplies),
        resolveCost: num(cost.resolve),
        resources: w.resources,
        resolve: w.resolve,
        threatLevel: w.threatLevel,
        kills: countOf("kills"),
        beaconOil: countOf("meter.beacon-oil"),
      });
      applyAvail(buttonId, av);
      setWhy(whyId, av.reason);
    }
    // Rehearsal gating: simulation-only tools. Handlers untouched; the
    // radios keep their existing behavior, and the engine path is identical
    // (rehearsal never touches the YouTube transport by construction).
    const srcYtLive = document.getElementById("src-yt") as HTMLInputElement | null;
    const rav = rehearsalAvailability(srcYtLive?.checked ? "youtube" : "simulation");
    set("cr-source-line", rav.sourceLine);
    setWhy("cr-rehearsal-why", rav.reason);
    for (const id of ["viewer-name", "viewer-id", "command", "paid-preset", "paid-custom", "btn-command", "btn-paid"]) {
      const el = document.getElementById(id);
      if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
        el.disabled = !rav.enabled;
      }
    }
  } catch {
    /* control-room sync must never break panel rendering */
  }

  // UX-005 activity workspace: read-only views over existing in-memory
  // sources. No new store, no new timers; lists sig-diff so the 1s poll
  // never rebuilds focused filter buttons (only their counts/labels).
  try {
    const results = rt.engine.recentResults.map((r) => ({
      eventId: r.eventId,
      action: r.action,
      actorName: r.actorName,
      summary: r.summary,
    }));
    const ledgerEntries = w.paidLedger
      .map((e) => pickLedgerFields(e))
      .filter((e): e is NonNullable<typeof e> => e !== null);
    const ledAct = ledgerStatus(w.paidLedger);
    const built = buildTimeline({
      results,
      storyLog: rt.engine.storyLog,
      deeds: w.deeds,
      ledger: ledgerEntries,
      voteLive:
        vote.phase === "none"
          ? null
          : {
              phase: vote.phase,
              prompt: vote.prompt,
              totalBallots: vote.totalBallots,
              commandsProcessed: vote.commandsProcessed,
              maxCommands: vote.maxCommands,
              closingSoon: vote.closingSoon,
              winnerLabel: vote.winnerLabel,
            },
      expandDeeds,
      expandLedger,
    });
    const setAc = (id: string, v: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    const warnings = built.items.filter((i) => i.warning || i.category === "ledger-noted");
    setAc("ac-sum-processed", `${results.length} retained (last ${RETENTION.results})`);
    setAc(
      "ac-sum-lifetime",
      `${w.totalViewerActions} events · ${w.totalPaidEvents} paid (lifetime totals)`,
    );
    setAc("ac-sum-queue", `${rt.engine.queue.size}/${QUEUE.maxSize} waiting`);
    setAc(
      "ac-sum-ledger",
      `${ledAct.applied} applied · ${ledAct.compensated} compensated · ${ledAct.noted} noted`,
    );
    setAc("ac-sum-warnings", `${warnings.length} warnings in retained history`);
    for (const f of ACTIVITY_FILTERS) {
      const btn = document.getElementById(`ac-filter-${f}`);
      if (btn instanceof HTMLButtonElement) {
        btn.textContent = `${FILTER_LABELS[f]} (${filterTimeline(built.items, f).length})`;
        btn.setAttribute("aria-pressed", String(f === activityFilter));
      }
    }
    const shown = filterTimeline(built.items, activityFilter);
    const sig = `${activityFilter}|${expandDeeds ? 1 : 0}|${expandLedger ? 1 : 0}|${shown.map((i) => i.id).join(",")}`;
    const list = document.getElementById("ac-timeline");
    const empty = document.getElementById("ac-timeline-empty");
    if (sig !== lastTimelineSig) {
      lastTimelineSig = sig;
      if (list instanceof HTMLElement) {
        list.innerHTML = shown
          .map((it: TimelineItem) => {
            const when = formatTime(it.timeMs);
            const meta = [it.actor, ...it.meta, when || null]
              .filter((m): m is string => typeof m === "string" && m.length > 0)
              .map((m) => escapeHtml(m))
              .join(" · ");
            return (
              `<li class="ac-item" data-cat="${it.category}" data-warn="${it.warning ? "1" : "0"}">` +
              `<span class="ac-cat">${CATEGORY_LABELS[it.category]}</span>` +
              `<span class="ac-text">${escapeHtml(it.title)}</span>` +
              (meta ? `<span class="ac-meta">${meta}</span>` : "") +
              `</li>`
            );
          })
          .join("");
      }
      if (empty instanceof HTMLElement) {
        empty.hidden = shown.length > 0;
        if (shown.length === 0) empty.textContent = FILTER_EMPTY[activityFilter];
      }
    }
    const moreRow = document.getElementById("ac-more-row");
    const moreDeedsBtn = document.getElementById("ac-more-deeds");
    const moreLedgerBtn = document.getElementById("ac-more-ledger");
    const deedsRelevant = activityFilter === "all" || activityFilter === "votes";
    const ledgerRelevant =
      activityFilter === "all" || activityFilter === "paid" || activityFilter === "warnings";
    if (moreDeedsBtn instanceof HTMLButtonElement) {
      moreDeedsBtn.hidden = !(built.deedsTruncated && deedsRelevant);
      if (!moreDeedsBtn.hidden) moreDeedsBtn.textContent = `Show all ${built.deedsTotal} deeds`;
    }
    if (moreLedgerBtn instanceof HTMLButtonElement) {
      moreLedgerBtn.hidden = !(built.ledgerTruncated && ledgerRelevant);
      if (!moreLedgerBtn.hidden) moreLedgerBtn.textContent = `Show all ${built.ledgerTotal} ledger entries`;
    }
    if (moreRow instanceof HTMLElement) {
      moreRow.hidden =
        !(
          (built.deedsTruncated && deedsRelevant) ||
          (built.ledgerTruncated && ledgerRelevant)
        );
    }
    const qs = queueSummary(rt.engine.queue.size, QUEUE.maxSize);
    setAc("ac-queue-summary", qs.line);
    const queued = rt.engine.queue.peekAll();
    const qsig = queued.map((e) => e.eventId).join(",");
    const qlist = document.getElementById("ac-queue-list");
    if (qlist instanceof HTMLElement && qsig !== lastQueueSig) {
      lastQueueSig = qsig;
      qlist.innerHTML =
        queued.length > 0
          ? queued
              .map((e) => {
                const what =
                  e.kind === "chat_command"
                    ? `${e.actorName}: ${e.command}`
                    : e.kind === "paid_event"
                      ? `${e.actorName}: paid ${e.amount}`
                      : `retraction noted: ${e.refPlatformId}`;
                const bits = [e.source, formatTime(Date.parse(e.receivedAt)) || null]
                  .filter((m): m is string => typeof m === "string" && m.length > 0)
                  .map((m) => escapeHtml(m))
                  .join(" · ");
                return `<div>${escapeHtml(what)}${bits ? ` <span class="ac-meta">${bits}</span>` : ""}</div>`;
              })
              .join("")
          : "<div>Queue empty — the world is caught up.</div>";
    }
    const ls = ledgerSummary(ledAct.applied, ledAct.compensated, ledAct.noted, ledAct.total, ledAct.overflow);
    setAc("ac-ledger-summary", ls.line);
    const s = rt.yt.lastStatus;
    const d = rt.yt.diag;
    const srcCheck = document.getElementById("src-yt") as HTMLInputElement | null;
    setAc(
      "ac-diag",
      `source: ${srcCheck?.checked ? "youtube" : "simulation"} · wire: ${s.status}${s.error ? ` (${s.error})` : ""}\n` +
        (s.diag
          ? `sidecar: seen ${s.diag.seen} · cmd ${s.diag.commands} · paid ${s.diag.paid} · ignored ${s.diag.ignored} · polls ${s.diag.polls} · apiErr ${s.diag.apiErrors}\n`
          : "sidecar: no data yet\n") +
        `browser: received ${d.received} · queued ${d.queued} · duplicate ${d.duplicate} · rejected ${d.rejected}\n` +
        `queue: ${rt.engine.queue.size}/${QUEUE.maxSize}${qs.full ? " FULL" : ""} · ledger: ${ledAct.total} entries${ledAct.overflow ? " OVERFLOW" : ""}\n` +
        `retention: results ≤${RETENTION.results} · story ≤${RETENTION.story} · feed ≤${RETENTION.feed} · deeds persist · ledger bounded`,
    );
  } catch {
    /* activity sync must never break panel rendering */
  }

  // UX-006 settings: stepper, recovery, source + persist mirrors. Readouts
  // only; the transport handlers above are untouched.
  try {
    const srcRadio = document.getElementById("src-yt") as HTMLInputElement | null;
    const settingsSource = srcRadio?.checked ? "youtube" : "simulation";
    const yts = rt.yt.lastStatus;
    const setSt = (id: string, v: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    const steps = connectionSteps({
      source: settingsSource,
      ytStatus: yts.status,
      authenticated: yts.authenticated ?? null,
    });
    const stepPairs = [
      ["authorize", "st-step-authorize"],
      ["connect", "st-step-connect"],
      ["verify", "st-step-verify"],
    ] as const;
    for (const [key, id] of stepPairs) {
      const state = steps[key];
      setSt(id, stepLabel(state));
      const li = document.getElementById(id)?.closest("li");
      if (li) li.setAttribute("data-state", state);
    }
    setSt("st-source-line", sourceLine(settingsSource));
    const rec = recoverySteps({
      source: settingsSource,
      ytStatus: yts.status,
      ytError: yts.error ?? null,
      outbound: yts.outbound ?? null,
    });
    const recSig = rec.join("\n");
    const recEl = document.getElementById("st-recovery");
    if (recEl instanceof HTMLElement && recSig !== lastRecoverySig) {
      lastRecoverySig = recSig;
      recEl.innerHTML = rec.map((line) => `<div>✦ ${escapeHtml(line)}</div>`).join("");
    }
    setSt("st-persist", persistStateLine(persistFrom).line);
  } catch {
    /* settings sync must never break panel rendering */
  }
}
