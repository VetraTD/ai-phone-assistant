import { describe, it, expect } from "vitest";
import {
  FORBIDDEN_IN_PHI_PROJECTS,
  findForbiddenSecrets,
  matchesRule,
  normalise,
} from "../../lib/credentialBoundary.js";

// The offline half of the credential-boundary gate. Same shape as A1.7's PHI
// lint: the LIVE check (scripts/check-credential-boundary.js) runs in the
// deploy path where credentials exist, and this pins the matcher so a later
// "simplification" that quietly stops matching anything fails HERE rather than
// passing silently in CI forever.
//
// Splitting it this way is not a convenience. A test that needs GCP credentials
// is a test that gets skipped on every workstation, and a check nobody can run
// is a check nobody trusts.

describe("credential boundary matcher", () => {
  // The accident this is aimed at, in the shapes it actually takes. A deploy
  // script that copies the whole secret set into every project produces exactly
  // these names.
  it.each([
    "ELEVENLABS_API_KEY",
    "elevenlabs-api-key",
    "eleven_labs_key",
    "tts-elevenlabs-primary",
    "ElevenLabsApiKey",
    "11labs-key",
    "xi-api-key",
    "XI_API_KEY",
  ])("%s is caught", (name) => {
    expect(findForbiddenSecrets([name])).toHaveLength(1);
  });

  it.each([
    "GEMINI_API_KEY",
    "gemini-api-key",
    "google-ai-studio-key",
    "generativelanguage-key",
  ])("%s is caught — the API-key path is not BAA-covered", (name) => {
    const found = findForbiddenSecrets([name]);
    expect(found).toHaveLength(1);
    expect(found[0].vendor).toMatch(/Gemini Developer API/);
  });

  // A gate that fires on innocent names is a gate someone disables. These are
  // the near misses that make the two-normalisation scheme worth its
  // complexity — `proxi-api-key` squashes to a string CONTAINING `xiapikey`,
  // and is rejected only because token matching sees "proxi", not "xi".
  it.each([
    "proxi-api-key",
    "twilio-auth-token",
    "deepgram-api-key",
    "vertex-service-account",
    "gemini-vertex-project-id",
    "eleven-oclock-digest",
    "database-password",
    "smtp-password",
  ])("%s is not a false positive", (name) => {
    expect(findForbiddenSecrets([name])).toEqual([]);
  });

  it("reports the vendor and the reason, not just a boolean", () => {
    const [found] = findForbiddenSecrets(["ELEVENLABS_API_KEY"]);
    expect(found.vendor).toBe("ElevenLabs");
    expect(found.why).toMatch(/BAA/);
    expect(found.secret).toBe("ELEVENLABS_API_KEY");
  });

  it("scans every secret, not just the first", () => {
    const found = findForbiddenSecrets([
      "twilio-auth-token",
      "elevenlabs-api-key",
      "database-password",
      "GEMINI_API_KEY",
    ]);
    expect(found.map((f) => f.secret)).toEqual(["elevenlabs-api-key", "GEMINI_API_KEY"]);
  });

  it("an empty project passes", () => {
    expect(findForbiddenSecrets([])).toEqual([]);
  });

  // Deepgram is deliberately absent from the rule set. Its BAA was requested
  // 2026-08-21 and the answer has not arrived. Encoding a guess in either
  // direction is worse than encoding nothing: a rule that fails the deploy
  // would block on an unanswered email, and an explicit allow would look like a
  // decision somebody made. When the answer lands, this test changes with it.
  it("does not yet rule on Deepgram", () => {
    expect(FORBIDDEN_IN_PHI_PROJECTS.map((r) => r.vendor).join(" ")).not.toMatch(/deepgram/i);
    expect(findForbiddenSecrets(["deepgram-api-key"])).toEqual([]);
  });
});

describe("normalise", () => {
  it("squashes separators and splits tokens", () => {
    expect(normalise("Eleven_Labs-Key")).toEqual({
      squashed: "elevenlabskey",
      tokens: ["eleven", "labs", "key"],
    });
  });

  it("token pairs must be adjacent", () => {
    const xi = FORBIDDEN_IN_PHI_PROJECTS.find((r) => r.vendor === "ElevenLabs");
    expect(matchesRule("xi-api-key", xi)).toBe(true);
    expect(matchesRule("xi-legacy-api-key", xi)).toBe(false);
  });
});
