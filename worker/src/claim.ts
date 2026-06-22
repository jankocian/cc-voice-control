// Device pairing: turn the leak-prone session URL into a short-lived pairing CODE, and the standing
// browser credential into an httpOnly device cookie that lives nowhere in the URL, history, or
// transcript. The daemon opens a pairing WINDOW (on its first connect and on /voice-control:pair);
// within it a phone's POST /claim mints a device cookie; outside it the claim is refused. The phone's
// WebSocket upgrade then requires that cookie. So a leaked URL presented after the window is dead, and
// stealing the conversation history yields no credential.
//
// These helpers are pure (no DurableObject/storage), so the pairing POLICY and the cookie wire-format
// are unit-tested without a Workers runtime; the DO wires them to ctx.storage + the request.

import { sha256Hex, toBase64url } from "../../src/shared/e2e";

// How long a pairing window stays open after the daemon opens it. Generous enough to cover
// start → render-QR → unlock-phone → scan, short enough that a leaked URL is only claimable in a
// brief, user-initiated window.
export const CLAIM_WINDOW_MS = 90_000;

// Device cookie / device-token lifetime. Both are ROLLING — refreshed on every reconnect (claim runs
// before each connect) — so day-to-day use never expires. A device untouched for this long must re-pair.
// Paired tokens survive an idle session (revoke-on-exit keeps `device:*`), so a morning refresh after the
// laptop slept still works, bounded by this TTL. Short enough that a stale cookie can't be used for long.
export const DEVICE_COOKIE_MAX_AGE_S = 3 * 24 * 60 * 60; // 3 days
export const DEVICE_TTL_MS = DEVICE_COOKIE_MAX_AGE_S * 1000;

// A paired device token is valid only within DEVICE_TTL_MS of its last use (createdAt is bumped on each
// successful claim). Pure so the rolling-expiry rule is unit-tested without a DO.
export function deviceFresh(createdAt: number, now: number): boolean {
  return now - createdAt < DEVICE_TTL_MS;
}

export const DEVICE_STORAGE_PREFIX = "device:";
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
// and in Node's vitest (globalThis.crypto). base64url + the SHA-256→hex below reuse the shared crypto
// encoders (src/shared/e2e.ts) so the token format and hashing can't drift from the rest of the system.
export function mintDeviceToken(): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

// We persist only the token's hash, so a leak of the DO's storage never yields a usable cookie.
export function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}
