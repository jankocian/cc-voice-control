import type { BridgeClientRole } from "./protocol.js";

export type { BridgeClientRole } from "./protocol.js";

// The phone page lives at a fixed path; the session SECRET rides in the URL *fragment* (/s#<secret>),
// which browsers never send to a server. So the worker only ever sees the routing id (below), never
// the secret — that is what lets the worker relay content it cannot decrypt (end-to-end encryption).
export const BRIDGE_BROWSER_SESSION_PATH = "/s";
export const BRIDGE_WEBSOCKET_PATH_PREFIX = "/ws";
// Device-pairing claim endpoint (POST). A phone calls it before opening its socket: within an open
// pairing window it mints an httpOnly device cookie; outside one it 403s. See worker/src/claim.ts.
export const BRIDGE_CLAIM_PATH_PREFIX = "/claim";
export const BRIDGE_ROLE_QUERY_PARAM = "role";
// Header carrying the daemon-role auth secret (session.json's daemonKey). Only a real local daemon sends
// it; a leaked phone URL can't, so it can't impersonate a daemon. Sent as a header (not the URL) so it
// stays out of the QR and out of any access logs that record paths/queries.
export const BRIDGE_DAEMON_KEY_HEADER = "x-vc-daemon-key";
// A daemon socket carries its non-secret threadId (the cmux surface id / per-process uuid) so
// the DO can attach it before the first message — routing browser→daemon needs it from the
// start. Browsers omit it (a browser is not bound to a single thread).
export const BRIDGE_THREAD_ID_QUERY_PARAM = "threadId";

// The session is keyed by `routingId = sha256(secret)` (hex). It is a one-way derivative of the secret:
// it routes the session (the worker maps it to a Durable Object via idFromName) but reveals nothing
// about the secret, so it is safe to carry in the URL path and in the worker's view. Knowing the
// routingId lets you REACH a session's relay; it does NOT let you read content (that needs the secret,
// which only the daemon and the phone hold) and — for browsers — does not let you join without a paired
// device cookie. `threadId` (daemon only) is a non-secret routing key, not a credential.
export type BridgeAuthQuery = {
  role?: BridgeClientRole;
  threadId?: string;
};

export type ParsedBridgeWebSocketUrl = {
  routingId: string;
  role: BridgeClientRole;
  threadId?: string;
};

const WEBSOCKET_PATH_PATTERN = /^\/ws\/([^/]+)$/;
const CLAIM_PATH_PATTERN = /^\/claim\/([^/]+)$/;

// The phone URL: /s with the secret in the fragment. `new URL` percent-encodes the fragment if needed;
// a base64url secret has no fragment-unsafe characters, so it stays compact (same length as the old
// /s/<secret> path → same QR size).
export function toBridgeBrowserSessionUrl(bridgeUrl: string, secret: string): string {
  if (!secret) throw new Error("secret is required");
  const url = new URL(bridgeUrl);
  url.pathname = BRIDGE_BROWSER_SESSION_PATH;
  url.search = "";
  url.hash = secret;
  return url.toString();
}

export function toBridgeWebSocketUrl(
  bridgeUrl: string,
  routingId: string,
  role: BridgeClientRole,
  threadId?: string
): string {
  const url = new URL(bridgeUrl);
  url.protocol = toBridgeWebSocketProtocol(url.protocol);
  url.pathname = toBridgeWebSocketPath(routingId);
  writeBridgeAuthQuery(url.searchParams, role, threadId);
  return url.toString();
}

export function toBridgeWebSocketPath(routingId: string): string {
  return `${BRIDGE_WEBSOCKET_PATH_PREFIX}/${encodeRoutingId(routingId)}`;
}

export function toBridgeClaimPath(routingId: string): string {
  return `${BRIDGE_CLAIM_PATH_PREFIX}/${encodeRoutingId(routingId)}`;
}

// True for the phone-page route (the worker serves the SPA shell here; the secret is in the fragment,
// so there is nothing to parse from the path).
export function isBridgeBrowserSessionPath(pathname: string): boolean {
  return pathname === BRIDGE_BROWSER_SESSION_PATH;
}

export function parseBridgeWebSocketUrl(input: string | URL): ParsedBridgeWebSocketUrl | undefined {
  const url = asUrl(input);
  const routingId = parseBridgeWebSocketPath(url.pathname);
  const { role, threadId } = readBridgeAuthQuery(url.searchParams);

  if (!routingId || !role) return undefined;
  return { routingId, role, threadId };
}

export function parseBridgeWebSocketPath(pathname: string): string | undefined {
  return parseRoutingIdPath(pathname, WEBSOCKET_PATH_PATTERN);
}

export function parseBridgeClaimPath(pathname: string): string | undefined {
  return parseRoutingIdPath(pathname, CLAIM_PATH_PATTERN);
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

function parseRoutingIdPath(pathname: string, pattern: RegExp): string | undefined {
  const match = pathname.match(pattern);
  if (!match) return undefined;

  try {
    const routingId = decodeURIComponent(match[1]);
    return routingId.length > 0 ? routingId : undefined;
  } catch {
    return undefined;
  }
}

function encodeRoutingId(routingId: string): string {
  if (!routingId) throw new Error("routingId is required");
  return encodeURIComponent(routingId);
}

function asUrl(input: string | URL): URL {
  return typeof input === "string" ? new URL(input) : input;
}
