/**
 * The credential boundary, as a decidable rule.
 *
 * ---------------------------------------------------------------------------
 * What this is defending
 * ---------------------------------------------------------------------------
 *
 * The whole six-project split exists to make one property STRUCTURAL rather
 * than aspirational: `voice-us` holds no ElevenLabs key. A project is the
 * credential boundary, so a misconfiguration in the US lane yields voicemail —
 * a degraded call — instead of the caller's utterance being sent to a vendor
 * with no BAA, which is a reportable disclosure.
 *
 * `lib/compliance.js` already refuses an uncovered vendor at client
 * construction, and that is the runtime half. This is the other half: the key
 * should not BE there. A guard that depends on code never having a bug is a
 * guard with a single point of failure; a project that never held the secret
 * has nothing to leak.
 *
 * ---------------------------------------------------------------------------
 * Why it exists NOW, specifically
 * ---------------------------------------------------------------------------
 *
 * The 6 -> 4 merge put US and UK staging in one project, so staging holds BOTH
 * credential sets and can no longer rehearse the boundary. Losing the rehearsal
 * is acceptable only if production is checked directly — which is what this is.
 * It is listed as a compensating control for the merge, not as an extra.
 *
 * ---------------------------------------------------------------------------
 * It is a lint, not a proof
 * ---------------------------------------------------------------------------
 *
 * It reads secret NAMES. Someone determined can call an ElevenLabs key
 * `tts-key-2` and sail through, exactly as A1.7's PHI lint can be defeated by a
 * computed property name. Both are aimed at the accident, which is the thing
 * that actually happens: a deploy script that copies the full secret set into
 * every project because that was easier than listing them.
 */

/**
 * Vendors whose credentials must never exist in a project that processes PHI
 * under the US HIPAA lane.
 *
 * `match` is checked against a name normalised two ways — see `matchesRule`.
 * Keep the needles DISTINCTIVE; a needle that also matches something innocent
 * turns this from a gate into a thing people disable.
 */
export const FORBIDDEN_IN_PHI_PROJECTS = Object.freeze([
  Object.freeze({
    vendor: "ElevenLabs",
    // `xi-api-key` is ElevenLabs' own header name, and a secret is as likely to
    // be named after the header as after the company.
    squashed: ["elevenlabs", "elevenlab", "11labs"],
    tokenPairs: [["xi", "api"]],
    why:
      "No BAA. This is the credential the entire US/UK project split exists to keep out of " +
      "the US lane — a misconfiguration must yield voicemail, not a disclosure.",
  }),
  Object.freeze({
    vendor: "Gemini Developer API (AI Studio)",
    // Found during A8 and not previously written anywhere: the API-key path is
    // the Gemini Developer API, not a Google Cloud service, and the GCP BAA
    // covers Google Cloud services. An uncovered LLM call carries the caller's
    // entire utterance, which is the largest single disclosure in the stack.
    // The Vertex path IS covered; this rule is about the key, not about Google.
    squashed: ["geminiapikey", "googleaistudio", "generativelanguage"],
    tokenPairs: [],
    why:
      "The API-key path is the Gemini Developer API, which the Google Cloud BAA does not cover. " +
      "Vertex is covered and is what the US lane must use.",
  }),
]);

/**
 * Two normalisations, because secret names are written both ways and a single
 * one produces false positives.
 *
 * `squashed` strips every separator, so `Eleven_Labs-Key` and `elevenlabskey`
 * are the same string. Good for distinctive multi-word vendor names, bad for
 * short needles: `xiapikey` is a substring of `proxiapikey`.
 *
 * `tokens` splits on separators, so a short needle can be matched as a whole
 * word instead. That is what `tokenPairs` uses.
 */
export function normalise(name) {
  const lower = String(name || "").toLowerCase();
  return {
    squashed: lower.replace(/[^a-z0-9]/g, ""),
    tokens: lower.split(/[^a-z0-9]+/).filter(Boolean),
  };
}

/** @returns {boolean} whether `name` names a credential belonging to `rule`. */
export function matchesRule(name, rule) {
  const { squashed, tokens } = normalise(name);

  if (rule.squashed.some((needle) => squashed.includes(needle))) return true;

  // An adjacent token pair — `xi-api-key` matches, `proxi-api-key` does not,
  // because "proxi" is one token and is not "xi".
  return rule.tokenPairs.some(([a, b]) =>
    tokens.some((tok, i) => tok === a && tokens[i + 1] === b)
  );
}

/**
 * @param {string[]} secretNames  Secret names as listed from one project.
 * @returns {Array<{secret: string, vendor: string, why: string}>} Violations.
 */
export function findForbiddenSecrets(secretNames) {
  const violations = [];
  for (const secret of secretNames) {
    for (const rule of FORBIDDEN_IN_PHI_PROJECTS) {
      if (matchesRule(secret, rule)) {
        violations.push({ secret, vendor: rule.vendor, why: rule.why });
      }
    }
  }
  return violations;
}
