import { describe, expect, it } from "vitest";
import {
  buildSetCookie,
  claimDecision,
  DEVICE_COOKIE_MAX_AGE_S,
  DEVICE_TTL_MS,
  deviceCookieName,
  deviceFresh,
  deviceStorageKey,
  hashToken,
  mintDeviceToken,
  readCookie,
  windowOpen
} from "./claim";

describe("claimDecision — the pairing policy", () => {
  it("a paired device is always allowed (refresh works after the window closes)", () => {
    expect(claimDecision(true, false)).toBe("allow");
    expect(claimDecision(true, true)).toBe("allow");
  });

  it("an unpaired device mints only while the window is open", () => {
    expect(claimDecision(false, true)).toBe("mint");
  });

  it("an unpaired device is rejected once the window has closed", () => {
    expect(claimDecision(false, false)).toBe("reject");
  });
});

describe("windowOpen", () => {
  const now = 1_000_000;
  it("is closed when never opened", () => {
    expect(windowOpen(undefined, now)).toBe(false);
  });
  it("is open strictly before the deadline", () => {
    expect(windowOpen(now + 1, now)).toBe(true);
    expect(windowOpen(now, now)).toBe(false);
    expect(windowOpen(now - 1, now)).toBe(false);
  });
});

describe("deviceFresh — rolling device-token expiry", () => {
  const now = 10 * DEVICE_TTL_MS;
  it("is fresh within the TTL of its last use, stale at/after it", () => {
    expect(deviceFresh(now, now)).toBe(true);
    expect(deviceFresh(now - DEVICE_TTL_MS + 1, now)).toBe(true);
    expect(deviceFresh(now - DEVICE_TTL_MS, now)).toBe(false);
    expect(deviceFresh(now - DEVICE_TTL_MS - 1, now)).toBe(false);
  });
  it("TTL matches the cookie Max-Age (server and browser expire together)", () => {
    expect(DEVICE_TTL_MS).toBe(DEVICE_COOKIE_MAX_AGE_S * 1000);
  });
});

describe("deviceCookieName", () => {
  it("scopes the cookie per session so two sessions in one browser don't clobber each other", () => {
    expect(deviceCookieName("abcdef0123456789abcdef")).toBe("vrt_abcdef0123456789");
    expect(deviceCookieName("abcdef0123456789")).not.toBe(deviceCookieName("fedcba9876543210"));
  });
});

describe("readCookie", () => {
  it("returns undefined when the header is absent or the name is missing", () => {
    expect(readCookie(null, "vrt_a")).toBeUndefined();
    expect(readCookie("other=1", "vrt_a")).toBeUndefined();
  });
  it("reads a value among several, tolerating spaces", () => {
    expect(readCookie("a=1; vrt_a=tok; b=2", "vrt_a")).toBe("tok");
    expect(readCookie("vrt_a=tok", "vrt_a")).toBe("tok");
  });
  it("rejoins values that contain '='", () => {
    expect(readCookie("vrt_a=ab=cd", "vrt_a")).toBe("ab=cd");
  });
  it("treats an empty value as absent", () => {
    expect(readCookie("vrt_a=", "vrt_a")).toBeUndefined();
  });
});

describe("buildSetCookie", () => {
  it("is httpOnly, SameSite=Strict, Path=/ and capped at the device max-age", () => {
    const c = buildSetCookie("vrt_a", "tok", true);
    expect(c).toContain("vrt_a=tok");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/");
    expect(c).toContain(`Max-Age=${DEVICE_COOKIE_MAX_AGE_S}`);
    expect(c).toContain("Secure");
  });
  it("drops Secure for local http dev", () => {
    expect(buildSetCookie("vrt_a", "tok", false)).not.toContain("Secure");
  });
});

describe("device token crypto", () => {
  it("mints unique, opaque base64url tokens", () => {
    const a = mintDeviceToken();
    const b = mintDeviceToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(40); // 32 bytes → ~43 base64url chars
  });

  it("hashes deterministically (storage key is the hash, never the token)", async () => {
    const token = mintDeviceToken();
    const h1 = await hashToken(token);
    const h2 = await hashToken(token);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toContain(token);
    expect(deviceStorageKey(h1)).toBe(`device:${h1}`);
  });
});
