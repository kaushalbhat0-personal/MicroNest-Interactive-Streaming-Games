import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthStateStore } from "../server/youtube/oauth-state-store.mjs";

const URL_SAFE = /^[A-Za-z0-9_-]+$/;
const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) {
    const d = dirs.pop() as string;
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "tb-state-"));
  dirs.push(d);
  return d;
}

function manualClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("oauth state store (T4F-C2.7-B)", () => {
  it("1. generates sufficiently random URL-safe state", async () => {
    const d = await freshDir();
    const s = new OAuthStateStore({ path: join(d, "state.json") });
    await s.init();
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) seen.add(await s.create());
    expect(seen.size).toBe(25);
    for (const v of seen) {
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(URL_SAFE.test(v)).toBe(true);
    }
  });

  it("2. valid state can be consumed once", async () => {
    const d = await freshDir();
    const s = new OAuthStateStore({ path: join(d, "state.json") });
    await s.init();
    const st = await s.create();
    expect(await s.consume(st)).toEqual({ ok: true });
  });

  it("3. second consumption is rejected", async () => {
    const d = await freshDir();
    const s = new OAuthStateStore({ path: join(d, "state.json") });
    await s.init();
    const st = await s.create();
    expect(await s.consume(st)).toEqual({ ok: true });
    const again = await s.consume(st);
    expect(again.ok).toBe(false);
    expect(again).toMatchObject({ reason: "already-consumed" });
  });

  it("4. missing state is rejected", async () => {
    const d = await freshDir();
    const s = new OAuthStateStore({ path: join(d, "state.json") });
    await s.init();
    const other = new OAuthStateStore({ path: join(d, "other.json") });
    await other.init();
    const st = await other.create();
    const out = await s.consume(st);
    expect(out.ok).toBe(false);
    expect(out).toMatchObject({ reason: "unknown-state" });
  });

  it("5. invalid state is rejected", async () => {
    const d = await freshDir();
    const s = new OAuthStateStore({ path: join(d, "state.json") });
    await s.init();
    for (const bad of ["", "   ", "not valid!!", null, undefined, 42, "short", "a".repeat(200)]) {
      const out = await s.consume(bad);
      expect(out.ok).toBe(false);
      expect(out).toMatchObject({ reason: "invalid-state" });
    }
  });

  it("6. expired state is rejected", async () => {
    const d = await freshDir();
    const clock = manualClock();
    const s = new OAuthStateStore({ path: join(d, "state.json"), ttlMs: 60_000, now: clock.now });
    await s.init();
    const st = await s.create();
    clock.advance(60_001);
    const out = await s.consume(st);
    expect(out).toMatchObject({ ok: false, reason: "expired-state" });
  });

  it("7. concurrent consumption allows exactly one success", async () => {
    const d = await freshDir();
    const s = new OAuthStateStore({ path: join(d, "state.json") });
    await s.init();
    const st = await s.create();
    const results = await Promise.all(Array.from({ length: 10 }, () => s.consume(st)));
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).length).toBe(9);
  });

  it("8. expired record cleanup works", async () => {
    const d = await freshDir();
    const clock = manualClock();
    const s = new OAuthStateStore({ path: join(d, "state.json"), ttlMs: 1000, now: clock.now });
    await s.init();
    await s.create();
    await s.create();
    expect(s.recordCount()).toBe(2);
    clock.advance(2000);
    expect(await s.cleanup()).toBe(0);
    expect(s.recordCount()).toBe(0);
  });

  it("9. restart/reload behavior is deterministic", async () => {
    const d = await freshDir();
    const p = join(d, "state.json");
    const clock = manualClock();
    const a = new OAuthStateStore({ path: p, now: clock.now });
    await a.init();
    const st = await a.create();
    // Simulate restart: new instance over the same file, same clock.
    const b = new OAuthStateStore({ path: p, now: clock.now });
    const loaded = await b.init();
    expect(loaded.restored).toBe(1);
    expect(await b.consume(st)).toEqual({ ok: true });
    // Consumed stays consumed across another reload.
    const c = new OAuthStateStore({ path: p, now: clock.now });
    await c.init();
    expect(await c.consume(st)).toMatchObject({ ok: false, reason: "already-consumed" });
  });

  it("10. corrupt state storage fails safely and recovers explicitly", async () => {
    const d = await freshDir();
    const p = join(d, "state.json");
    await writeFile(p, "not-json{{{", "utf8");
    const s = new OAuthStateStore({ path: p });
    const loaded = await s.init();
    expect(loaded.corrupt).toBe(true);
    expect(s.storageCorrupt).toBe(true);
    // Pre-restart states cannot validate: explicit rejection, operator retries.
    const fake = "x".repeat(43);
    expect(await s.consume(fake)).toMatchObject({ ok: false, reason: "unknown-state" });
    // Fresh creation overwrites the corrupt file with a valid store.
    const st = await s.create();
    expect(await s.consume(st)).toEqual({ ok: true });
    const raw = await readFile(p, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("error reasons never echo the state value", async () => {
    const d = await freshDir();
    const s = new OAuthStateStore({ path: join(d, "state.json") });
    await s.init();
    const st = await s.create();
    const out = await s.consume(st + "DIFFERENT");
    expect(JSON.stringify(out)).not.toContain(st);
  });
});
