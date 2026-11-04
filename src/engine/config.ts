// Creator-configured mappings. The engine NEVER interprets arbitrary chat:
// only keys of COMMANDS can cause gameplay actions. A creator dashboard
// would edit this object; the engine code stays untouched.

export interface CommandMapping {
  /** What it does, in creator-facing language. */
  does: string;
  /** Per-viewer cooldown. */
  cooldownMs: number;
}

export const COMMANDS: Record<string, CommandMapping> = {
  "!strike": { does: "Strike the Gloam vessel threatening the light", cooldownMs: 3000 },
  "!mend": { does: "Mend the keeper's crew", cooldownMs: 5000 },
  "!scout": { does: "Scout the Pale beyond the light", cooldownMs: 10000 },
  "!shield": { does: "Raise a ward over the beacon", cooldownMs: 8000 },
  "!ring": { does: "Sound the drowned bell (stirs the Gloam, may reveal clues)", cooldownMs: 8000 },
  "!hide": { does: "Douse the lantern to lower danger at a resolve cost", cooldownMs: 8000 },
  "!tribute": { does: "Spend supplies to honor the faced faction", cooldownMs: 10000 },
  "!defy": { does: "Provoke the faced faction and raise danger", cooldownMs: 5000 },
  "!votea": { does: "Reserved for audience votes (opened by the assembly's call)", cooldownMs: 5000 },
  "!voteb": { does: "Reserved for audience votes (opened by the assembly's call)", cooldownMs: 5000 },
  "!votec": { does: "Reserved for audience votes (opened by the assembly's call)", cooldownMs: 5000 },
  "!help": { does: "Show available commands", cooldownMs: 2000 },
};

export interface PaidTier {
  /** Minimum amount in MINOR units for this currency. */
  minMinor: number;
  key: "paid_strike" | "paid_supply" | "paid_elite" | "paid_story";
  does: string;
}

/**
 * Currency-aware thresholds. Prototype values are configured for INR;
 * other currencies fall back to the DEFAULT table. Amounts are compared
 * in major units (e.g. rupees / dollars) so tiers stay readable.
 */
export const PAID_TIERS: Record<string, PaidTier[]> = {
  DEFAULT: [
    { minMinor: 100000, key: "paid_story", does: "The Bell Tolls (major situation)" },
    { minMinor: 50000, key: "paid_elite", does: "Herald's Attention (named elite arrives)" },
    { minMinor: 10000, key: "paid_supply", does: "Supply Convoy (resources and repairs)" },
    { minMinor: 5000, key: "paid_strike", does: "Gale Call (storm-surge strike)" },
  ],
};

// INR prototype thresholds: ₹50 / ₹100 / ₹500 / ₹1000 (in paise).
PAID_TIERS["INR"] = PAID_TIERS["DEFAULT"];

export const QUEUE = {
  maxSize: 100,
  /** Max events processed per pump tick. */
  maxPerTick: 4,
  /** Feed batching window: same-action results merge visually. */
  batchWindowMs: 1500,
  /** Global anti-spam: min gap between processed events. */
  minGapMs: 100,
} as const;

export const SIM = {
  attackDamage: 7,
  eliteAttackDamage: 7,
  paidStrikeDamage: 15,
  healAmount: 12,
  searchProgressPerSearch: 20,
  uniqueSearchersForSecret: 5,
  shieldDurationMs: 12000,
  shieldBlockFraction: 0.75,
  enemyAttackIntervalMs: 4000,
  enemyDamage: 6,
  eliteEnemyDamage: 10,
  keepShareOfEnemyDamage: 0.5,
  threatDecayPerTick: 1,
  chaptersPerArc: 3,
} as const;

export function tiersFor(currency: string): PaidTier[] {
  return PAID_TIERS[currency] ?? PAID_TIERS["DEFAULT"];
}

/** Convert minor units to major for tier comparison. */
export function toMajor(minor: number): number {
  return minor / 100;
}

/**
 * ISO 4217 currencies with zero minor digits. Tier thresholds are denominated
 * in 2-decimal-equivalent minor units, so zero-decimal amounts are scaled ×100
 * before comparison. INR (and all 2-decimal currencies) are unaffected.
 */
export const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
  "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
]);

export function toTierUnits(amountMinor: number, currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())) return amountMinor * 100;
  return amountMinor;
}

/** Display label that preserves the actual currency (₹ kept for INR). */
export function formatPaidLabel(amountMinor: number, currency: string): string {
  const code = currency.toUpperCase();
  if (code === "INR") return `₹${toMajor(amountMinor)} ${code}`;
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return `${amountMinor} ${code}`;
  return `${toMajor(amountMinor)} ${code}`;
}
