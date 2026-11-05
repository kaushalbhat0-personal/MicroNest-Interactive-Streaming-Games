// T4F-C2.7-D1-C — persistence selection, startup sequence, outage policy.
//
// The authority boots through ONE deterministic chain and exposes readiness
// only after required persistence has initialized:
//
//   1. validate environment configuration (backend, DATABASE_URL, tokens)
//   2. establish database connectivity (postgres mode; SELECT 1 with timeout)
//   3. validate schema/migration version (refuse on mismatch)
//   4. load + validate world state (no-save | unavailable | corrupt distinct)
//   5. load encrypted credentials (envelope only; outage != absence)
//   6. restore required cursors + pending metadata (allowlisted keys)
//   7. initialize the existing authority/adapter lifecycle (unchanged)
//   8. expose ready status only after 1-7 succeed
//
// Production cloud mode MUST use postgres and MUST fail visibly when the
// database is unavailable. It must NEVER silently fall back to ephemeral
// local files, and must NEVER start with an empty world merely because the
// database could not be reached.
//
// OUTAGE POLICY (live-stream tradeoff, documented here — not invented
// silently). The last committed world is always safer than unsavable
// progress, but freezing the stream on every transient blip is worse than a
// marked degraded mode for a community-consequence game (seconds of delay
// are immaterial; the engine is deterministic and autosave retries every
// mutation). So:
//
// - startup unavailable            -> FAIL boot (lifecycle "failed"). No
//   genesis, no readiness. The operator sees the reason in status/logs.
// - save failure during a stream   -> CONTINUE in degraded mode: the game
//   loop keeps running, persistFrom reports "db-error", lastError names the
//   failure, autosave retries on the next mutation + shutdown flush. Nothing
//   is silentlyobre written; the last committed DB row stays intact.
// - credential update failure      -> keep serving the previous grant (never
//   delete on outage); refresh single-flight unchanged; status surfaces the
//   error; next refresh/save retries.
// - cursor update failure          -> best-effort only (dedup degrades to
//   engine-level dedup; bounded re-forward is safe). Never blocks polling.
// - reconnect                      -> pool reconnects automatically; the next
//   successful save clears the degraded flag (persistFrom back to
//   "postgres", lastError preserved until then for audit).
// - restart during an outage       -> FAIL boot (same as startup
//   unavailable). A restart must not reinterpret outage as empty world.
// - migration version mismatch     -> FAIL boot (code older than DB, or
//   migration not yet applied and auto-migrate failed). No partial boot.
// - pause-vs-degraded choice       -> the authority does NOT auto-pause on
//   persistence failure (an operator can pause via the control API; the
//   dashboard shows the degraded flag). Rationale: pausing mid-stream on a
//   transient Neon cold-start (few hundred ms resume) would be a worse
//   viewer experience than a visibly-marked retry, and no unsavable state is
//   presented as saved — the status explicitly says otherwise.
//
// The file backend keeps its historical behavior exactly (fresh genesis on
// corrupt save with the "corrupt-save-fresh" flag) because local dev has no
// operator to intervene. The postgres backend is stricter: corrupt saved
// state fails boot (operator must restore/repair; auto-wiping a production
// world would be data loss).

export const OUTAGE_POLICY = {
  startupUnavailable: "fail-boot",
  saveFailureDuringStream: "degraded-continue-with-retry",
  credentialUpdateFailure: "keep-previous-grant-and-retry",
  cursorUpdateFailure: "best-effort-degraded-dedup",
  reconnect: "automatic-pool-reconnect-clears-degraded-on-next-save",
  restartDuringOutage: "fail-boot-never-empty-world",
  migrationMismatch: "fail-boot",
  autoPauseOnPersistenceFailure: false,
};

/** Readiness gate: true only after the full persistence chain succeeded. */
export function readyStatus({ lifecycle, persistenceReady }) {
  return lifecycle === "running" && persistenceReady === true;
}

export async function checkConnectivity(db, timeoutMs = 5000) {
  const raced = await Promise.race([
    (async () => {
      try {
        await db.query("SELECT 1 AS ok");
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: "database-unavailable", detail: String(e?.message ?? e).slice(0, 120) };
      }
    })(),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: "database-unavailable", detail: "connect-timeout" }), timeoutMs)),
  ]);
  return raced;
}
