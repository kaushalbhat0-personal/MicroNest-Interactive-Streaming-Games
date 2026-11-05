import Phaser from "phaser";
import { renderPanelState, wirePanel } from "./app";
import { initShell } from "./dashboard/shell";
import { GameScene } from "./phaser/GameScene";
import { clearStoredToken, getStoredToken, ServerRuntime, setStoredToken } from "./dashboard/server-runtime";
import { applySnapshotToScene } from "./renderer/apply-snapshot";
import { connectRendererTransport } from "./renderer/transport-client";
import { resolveStateTransportUrls } from "./renderer/state-transport-urls";
import type { SnapshotV1 } from "./shared/snapshot";
import "./presentation/tidebound.css";

// T4F-C1 dashboard entry: control client + snapshot-subscribed preview.
// No engine, no queue, no YouTubeSource, no simulation loop is constructed
// here (boundary tests enforce it). The single Phaser.Game is the console
// preview, driven read-only by authoritative snapshots like the renderers.

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "game",
  width: 1920,
  height: 1080,
  transparent: false,
  backgroundColor: "#1a1033",
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.NO_CENTER },
  scene: [GameScene],
});

try {
  (window as unknown as { __tbGame?: Phaser.Game }).__tbGame = game;
} catch {
  /* non-browser test env */
}

function getScene(): GameScene | null {
  try {
    const s = game.scene.getScene("game") as GameScene | null | undefined;
    if (!s) return null;
    return s.scene && s.scene.isActive() ? s : null;
  } catch {
    return null;
  }
}

const runtime = new ServerRuntime();
runtime.attachScene(getScene);

function setText(id: string, text: string): void {
  try {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  } catch {
    /* status sync must never break boot */
  }
}

function refreshPanel(): void {
  if (!runtime.hasData) return;
  try {
    renderPanelState(runtime);
  } catch {
    /* panel render must never break the poll loop */
  }
}

async function syncDualBlock(): Promise<void> {
  try {
    const res = await fetch("/api/state/status", { headers: { accept: "application/json" } });
    if (!res.ok) {
      setText("st-dual-transport", "State transport: unreachable — start it with: npm run state-server");
      return;
    }
    const data = (await res.json().catch(() => null)) as {
      seq?: unknown;
      worldRev?: unknown;
      subscribers?: { total?: unknown; byFormat?: Record<string, unknown> };
    } | null;
    const by = data?.subscribers?.byFormat ?? {};
    const num = (k: string): number | null => (typeof by[k] === "number" ? (by[k] as number) : null);
    const total = typeof data?.subscribers?.total === "number" ? data.subscribers.total : null;
    const wr = typeof data?.worldRev === "number" ? data.worldRev : runtime.worldRev;
    setText(
      "st-dual-rev",
      `Authoritative revision: worldRev ${wr}${typeof data?.seq === "number" ? ` · seq ${data.seq}` : ""} (server-owned; this console holds no game)`,
    );
    const l = num("landscape");
    const p = num("portrait");
    setText("st-dual-landscape", `Landscape renderer (1920×1080): ${l === null ? "no subscription seen yet" : l === 0 ? "no subscription (open the URL in OBS or a tab)" : `${l} subscription(s)`}`);
    setText("st-dual-portrait", `Portrait renderer (1080×1920): ${p === null ? "no subscription seen yet" : p === 0 ? "no subscription (open the URL in OBS or a tab)" : `${p} subscription(s)`}`);
    setText(
      "st-dual-transport",
      `State transport: ${total === null ? "reachable — renderer subscriptions unknown" : `reachable · ${total} renderer subscription(s)`}`,
    );
  } catch {
    setText("st-dual-transport", "State transport: unreachable — start it with: npm run state-server");
  }
}

async function syncAuthorityBlock(): Promise<void> {
  const pub = await runtime.fetchAuthorityStatus();
  if (!pub) {
    setText("st-auth-lifecycle", "Authority: unreachable — start it with: npm run authority-server");
    return;
  }
  const lc = typeof pub.lifecycle === "string" ? pub.lifecycle : "unknown";
  const rec = typeof pub.recoveredFrom === "string" ? pub.recoveredFrom : "none";
  setText(
    "st-auth-lifecycle",
    `Authority: ${lc} · session ${typeof pub.sessionId === "string" ? pub.sessionId : "?"} · restored from ${rec} · dashboard refresh never resets the game`,
  );
  if (!getStoredToken()) {
    setText("st-auth-status", "No authority token set — paste the token (server console, first boot) and press Save. Control actions stay disabled until the authority accepts it.");
  } else {
    const ok = await runtime.refresh();
    setText(
      "st-auth-status",
      ok
        ? `Token accepted · control channel live (worldRev ${runtime.worldRev})`
        : "Token not accepted yet — check the value and press Save (the authority answers 401 for unknown tokens).",
    );
  }
}

function wireAuthCard(): void {
  try {
    const save = document.getElementById("st-auth-save");
    if (save instanceof HTMLButtonElement) {
      save.onclick = () => {
        const input = document.getElementById("st-auth-token");
        if (input instanceof HTMLInputElement) {
          setStoredToken(input.value);
          try {
            input.value = "";
          } catch {
            /* clearing is best-effort */
          }
          void syncAuthorityBlock();
        }
      };
    }
    const forget = document.getElementById("st-auth-forget");
    if (forget instanceof HTMLButtonElement) {
      forget.onclick = () => {
        clearStoredToken();
        try {
          const input = document.getElementById("st-auth-token");
          if (input instanceof HTMLInputElement) input.value = "";
        } catch {
          /* clearing is best-effort */
        }
        setText("st-auth-status", "Token forgotten on this browser — paste it again to resume control. The server credential is unchanged.");
      };
    }
    const rotate = document.getElementById("st-auth-rotate");
    if (rotate instanceof HTMLButtonElement) {
      rotate.onclick = () => {
        void (async () => {
          const out = await runtime.rotateToken();
          setText(
            "st-auth-status",
            out === "token-rotated"
              ? "Token rotated — this pairing is cleared. Read the new value from data/authority-token.json and Save it to resume control."
              : `Rotation failed: ${out}`,
          );
          await syncAuthorityBlock();
        })();
      };
    }
  } catch {
    /* auth card wiring must never break boot */
  }
}

// Preview subscription: the console canvas follows snapshots read-only,
// exactly like a renderer (same applier, bounded animation replays).
const previewSeen = new Set<string>();
function onPreviewSnapshot(snap: SnapshotV1): void {
  applySnapshotToScene(getScene(), snap, previewSeen);
}

let wired = false;
async function bootTick(): Promise<void> {
  await syncAuthorityBlock();
  if (!getStoredToken()) return;
  const ok = await runtime.refresh();
  if (!ok) return;
  if (!wired) {
    wired = true;
    wirePanel(runtime, refreshPanel);
    connectRendererTransport({ onSnapshot: onPreviewSnapshot, onState: () => undefined }, { format: "landscape", ...resolveStateTransportUrls() });
    setInterval(refreshPanel, 1000);
    setInterval(() => void syncDualBlock(), 2000);
    refreshPanel();
  }
  refreshPanel();
}

wireAuthCard();
// D2.2: hash navigation must work before any token exists — the Settings
// section holds the token input itself, so gating initShell() on a stored
// token dead-ends first-run operators on Overview. initShell() is idempotent
// (wirePanel calls it again after auth); it only shows/hides static sections
// and never performs control actions, so bearer gating is unchanged.
initShell();
void bootTick();
setInterval(() => void bootTick(), 1000);
game.events.once("ready", refreshPanel);
setTimeout(refreshPanel, 800);
setTimeout(refreshPanel, 2000);
