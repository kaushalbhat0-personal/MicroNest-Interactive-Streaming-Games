import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialRepository, CredentialStoreError } from "../server/youtube/credential-repository.mjs";

const KEY = Buffer.alloc(32, 0x3a);
const WRONG_KEY = Buffer.alloc(32, 0x7b);
const CANARY_ACCESS = "CANARY-ACCESS-9f8e7d6c5b4a";
const CANARY_REFRESH = "CANARY-REFRESH-1a2b3c4d5e6f";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) {
    const d = dirs.pop() as string;
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function freshDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "tb-creds-"));
  dirs.push(d);
  return d;
}

function creds(over: Record<string, unknown> = {}) {
  return {
    access_token: CANARY_ACCESS,
    refresh_token: CANARY_REFRESH,
    expires_at: Date.now() + 3600_000,
    scopes: ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.force-ssl"],
    obtainedAt: 1_700_000_000_000,
    ...over,
  };
}

describe("encrypted credential repository (T4F-C2.7-B)", () => {
  it("11. encryption round trip preserves valid credentials", async () => {
    const d = await freshDir();
    const repo = new CredentialRepository({ path: join(d, "creds.json"), key: KEY });
    const input = creds({ channel: { id: "UC-CANARY", handle: "@canary" } });
    await repo.save(input);
    const out = await repo.load();
    expect(out).toEqual(input);
    expect(await repo.hasCredentials()).toBe(true);
  });

  it("12. stored bytes do not contain plaintext canary tokens", async () => {
    const d = await freshDir();
    const p = join(d, "creds.json");
    const repo = new CredentialRepository({ path: p, key: KEY });
    await repo.save(creds());
    const raw = await readFile(p, "utf8");
    expect(raw).not.toContain(CANARY_ACCESS);
    expect(raw).not.toContain(CANARY_REFRESH);
    const env = JSON.parse(raw);
    expect(env.v).toBe(1);
    expect(env.alg).toBe("aes-256-gcm");
    expect(typeof env.iv).toBe("string");
    expect(typeof env.tag).toBe("string");
    expect(typeof env.data).toBe("string");
  });

  it("rejects missing, malformed and wrong-sized keys", async () => {
    const d = await freshDir();
    const p = join(d, "creds.json");
    for (const bad of [undefined, null, "", "short", Buffer.alloc(16, 1), Buffer.alloc(64, 1), "zzzz-not-base64-!!!"]) {
      expect(() => new CredentialRepository({ path: p, key: bad })).toThrowError(CredentialStoreError);
    }
    // Hex and base64 spellings of a 32-byte key are accepted.
    const hex = Buffer.alloc(32, 9).toString("hex");
    const b64 = Buffer.alloc(32, 9).toString("base64");
    expect(() => new CredentialRepository({ path: p, key: hex })).not.toThrow();
    expect(() => new CredentialRepository({ path: p, key: b64 })).not.toThrow();
  });

  it("13. wrong key fails closed and preserves the file", async () => {
    const d = await freshDir();
    const p = join(d, "creds.json");
    await new CredentialRepository({ path: p, key: KEY }).save(creds());
    const before = await readFile(p, "utf8");
    const wrong = new CredentialRepository({ path: p, key: WRONG_KEY });
    const err = await wrong.load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialStoreError);
    expect((err as CredentialStoreError).code).toBe("auth-failed");
    expect(await readFile(p, "utf8")).toBe(before);
    await expect(wrong.hasCredentials()).rejects.toMatchObject({ code: "auth-failed" });
  });

  it("14. tampered ciphertext fails authentication", async () => {
    const d = await freshDir();
    const p = join(d, "creds.json");
    const repo = new CredentialRepository({ path: p, key: KEY });
    await repo.save(creds());
    const env = JSON.parse(await readFile(p, "utf8"));
    const data = Buffer.from(env.data, "base64");
    data[0] ^= 0xff;
    env.data = data.toString("base64");
    await writeFile(p, JSON.stringify(env), "utf8");
    await expect(repo.load()).rejects.toMatchObject({ code: "auth-failed" });
  });

  it("15. tampered authentication tag fails", async () => {
    const d = await freshDir();
    const p = join(d, "creds.json");
    const repo = new CredentialRepository({ path: p, key: KEY });
    await repo.save(creds());
    const env = JSON.parse(await readFile(p, "utf8"));
    const tag = Buffer.from(env.tag, "base64");
    tag[tag.length - 1] ^= 0x01;
    env.tag = tag.toString("base64");
    await writeFile(p, JSON.stringify(env), "utf8");
    await expect(repo.load()).rejects.toMatchObject({ code: "auth-failed" });
  });

  it("16. unsupported envelope version/algorithm fail closed", async () => {
    const d = await freshDir();
    const p = join(d, "creds.json");
    const repo = new CredentialRepository({ path: p, key: KEY });
    await repo.save(creds());
    const env = JSON.parse(await readFile(p, "utf8"));
    await writeFile(p, JSON.stringify({ ...env, v: 999 }), "utf8");
    await expect(repo.load()).rejects.toMatchObject({ code: "unsupported-version" });
    await writeFile(p, JSON.stringify({ ...env, alg: "aes-256-cbc" }), "utf8");
    await expect(repo.load()).rejects.toMatchObject({ code: "unsupported-algorithm" });
  });

  it("17. invalid credential data is rejected before persistence", async () => {
    const d = await freshDir();
    const p = join(d, "creds.json");
    const repo = new CredentialRepository({ path: p, key: KEY });
    const badInputs: unknown[] = [
      null,
      {},
      { access_token: "" },
      { access_token: 42 },
      { access_token: "x", refresh_token: 42 },
      { access_token: "x", expires_at: Number.NaN },
      { access_token: "x", scopes: "not-an-array" },
      { access_token: "x", channel: { noId: true } },
    ];
    for (const bad of badInputs) {
      await expect(repo.save(bad)).rejects.toMatchObject({ code: "invalid-credentials" });
    }
    // No file was created by any rejected save.
    await expect(repo.load()).resolves.toBeNull();
  });

  it("18. missing file is distinct from corrupt file", async () => {
    const d = await freshDir();
    const repo = new CredentialRepository({ path: join(d, "absent.json"), key: KEY });
    expect(await repo.load()).toBeNull();
    expect(await repo.hasCredentials()).toBe(false);
    const p2 = join(d, "corrupt.json");
    await writeFile(p2, "{not json", "utf8");
    const bad = new CredentialRepository({ path: p2, key: KEY });
    await expect(bad.load()).rejects.toMatchObject({ code: "corrupt-storage" });
  });

  it("19. atomic write produces a valid final file with no temp residue", async () => {
    const d = await freshDir();
    const repo = new CredentialRepository({ path: join(d, "creds.json"), key: KEY });
    const input = creds();
    await repo.save(input);
    expect(await repo.load()).toEqual(input);
    const names = await readdir(d);
    expect(names.filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("20. failed save does not destroy an existing valid file", async () => {
    const d = await freshDir();
    const repo = new CredentialRepository({ path: join(d, "creds.json"), key: KEY });
    const good = creds();
    await repo.save(good);
    await expect(repo.save({ access_token: "" })).rejects.toMatchObject({ code: "invalid-credentials" });
    expect(await repo.load()).toEqual(good);
  });

  it("21. clear() removes stored credentials safely", async () => {
    const d = await freshDir();
    const repo = new CredentialRepository({ path: join(d, "creds.json"), key: KEY });
    await repo.save(creds());
    expect(await repo.hasCredentials()).toBe(true);
    expect(await repo.clear()).toEqual({ ok: true });
    expect(await repo.load()).toBeNull();
    expect(await repo.hasCredentials()).toBe(false);
    // Idempotent: clearing an absent file still succeeds.
    expect(await repo.clear()).toEqual({ ok: true });
  });

  it("22. concurrent in-process saves never corrupt the file", async () => {
    const d = await freshDir();
    const repo = new CredentialRepository({ path: join(d, "creds.json"), key: KEY });
    const variants = Array.from({ length: 10 }, (_, i) => creds({ access_token: `${CANARY_ACCESS}-${i}` }));
    await Promise.all(variants.map((v) => repo.save(v)));
    const out = await repo.load();
    expect(variants.map((v) => v.access_token)).toContain(out?.access_token);
    const raw = await readFile(join(d, "creds.json"), "utf8");
    expect(raw).not.toContain(CANARY_REFRESH);
  });

  it("load returns copies, not mutable internal references", async () => {
    const d = await freshDir();
    const repo = new CredentialRepository({ path: join(d, "creds.json"), key: KEY });
    await repo.save(creds());
    const a = await repo.load();
    expect(a).not.toBeNull();
    (a as Record<string, unknown>).access_token = "MUTATED";
    expect((await repo.load())?.access_token).toBe(CANARY_ACCESS);
  });
});
