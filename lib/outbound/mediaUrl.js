// lib/outbound/mediaUrl.js
/**
 * Signed URLs for `GET /media/outbound/:callSid/:kind.wav` (spec §9.1, plan
 * C15): the door serves the pre-rendered voicemail clip to Twilio's
 * `<Play>`, and this is the only credential that request carries. There is
 * no Twilio signature on that fetch -- `<Play>` is an outbound GET Twilio's
 * media fetcher makes, not a webhook -- so the URL itself has to prove it was
 * minted by us, for THIS call, for THIS kind, and not after it expired.
 *
 * ---------------------------------------------------------------------------
 * Why the path carries the CallSid, not the attemptId (C15)
 * ---------------------------------------------------------------------------
 *
 * The route resolves the tenant with `app_outbound_attempt_by_call_sid`
 * (services/db.js `outboundAttemptByCallSid`, migration 044), which is keyed
 * by CallSid and works before the tenant is known -- exactly the same
 * property the answer and status doors need. Keying this URL by attemptId
 * instead would need a second, redundant definer function over the same
 * directory, for no benefit: Twilio already hands every callback the CallSid.
 *
 * ---------------------------------------------------------------------------
 * Why a fresh key, not the media-stream token's key directly
 * ---------------------------------------------------------------------------
 *
 * `signingKey(env)` (lib/mediaStreamToken.js) is ALREADY a purpose-derived
 * subkey of MEDIA_STREAM_SECRET/TWILIO_AUTH_TOKEN, scoped to the websocket
 * upgrade. Using it unchanged here would let a leak of one credential forge
 * the other. HMAC-ing it again under a second, unrelated label produces an
 * independent key for this purpose alone -- the same domain-separation
 * argument lib/mediaStreamToken.js makes about its own KEY_LABEL, one layer
 * up. `OUTBOUND_MEDIA_URL_SECRET` overrides the whole derivation when set,
 * for rotation without touching either of the other two secrets.
 *
 * ---------------------------------------------------------------------------
 * What is bound into the signature
 * ---------------------------------------------------------------------------
 *
 * callSid + kind + exp, all three. Binding only exp+sig (as a naive "signed
 * URL" might) would let a valid signature for one call's voicemail be replayed
 * against ANY callSid/kind by editing the path -- the path is not itself
 * signed by Twilio or anything else, only by this HMAC.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { signingKey } from "../mediaStreamToken.js";

/** A second, unrelated label over the same base secret (see file header). */
const KEY_LABEL = "vetra:outbound-media:v1";

/** Ten minutes, matching spec §9.1's table. */
const DEFAULT_TTL_S = 600;

/**
 * The separator and the path are the same character. A callSid or kind
 * carrying `.`, `/` or `\` could move the field boundary the signed payload
 * relies on -- the same reasoning mintMediaStreamToken applies to a call SID
 * (lib/mediaStreamToken.js:108-112). Checked at BOTH sign and verify time
 * (fix round 1, item 3): a value that was safe when signed but got mangled in
 * transit must not verify either.
 */
const UNSAFE_ID = /[.\/\\]/;

/** A unix timestamp, decimal digits only, capped at 12 (~31,700 CE). No
 * leading `+`/`-`, no whitespace, nothing parseInt would silently accept a
 * PREFIX of. The exp string is signed and compared VERBATIM -- see
 * verifyMediaUrl -- so this is also what stops "0" + a huge suffix or a
 * reprinted-vs-raw mismatch from ever being a question. */
const EXP_RE = /^\d{1,12}$/;

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Buffer|null} null when neither OUTBOUND_MEDIA_URL_SECRET nor the
 *   base media-stream secret (MEDIA_STREAM_SECRET / TWILIO_AUTH_TOKEN) is set.
 */
function outboundMediaKey(env) {
  const override = (env.OUTBOUND_MEDIA_URL_SECRET || "").trim();
  if (override) return createHmac("sha256", override).update(KEY_LABEL).digest();

  const base = signingKey(env);
  if (!base) return null;
  return createHmac("sha256", base).update(KEY_LABEL).digest();
}

function sign(key, payload) {
  return createHmac("sha256", key).update(payload).digest("hex");
}

/**
 * Mint a signed playback URL for one attempt's rendered clip.
 *
 * @param {object} args
 * @param {string} args.base - the service's own base URL (BASE_URL), no trailing slash
 * @param {string} args.callSid
 * @param {string} args.kind - "voicemail" (spec §9.1) or "transfer_miss" (S3-4, D6); the door's own allow-list (lib/outbound/doorRoutes.js) 404s on anything else -- this module signs and verifies whatever kind string it is given
 * @param {number} [args.ttlSeconds=600]
 * @param {number} [args.now] - ms since epoch; defaults to Date.now()
 * @param {NodeJS.ProcessEnv} [args.env] - defaults to process.env
 * @returns {string} `${base}/media/outbound/${callSid}/${kind}.wav?exp=<unix>&sig=<hex>`
 */
export function signMediaUrl({ base, callSid, kind, ttlSeconds = DEFAULT_TTL_S, now = Date.now(), env = process.env }) {
  const key = outboundMediaKey(env);
  if (!key) {
    throw new Error(
      "signMediaUrl: no signing key available (set OUTBOUND_MEDIA_URL_SECRET, MEDIA_STREAM_SECRET, or TWILIO_AUTH_TOKEN)"
    );
  }
  if (!callSid || UNSAFE_ID.test(callSid)) {
    throw new Error(`signMediaUrl: unusable callSid ${JSON.stringify(callSid)}`);
  }
  if (!kind || UNSAFE_ID.test(kind)) {
    throw new Error(`signMediaUrl: unusable kind ${JSON.stringify(kind)}`);
  }
  // A string from the start, and signed as one (see verifyMediaUrl): the
  // payload is never reconstructed from a re-parsed Number, so there is no
  // second string that reduces to the same signature.
  const exp = String(Math.floor(now / 1000) + ttlSeconds);
  const sig = sign(key, `${callSid}.${kind}.${exp}`);
  return `${base}/media/outbound/${encodeURIComponent(callSid)}/${encodeURIComponent(kind)}.wav?exp=${exp}&sig=${sig}`;
}

/**
 * Verify a signed playback URL's parameters.
 *
 * Returns a reason rather than a bare boolean, matching
 * verifyMediaStreamToken's shape: the door logs WHY a request was refused
 * without ever echoing that reason back to the caller.
 *
 * @param {object} args
 * @param {string} args.callSid
 * @param {string} args.kind
 * @param {string|number} args.exp
 * @param {string} args.sig
 * @param {number} [args.now] - ms since epoch; defaults to Date.now()
 * @param {NodeJS.ProcessEnv} [args.env] - defaults to process.env
 * @returns {{ok: true}|{ok: false, reason: "no_key"|"malformed"|"bad_signature"|"expired"}}
 */
export function verifyMediaUrl({ callSid, kind, exp, sig, now = Date.now(), env = process.env }) {
  const key = outboundMediaKey(env);
  // Fail CLOSED, matching verifyMediaStreamToken: a deployment that cannot
  // verify must refuse, not wave every playback request through.
  if (!key) return { ok: false, reason: "no_key" };

  if (!callSid || UNSAFE_ID.test(callSid)) return { ok: false, reason: "malformed" };
  if (!kind || UNSAFE_ID.test(kind)) return { ok: false, reason: "malformed" };
  if (sig == null) return { ok: false, reason: "malformed" };

  // exp must be exactly a decimal integer string, checked BEFORE it is used
  // in the signed payload -- parseInt silently accepts "123abc" or "007" as a
  // PREFIX, and signing/verifying against the reparsed-and-reprinted number
  // (rather than the raw string) would let a differently-spelled exp with the
  // same numeric value verify against a signature computed over the original
  // spelling (fix round 1, item 3).
  const expStr = String(exp);
  if (!EXP_RE.test(expStr)) return { ok: false, reason: "malformed" };

  const expected = sign(key, `${callSid}.${kind}.${expStr}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig));
  // Length-check first: timingSafeEqual THROWS on a length mismatch, and an
  // exception here would be a 500 where a refusal belongs.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  // Expiry AFTER the signature check, so an expired URL and a forged one are
  // not distinguishable by how long the answer takes.
  if (Number(expStr) * 1000 <= now) return { ok: false, reason: "expired" };

  return { ok: true };
}
