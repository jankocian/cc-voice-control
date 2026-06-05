import type { BridgeClientRole } from "./protocol.js";

export type { BridgeClientRole } from "./protocol.js";

export const BRIDGE_BROWSER_SESSION_PATH_PREFIX = "/s";
export const BRIDGE_WEBSOCKET_PATH_PREFIX = "/ws";
export const BRIDGE_TOKEN_QUERY_PARAM = "token";
export const BRIDGE_ROLE_QUERY_PARAM = "role";
export const BRIDGE_EXPIRES_AT_QUERY_PARAM = "expiresAt";

export type BridgeAuthQuery = {
  token: string;
  role?: BridgeClientRole;
  expiresAt?: number;
};

export type ParsedBridgeBrowserSessionUrl = {
  sessionId: string;
  token: string;
  expiresAt?: number;
};

export type ParsedBridgeWebSocketUrl = ParsedBridgeBrowserSessionUrl & {
  role: BridgeClientRole;
};

const BROWSER_SESSION_PATH_PATTERN = /^\/s\/([^/]+)$/;
const WEBSOCKET_PATH_PATTERN = /^\/ws\/([^/]+)$/;

export function toBridgeBrowserSessionUrl(
  bridgeUrl: string,
  sessionId: string,
  token: string,
  expiresAt?: number
): string {
  const url = new URL(bridgeUrl);
  url.pathname = toBridgeBrowserSessionPath(sessionId);
  writeBridgeAuthQuery(url.searchParams, token, undefined, expiresAt);
  return url.toString();
}

export function toBridgeWebSocketUrl(
  bridgeUrl: string,
  sessionId: string,
  token: string,
  role: BridgeClientRole,
  expiresAt?: number
): string {
  const url = new URL(bridgeUrl);
  url.protocol = toBridgeWebSocketProtocol(url.protocol);
  url.pathname = toBridgeWebSocketPath(sessionId);
  writeBridgeAuthQuery(url.searchParams, token, role, expiresAt);
  return url.toString();
}

export function toBridgeBrowserSessionPath(sessionId: string): string {
  return `${BRIDGE_BROWSER_SESSION_PATH_PREFIX}/${encodeSessionId(sessionId)}`;
}

export function toBridgeWebSocketPath(sessionId: string): string {
  return `${BRIDGE_WEBSOCKET_PATH_PREFIX}/${encodeSessionId(sessionId)}`;
}

export function parseBridgeBrowserSessionUrl(input: string | URL): ParsedBridgeBrowserSessionUrl | undefined {
  const url = asUrl(input);
  const sessionId = parseBridgeBrowserSessionPath(url.pathname);
  const query = readBridgeAuthQuery(url.searchParams);

  if (!sessionId || !query.token) return undefined;
  return withOptionalExpiresAt({ sessionId, token: query.token }, query.expiresAt);
}

export function parseBridgeWebSocketUrl(input: string | URL): ParsedBridgeWebSocketUrl | undefined {
  const url = asUrl(input);
  const sessionId = parseBridgeWebSocketPath(url.pathname);
  const query = readBridgeAuthQuery(url.searchParams);

  if (!sessionId || !query.token || !query.role) return undefined;
  return withOptionalExpiresAt({ sessionId, token: query.token, role: query.role }, query.expiresAt);
}

export function parseBridgeBrowserSessionPath(pathname: string): string | undefined {
  return parseSessionPath(pathname, BROWSER_SESSION_PATH_PATTERN);
}

export function parseBridgeWebSocketPath(pathname: string): string | undefined {
  return parseSessionPath(pathname, WEBSOCKET_PATH_PATTERN);
}

export function readBridgeAuthQuery(searchParams: URLSearchParams): BridgeAuthQuery {
  return {
    token: searchParams.get(BRIDGE_TOKEN_QUERY_PARAM) ?? "",
    role: parseBridgeClientRole(searchParams.get(BRIDGE_ROLE_QUERY_PARAM)),
    expiresAt: parseBridgeExpiresAt(searchParams.get(BRIDGE_EXPIRES_AT_QUERY_PARAM))
  };
}

export function parseBridgeClientRole(value: string | null | undefined): BridgeClientRole | undefined {
  return value === "daemon" || value === "browser" ? value : undefined;
}

export function parseBridgeExpiresAt(value: string | null | undefined): number | undefined {
  if (!value) return undefined;

  const expiresAt = Number(value);
  return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined;
}

export function formatBridgeExpiresAt(expiresAt: number | undefined): string | undefined {
  if (expiresAt === undefined) return undefined;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new RangeError("expiresAt must be a positive finite timestamp");
  }
  return String(expiresAt);
}

function writeBridgeAuthQuery(
  searchParams: URLSearchParams,
  token: string,
  role?: BridgeClientRole,
  expiresAt?: number
): void {
  if (!token) throw new Error("token is required");

  searchParams.set(BRIDGE_TOKEN_QUERY_PARAM, token);
  if (role) searchParams.set(BRIDGE_ROLE_QUERY_PARAM, role);

  const formattedExpiresAt = formatBridgeExpiresAt(expiresAt);
  if (formattedExpiresAt !== undefined) {
    searchParams.set(BRIDGE_EXPIRES_AT_QUERY_PARAM, formattedExpiresAt);
  }
}

function toBridgeWebSocketProtocol(protocol: string): "ws:" | "wss:" {
  return protocol === "https:" || protocol === "wss:" ? "wss:" : "ws:";
}

function parseSessionPath(pathname: string, pattern: RegExp): string | undefined {
  const match = pathname.match(pattern);
  if (!match) return undefined;

  try {
    const sessionId = decodeURIComponent(match[1]);
    return sessionId.length > 0 ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

function encodeSessionId(sessionId: string): string {
  if (!sessionId) throw new Error("sessionId is required");
  return encodeURIComponent(sessionId);
}

function asUrl(input: string | URL): URL {
  return typeof input === "string" ? new URL(input) : input;
}

function withOptionalExpiresAt<T extends object>(value: T, expiresAt: number | undefined): T & { expiresAt?: number } {
  return expiresAt === undefined ? value : { ...value, expiresAt };
}
