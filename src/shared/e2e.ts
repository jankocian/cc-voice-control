// End-to-end encryption shared by the daemon (Node) and the phone (browser). Both derive the SAME
// AES-GCM key from the session secret, which the worker never sees (it rides in the URL fragment / lives
// in session.json). So the worker relays only ciphertext: it can route by channel/threadId and store the
// opaque label blob, but it cannot read prompts, replies, transcripts, repo/branch labels, or audio.
//
// Uses WebCrypto (globalThis.crypto.subtle), available in Node 18+ and every target browser — no
// dependency. Symmetric only: this protects content FROM THE RELAY. It is not forward-secret and does
// not defend against a malicious relay replaying/reordering ciphertext (out of scope — the threat is a
// compromised/curious operator reading content, and the operator never holds the key).

export type EncBlob = { iv: string; ct: string };

const TEXT = new TextEncoder();
const FROM = new TextDecoder();
const IV_BYTES = 12; // 96-bit GCM nonce — fresh-random per message (never reused under one key).

// UTF-8 → bytes backed by a concrete `ArrayBuffer` (not the looser `ArrayBufferLike` TextEncoder returns),
// so the result satisfies `BufferSource` under both the Node and the stricter Cloudflare Workers lib
// typings without a cast.
function bytes(value: string): Uint8Array<ArrayBuffer> {
  const encoded = TEXT.encode(value);
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

// HKDF-SHA256(secret) → AES-256-GCM key. The salt/info strings domain-separate this key; bump the
// version suffix if the scheme ever changes. Non-extractable: only used to encrypt/decrypt here.
export async function deriveKey(secret: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", bytes(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bytes("voice-control/e2e/v1"),
      info: bytes("content")
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// AES-GCM with a fresh random IV and the given AAD (bound but unencrypted context, e.g. channel:threadId —
// so the relay can't move a ciphertext to a different thread without the auth tag failing).
export async function seal(key: CryptoKey, plaintext: string, aad: string): Promise<EncBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: bytes(aad) }, key, bytes(plaintext));
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

// Decrypt + verify. Throws if the ciphertext, IV, or AAD was tampered with (GCM auth tag mismatch).
export async function open(key: CryptoKey, blob: EncBlob, aad: string): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(blob.iv), additionalData: bytes(aad) },
    key,
    fromBase64(blob.ct)
  );
  return FROM.decode(plaintext);
}

// AAD binds a ciphertext to its routing context (channel + thread) so the relay can't move a sealed
// message to a different channel/thread without the GCM auth tag failing. Both ends MUST build it the
// same way — hence one shared helper rather than a copy on each side.
export function aad(channel: string, threadId: string): string {
  return `${channel}:${threadId}`;
}

export async function sealJson(key: CryptoKey, value: unknown, aad: string): Promise<EncBlob> {
  return seal(key, JSON.stringify(value), aad);
}

export async function openJson<T>(key: CryptoKey, blob: EncBlob, aad: string): Promise<T> {
  return JSON.parse(await open(key, blob, aad)) as T;
}

// SHA-256 → lowercase hex, via WebCrypto. Shared by the phone (routingId) and the worker (device-token
// hashing) so they can't drift. The daemon derives routingId with Node's sync createHash — same output,
// pinned by a test — because it can't await in a sync constructor path.
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes(input));
  return hex(new Uint8Array(digest));
}

// base64url of raw bytes (used for the device token). Built on the same call-stack-safe base64 as the
// sealing path, then made URL-safe.
export function toBase64url(raw: Uint8Array): string {
  return toBase64(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// base64 (standard, with +/=) for JSON transport. Loop, not spread — audio blobs are hundreds of KB and
// String.fromCharCode(...bigArray) would overflow the call stack.
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}
