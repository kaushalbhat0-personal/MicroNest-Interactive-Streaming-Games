/**
 * T4F-B — authority/renderer ownership boundary tests (mechanical).
 * Boundaries are enforced by file-text audits, not comments:
 * - exactly one authority creates GameEngine / YouTubeSource / the pump loop;
 * - renderer + shared modules never import authority-only modules
 *   (value imports; `import type` is erased and allowed);
 * - renderer code never calls simulation/mutation operations.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const APP_TS = readFileSync(join(ROOT, "src", "app.ts"), "utf8");
const MAIN_TS = readFileSync(join(ROOT, "src", "main.ts"), "utf8");
const SERVER_TS = readFileSync(join(ROOT, "server", "authority-server.ts"), "utf8");

function dashboardBundle(): string {
  return [APP_TS, MAIN_TS, ...listTs(join(ROOT, "src", "dashboard")).map((f) => readFileSync(f, "utf8"))].join("\n");
}

function listTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return listTs(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}

const RENDERER_FILES = listTs(join(ROOT, "src", "renderer"));
const SHARED_FILES = listTs(join(ROOT, "src", "shared"));
const READONLY_FILES = [...RENDERER_FILES, ...SHARED_FILES];

/** Authority-only modules: engine ownership, ingestion, mutation, secrets. */
const AUTHORITY_ONLY = [
  "engine/engine",
  "engine/queue",
  "youtube/client",
  "persistence/store",
  "runtime/progression",
  "authority/publisher",
  "authority/",
  "app",
];

/** Strip `import type …` statements (erased at compile; carry no runtime). */
function valueImportsOnly(source: string): string {
  const lines = source.split("\n");
  const kept: string[] = [];
  let inTypeImport = false;
  let depth = 0;
  for (const line of lines) {
    if (!inTypeImport && /^\s*import\s+type\b/.test(line)) {
      inTypeImport = true;
      depth = (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      if (depth <= 0 && line.includes("from")) inTypeImport = false;
      continue;
    }
    if (inTypeImport) {
      depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      if (depth <= 0 && line.includes("from")) inTypeImport = false;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/** Segment-aware authority matching (bare "app" must not match "apply-…"). */
function isAuthorityImport(mod: string): boolean {
  const segments = mod.split("/");
  for (const a of AUTHORITY_ONLY) {
    if (a === "app") {
      if (segments[segments.length - 1] === "app") return true;
      continue;
    }
    if (mod.includes(a)) return true;
  }
  return false;
}

function importedModules(source: string): string[] {
  const out: string[] = [];
  const re = /(?:import|export)[^"']*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  const sideEffect = /^\s*import\s*["']([^"']+)["']/gm;
  let s: RegExpExecArray | null;
  while ((s = sideEffect.exec(source)) !== null) out.push(s[1]);
  return out;
}

/** Strip block + line comments (audits cover code, not prose). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("T4F-B — authority uniqueness", () => {
  // T4F-C1 migration: the authority moved server-side. The dashboard
  // bundle (app + boot + dashboard modules) constructs NOTHING; the
  // server module constructs exactly one of each. Same strictness,
  // relocated ownership.
  it("no GameEngine construction anywhere in browser bundles", () => {
    expect(dashboardBundle().split("new GameEngine(").length - 1).toBe(0);
    for (const file of READONLY_FILES) {
      expect(readFileSync(file, "utf8").split("new GameEngine(").length - 1).toBe(0);
    }
  });

  it("exactly one GameEngine construction in the authority server", () => {
    expect(SERVER_TS.split("new GameEngine(").length - 1).toBe(1);
  });

  it("no YouTubeSource ingestion pipeline in browser bundles; one guarded ingest in the server", () => {
    expect(dashboardBundle().split("new YouTubeSource(").length - 1).toBe(0);
    // Single-subscription guard: startIngestion() no-ops while active.
    expect(SERVER_TS).toContain("if (ytReader) return;");
  });

  it("no pump/tick loop in browser bundles; exactly one in the server", () => {
    // The 250ms simulation pump (queue + tick); the dashboard keeps only
    // its 1s panel refresh and the renderers keep presentation sync.
    expect(dashboardBundle().split("engine.pump()").length - 1).toBe(0);
    expect(dashboardBundle()).not.toContain("engine.tick()");
    expect(SERVER_TS.split("engine.pump()").length - 1).toBe(1);
    expect(SERVER_TS).toContain("engine.tick()");
  });

  it("browser publisher removed; the server owns publication", () => {
    // T4F-C1: src/authority/publisher.ts is deleted (no browser page
    // publishes). The server publishes with the authority credential.
    expect(dashboardBundle()).not.toContain("createStatePublisher(");
    expect(SERVER_TS).toContain("/api/state/publish");
    expect(SERVER_TS).toContain("authorization");
  });

  it("ballot box, vote clock, and announcement sender live only in authority code", () => {
    const haystack = RENDERER_FILES.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");
    expect(haystack).not.toContain("castSessionVote");
    expect(haystack).not.toContain("openSessionVote");
    expect(haystack).not.toContain("closeSessionVote");
    expect(haystack).not.toContain("sendAnnouncement");
    expect(haystack).not.toContain("WorldStore");
  });
});

describe("T4F-B — renderer separation (import boundary)", () => {
  it("renderer + shared files exist on both sides of the boundary", () => {
    expect(RENDERER_FILES.length).toBeGreaterThan(0);
    expect(SHARED_FILES.length).toBeGreaterThan(0);
  });

  it("read-only bundles never value-import authority-only modules", () => {
    const violations: string[] = [];
    for (const file of READONLY_FILES) {
      const source = valueImportsOnly(readFileSync(file, "utf8"));
      for (const mod of importedModules(source)) {
        if (isAuthorityImport(mod)) {
          violations.push(`${file} imports ${mod}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("renderer code never constructs simulation/mutation objects", () => {
    const violations: string[] = [];
    for (const file of RENDERER_FILES) {
      const source = readFileSync(file, "utf8");
      for (const token of [
        "new GameEngine(",
        "new YouTubeSource(",
        "new EventQueue(",
        "new WorldStore(",
        "new FeedAggregator(",
        "new ViewerFeedStore(",
        "new BannerQueue(",
        ".ingestCommand(",
        ".ingestPaid(",
        ".ingest(",
        ".pump(",
        ".tick(",
        "store.save(",
        "retryAnnounce",
      ]) {
        if (source.includes(token)) violations.push(`${file} contains ${token}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("renderer code never POSTs to the authority publish endpoint", () => {
    for (const file of RENDERER_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("/api/state/publish");
    }
  });

  it("renderer entry owns one Phaser.Game and no simulation", () => {
    const entry = readFileSync(join(ROOT, "src", "overlay.ts"), "utf8");
    expect(entry).toContain("bootRenderer");
    expect(entry).not.toContain("createRuntime");
    const renderer = readFileSync(join(ROOT, "src", "renderer", "renderer.ts"), "utf8");
    expect(renderer.split("new Phaser.Game(").length - 1).toBe(1);
  });
});
