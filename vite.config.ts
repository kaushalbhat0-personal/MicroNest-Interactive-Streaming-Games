import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    // Never serve secrets or runtime state to the browser: data/ (OAuth
    // client JSON, tokens, cursor, world saves) and server/ (sidecars)
    // are backend-only. The app reaches them via the /api proxies.
    // (Defaults .env/.pem patterns are re-listed: `deny` replaces them.)
    fs: {
      strict: true,
      deny: [".env", ".env.*", "*.{crt,pem}", "data/**", "server/**"],
    },
    proxy: {
      // More specific first: /api/youtube -> sidecar, /api/state -> state
      // transport (T4F-B dual-renderer snapshots/SSE), /api/authority ->
      // authority server (T4F-C1 control API), /api -> persist.
      "/api/youtube": "http://localhost:3002",
      "/api/state": "http://localhost:3003",
      "/api/authority": "http://localhost:3004",
      "/api": "http://localhost:3001",
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        overlay: "overlay.html",
      },
    },
  },
});
