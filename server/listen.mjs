// T4F-C2.7-D1-D — production listener configuration (server-only).
//
// Render web services expose ONE public HTTP port: the injected PORT env
// bound on 0.0.0.0. Local development keeps the historical loopback bind.
// Strict validation fails boot on misconfiguration instead of binding the
// wrong interface or silently picking a port.
//
// - Production (NODE_ENV=production): PORT is REQUIRED (Render injects it);
//   HOST must be 0.0.0.0 when set (loopback in production fails boot);
//   unset HOST defaults to 0.0.0.0. No hardcoded production port.
// - Development: HOST defaults to 127.0.0.1 (existing workflows preserved),
//   port defaults to the service default (authority 3004 / state 3003).
// - A passing local bind test proves the listener logic only — it never
//   proves Render deployment (documented in docs/render-hosting.md).

export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];
export const PUBLIC_HOST = "0.0.0.0";

function parsePort(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

/**
 * Resolve the single public listener. `overrides` ({port, host}) win over
 * env/argv (unit tests + in-process boots); otherwise PORT/HOST env, then
 * argv, then service defaults.
 */
export function resolveListenerConfig({ defaultPort, env = process.env, argvPort, overrides } = {}) {
  if (!Number.isInteger(defaultPort) || defaultPort < 1 || defaultPort > 65535) {
    return { ok: false, reason: "listener-default-invalid" };
  }
  const nodeEnv = typeof env?.NODE_ENV === "string" ? env.NODE_ENV : "";
  const isProd = nodeEnv === "production";

  let port = null;
  if (overrides && overrides.port !== undefined) {
    port = parsePort(overrides.port);
    if (port === null) return { ok: false, reason: "port-invalid" };
  } else if (typeof env?.PORT === "string" && env.PORT !== "") {
    port = parsePort(env.PORT);
    if (port === null) return { ok: false, reason: "port-invalid" };
  } else if (isProd) {
    return { ok: false, reason: "port-required" };
  } else {
    port = argvPort !== undefined ? parsePort(argvPort) : null;
    if (argvPort !== undefined && port === null) return { ok: false, reason: "port-invalid" };
    if (port === null) port = defaultPort;
  }

  let host;
  if (overrides && overrides.host !== undefined) {
    host = String(overrides.host);
  } else if (typeof env?.HOST === "string" && env.HOST !== "") {
    host = env.HOST.trim();
  } else {
    host = isProd ? PUBLIC_HOST : "127.0.0.1";
  }
  if (isProd && LOOPBACK_HOSTS.includes(host.toLowerCase())) {
    return { ok: false, reason: "host-must-be-public" };
  }
  if (host.length === 0 || host.length > 255) return { ok: false, reason: "host-invalid" };
  return { ok: true, host, port };
}
