/**
 * Per-call credentials for the media-stream WebSocket (ledger P10).
 *
 * ---------------------------------------------------------------------------
 * The hole this closes
 * ---------------------------------------------------------------------------
 *
 * `/twilio/media-stream` used to accept ANY upgrade that hit the path. No
 * signature, no token, nothing — while `/twilio/probe-stream` two lines below
 * it required `DEBUG_TOKEN`. `businessPhone` then arrived inside
 * attacker-controlled `customParameters`, so anyone who knew the URL could open
 * a session against any tenant they could name.
 *
 * That is not only a data question, it is a bill and an outage: every accepted
 * socket opens a Deepgram stream, drives Gemini turns and synthesises speech,
 * and ten concurrent sockets exhaust the entire measured ElevenLabs concurrency
 * cap (docs/capacity.md), which real callers are sharing. It was demonstrated
 * with `scripts/load-test-calls.js`: 30 concurrent calls against a real tenant,
 * no credential of any kind.
 *
 * ---------------------------------------------------------------------------
 * Why a signed token and not a stored nonce
 * ---------------------------------------------------------------------------
 *
 * The whole point of Phase 3 is that there is more than one instance. A nonce
 * minted by the instance that served `/twilio/voice` and looked up by the
 * instance that receives the upgrade is the SAME cross-instance state problem
 * `call_state` exists to solve — and putting it in Postgres would add a
 * synchronous database read to the pickup path, which is the one path where
 * latency is the product.
 *
 * A keyed MAC needs no shared state at all: any instance holding the key can
 * verify what any other instance minted.
 *
 * ---------------------------------------------------------------------------
 * Why the token is in the PATH and not a query string
 * ---------------------------------------------------------------------------
 *
 * Because Twilio does not carry a `<Stream url="...">` query string through to
 * the websocket handshake. A `?token=` form arrives EMPTY and the upgrade is
 * refused with a 31920 that looks exactly like a broken endpoint. This is not a
 * guess — `probeUpgradeAllowed` in server.js records having been bitten by it,
 * and this follows the shape that already works.
 *
 * ---------------------------------------------------------------------------
 * Why no new secret
 * ---------------------------------------------------------------------------
 *
 * The signing key is DERIVED from `TWILIO_AUTH_TOKEN` rather than being a new
 * variable, so this needs nothing provisioned in Secret Manager or Terraform —
 * which Phase 3 must not touch — and cannot ship half-configured. It is a
 * derived subkey, not the token itself, so a leak of one does not hand over the
 * other. `MEDIA_STREAM_SECRET` overrides it for rotation without touching the
 * Twilio credential.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Domain separation. A key used for two purposes is one purpose away from a bug. */
const KEY_LABEL = "vetra:media-stream-token:v1";

/** Minted at pickup, used seconds later. Generous, and nowhere near a call's length. */
const DEFAULT_TTL_S = 300;

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Buffer|null} the signing key, or null when nothing can sign.
 */
function signingKey(env) {
  const override = (env.MEDIA_STREAM_SECRET || "").trim();
  if (override) return createHmac("sha256", override).update(KEY_LABEL).digest();

  const twilio = (env.TWILIO_AUTH_TOKEN || "").trim();
  if (!twilio) return null;
  return createHmac("sha256", twilio).update(KEY_LABEL).digest();
}

/** Whether this deployment can mint/verify at all. */
export function mediaStreamTokenAvailable(env = process.env) {
  return signingKey(env) !== null;
}

/**
 * Is the upgrade required to carry a valid token?
 *
 * Tied to `TWILIO_VALIDATE_SIGNATURE` deliberately: it is the same threat model
 * and the same answer to "is this request really from Twilio", so it should not
 * be possible to turn one off believing the other still holds. One switch, and
 * the boot log says which way it is set.
 */
export function mediaStreamTokenRequired(env = process.env) {
  return env.TWILIO_VALIDATE_SIGNATURE !== "false";
}

function sign(key, payload) {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/**
 * Mint a token binding one call SID, for a short window.
 *
 * @param {string} callSid
 * @param {{ env?: NodeJS.ProcessEnv, ttlSeconds?: number, now?: number }} [opts]
 * @returns {string|null} null when this deployment holds no key.
 */
export function mintMediaStreamToken(callSid, { env = process.env, ttlSeconds = DEFAULT_TTL_S, now = Date.now() } = {}) {
  const key = signingKey(env);
  if (!key) return null;
  if (!callSid || /[.\/\\]/.test(callSid)) {
    // The separator and the path are the same character set. A call SID
    // carrying one would let a crafted value move the field boundary.
    throw new Error(`mintMediaStreamToken: unusable call SID "${callSid}"`);
  }
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const payload = `${exp}.${callSid}`;
  return `${payload}.${sign(key, payload)}`;
}

/**
 * Verify a token and recover the call SID it is bound to.
 *
 * Returns the SID rather than a bare boolean because the binding is half the
 * control: without checking it against the `start` frame, one valid token would
 * authorise a session for any OTHER call the attacker cared to name.
 *
 * @param {string|null|undefined} token
 * @param {{ env?: NodeJS.ProcessEnv, now?: number }} [opts]
 * @returns {{ ok: boolean, callSid: string|null, reason: string|null }}
 */
export function verifyMediaStreamToken(token, { env = process.env, now = Date.now() } = {}) {
  const key = signingKey(env);
  // Fail CLOSED, matching twilioValidation: a deployment that cannot verify
  // must refuse, not wave everything through.
  if (!key) return { ok: false, callSid: null, reason: "no_key" };
  if (!token) return { ok: false, callSid: null, reason: "missing" };

  const parts = String(token).split(".");
  if (parts.length !== 3) return { ok: false, callSid: null, reason: "malformed" };

  const [expRaw, callSid, supplied] = parts;
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp)) return { ok: false, callSid: null, reason: "malformed" };

  const expected = sign(key, `${expRaw}.${callSid}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(supplied));
  // Length-check first: timingSafeEqual THROWS on a length mismatch, and an
  // exception here would be a 500 where a refusal belongs.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, callSid: null, reason: "bad_signature" };
  }

  // Expiry AFTER the signature check, so an expired token and a forged one are
  // not distinguishable by how long the answer takes.
  if (exp * 1000 <= now) return { ok: false, callSid: null, reason: "expired" };

  return { ok: true, callSid, reason: null };
}

/**
 * Pull the token out of `/twilio/media-stream/<token>`.
 *
 * @param {string} pathname
 * @param {string} basePath
 * @returns {string|null}
 */
export function tokenFromPath(pathname, basePath) {
  if (!pathname.startsWith(`${basePath}/`)) return null;
  const raw = pathname.slice(basePath.length + 1);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
