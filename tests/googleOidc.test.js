import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { createGoogleOidcVerifier } from "../lib/auth/googleOidc.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const AUD = "https://voice-uk-prod-462445274080.europe-west2.run.app";
const SA = "outbound-tasks@vetra-uk-edc8ca.iam.gserviceaccount.com";
const sign = (claims, opts = {}) => jwt.sign(
  { iss: "https://accounts.google.com", aud: AUD, email: SA, email_verified: true, ...claims },
  privateKey, { algorithm: "RS256", keyid: "k1", expiresIn: 300, ...opts });
const verifier = createGoogleOidcVerifier({ audience: AUD, allowedEmails: [SA], getPublicKey: async () => publicKey });

describe("Google OIDC verification for /internal/outbound/*", () => {
  it("accepts a token from the right service account for the right audience", async () =>
    expect(await verifier.verify(`Bearer ${sign({})}`)).toEqual({ ok: true, email: SA }));
  it("refuses a missing header", async () => expect((await verifier.verify(undefined)).ok).toBe(false));
  it("refuses the wrong audience", async () => expect((await verifier.verify(`Bearer ${sign({ aud: "https://evil.example" })}`)).ok).toBe(false));
  it("refuses the wrong service account", async () =>
    expect((await verifier.verify(`Bearer ${sign({ email: "someone@else.iam.gserviceaccount.com" })}`)).ok).toBe(false));
  it("refuses an unverified email", async () => expect((await verifier.verify(`Bearer ${sign({ email_verified: false })}`)).ok).toBe(false));
  it("refuses the wrong issuer", async () => expect((await verifier.verify(`Bearer ${sign({ iss: "https://securetoken.google.com/x" })}`)).ok).toBe(false));
  it("refuses an expired token", async () => expect((await verifier.verify(`Bearer ${sign({}, { expiresIn: -10 })}`)).ok).toBe(false));
  it("refuses alg none", async () => {
    const none = jwt.sign({ iss: "https://accounts.google.com", aud: AUD, email: SA, email_verified: true }, "", { algorithm: "none" });
    expect((await verifier.verify(`Bearer ${none}`)).ok).toBe(false);
  });
});
