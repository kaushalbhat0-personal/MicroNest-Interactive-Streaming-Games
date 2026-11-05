// Types for server/persistence/world-store.mjs (server-only).
import type { WorldState } from "../../src/engine/types";
export type WorldLoadResult =
  | { status: "ok"; world: WorldState; revision: number }
  | { status: "no-save" }
  | { status: "unavailable"; error: string }
  | { status: "corrupt"; error: string };
export interface DbClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number }>;
}
export declare class DbWorldStore {
  constructor(opts: { db: DbClient; normalizeWorld: (input: unknown) => WorldState | null; serialize: (w: WorldState) => string });
  load(): Promise<WorldLoadResult>;
  save(world: WorldState): Promise<{ ok: true; revision: number } | { ok: false; reason: string; detail?: string }>;
}
