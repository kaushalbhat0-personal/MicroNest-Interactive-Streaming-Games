// Minimal local persistence server. Node builtins ONLY — no framework.
// Reads/writes data/world-state.json so world state survives app restarts
// as a real file (not just browser storage).
//   node server/persist-server.mjs [port]
// Vite proxies /api -> this server during `npm run dev`.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");
const file = join(dataDir, "world-state.json");
const port = Number(process.argv[2] ?? 3001);

await mkdir(dataDir, { recursive: true });

const server = createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, PUT, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.url === "/api/world" && req.method === "GET") {
    try {
      const body = await readFile(file, "utf8");
      res.writeHead(200, { "content-type": "application/json" }).end(body);
    } catch (err) {
      if (err?.code === "ENOENT") {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"no-save"}');
      } else {
        res.writeHead(500).end('{"error":"read-failed"}');
      }
    }
    return;
  }
  if (req.url === "/api/world" && req.method === "PUT") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.worldId !== "emberkeep-prototype") throw new Error("bad-world");
      await writeFile(file, JSON.stringify(parsed, null, 2), "utf8");
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid-world"}');
    }
    return;
  }
  res.writeHead(404).end("not-found");
});

server.listen(port, () => {
  console.log(`[emberkeep] persistence server on http://localhost:${port} -> ${file}`);
});
