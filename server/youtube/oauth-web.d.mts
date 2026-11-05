// Types for oauth-web.mjs (server-side YouTube OAuth Web Server flow).
import type { OAuthStateStore } from "./oauth-state-store";
import type { YoutubeCredentials } from "./credential-repository";

export declare const TOKEN_ENDPOINT: string;
export declare const AUTH_ENDPOINT: string;
export declare const CHANNELS_ENDPOINT: string;
export declare const EXCHANGE_TIMEOUT_MS: number;
export declare const IDENTITY_TIMEOUT_MS: number;
export declare const CORRELATION_BYTES: number;
export declare const CORRELATION_MAX_AGE_SEC: number;
export declare const OAUTH_SCOPES: string[];
export declare const OAUTH_SECURITY_HEADERS: Record<string, string>;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  redirectPath: string;
  encryptionKey: unknown;
  dashboardUrl: string | null;
  isProd: boolean;
}

export interface OAuthConfigInput {
  clientId?: unknown;
  clientSecret?: unknown;
  redirectUri?: unknown;
  encryptionKey?: unknown;
  dashboardUrl?: unknown;
  allowHttpLoopback?: boolean;
}

export declare function loadOAuthConfig(input?: OAuthConfigInput): { ok: true; config: OAuthConfig } | { ok: false; reason: string };
export declare function mintCorrelationSecret(randomBytesImpl?: (n: number) => Uint8Array): string;
export declare function hashCorrelation(secret: string): string;
export declare function correlationCookieName(secure: boolean): string;
export declare function buildCorrelationSetCookie(secret: string, opts: { secure: boolean }): string;
export declare function parseCorrelationCookie(header: unknown, opts: { secure: boolean }): string | null;
export declare function buildWebAuthUrl(args: { config: OAuthConfig; state: string }): string;

export interface TokenExchange {
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
}

export declare function exchangeAuthCode(args: {
  config: OAuthConfig;
  code: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ ok: true; tokens: TokenExchange } | { ok: false; reason: string }>;

export interface ChannelIdentity {
  id: string;
  title?: string;
  handle?: string;
}

export declare function fetchChannelIdentity(args: {
  accessToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ ok: true; channel: ChannelIdentity } | { ok: false; reason: string }>;

export interface ExistingGrantSummary {
  refresh_token?: string | null;
  obtainedAt?: number;
  channel?: { id?: string } | null;
}

export interface PendingChannelInfo {
  previousChannelId: string;
  newChannel: ChannelIdentity;
}

export type CallbackOutcome =
  | { ok: true; channel: ChannelIdentity }
  | { ok: false; reason: string; pendingChannel?: PendingChannelInfo };

export declare function handleOAuthCallback(deps: {
  config: OAuthConfig;
  stateStore: OAuthStateStore;
  query?: { code?: unknown; state?: unknown; error?: unknown };
  cookieSecret?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  current?: ExistingGrantSummary | null;
  persistGrant: (creds: YoutubeCredentials) => Promise<unknown>;
  stagePendingGrant: (args: { creds: YoutubeCredentials; newChannel: ChannelIdentity; previousChannelId: string }) => Promise<unknown>;
}): Promise<CallbackOutcome>;

export declare function renderLandingPage(outcome: CallbackOutcome | null, dashboardUrl?: string | null): string;
