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
}

export interface YouTubeAdapterOptions {
  fetchImpl?: typeof fetch;
  onEvents?: (events: unknown[]) => void;
  onStatus?: (status: string) => void;
  client?: { clientId: string; clientSecret: string } | null;
  redirectUri?: string;
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
  init(tokenPath: string): Promise<void>;
  loadCursor(): Promise<void>;
  saveCursor(): Promise<void>;
  applyCursor(items: unknown[]): unknown[];
  ownChannel(): Promise<string>;
  discover(): Promise<{ liveChatId: string; title: string } | null>;
  authUrl(): string | null;
  handleCallback(code: string): Promise<void>;
  logout(): Promise<void>;
  connect(): Promise<AdapterState>;
  disconnect(): void;
  discoverAndStream(): Promise<void>;
  pollOnce(): Promise<void>;
  getState(): AdapterState;
}

export function clampPoll(serverMs: unknown): number;
