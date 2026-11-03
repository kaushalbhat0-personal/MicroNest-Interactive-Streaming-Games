// Types for mapper.mjs (pure YouTube -> canonical mapping).
export const YT_SOURCE: string;

export interface MappedCommand {
  outcome: "command";
  event: {
    kind: "chat_command";
    eventId: string;
    actorId: string;
    actorName: string;
    command: string;
    receivedAt: string;
    source: string;
    platformEventId: string;
  };
}

export interface MappedPaid {
  outcome: "paid";
  event: {
    kind: "paid_event";
    eventId: string;
    actorId: string;
    actorName: string;
    amount: number;
    currency: string;
    receivedAt: string;
    source: string;
    platformEventId: string;
  };
}

export interface MappedRetraction {
  outcome: "retraction";
  event: {
    kind: "paid_retraction";
    eventId: string;
    refPlatformId: string;
    platformEventId: string;
    source: string;
    receivedAt: string;
  };
}

export interface MappedIgnored {
  outcome: "ignored";
  reason: string;
  event?: undefined;
}

export type MappedMessage = MappedCommand | MappedPaid | MappedRetraction | MappedIgnored;

export function microsToMinor(amountMicros: string | number, currency: string): number;
export function mapYouTubeMessage(msg: unknown, nowIso?: string): MappedMessage;
