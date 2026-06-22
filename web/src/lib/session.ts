// Reads the session capability from the URL the daemon handed the phone:
//   /s#<secret>
// The secret rides in the URL FRAGMENT, which the browser never sends to a server — so the worker
// never sees it. From it the phone derives:
//   - routingId = sha256(secret) (hex): the only session id sent to the worker (routes the socket);
//   - (end-to-end) an AES key, so the worker relays content it cannot decrypt (see e2e.ts).
// Standing access is a per-device httpOnly cookie minted by POST /claim during a pairing window — never
// the secret — so a stolen conversation history (which never contains the cookie) grants no access.

export type SessionCredentials = {
  secret: string;
};

// The resolved session passed to the app: only the DERIVED values it needs — the routing id and the
// end-to-end key. The raw secret stays in main.tsx's bootstrap and never enters React state/props.
export type Session = {
  routingId: string;
  key: CryptoKey;
};

export function readSessionCredentials(loc: Location = window.location): SessionCredentials | null {
  // The secret is the URL fragment (everything after '#'); the browser keeps it client-side.
  const raw = loc.hash.startsWith("#") ? loc.hash.slice(1) : loc.hash;
  if (!raw) return null;

  let secret: string;
  try {
    secret = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return secret ? { secret } : null;
}

// routingId = sha256(secret) (lowercase hex). MUST match the daemon's deriveRoutingId (node createHash)
// exactly, or the two ends would reach different Durable Objects.
export async function deriveRoutingId(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The bridge socket: wss when the page is https, routed by routingId, carrying only role=browser. The
// standing capability is the device cookie (sent automatically), not anything in this URL.
export function buildWebSocketUrl(routingId: string, loc: Location = window.location): string {
  const wsUrl = new URL(`/ws/${encodeURIComponent(routingId)}`, loc.href);
  wsUrl.protocol = loc.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("role", "browser");
  return wsUrl.toString();
}

export type ClaimResult = "ok" | "expired" | "error";

// Claim/refresh this device's pairing cookie before connecting. `ok` → a pairing window was open (or
// this device is already paired) and the httpOnly cookie is set; `expired` → no window and no valid
// cookie (show "run /voice-control:pair"); `error` → network/other, treat as transient and retry.
export async function claimSession(routingId: string, loc: Location = window.location): Promise<ClaimResult> {
  try {
    const res = await fetch(new URL(`/claim/${encodeURIComponent(routingId)}`, loc.href).toString(), {
      method: "POST",
      credentials: "include",
      cache: "no-store"
    });
    if (res.ok) return "ok";
    if (res.status === 403) return "expired";
    return "error";
  } catch {
    return "error";
  }
}
