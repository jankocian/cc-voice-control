// Re-export the end-to-end crypto from the single source of truth (src/shared). The phone and the
// daemon share these exact routines so a message sealed on one end opens on the other; the worker,
// which never has the key, can only relay ciphertext. Do not fork them here.
export { aad, deriveKey, openJson, sealJson, sha256Hex } from "../../../src/shared/e2e";
