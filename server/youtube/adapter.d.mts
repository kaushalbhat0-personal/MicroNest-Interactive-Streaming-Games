// Types for adapter.mjs (local YouTube live-chat adapter).
export const STATUS: {
  DISCONNECTED: "DISCONNECTED";
  CONNECTING: "CONNECTING";
  AUTH_REQUIRED: "AUTH_REQUIRED";
  CONNECTED: "CONNECTED";
  LIVE_CHAT_FOUND: "LIVE_CHAT_FOUND";
  STREAMING: "STREAMING";
  RECONNECTING: "RECONNECTING";
  STREAM_ENDED: "STREAM_ENDED";
  ERROR: "ERROR";
};

export interface AdapterDiag {
  seen: number;
  commands: number;
  paid: number;
  retractions: number;
  ignored: number;
  polls: number;
  apiErrors: number;
}

export interface AdapterState {
  status: string;
  error: string | null;
  configured: boolean;
  authenticated: boolean;
  liveChatId: string | null;
  broadcastTitle: string | null;
  reconnects: number;
  lastApi: { endpoint: string; status: number | null; at: string } | null;
  discovery: { at: string; broadcastType: string; activeItems: number; withChat: number; ownChannelMatch: number } | null;
  cursor: { liveChatId: string; platformId: string } | null;
  diag: AdapterDiag;
  /** T3 outbound capability: unknown until the first insert proves the grant. */
  outbound: "unknown" | "ok" | "insufficient";
  deliveredAnnouncements: number;
}

export type SendChatMessageResult =
  | { ok: true; messageId?: string | null; duplicate?: boolean }
  | { ok: false; error: string };

export interface YouTubeAdapterOptions {
  fetchImpl?: typeof fetch;
  onEvents?: (events: unknown[]) => void;
  onStatus?: (status: string) => void;
  client?: { clientId: string; clientSecret: string } | null;
  redirectUri?: string;
  /** Optional encrypted-repository writer (cloud flow; file otherwise). */
  persistTokens?: (tokens: { access_token: string; expires_at: number; refresh_token?: string | null }) => Promise<unknown>;
  /** Optional restart-guard cursor file (best-effort, never blocks polling). */
  cursorPath?: string | null;
}

export class YouTubeAdapter {
  constructor(opts?: YouTubeAdapterOptions);
  fetchImpl: typeof fetch;
  tokens: { access_token: string; expires_at: number; refresh_token?: string | null } | null;
  liveChatId: string | null;
  status: string;
  reconnects: number;
  stopped: boolean;
  diag: AdapterDiag;
  /** T3: unknown until the first insert proves the grant. */
  outbound: "unknown" | "ok" | "insufficient";
  delivered: Map<string, string | null>;
  lastApi: { endpoint: string; status: number | null; at: string } | null;
  sendTimes: number[];
  sendChain: Promise<unknown>;
  /** Shared in-progress refresh (single-flight; in-process only). */
  refreshInflight: Promise<string> | null;
  tokenGeneration: number;
  onStatus: (status: string) => void;
  init(tokenPath: string): Promise<void>;
  loadCursor(): Promise<void>;
  saveCursor(): Promise<void>;
  applyCursor(items: unknown[]): unknown[];
  ownChannel(): Promise<string>;
  discover(): Promise<{ liveChatId: string; title: string } | null>;
  authUrl(): string | null;
  handleCallback(code: string): Promise<void>;
  applyCredentials(creds: { access_token?: string; refresh_token?: string | null; expires_at?: number } | null): void;
  accessToken(): Promise<string>;
  api(path: string, params: Record<string, unknown>): Promise<any>;
  logout(): Promise<void>;
  connect(): Promise<AdapterState>;
  disconnect(): void;
  discoverAndStream(): Promise<void>;
  pollOnce(): Promise<void>;
  getState(): AdapterState;
  pruneSendTimes(now: number): void;
  markDelivered(eventId: string, messageId: string | null): void;
  sendChatMessage(args: { text: string; eventId: string }): Promise<SendChatMessageResult>;
  insertThrottled(text: string, eventId: string): Promise<SendChatMessageResult>;
  insertMessage(text: string, eventId: string): Promise<SendChatMessageResult>;
}

export function clampPoll(serverMs: unknown): number;
