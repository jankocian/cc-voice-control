import type { BridgeClientRole } from "./protocol.js";

export type { BridgeClientRole } from "./protocol.js";

// The phone URL is `/s/<sessionId>#<secret>`:
//  - `sessionId` (path) is a SHORT, non-secret handle = sha256(secret) truncated. It identifies the
//    session / Durable Object (the worker routes by it), is safe to show and log, distinguishes one
//    machine's session from another's — and on its own leads nowhere (reaching the DO is gated, and
//    without the secret there is no key and no cookie).
//  - `secret` (fragment) is never sent to any server (browsers don't send the fragment). From it the
//    phone derives the end-to-end key; the worker never sees it.
export const BRIDGE_BROWSER_SESSION_PATH_PREFIX = "/s";
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

export type BridgeAuthQuery = {
  role?: BridgeClientRole;
  threadId?: string;
};

export type ParsedBridgeWebSocketUrl = {
  sessionId: string;
  role: BridgeClientRole;
  threadId?: string;
};

const BROWSER_SESSION_PATH_PATTERN = /^\/s\/([^/]+)$/;
const WEBSOCKET_PATH_PATTERN = /^\/ws\/([^/]+)$/;
const CLAIM_PATH_PATTERN = /^\/claim\/([^/]+)$/;

// The phone URL: /s/<sessionId> with the secret in the fragment. `new URL` percent-encodes the fragment
// if needed; a base64url secret/sessionId has no unsafe characters.
export function toBridgeBrowserSessionUrl(bridgeUrl: string, sessionId: string, secret: string): string {
  if (!secret) throw new Error("secret is required");
  const url = new URL(bridgeUrl);
  url.pathname = `${BRIDGE_BROWSER_SESSION_PATH_PREFIX}/${encodeId(sessionId)}`;
  url.search = "";
  url.hash = secret;
  return url.toString();
}

export function toBridgeWebSocketUrl(
  bridgeUrl: string,
  sessionId: string,
  role: BridgeClientRole,
  threadId?: string
): string {
  const url = new URL(bridgeUrl);
  url.protocol = toBridgeWebSocketProtocol(url.protocol);
  url.pathname = toBridgeWebSocketPath(sessionId);
  writeBridgeAuthQuery(url.searchParams, role, threadId);
  return url.toString();
}

export function toBridgeWebSocketPath(sessionId: string): string {
  return `${BRIDGE_WEBSOCKET_PATH_PREFIX}/${encodeId(sessionId)}`;
}

export function toBridgeClaimPath(sessionId: string): string {
  return `${BRIDGE_CLAIM_PATH_PREFIX}/${encodeId(sessionId)}`;
}

// The sessionId from a phone-page route (`/s/<sessionId>`), or undefined if the path isn't one. The
// worker uses this to recognise a page request; the SPA shell it serves is identical for every session.
export function parseBridgeBrowserSessionPath(pathname: string): string | undefined {
  return parseIdPath(pathname, BROWSER_SESSION_PATH_PATTERN);
}

export function parseBridgeWebSocketUrl(input: string | URL): ParsedBridgeWebSocketUrl | undefined {
  const url = asUrl(input);
  const sessionId = parseBridgeWebSocketPath(url.pathname);
  const { role, threadId } = readBridgeAuthQuery(url.searchParams);

  if (!sessionId || !role) return undefined;
  return { sessionId, role, threadId };
}

export function parseBridgeWebSocketPath(pathname: string): string | undefined {
  return parseIdPath(pathname, WEBSOCKET_PATH_PATTERN);
}

export function parseBridgeClaimPath(pathname: string): string | undefined {
  return parseIdPath(pathname, CLAIM_PATH_PATTERN);
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

function parseIdPath(pathname: string, pattern: RegExp): string | undefined {
  const match = pathname.match(pattern);
  if (!match) return undefined;

  try {
    const id = decodeURIComponent(match[1]);
    return id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function encodeId(id: string): string {
  if (!id) throw new Error("sessionId is required");
  return encodeURIComponent(id);
}

function asUrl(input: string | URL): URL {
  return typeof input === "string" ? new URL(input) : input;
}
