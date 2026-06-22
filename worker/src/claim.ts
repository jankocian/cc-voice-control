// Device pairing: turn the leak-prone session URL into a short-lived pairing CODE, and the standing
// browser credential into an httpOnly device cookie that lives nowhere in the URL, history, or
// transcript. The daemon opens a pairing WINDOW (on its first connect and on /voice-control:pair);
// within it a phone's POST /claim mints a device cookie; outside it the claim is refused. The phone's
// WebSocket upgrade then requires that cookie. So a leaked URL presented after the window is dead, and
// stealing the conversation history yields no credential.
//
// These helpers are pure (no DurableObject/storage), so the pairing POLICY and the cookie wire-format
// are unit-tested without a Workers runtime; the DO wires them to ctx.storage + the request.

// How long a pairing window stays open after the daemon opens it. Generous enough to cover
// start → render-QR → unlock-phone → scan, short enough that a leaked URL is only claimable in a
// brief, user-initiated window.
export const CLAIM_WINDOW_MS = 90_000;

// Device cookie lifetime. The DO's device set is the real source of truth (revoke-on-exit wipes it);
// this is just how long the browser bothers to keep sending the cookie before a re-pair.
export const DEVICE_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days

const DEVICE_STORAGE_PREFIX = "device:";
// Persisted timestamp (epoch ms) until which the pairing window is open. One per session DO.
export const CLAIM_WINDOW_KEY = "claimOpenUntil";
// Pinned hash of the daemon-role auth secret (daemonKey), set on the first daemon connect
// (trust-on-first-use). Later daemon connects must present a key hashing to this.
export const DAEMON_AUTH_KEY = "daemonAuth";

// Per-session cookie name so two sessions opened in one browser (two machines) don't clobber each
// other's device token. 16 hex chars (64 bits) of the non-secret routingId makes an accidental
// same-prefix collision negligible.
export function deviceCookieName(routingId: string): string {
  return `vrt_${routingId.slice(0, 16)}`;
}

export function deviceStorageKey(tokenHashHex: string): string {
  return `${DEVICE_STORAGE_PREFIX}${tokenHashHex}`;
}

// The pairing policy, as a pure decision:
//  - a phone that already holds a valid device cookie is always allowed (refresh after window closed);
//  - otherwise it may mint a cookie only while the window is open;
//  - otherwise the claim is refused (the phone shows "link expired — run /voice-control:pair").
export function claimDecision(hasValidCookie: boolean, windowOpen: boolean): "allow" | "mint" | "reject" {
  if (hasValidCookie) return "allow";
  if (windowOpen) return "mint";
  return "reject";
}

export function windowOpen(claimOpenUntil: number | undefined, now: number): boolean {
  return claimOpenUntil !== undefined && now < claimOpenUntil;
}

// Read one cookie value from a Cookie header (returns undefined if absent). Tolerant of spacing and of
// values that themselves contain "=" (rejoins the remainder).
export function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

export function buildSetCookie(name: string, value: string, secure: boolean): string {
  // SameSite=Strict: every use (the /claim POST and the WS upgrade) is same-origin, so Strict is safe
  // and strongest. Path=/ so it rides both /claim/<routingId> and /ws/<routingId>. Secure is dropped
  // only for local http dev (wrangler dev), where the browser would otherwise refuse to store it.
  const attrs = [`${name}=${value}`, "HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${DEVICE_COOKIE_MAX_AGE_S}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

// 256-bit opaque device token, base64url. crypto.getRandomValues is available in the Workers runtime
// and in Node's vitest (globalThis.crypto).
export function mintDeviceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

// We persist only the token's hash, so a leak of the DO's storage never yields a usable cookie.
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return hex(new Uint8Array(digest));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
