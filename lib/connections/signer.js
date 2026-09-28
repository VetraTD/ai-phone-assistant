// lib/connections/signer.js
/**
 * X-Vetra-Signature (spec §12.5, S3-8):
 *   t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + raw_body)>
 *
 * Signs the EXACT bytes that will be sent on the wire. Callers must pass the
 * same `rawBody` string used as the HTTP request body, never a re-serialised
 * object -- `JSON.stringify` is not guaranteed byte-stable across engines or
 * even across two calls with differently-ordered keys, and a receiver that
 * verifies against its own independent HMAC (the test in
 * tests/connectionsSigner.test.js does exactly this, deliberately not
 * importing this module) would fail on a message that is semantically
 * identical but not byte-identical. Named risk 5 in the S3-8 brief.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const HEADER_RE = /^t=(\d+),v1=([0-9a-f]{64})$/i;

/**
 * @param {{ secret: string, rawBody: string, timestamp?: number }} o
 * @returns {{ header: string, timestamp: number, signature: string }}
 */
export function signPayload({ secret, rawBody, timestamp = Math.floor(Date.now() / 1000) }) {
  if (typeof secret !== "string" || secret.length === 0) throw new Error("signPayload: secret is required");
  if (typeof rawBody !== "string") throw new Error("signPayload: rawBody must be a string");
  if (!Number.isInteger(timestamp)) throw new Error("signPayload: timestamp must be an integer");
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return { header: `t=${timestamp},v1=${signature}`, timestamp, signature };
}

/**
 * Verify a `X-Vetra-Signature` header against the raw bytes received.
 * Constant-time comparison on the digest (timingSafeEqual), so a partial
 * match cannot be used to guess the signature byte by byte.
 * @param {{ header: string, secret: string, rawBody: string }} o
 * @returns {boolean}
 */
export function verifySignature({ header, secret, rawBody }) {
  if (typeof header !== "string") return false;
  const m = HEADER_RE.exec(header.trim());
  if (!m) return false;
  const [, tRaw, sigHex] = m;
  const expected = createHmac("sha256", secret).update(`${tRaw}.${rawBody}`).digest("hex");
  const a = Buffer.from(sigHex.toLowerCase(), "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
