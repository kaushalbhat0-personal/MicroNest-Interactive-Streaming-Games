// Local-only YouTube credentials + spike configuration.
//
// SECURITY: secrets live OUTSIDE the project tree in the user's profile
// (~/.emberkeep). Vite serves project files to the browser and git tracks
// the project — both must never see client secrets or tokens.
// Client ID/secret come from env or ~/.emberkeep/youtube-client.json.
// Tokens live in ~/.emberkeep/youtube-tokens.json (chmod 0600).
// Only non-secret runtime files (world save, chat cursor) stay in data/.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const profileDir = join(homedir(), ".emberkeep");

export const YT = {
  clientId: process.env.YOUTUBE_CLIENT_ID ?? "",
  clientSecret: process.env.YOUTUBE_CLIENT_SECRET ?? "",
  profileDir,
  tokenPath: join(profileDir, "youtube-tokens.json"),
  cursorPath: join(root, "data", ".youtube-cursor.json"),
  clientFile: join(profileDir, "youtube-client.json"),
  scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
  // Floor under the server's pollingIntervalMillis: quota guard for the spike.
  // Default YouTube quota (10k units/day) sustains ~2000 list calls/day.
  minPollMs: Number(process.env.YT_MIN_POLL_MS ?? 10000),
  maxPollMs: 30000,
  maxResults: 200,
  connectTimeoutMs: 15000,
  // Bounded reconnect: base delay, cap, max attempts before ERROR.
  backoffBaseMs: 2000,
  backoffCapMs: 60000,
  maxReconnects: 10,
  // Bounded ingestion: SSE replay buffer + diagnostics only, no unbounded growth.
  sseBufferSize: 200,
};

export async function loadClientConfig() {
  if (YT.clientId && YT.clientSecret) return { clientId: YT.clientId, clientSecret: YT.clientSecret };
  try {
    const raw = await readFile(YT.clientFile, "utf8");
    const parsed = JSON.parse(raw);
    // Accept the Google Desktop download as-is: {"installed": {...}}.
    const body = parsed.installed && typeof parsed.installed === "object" ? parsed.installed : parsed;
    const id = body.client_id ?? body.clientId ?? "";
    const secret = body.client_secret ?? body.clientSecret ?? "";
    if (id && secret) return { clientId: id, clientSecret: secret };
  } catch {
    /* no file */
  }
  return null;
}
