// Reads the session from the URL the daemon handed the phone:
//   /s/<sessionId>#<secret>
//   - sessionId (path): the short, non-secret session handle — routes the socket/claim. Visible and
//     safe to log; on its own (no secret) it leads nowhere.
//   - secret (fragment): never sent to any server (browsers don't send the fragment). The phone derives
//     the end-to-end key from it; the worker never sees it.
// Standing access is a per-device httpOnly cookie minted by POST /claim during a pairing window — never
// the secret — so a stolen conversation history (which never contains the cookie) grants no access.

export type SessionCredentials = {
  sessionId: string;
  secret: string;
};

// The resolved session passed to the app: the routing handle plus the end-to-end key derived from the
// (now consumed) secret. The raw secret never enters React state/props.
export type Session = {
  sessionId: string;
  key: CryptoKey;
};

const SESSION_PATH_PATTERN = /^\/s\/([^/]+)$/;

// The active thread is carried in the URL query (`?t=<threadId>`) — the fragment is reserved for the
// secret, so the hint rides in the query (a non-secret routing id, already plaintext on the wire). A plain
// refresh restores the last thread. Returns null when absent/empty.
export function readThreadHint(loc: Location = window.location): string | null {
  return new URLSearchParams(loc.search).get("t") || null;
}

export function readSessionCredentials(loc: Location = window.location): SessionCredentials | null {
  const match = loc.pathname.match(SESSION_PATH_PATTERN);
  if (!match) return null;
  const raw = loc.hash.startsWith("#") ? loc.hash.slice(1) : loc.hash;

  let sessionId: string;
  let secret: string;
  try {
    sessionId = decodeURIComponent(match[1]);
    secret = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return sessionId && secret ? { sessionId, secret } : null;
}

// The bridge socket: wss when the page is https, routed by sessionId, carrying only role=browser. The
// standing capability is the device cookie (sent automatically), not anything in this URL.
export function buildWebSocketUrl(sessionId: string, loc: Location = window.location): string {
  const wsUrl = new URL(`/ws/${encodeURIComponent(sessionId)}`, loc.href);
  wsUrl.protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("role", "browser");
  return wsUrl.toString();
}

// `ok` → paired (cookie set/refreshed). `stale` → a cookie was sent but the session no longer knows it
// (e.g. it was revoked while the phone was away) → re-pair. `expired` → no valid cookie + closed window
// (a fresh/used one-time link) → re-pair. `error` → network/other, treat as transient and retry.
export type ClaimResult = "ok" | "stale" | "expired" | "error";

// Claim/refresh this device's pairing cookie before connecting.
export async function claimSession(sessionId: string, loc: Location = window.location): Promise<ClaimResult> {
  try {
    const res = await fetch(new URL(`/claim/${encodeURIComponent(sessionId)}`, loc.href).toString(), {
      method: "POST",
      credentials: "include",
      cache: "no-store"
    });
    if (res.ok) return "ok";
    if (res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { reason?: string };
      return body.reason === "stale" ? "stale" : "expired";
    }
    return "error";
  } catch {
    return "error";
  }
}
