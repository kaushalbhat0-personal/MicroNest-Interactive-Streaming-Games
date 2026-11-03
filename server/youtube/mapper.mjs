// Pure mapping: YouTube liveChatMessage JSON -> canonical Emberkeep events.
// No network, no secrets, no gameplay knowledge. The adapter NEVER decides
// what a command does or what an amount means — it only translates shapes.
//
// YouTube reference shapes (Data API v3, liveChatMessage resource):
//   id: stable per-message id (NOTE: giftEvent ids may be reused for combos)
//   snippet.type: textMessageEvent | superChatEvent | superStickerEvent | ...
//   snippet.textMessageDetails.messageText
//   snippet.superChatDetails/superStickerDetails: { amountMicros, currency, ... }
//   snippet.publishedAt, snippet.authorChannelId
//   authorDetails: { channelId, displayName }

export const YT_SOURCE = "youtube";

/** ISO 4217 currencies with zero minor digits. Everything else assumes 2. */
const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
  "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
]);

/** amountMicros (string|number, micros of purchase currency) -> minor units. */
export function microsToMinor(amountMicros, currency) {
  const micros = typeof amountMicros === "string" ? Number(amountMicros) : amountMicros;
  if (!Number.isFinite(micros) || micros <= 0) return 0;
  if (ZERO_DECIMAL.has(String(currency).toUpperCase())) return Math.round(micros / 1e6);
  return Math.round(micros / 1e4);
}

/**
 * Map one raw YouTube message to a canonical event candidate.
 * Returns { outcome, event?, reason? } where outcome is:
 *   "command"    — text starting with "!" (engine re-validates the whitelist)
 *   "paid"       — superChat / superSticker purchase
 *   "retraction" — messageDeletedEvent / messageRetractedEvent signal.
 *                  A CANDIDATE only: it references a platform message id but
 *                  never claims that message was paid (the ledger decides).
 *   "ignored"    — anything else (ordinary chat, memberships, polls,
 *                  tombstones without a usable reference, malformed)
 */
export function mapYouTubeMessage(msg, nowIso) {
  const receivedAt = nowIso ?? new Date().toISOString();
  if (!msg || typeof msg !== "object") return { outcome: "ignored", reason: "malformed" };
  const platformEventId = typeof msg.id === "string" && msg.id ? msg.id : null;
  if (!platformEventId) return { outcome: "ignored", reason: "missing-id" };
  const snippet = msg.snippet && typeof msg.snippet === "object" ? msg.snippet : null;
  if (!snippet || typeof snippet.type !== "string") return { outcome: "ignored", reason: "malformed" };

  const author = msg.authorDetails && typeof msg.authorDetails === "object" ? msg.authorDetails : {};
  const actorId =
    (typeof snippet.authorChannelId === "string" && snippet.authorChannelId) ||
    (typeof author.channelId === "string" && author.channelId) ||
    "unknown";
  const actorName =
    (typeof author.displayName === "string" && author.displayName) || "youtube-viewer";
  const publishedAt =
    typeof snippet.publishedAt === "string" && snippet.publishedAt ? snippet.publishedAt : receivedAt;
  const eventId = `yt:${platformEventId}`;

  if (snippet.type === "textMessageEvent") {
    const details = snippet.textMessageDetails;
    const text =
      details && typeof details.messageText === "string" ? details.messageText : "";
    const token = text.trim().split(/\s+/)[0] ?? "";
    if (!token.startsWith("!") || token.length < 2) {
      return { outcome: "ignored", reason: "not-a-command" };
    }
    return {
      outcome: "command",
      event: {
        kind: "chat_command",
        eventId,
        actorId: `yt:${actorId}`,
        actorName,
        command: token.toLowerCase().slice(0, 64),
        receivedAt: publishedAt,
        source: YT_SOURCE,
        platformEventId,
      },
    };
  }

  if (snippet.type === "superChatEvent" || snippet.type === "fanFundingEvent") {
    const d = snippet.superChatDetails ?? snippet.fanFundingEventDetails;
    return mapPaid(eventId, actorId, actorName, publishedAt, platformEventId, d, "super-chat");
  }

  if (snippet.type === "superStickerEvent") {
    return mapPaid(
      eventId, actorId, actorName, publishedAt, platformEventId,
      snippet.superStickerDetails, "super-sticker",
    );
  }

  // Phase 5G-1 — retraction candidates. The mapper does NOT know (and does
  // not check) whether the referenced message was paid; the later ledger
  // decides that. No amount, payer, text, tier, or effect is inferred here.
  if (snippet.type === "messageRetractedEvent") {
    const d = snippet.messageRetractedDetails;
    const ref = d && typeof d === "object" ? d.retractedMessageId : null;
    return mapRetraction(platformEventId, publishedAt, ref, "retracted");
  }

  if (snippet.type === "messageDeletedEvent") {
    const d = snippet.messageDeletedDetails;
    const ref = d && typeof d === "object" ? d.deletedMessageId : null;
    return mapRetraction(platformEventId, publishedAt, ref, "deleted");
  }

  // Memberships, milestones, polls, gifts: no amount, no command.
  // Tombstones: no usable referenced message id by contract (only liveChatId,
  // type, publishedAt) — so they can never fabricate a retraction reference.
  return { outcome: "ignored", reason: `unsupported-type:${snippet.type}` };
}

/**
 * Build a canonical paid_retraction candidate for one platform deletion /
 * retraction signal. Fail closed: a missing or malformed reference id is
 * an ignored diagnostic, never a fabricated reference.
 */
function mapRetraction(platformEventId, publishedAt, ref, reason) {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 256) {
    return { outcome: "ignored", reason: `malformed-${reason}-ref` };
  }
  return {
    outcome: "retraction",
    event: {
      kind: "paid_retraction",
      // Namespaced + prefixed so a retraction id can never collide with the
      // original paid event id (`yt:<ref>`).
      eventId: `yt:retraction:${ref}`,
      refPlatformId: ref,
      platformEventId,
      source: YT_SOURCE,
      receivedAt: publishedAt,
    },
  };
}

function mapPaid(eventId, actorId, actorName, publishedAt, platformEventId, d, reason) {
  if (!d || typeof d !== "object") return { outcome: "ignored", reason: `malformed-${reason}` };
  const currency = typeof d.currency === "string" && d.currency ? d.currency.toUpperCase() : "";
  const amount = microsToMinor(d.amountMicros, currency);
  if (!currency || amount <= 0) return { outcome: "ignored", reason: `malformed-${reason}` };
  return {
    outcome: "paid",
    event: {
      kind: "paid_event",
      eventId,
      actorId: `yt:${actorId}`,
      actorName,
      amount,
      currency,
      receivedAt: publishedAt,
      source: YT_SOURCE,
      platformEventId,
    },
  };
}
