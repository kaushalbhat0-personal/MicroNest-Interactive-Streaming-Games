// Types for server/state-transport.mjs (server-only).
export declare const TRANSPORT_PROTOCOL: number;
export declare const PUBLISH_MAX_BYTES: number;
export declare const REPLAY_BUFFER_MAX: number;
export declare const SUBSCRIBER_BACKLOG_MAX: number;
export declare const HEARTBEAT_MS: number;
export declare function snapshotShapeOk(s: unknown): boolean;
export interface StateTransport {
  handleRequest: (
    req: { method?: string; on: Function; headers?: Record<string, unknown> },
    res: { writeHead: Function; end: Function; write: Function; on: Function },
    url: URL,
  ) => Promise<boolean>;
  publishLocal: (snapshot: unknown) => { ok: true; seq: number } | { ok: false; reason: string; seq?: number };
  getSeq: () => number;
  getStatus: () => Record<string, unknown>;
  subscriberCount: () => number;
  close: () => void;
}
export declare function createStateTransport(opts?: {
  isAuthorized?: (req: unknown) => boolean | Promise<boolean>;
  now?: () => number;
}): StateTransport;
