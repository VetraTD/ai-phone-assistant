// lib/connections/secretBox.js
/**
 * AES-256-GCM secret box for the shared results channel (S3-8, spec §19
 * S3-D3, Ruling S3-8 "Secret box" / P-c). The ONLY plaintext this module ever
 * handles is a webhook endpoint's signing secret, and it never logs it: no
 * `log.*` import exists in this file at all, on purpose, so a future edit
 * cannot accidentally wire one in without the diff being obvious.
 *
 * The key is resolved and validated LAZILY, at first use inside
 * encryptSecret/decryptSecret -- never at import time. A missing or
 * wrong-length CONNECTIONS_WEBHOOK_KEY throws (fail closed): there is no
 * fallback, no silent truncation/padding, and no plaintext-passthrough mode.
 * A deployment that has not configured the key simply cannot box or unbox a
 * secret, which is the correct posture for a capability that is not
 * configured (memory: plan-verbatim-code-fails-open).
 *
 * Wire format (one Buffer): iv(12) || authTag(16) || ciphertext(N). GCM's own
 * authTag is what makes a ciphertext produced under a DIFFERENT key, or one
 * tampered in transit, fail to decrypt with a thrown error rather than
 * silently returning garbage bytes.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Resolve and validate the 32-byte key from CONNECTIONS_WEBHOOK_KEY (base64).
 * Throws on missing, non-base64, or wrong-length input -- every one of those
 * is exactly as unusable as no key at all, and treating them differently
 * would be a silent capability downgrade.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Buffer}
 */
export function loadWebhookKey(env = process.env) {
  const raw = (env.CONNECTIONS_WEBHOOK_KEY || "").trim();
  if (!raw) throw new Error("CONNECTIONS_WEBHOOK_KEY is not set");
  let key;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("CONNECTIONS_WEBHOOK_KEY is not valid base64");
  }
  if (key.length !== KEY_BYTES) {
    throw new Error(`CONNECTIONS_WEBHOOK_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

/**
 * Encrypt `plaintext` (utf8) under CONNECTIONS_WEBHOOK_KEY.
 * @param {string} plaintext
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Buffer} iv || authTag || ciphertext
 */
export function encryptSecret(plaintext, env = process.env) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptSecret: plaintext must be a non-empty string");
  }
  const key = loadWebhookKey(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/**
 * Decrypt a buffer produced by encryptSecret. Throws on a short/malformed
 * buffer, a wrong key, or a tampered ciphertext (GCM's own authTag check) --
 * every failure mode fails closed; there is no best-effort partial result.
 * @param {Buffer} boxed
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function decryptSecret(boxed, env = process.env) {
  if (!Buffer.isBuffer(boxed) || boxed.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error("decryptSecret: ciphertext is missing or too short");
  }
  const key = loadWebhookKey(env);
  const iv = boxed.subarray(0, IV_BYTES);
  const authTag = boxed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = boxed.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
