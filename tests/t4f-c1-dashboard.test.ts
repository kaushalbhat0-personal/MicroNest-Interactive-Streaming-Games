/**
 * T4F-C1 — dashboard migration audits (static).
 * The dashboard is a server-backed control client: it constructs no
 * simulation, fetches only through the token-gated control API, never
 * fabricates control outcomes, and keeps the auth/lifecycle surfaces.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const APP_TS = readFileSync(join(ROOT, "src", "app.ts"), "utf8");
const MAIN_TS = readFileSync(join(ROOT, "src", "main.ts"), "utf8");
const CLIENT_TS = readFileSync(join(ROOT, "src", "dashboard", "server-runtime.ts"), "utf8");
const INDEX_HTML = readFileSync(join(ROOT, "index.html"), "utf8");

function countId(html: string, id: string): number {
  return html.split(`id="${id}"`).length - 1;
}

describe("T4F-C1 — dashboard constructs no simulation", () => {
  it("no engine/queue/ingestion construction in any browser entry", () => {
    for (const [name, src] of [["app.ts", APP_TS], ["main.ts", MAIN_TS], ["server-runtime.ts", CLIENT_TS]] as const) {
      for (const token of ["new GameEngine(", "new EventQueue(", "new YouTubeSource(", ".pump(", ".tick(", "createStatePublisher("]) {
        expect(src, `${name} must not contain ${token}`).not.toContain(token);
      }
    }
  });

  it("app.ts performs no network calls (all control HTTP lives in the client module)", () => {
    expect(APP_TS).not.toMatch(/[^a-zA-Z]fetch\(/);
    expect(CLIENT_TS).toContain("fetch(");
  });

  it("boot owns the single preview game and the snapshot-following preview", () => {
    expect(MAIN_TS.split("= new Phaser.Game(").length - 1).toBe(1);
    expect(MAIN_TS).toContain("ServerRuntime");
    expect(MAIN_TS).toContain("connectRendererTransport");
    expect(MAIN_TS).toContain("applySnapshotToScene");
    expect(MAIN_TS).toContain("wirePanel");
  });
});

describe("T4F-C1 — control outcomes are server-confirmed, never fabricated", () => {
  it("client returns server outcomes or explicit failure strings", () => {
    expect(CLIENT_TS).toContain("authority-unreachable");
    expect(CLIENT_TS).toContain("unauthorized");
    // Outcome vocabulary is received from the server, never invented here.
    for (const invented of ["opened-route-vote", "closed-vote:fired", "rite-fired", "override:"]) {
      expect(CLIENT_TS).not.toContain(invented);
    }
  });

  it("every mutation posts to the token-gated control API", () => {
    for (const route of [
      "/api/authority/command",
      "/api/authority/paid",
      "/api/authority/vote/open",
      "/api/authority/vote/close",
      "/api/authority/vote/override",
      "/api/authority/vote/retry",
      "/api/authority/rite",
      "/api/authority/pause",
      "/api/authority/resume",
      "/api/authority/save",
      "/api/authority/reload",
      "/api/authority/reset",
      "/api/authority/end-stream",
      "/api/authority/source",
      "/api/authority/token/rotate",
    ]) {
      expect(CLIENT_TS).toContain(route);
    }
    expect(CLIENT_TS).toContain("authorization");
  });

  it("panel control methods are async (outcomes awaited, never flashed early)", () => {
    expect(APP_TS).toContain("sendCommand: (actorId: string, actorName: string, command: string) => Promise<string>;");
    expect(APP_TS).toContain("openRouteVote: () => Promise<string>;");
    expect(APP_TS).toContain("await rt.sendCommand(id, name, cmd)");
  });
});

describe("T4F-C1 — authority connection surface", () => {
  it("auth card nodes exist exactly once; token field is a password input", () => {
    for (const id of ["st-auth-h", "st-auth-token", "st-auth-save", "st-auth-forget", "st-auth-rotate", "st-auth-status", "st-auth-lifecycle"]) {
      expect(countId(INDEX_HTML, id)).toBe(1);
    }
    expect(INDEX_HTML).toContain('id="st-auth-token" type="password"');
  });

  it("auth copy states the trust model honestly", () => {
    const card = INDEX_HTML.slice(INDEX_HTML.indexOf('id="st-auth-h"'), INDEX_HTML.indexOf('id="st-source-h"'));
    expect(card).toContain("holds no simulation");
    expect(card).toContain("never resets the game");
    expect(card).toContain("Renderer pages never receive it");
  });
});
