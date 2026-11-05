// Types for server/persistence/storage.mjs (server-only).
export declare const OUTAGE_POLICY: {
  startupUnavailable: string;
  saveFailureDuringStream: string;
  credentialUpdateFailure: string;
  cursorUpdateFailure: string;
  reconnect: string;
  restartDuringOutage: string;
  migrationMismatch: string;
  autoPauseOnPersistenceFailure: boolean;
};
export declare function readyStatus(args: { lifecycle: string; persistenceReady: boolean }): boolean;
export declare function checkConnectivity(
  db: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  timeoutMs?: number,
): Promise<{ ok: boolean; reason?: string; detail?: string }>;
