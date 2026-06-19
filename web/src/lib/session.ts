// Reads the session credentials straight from the URL the daemon handed the phone:
//   /s/<sessionId>?token=…   (optionally &expiresAt=… — forward-compatible; the
// current daemon does not set it, and the bridge has no wall-clock expiry).
// No server-side injection — the SPA is a static asset.

export type SessionCredentials = {
  sessionId: string;
  token: string;
  expiresAt: number | null;
};

const SESSION_PATH_PATTERN = /^\/s\/([^/]+)$/;

export function readSessionCredentials(loc: Location = window.location): SessionCredentials | null {
  const match = loc.pathname.match(SESSION_PATH_PATTERN);
  if (!match) return null;

  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!sessionId) return null;

  const params = new URLSearchParams(loc.search);
  const token = params.get("token") ?? "";
  if (!token) return null;

  const rawExpiresAt = params.get("expiresAt");
  const expiresAt = rawExpiresAt ? Number.parseInt(rawExpiresAt, 10) : NaN;

  return {
    sessionId,
    token,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null
  };
}

// Mirrors the original: wss when the page is https, the bridge socket path is
// /ws/<sessionId>, carrying the token and role=browser.
export function buildWebSocketUrl(sessionId: string, token: string, loc: Location = window.location): string {
  const wsUrl = new URL(`/ws/${encodeURIComponent(sessionId)}`, loc.href);
  wsUrl.protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("token", token);
  wsUrl.searchParams.set("role", "browser");
  return wsUrl.toString();
}
