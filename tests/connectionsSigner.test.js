// tests/connectionsSigner.test.js
/**
 * S3-8, named risk 5 (a signature over a re-serialised body rather than the
 * raw bytes sent). The correctness checks below verify signPayload's output
 * against an INDEPENDENT inline `crypto.createHmac` call, built in this file
 * rather than imported from lib/connections/signer.js -- importing the
 * function under test to check its own output would prove nothing but that
 * the module agrees with itself.
 */
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signPayload, verifySignature } from "../lib/connections/signer.js";

const SECRET = "whsec_test_only_do_not_use_in_prod";

function independentHmac(secret, timestamp, rawBody) {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

describe("connections signer: X-Vetra-Signature", () => {
  it("matches an independently computed HMAC-SHA256(secret, t + \".\" + raw_body)", () => {
    const rawBody = JSON.stringify({ event: "call.completed", delivery_id: "d1", direction: "outbound" });
    const timestamp = 1_758_000_000;
    const { header, signature } = signPayload({ secret: SECRET, rawBody, timestamp });

    const expected = independentHmac(SECRET, timestamp, rawBody);
    expect(signature).toBe(expected);
    expect(header).toBe(`t=${timestamp},v1=${expected}`);
  });

  it("produces a header the independent HMAC no longer matches once the body is tampered with", () => {
    const rawBody = JSON.stringify({ event: "call.completed", outcome: "booked" });
    const timestamp = 1_758_000_001;
    const { header } = signPayload({ secret: SECRET, rawBody, timestamp });
    const [, v1] = header.split(",");
    const signedHex = v1.slice("v1=".length);

    const tamperedBody = JSON.stringify({ event: "call.completed", outcome: "not_interested" });
    const tamperedHmac = independentHmac(SECRET, timestamp, tamperedBody);

    expect(tamperedHmac).not.toBe(signedHex);
  });

  it("a re-serialised (key-reordered) body no longer matches the original signature", () => {
    // The exact scenario named risk 5 warns about: semantically identical,
    // byte-different JSON. { a, b } vs { b, a } are the same object but
    // different raw bytes.
    const original = JSON.stringify({ a: 1, b: 2 });
    const reserialised = JSON.stringify({ b: 2, a: 1 });
    expect(original).not.toBe(reserialised);

    const timestamp = 1_758_000_002;
    const { signature } = signPayload({ secret: SECRET, rawBody: original, timestamp });
    const reserialisedHmac = independentHmac(SECRET, timestamp, reserialised);
    expect(reserialisedHmac).not.toBe(signature);
  });

  it("requires a non-empty secret and a string rawBody", () => {
    expect(() => signPayload({ secret: "", rawBody: "{}" })).toThrow();
    expect(() => signPayload({ secret: SECRET, rawBody: undefined })).toThrow();
  });
});

describe("connections signer: verifySignature (receiver-side helper)", () => {
  it("accepts a header signPayload produced, over the same raw bytes", () => {
    const rawBody = JSON.stringify({ event: "outreach.closed" });
    const { header } = signPayload({ secret: SECRET, rawBody, timestamp: 1_758_000_003 });
    expect(verifySignature({ header, secret: SECRET, rawBody })).toBe(true);
  });

  it("refuses a tampered body", () => {
    const rawBody = JSON.stringify({ event: "outreach.closed" });
    const { header } = signPayload({ secret: SECRET, rawBody, timestamp: 1_758_000_004 });
    expect(verifySignature({ header, secret: SECRET, rawBody: rawBody + " " })).toBe(false);
  });

  it("refuses the wrong secret", () => {
    const rawBody = JSON.stringify({ event: "outreach.closed" });
    const { header } = signPayload({ secret: SECRET, rawBody, timestamp: 1_758_000_005 });
    expect(verifySignature({ header, secret: "wrong-secret", rawBody })).toBe(false);
  });

  it("refuses a malformed header", () => {
    expect(verifySignature({ header: "not-a-real-header", secret: SECRET, rawBody: "{}" })).toBe(false);
    expect(verifySignature({ header: "", secret: SECRET, rawBody: "{}" })).toBe(false);
  });
});
