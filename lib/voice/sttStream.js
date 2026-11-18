import { IS_HIPAA_MODE } from "../deploymentMode.js";
import { log } from "../logger.js";
import { createDeepgramSttStream, deepgramEnvironment } from "./sttDeepgram.js";
import { createGoogleSttStream } from "./sttGoogle.js";

// ---------------------------------------------------------------------------
// The STT seam.
//
// ONE call site (lib/voice/session.js), six provider-agnostic callbacks, two
// implementations behind it:
//
//   `hipaa`    -> sttGoogle.js    Google Speech-to-Text v2, covered by the
//                                 Google Cloud BAA accepted 2026-08-20.
//   `standard` -> sttDeepgram.js  Deepgram nova-3. The UK lane and local dev.
//
// This split is not a preference. A6 refuses a Deepgram client at
// construction because no BAA covers it, which left `DEPLOYMENT_MODE=hipaa`
// with no speech-to-text at all: server.js exited WITHOUT a Deepgram key and
// bootChecks exited WITH one in hipaa mode, and no configuration resolved
// that. Deepgram is not being replaced — the UK keeps it (2026-08-19: GDPR has
// no covered-products restriction, an Art. 28 DPA suffices, and it is both
// cheaper and the vendor this pipeline's turn-taking was tuned against).
//
// ---------------------------------------------------------------------------
// Why the tier decides and an environment variable does not
// ---------------------------------------------------------------------------
//
// There is no STT_PROVIDER. A provider variable is exactly the kind of thing
// that gets copied between environments in a hurry, and the failure it
// produces is silent: a `hipaa` stack that answers calls perfectly while
// streaming patient speech to a vendor with no BAA. That is a reportable
// disclosure that looks like everything working.
//
// The tier comes from lib/compliance.js `effectiveTier(business)`, which is
// already the STRICTER of the deployment and the tenant. Selection honours
// that ratchet in the one direction it moves: a `hipaa` tenant on a
// `standard` deployment gets Google, and a `standard` tenant can never pull a
// `hipaa` deployment back to Deepgram.
//
// Defence in depth is unchanged. sttDeepgram.js still calls
// assertVendorAllowed("deepgram") inside its own constructor, so even a bug in
// this file cannot produce a Deepgram client in a covered process.
// ---------------------------------------------------------------------------

/** Kept exported here: lib/probe and the region tests read it from this path. */
export { deepgramEnvironment };

/**
 * Which STT provider serves a call at this tier.
 *
 * Pure and exported so the decision can be tested directly rather than
 * inferred from which client happened to be constructed.
 *
 * @param {"standard"|"hipaa"} [tier] - from effectiveTier(business)
 * @returns {"google"|"deepgram"}
 */
export function sttProviderFor(tier) {
  const covered = IS_HIPAA_MODE || String(tier || "").trim().toLowerCase() === "hipaa";
  return covered ? "google" : "deepgram";
}

/**
 * Open a streaming STT connection for one call.
 *
 * The returned handle and all six callbacks are identical across providers —
 * that identity is what makes this a seam rather than a branch. Callers do not
 * know, and must not need to know, which vendor is transcribing.
 *
 * @param {object} opts
 * @param {"standard"|"hipaa"} [opts.tier] - compliance tier for THIS call
 * @param {string}   [opts.language="en-US"]
 * @param {number}   [opts.endpointing]    - Deepgram only; Google has no ms knob
 * @param {string[]} [opts.keyterms=[]]
 * @param {string}   [opts.callSid]
 * @param {function} [opts.onFinal]
 * @param {function} [opts.onInterim]
 * @param {function} [opts.onUtteranceEnd]
 * @param {function} [opts.onSpeechStarted]
 * @param {function} [opts.onError]
 * @param {function} [opts.onReconnect]
 * @param {function} [opts.now]
 * @returns {Promise<{sendAudio: function(Buffer): void, close: function(): void, isAlive: function(): boolean, getLastSpeechEndAt: function(): number|null}>}
 */
export async function createSttStream({ tier, ...opts } = {}) {
  const provider = sttProviderFor(tier);
  log.info("stt_provider_selected", { callSid: opts.callSid ?? null, provider, tier: tier ?? null });

  if (provider === "google") {
    // `endpointing` is a Deepgram millisecond window. Google exposes no
    // equivalent — measured across all three sensitivity levels the spread was
    // inside the noise — so it is dropped rather than passed to be ignored.
    const { endpointing, ...googleOpts } = opts;
    return createGoogleSttStream(googleOpts);
  }

  return createDeepgramSttStream(opts);
}
