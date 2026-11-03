import { QUEUE } from "./config";
import type { CanonicalEvent } from "./types";

export type EnqueueOutcome = "queued" | "duplicate" | "rejected-invalid" | "dropped-full";

function isValid(ev: CanonicalEvent): boolean {
  if (!ev || typeof ev !== "object") return false;
  if (!ev.eventId || !ev.receivedAt) return false;
  if (ev.kind === "chat_command") {
    if (!ev.actorId || !ev.actorName) return false;
    return typeof ev.command === "string" && ev.command.length > 0 && ev.command.length <= 64;
  }
  if (ev.kind === "paid_event") {
    if (!ev.actorId || !ev.actorName) return false;
    return (
      Number.isFinite(ev.amount) && ev.amount > 0 && typeof ev.currency === "string" && !!ev.currency
    );
  }
  if (ev.kind === "paid_retraction") {
    // 5G-1 candidate: no actor, no amount — only the opaque reference.
    // Bound the ref so malformed platform payloads fail closed here too.
    return (
      typeof ev.refPlatformId === "string" &&
      ev.refPlatformId.length > 0 &&
      ev.refPlatformId.length <= 256
    );
  }
  return false;
}

/**
 * Small deterministic priority queue.
 * - paid events first (higher amount first), then chat commands and
 *   retraction candidates FIFO (retractions carry no amount, never priority)
 * - duplicate eventIds ignored, bounded size, invalid events rejected
 */
export class EventQueue {
  private paid: CanonicalEvent[] = [];
  private normal: CanonicalEvent[] = [];
  private seen = new Set<string>();

  get size(): number {
    return this.paid.length + this.normal.length;
  }

  peekAll(): CanonicalEvent[] {
    return [...this.paid, ...this.normal];
  }

  enqueue(ev: CanonicalEvent): EnqueueOutcome {
    if (!isValid(ev)) return "rejected-invalid";
    if (this.seen.has(ev.eventId)) return "duplicate";
    if (this.size >= QUEUE.maxSize) return "dropped-full";
    this.seen.add(ev.eventId);
    if (ev.kind === "paid_event") {
      // Keep paid lane sorted by amount desc for determinism.
      this.paid.push(ev);
      this.paid.sort((a, b) =>
        a.kind === "paid_event" && b.kind === "paid_event" ? b.amount - a.amount : 0,
      );
    } else {
      this.normal.push(ev);
    }
    return "queued";
  }

  dequeue(): CanonicalEvent | undefined {
    return this.paid.shift() ?? this.normal.shift();
  }

  clear(): void {
    this.paid = [];
    this.normal = [];
  }

  /** Restore dedup memory (e.g. after load so old ids stay ignored). */
  primeSeen(ids: string[]): void {
    for (const id of ids) this.seen.add(id);
  }
}
