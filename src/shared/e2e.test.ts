import { describe, expect, it } from "vitest";
import { deriveKey, open, openJson, seal, sealJson, sha256Hex, toBase64url } from "./e2e.js";

const SECRET = "y9Qn3kР- a test secret with unicode ☃";
const AAD = "browser:thread-1";

describe("e2e seal/open round-trip", () => {
  it("decrypts what it sealed under the same key + AAD", async () => {
    const key = await deriveKey(SECRET);
    const blob = await seal(key, "your AWS key is in config.ts", AAD);
    expect(await open(key, blob, AAD)).toBe("your AWS key is in config.ts");
  });

  it("never puts plaintext on the wire", async () => {
    const key = await deriveKey(SECRET);
    const blob = await seal(key, "super secret repo name", AAD);
    expect(JSON.stringify(blob)).not.toContain("super secret repo name");
    expect(blob.iv).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(blob.ct).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("uses a fresh IV each time (same plaintext → different ciphertext)", async () => {
    const key = await deriveKey(SECRET);
    const a = await seal(key, "same", AAD);
    const b = await seal(key, "same", AAD);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("round-trips JSON (the shape content is sealed as)", async () => {
    const key = await deriveKey(SECRET);
    const value = { type: "history", turns: [{ text: "hi", role: "user" }] };
    const blob = await sealJson(key, value, AAD);
    expect(await openJson(key, blob, AAD)).toEqual(value);
  });

  it("round-trips a large (audio-sized) payload without stack overflow", async () => {
    const key = await deriveKey(SECRET);
    const big = "A".repeat(300_000); // ~300KB base64 audio stand-in
    const blob = await seal(key, big, AAD);
    expect(await open(key, blob, AAD)).toBe(big);
  });
});

describe("shared crypto encoders", () => {
  it("sha256Hex is correct SHA-256 → lowercase hex (pinned vector)", async () => {
    expect(await sha256Hex("secret")).toBe("2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b");
    expect(await sha256Hex("secret")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("toBase64url is URL-safe and unpadded", () => {
    expect(toBase64url(new Uint8Array([255, 255, 255]))).toBe("____");
    expect(toBase64url(new Uint8Array([0]))).toBe("AA");
    expect(toBase64url(new Uint8Array([251, 255]))).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("e2e authentication (the relay cannot read or forge)", () => {
  it("the same secret derives the same key on both ends", async () => {
    const a = await deriveKey(SECRET);
    const b = await deriveKey(SECRET);
    const blob = await seal(a, "ping", AAD);
    expect(await open(b, blob, AAD)).toBe("ping");
  });

  it("a different secret cannot decrypt (a worker without the secret is locked out)", async () => {
    const key = await deriveKey(SECRET);
    const wrong = await deriveKey(`${SECRET}!`);
    const blob = await seal(key, "secret", AAD);
    await expect(open(wrong, blob, AAD)).rejects.toBeDefined();
  });

  it("a tampered ciphertext fails the auth tag", async () => {
    const key = await deriveKey(SECRET);
    const blob = await seal(key, "secret", AAD);
    const flipped = blob.ct[0] === "A" ? "B" : "A";
    await expect(open(key, { iv: blob.iv, ct: flipped + blob.ct.slice(1) }, AAD)).rejects.toBeDefined();
  });

  it("a mismatched AAD fails (the relay cannot move a ciphertext to another thread)", async () => {
    const key = await deriveKey(SECRET);
    const blob = await seal(key, "secret", "browser:thread-1");
    await expect(open(key, blob, "browser:thread-2")).rejects.toBeDefined();
  });
});
