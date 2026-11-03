import { QUEUE } from "./config";
import type { GameResult } from "./types";

export interface FeedEntry {
  text: string;
  count: number;
  action: GameResult["action"];
  at: number;
}

/**
 * Visually aggregate repeated actions within a short window so the game
 * stays readable when many viewers act at once. Engine results are still
 * processed individually — only the FEED merges them.
 */
export class FeedAggregator {
  private entries: FeedEntry[] = [];
  constructor(private readonly now: () => number = () => Date.now()) {}

  push(r: GameResult): FeedEntry[] {
    // Skip internal noise.
    if (r.action === "rejected" && r.actorName === "world") return this.entries;
    const t = this.now();
    const last = this.entries[0];
    if (
      last &&
      last.action === r.action &&
      t - last.at < QUEUE.batchWindowMs &&
      r.action !== "paid_story" &&
      r.action !== "paid_elite"
    ) {
      last.count += 1;
      last.at = t;
      last.text = FeedAggregator.render(r.action, last.count);
    } else {
      this.entries.unshift({ text: r.summary, count: 1, action: r.action, at: t });
    }
    this.entries = this.entries.slice(0, 12);
    return this.entries;
  }

  list(): FeedEntry[] {
    return this.entries;
  }

  private static render(action: GameResult["action"], count: number): string {
    switch (action) {
      case "attack":
        return `${count} viewers struck the Gloam!`;
      case "heal":
        return `${count} viewers mended the keeper's crew!`;
      case "search":
        return `${count} viewers scouted the Pale!`;
      case "shield":
        return `${count} viewers warded the beacon!`;
      case "ring":
        return `${count} viewers rang the drowned bell!`;
      case "hide":
        return `${count} viewers doused the lantern!`;
      case "tribute":
        return `${count} viewers offered tribute to the Gloam!`;
      case "defy":
        return `${count} viewers defied the Gloam!`;
      case "cooldown":
        return `${count} commands ignored (cooldown).`;
      default:
        return `${count}× ${action}`;
    }
  }
}
