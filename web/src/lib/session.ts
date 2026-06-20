// Reads the session capability from the URL the daemon handed the phone:
//   /s/<secret>
// A session is gated by a single secret carried in the URL path. There is no separate
// token: the secret both routes the session (the worker derives the Durable Object name
// by hashing it) and authorizes joining it, so knowledge of the secret IS the capability.
// No server-side injection — the SPA is a static asset and reads the secret from the path.

export type SessionCredentials = {
  secret: string;
};

const SESSION_PATH_PATTERN = /^\/s\/([^/]+)$/;

export function readSessionCredentials(loc: Location = window.location): SessionCredentials | null {
  const match = loc.pathname.match(SESSION_PATH_PATTERN);
  if (!match) return null;

  let secret: string;
  try {
    secret = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (!secret) return null;

  return { secret };
}

// Mirrors the bridge contract: wss when the page is https, the bridge socket path is
// /ws/<secret>, carrying only role=browser. The secret in the path is the whole
// capability — the worker routes by idFromName(sha256(secret)), so reaching the
// session's Durable Object already proves knowledge of the secret.
export function buildWebSocketUrl(secret: string, loc: Location = window.location): string {
  const wsUrl = new URL(`/ws/${encodeURIComponent(secret)}`, loc.href);
  wsUrl.protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("role", "browser");
  return wsUrl.toString();
}
