import type { BridgeClientRole } from "./protocol.js";

export type { BridgeClientRole } from "./protocol.js";

export const BRIDGE_BROWSER_SESSION_PATH_PREFIX = "/s";
export const BRIDGE_WEBSOCKET_PATH_PREFIX = "/ws";
export const BRIDGE_ROLE_QUERY_PARAM = "role";

// A session is gated by a single secret carried in the URL path. There is no separate
// token: the secret both routes the session (the worker derives the Durable Object name
// by hashing it) and authorizes joining it, so knowledge of the secret IS the capability.
export type BridgeAuthQuery = {
  role?: BridgeClientRole;
};

export type ParsedBridgeBrowserSessionUrl = {
  secret: string;
};

export type ParsedBridgeWebSocketUrl = ParsedBridgeBrowserSessionUrl & {
  role: BridgeClientRole;
};

const BROWSER_SESSION_PATH_PATTERN = /^\/s\/([^/]+)$/;
const WEBSOCKET_PATH_PATTERN = /^\/ws\/([^/]+)$/;

export function toBridgeBrowserSessionUrl(bridgeUrl: string, secret: string): string {
  const url = new URL(bridgeUrl);
  url.pathname = toBridgeBrowserSessionPath(secret);
  return url.toString();
}

export function toBridgeWebSocketUrl(bridgeUrl: string, secret: string, role: BridgeClientRole): string {
  const url = new URL(bridgeUrl);
  url.protocol = toBridgeWebSocketProtocol(url.protocol);
  url.pathname = toBridgeWebSocketPath(secret);
  writeBridgeAuthQuery(url.searchParams, role);
  return url.toString();
}

export function toBridgeBrowserSessionPath(secret: string): string {
  return `${BRIDGE_BROWSER_SESSION_PATH_PREFIX}/${encodeSecret(secret)}`;
}

export function toBridgeWebSocketPath(secret: string): string {
  return `${BRIDGE_WEBSOCKET_PATH_PREFIX}/${encodeSecret(secret)}`;
}

export function parseBridgeBrowserSessionUrl(input: string | URL): ParsedBridgeBrowserSessionUrl | undefined {
  const secret = parseBridgeBrowserSessionPath(asUrl(input).pathname);
  return secret ? { secret } : undefined;
}

export function parseBridgeWebSocketUrl(input: string | URL): ParsedBridgeWebSocketUrl | undefined {
  const url = asUrl(input);
  const secret = parseBridgeWebSocketPath(url.pathname);
  const { role } = readBridgeAuthQuery(url.searchParams);

  if (!secret || !role) return undefined;
  return { secret, role };
}

export function parseBridgeBrowserSessionPath(pathname: string): string | undefined {
  return parseSessionPath(pathname, BROWSER_SESSION_PATH_PATTERN);
}

export function parseBridgeWebSocketPath(pathname: string): string | undefined {
  return parseSessionPath(pathname, WEBSOCKET_PATH_PATTERN);
}

export function readBridgeAuthQuery(searchParams: URLSearchParams): BridgeAuthQuery {
  return {
    role: parseBridgeClientRole(searchParams.get(BRIDGE_ROLE_QUERY_PARAM))
  };
}

export function parseBridgeClientRole(value: string | null | undefined): BridgeClientRole | undefined {
  return value === "daemon" || value === "browser" ? value : undefined;
}

function writeBridgeAuthQuery(searchParams: URLSearchParams, role?: BridgeClientRole): void {
  if (role) searchParams.set(BRIDGE_ROLE_QUERY_PARAM, role);
}

function toBridgeWebSocketProtocol(protocol: string): "ws:" | "wss:" {
  return protocol === "https:" || protocol === "wss:" ? "wss:" : "ws:";
}

function parseSessionPath(pathname: string, pattern: RegExp): string | undefined {
  const match = pathname.match(pattern);
  if (!match) return undefined;

  try {
    const secret = decodeURIComponent(match[1]);
    return secret.length > 0 ? secret : undefined;
  } catch {
    return undefined;
  }
}

function encodeSecret(secret: string): string {
  if (!secret) throw new Error("secret is required");
  return encodeURIComponent(secret);
}

function asUrl(input: string | URL): URL {
  return typeof input === "string" ? new URL(input) : input;
}
