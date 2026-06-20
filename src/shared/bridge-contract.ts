import type { BridgeClientRole } from "./protocol.js";

export type { BridgeClientRole } from "./protocol.js";

export const BRIDGE_BROWSER_SESSION_PATH_PREFIX = "/s";
export const BRIDGE_WEBSOCKET_PATH_PREFIX = "/ws";
export const BRIDGE_ROLE_QUERY_PARAM = "role";
// A daemon socket carries its non-secret threadId (the cmux surface id / per-process uuid) so
// the DO can attach it before the first message — routing browser→daemon needs it from the
// start. Browsers omit it (a browser is not bound to a single thread).
export const BRIDGE_THREAD_ID_QUERY_PARAM = "threadId";

// A session is gated by a single secret carried in the URL path. There is no separate
// token: the secret both routes the session (the worker derives the Durable Object name
// by hashing it) and authorizes joining it, so knowledge of the secret IS the capability.
// `threadId` (daemon only) is a non-secret routing key, not a credential.
export type BridgeAuthQuery = {
  role?: BridgeClientRole;
  threadId?: string;
};

export type ParsedBridgeBrowserSessionUrl = {
  secret: string;
};

export type ParsedBridgeWebSocketUrl = ParsedBridgeBrowserSessionUrl & {
  role: BridgeClientRole;
  threadId?: string;
};

const BROWSER_SESSION_PATH_PATTERN = /^\/s\/([^/]+)$/;
const WEBSOCKET_PATH_PATTERN = /^\/ws\/([^/]+)$/;

export function toBridgeBrowserSessionUrl(bridgeUrl: string, secret: string): string {
  const url = new URL(bridgeUrl);
  url.pathname = toBridgeBrowserSessionPath(secret);
  return url.toString();
}

export function toBridgeWebSocketUrl(
  bridgeUrl: string,
  secret: string,
  role: BridgeClientRole,
  threadId?: string
): string {
  const url = new URL(bridgeUrl);
  url.protocol = toBridgeWebSocketProtocol(url.protocol);
  url.pathname = toBridgeWebSocketPath(secret);
  writeBridgeAuthQuery(url.searchParams, role, threadId);
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
  const { role, threadId } = readBridgeAuthQuery(url.searchParams);

  if (!secret || !role) return undefined;
  return { secret, role, threadId };
}

export function parseBridgeBrowserSessionPath(pathname: string): string | undefined {
  return parseSessionPath(pathname, BROWSER_SESSION_PATH_PATTERN);
}

export function parseBridgeWebSocketPath(pathname: string): string | undefined {
  return parseSessionPath(pathname, WEBSOCKET_PATH_PATTERN);
}

export function readBridgeAuthQuery(searchParams: URLSearchParams): BridgeAuthQuery {
  return {
    role: parseBridgeClientRole(searchParams.get(BRIDGE_ROLE_QUERY_PARAM)),
    threadId: searchParams.get(BRIDGE_THREAD_ID_QUERY_PARAM) ?? undefined
  };
}

export function parseBridgeClientRole(value: string | null | undefined): BridgeClientRole | undefined {
  return value === "daemon" || value === "browser" ? value : undefined;
}

function writeBridgeAuthQuery(searchParams: URLSearchParams, role?: BridgeClientRole, threadId?: string): void {
  if (role) searchParams.set(BRIDGE_ROLE_QUERY_PARAM, role);
  if (threadId) searchParams.set(BRIDGE_THREAD_ID_QUERY_PARAM, threadId);
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
