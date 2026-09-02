import { GoogleGenAI } from "@google/genai";
import { assertVendorAllowed } from "../../compliance.js";
import { log } from "../../logger.js";

// ---------------------------------------------------------------------------
// The Live model client. One branch, because the surface will move.
//
// docs/speech-to-speech-handoff.md section 2 decides the model:
// gemini-3.1-flash-live-preview, on AI Studio. Behaviourally it is the clear
// winner -- 0 tool duplicates in 26 trials against 2.5's 15, 0 doubled
// utterances in 90 turns against 2.5's 5 in 33 -- and the one objection, that
// AI Studio might train on prompts, was resolved on 2026-09-02: the paid tier
// does not use data for model training.
//
// What that choice costs, recorded here because it is the reason this file has
// a branch at all:
//
//   - US transfer, not EEA.
//   - No Cloud Audit Logs, no VPC-SC, no CMEK on the model leg. It is egress
//     to a public API.
//   - A `-preview` model. It will move, change, or be withdrawn.
//   - Moving the LLM leg from Vertex to AI Studio is a DOWNGRADE in posture
//     against what the cascade does today. A deliberate trade of audit surface
//     for measured behaviour, not an oversight.
//
// Revisit when 3.1 ships GA on Vertex: at that point the trade disappears and
// this becomes LIVE_SURFACE=vertex.
//
// Vertex is not a fallback TODAY, and the tests say so rather than implying
// otherwise: Vertex serves exactly one Live model
// (gemini-live-2.5-flash-native-audio), only in europe-west1 and us-central1,
// and returns "Publisher model not found" for 3.1 in all three regions probed.
// europe-west2 (London) serves no Live model at all -- HTTP 400 at the
// WebSocket upgrade, every candidate.
// ---------------------------------------------------------------------------

/** Tier 1. Decided; see the header. Overridable so a withdrawal is a variable. */
export const LIVE_MODEL_DEFAULT = "gemini-3.1-flash-live-preview";

/**
 * Which surface serves the Live session.
 *
 * Defaults to AI Studio because that is the only place the tier-1 model exists.
 * An unrecognised value resolves to the default rather than throwing: this is
 * read while a caller is on the line, and a typo in a deploy variable should
 * not be the thing that drops the call.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"aistudio"|"vertex"}
 */
export function liveSurface(env = process.env) {
  return String(env.LIVE_SURFACE || "").trim().toLowerCase() === "vertex" ? "vertex" : "aistudio";
}

/**
 * Build the client for the configured surface.
 *
 * The refusal sits HERE, at construction, for the reason lib/compliance.js
 * spells out: a guard at provider selection, or behind a breaker, or in a
 * config check, is a guard with doors next to it. There is exactly one place a
 * Live client comes into existence.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{GenAI?: Function}} [deps] - test seam for the SDK constructor
 */
export function createLiveClient(env = process.env, { GenAI = GoogleGenAI } = {}) {
  const surface = liveSurface(env);

  if (surface === "vertex") {
    const project = (env.GOOGLE_CLOUD_PROJECT || "").trim();
    const location = (env.VERTEX_LOCATION || "europe-west1").trim();
    if (!project) {
      // Refused rather than falling back to the key. The operator asked for the
      // covered backend; handing them the uncovered one silently is the exact
      // failure services/gemini.js getClient() already refuses to make.
      throw new Error(
        "LIVE_SURFACE=vertex but GOOGLE_CLOUD_PROJECT is not set. Refusing to fall back to " +
          "the Gemini Developer API, which the Google Cloud BAA does not cover. Note that " +
          "Vertex serves no gemini-3.1-flash-live-preview in any region as of 2026-09-02."
      );
    }
    // No apiKey: Vertex authenticates with Application Default Credentials.
    return new GenAI({ vertexai: true, project, location });
  }

  // The Gemini Developer API (AI Studio). NOT a Google Cloud service, so the
  // Google Cloud BAA does not reach it, and an uncovered LLM call carries the
  // caller's entire utterance -- the largest single disclosure in the stack if
  // it is got wrong.
  assertVendorAllowed("gemini-developer-api");

  const apiKey = (env.GEMINI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set and LIVE_SURFACE is not vertex. The key belongs in Secret " +
        "Manager (scripts/push-secrets.js), not .env."
    );
  }
  return new GenAI({ apiKey });
}

/**
 * Open a Live session, and record whether the language code survived.
 *
 * ---------------------------------------------------------------------------
 * Why the retry exists when the thing it guards against did not happen
 * ---------------------------------------------------------------------------
 *
 * Handoff section 4 asserted, from vendor documentation, that Live native
 * audio "does not accept an explicit language code -- it auto-detects". The
 * spike set `en-GB` anyway and it was accepted on 9 of 9 calls with no error
 * and no fallback, which puts that claim in section 3's retraction table.
 *
 * Accepted is not honoured, and 3.1 is preview: a key it accepts today is not
 * one it accepts after the next model revision. So the retry stays, and
 * `languagePinned` is REPORTED per call rather than assumed either way. It
 * costs one branch and turns a doc claim into a measurement every call.
 *
 * The voice deliberately survives the retry. Dropping the whole speechConfig
 * would silently change how the assistant sounds, mid-incident, which is a
 * worse failure than the one being recovered from.
 *
 * @param {object} opts
 * @param {object} opts.config - the Live session config
 * @param {object} opts.callbacks - onmessage / onerror / onclose
 * @param {string} [opts.model]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {{GenAI?: Function}} [opts.deps]
 * @returns {Promise<{session: object, languagePinned: boolean, surface: string, model: string}>}
 */
export async function connectLive({ config, callbacks, model, env = process.env, deps = {} }) {
  const surface = liveSurface(env);
  const resolvedModel = model || env.LIVE_MODEL || LIVE_MODEL_DEFAULT;
  const client = createLiveClient(env, deps);

  try {
    const session = await client.live.connect({ model: resolvedModel, config, callbacks });
    return { session, languagePinned: Boolean(config?.speechConfig?.languageCode), surface, model: resolvedModel };
  } catch (err) {
    const message = err?.message || String(err);
    if (!/language_?code|speech_?config/i.test(message) || !config?.speechConfig?.languageCode) {
      // Not a language problem. A real outage must surface as itself rather
      // than as a mysterious second attempt.
      throw err;
    }

    log.error("live_language_code_rejected", {
      model: resolvedModel,
      languageCode: config.speechConfig.languageCode,
      reason: message.slice(0, 200),
      severity: "warn",
    });

    const { languageCode, ...speechConfig } = config.speechConfig;
    const session = await client.live.connect({
      model: resolvedModel,
      config: { ...config, speechConfig },
      callbacks,
    });
    return { session, languagePinned: false, surface, model: resolvedModel };
  }
}
