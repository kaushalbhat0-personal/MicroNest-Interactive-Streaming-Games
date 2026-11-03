import type { LatentThreat, PaidLedgerEntry, TemplateRepeatState, WorldState } from "../engine/types";
import { defaultRepeatState, validateRepeatState } from "../engine/templates";
import { validatePaidLedger } from "../engine/ledger";

const LOCAL_KEY = "emberkeep.world.v1";
const FILE_URL = "/api/world";

/** Current save-format version. v2 adds the 5G-2 paidLedger (old saves default it). */
export const WORLD_SCHEMA_VERSION = 2;
const DEFAULT_RESOLVE = 50;
/** Attention shares the canonical 0..100 threat scale (cf. WorldState.threatLevel). */
const MAX_ATTENTION = 100;

const LOCATION_STATES: ReadonlySet<string> = new Set(["sound", "strained", "lost"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isLatentThreat(e: unknown): e is LatentThreat {
  if (!isRecord(e)) return false;
  return (
    typeof e.id === "string" &&
    e.id.length > 0 &&
    typeof e.attention === "number" &&
    Number.isFinite(e.attention) &&
    e.attention >= 0 &&
    e.attention <= MAX_ATTENTION
  );
}

/**
 * Persistence boundary. Prefers the local file server
 * (server/persist-server.mjs → data/world-state.json) so state survives
 * browser wipes and proves file-based restore; falls back to localStorage.
 */
export class WorldStore {
  async save(w: WorldState): Promise<"file" | "local"> {
    try {
      const res = await fetch(FILE_URL, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(w),
      });
      if (res.ok) return "file";
    } catch {
      /* server not running — fall through */
    }
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(w));
    } catch {
      /* storage unavailable */
    }
    return "local";
  }

  async load(): Promise<{ state: WorldState | null; from: "file" | "local" | "none" }> {
    try {
      const res = await fetch(FILE_URL, { cache: "no-store" });
      if (res.ok) {
        const state = normalizeWorld(await res.json());
        if (state) return { state, from: "file" };
      }
    } catch {
      /* ignore */
    }
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      if (raw) {
        const state = deserialize(raw);
        if (state) return { state, from: "local" };
      }
    } catch {
      /* ignore */
    }
    return { state: null, from: "none" };
  }

  exportFile(w: WorldState): void {
    const blob = new Blob([JSON.stringify(w, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "emberkeep-world.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}

/** Synchronous helpers for tests / node (file + string round-trips). */
export function serialize(w: WorldState): string {
  return JSON.stringify(w);
}

/**
 * Validate a parsed save and fill defaults for fields that old saves lack.
 * Missing new field -> default; present new field -> must be well-formed or
 * the whole save is rejected (existing invalid-save rule).
 * NOTE: no deeds cap is enforced here. Capping belongs to the deed-writing
 * slice (enforced on append); truncating on read would silently mutate saves.
 * Phase 5G-2: paidLedger defaults to [] (v1 saves stay loadable); a present
 * but malformed ledger rejects the save like any other corrupt new field.
 */
export function normalizeWorld(input: unknown): WorldState | null {
  if (!isRecord(input)) return null;
  if (input.worldId !== "emberkeep-prototype") return null;
  const w = input;

  const schemaVersion = w.schemaVersion === undefined ? WORLD_SCHEMA_VERSION : w.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isFinite(schemaVersion)) return null;

  const streamCount = w.streamCount === undefined ? 0 : w.streamCount;
  if (typeof streamCount !== "number" || !Number.isInteger(streamCount) || streamCount < 0) {
    return null;
  }

  const deeds = w.deeds === undefined ? [] : w.deeds;
  if (!Array.isArray(deeds) || !deeds.every((d) => typeof d === "string")) return null;

  const resolve = w.resolve === undefined ? DEFAULT_RESOLVE : w.resolve;
  if (typeof resolve !== "number" || !Number.isFinite(resolve) || resolve < 0) return null;

  const locationState = w.locationState === undefined ? {} : w.locationState;
  if (!isRecord(locationState)) return null;
  for (const v of Object.values(locationState)) {
    if (typeof v !== "string" || !LOCATION_STATES.has(v)) return null;
  }

  const latent = w.latent === undefined ? [] : w.latent;
  if (!Array.isArray(latent) || !latent.every(isLatentThreat)) return null;

  const repeatState = w.repeatState === undefined ? defaultRepeatState() : w.repeatState;
  if (!validateRepeatState(repeatState)) return null;

  const paidLedger = w.paidLedger === undefined ? [] : w.paidLedger;
  if (!validatePaidLedger(paidLedger)) return null;

  return {
    ...w,
    schemaVersion,
    streamCount,
    deeds: [...deeds],
    resolve,
    locationState: { ...locationState },
    latent: latent.map((e) => ({ ...(e as LatentThreat) })),
    repeatState: {
      onceFired: [...(repeatState as TemplateRepeatState).onceFired],
      chapterFired: (repeatState as TemplateRepeatState).chapterFired.map((e) => ({ ...e })),
      cooldownUntilStream: { ...(repeatState as TemplateRepeatState).cooldownUntilStream },
    },
    paidLedger: (paidLedger as PaidLedgerEntry[]).map((e) =>
      e.status === "retraction-noted"
        ? { ...e }
        : { ...e, appliedCheckpoint: { ...e.appliedCheckpoint } },
    ),
  } as WorldState;
}

export function deserialize(raw: string): WorldState | null {
  try {
    return normalizeWorld(JSON.parse(raw));
  } catch {
    return null;
  }
}
