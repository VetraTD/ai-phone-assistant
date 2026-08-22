import twilio from "twilio";
import { log } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// O28 — the vendor half of an Art. 17 erasure.
//
// server.js's degraded voicemail path receives a `RecordingUrl` and files it
// into a customer_requests message. The AUDIO lives at Twilio. eraseCallerData
// deletes rows in OUR database, so an erasure reported success while leaving
// the data subject's recorded voice with a third party indefinitely.
//
// A module of its own, shaped like services/twilioNumbers.js, for one reason
// beyond tidiness: the module boundary is what makes it mockable with vi.mock,
// which is the pattern A3's module-boundary mocks preserved. An erasure test
// must never be one misconfigured environment away from calling Twilio.
// ---------------------------------------------------------------------------

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

/** @type {ReturnType<typeof twilio> | null} */
let twilioClient = null;

if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

/** @returns {boolean} Whether recordings can be deleted at the vendor at all. */
export function isConfigured() {
  return twilioClient !== null;
}

/**
 * A Twilio recording SID is `RE` followed by 32 hex characters.
 *
 * Anchored to the `/Recordings/` path segment on purpose. A recording URL is
 * stored inside a free-text `message` column, and a message column is where a
 * caller's own words end up — so a looser pattern would let a transcript name
 * something deletable. Matching the URL SHAPE, not just the SID shape, is what
 * stops that.
 */
const RECORDING_URL = /\/Recordings\/(RE[0-9a-f]{32})/gi;

/**
 * The recording SID in one URL, or null.
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export function recordingSidFromUrl(url) {
  if (typeof url !== "string" || !url) return null;
  // A fresh regex each call: RECORDING_URL is global and therefore stateful,
  // and sharing `lastIndex` between callers makes results depend on call order.
  const m = new RegExp(RECORDING_URL.source, "i").exec(url);
  return m ? m[1] : null;
}

/**
 * Every distinct recording SID mentioned in a block of text.
 *
 * Takes text rather than a URL because that is what the database actually
 * holds: `Voicemail recording: <url>`. Parsing the stored form rather than an
 * idealised one is the difference between an erasure that works and one that
 * looks like it should.
 *
 * @param {string|null|undefined} text
 * @returns {string[]}
 */
export function recordingSidsInText(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  const re = new RegExp(RECORDING_URL.source, "gi");
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Delete recordings at Twilio.
 *
 * NEVER THROWS. The caller is an erasure, and an erasure that aborts on a
 * vendor error is one that leaves the data subject's database rows in place
 * too. It reports instead, and the route decides what that means.
 *
 * Three outcomes per recording, and the middle one matters:
 *
 *   deleted      gone now.
 *   alreadyGone  a 404. Counted as SUCCESS, because erasure has to be safely
 *                re-runnable: an operator whose first attempt half-failed will
 *                run it again, and the half that worked must not report a
 *                failure forever.
 *   failed       anything else. The audio may still exist, so the erasure is
 *                not complete and must not be reported as such.
 *
 * Sequential, not Promise.all. A subject with a dozen voicemails is not worth
 * a burst against a rate limit on a path that runs by hand, a few times a year.
 *
 * @param {string[]} sids
 * @returns {Promise<{ok: boolean, deleted: string[], alreadyGone: string[], failed: string[], reason: string|null}>}
 */
export async function deleteRecordings(sids) {
  const result = { ok: true, deleted: [], alreadyGone: [], failed: [], reason: null };
  const list = (sids || []).filter(Boolean);
  if (list.length === 0) return result;

  if (!twilioClient) {
    // NOT "nothing to delete, so complete". An unconfigured vendor cannot prove
    // the audio is gone, and an erasure that cannot prove it must not claim it.
    // The dangerous version of this function returns ok:true here.
    result.ok = false;
    result.failed = [...list];
    result.reason = "twilio_not_configured";
    log.error("dsr_recording_delete_unavailable", {
      count: list.length,
      reason: "twilio_not_configured",
      severity: "warn",
    });
    return result;
  }

  for (const sid of list) {
    try {
      await twilioClient.recordings(sid).remove();
      result.deleted.push(sid);
    } catch (err) {
      const status = err?.status ?? err?.statusCode ?? null;
      if (status === 404) {
        result.alreadyGone.push(sid);
        continue;
      }
      // Keep going. Stopping at the first error would leave recordings at
      // Twilio that could have been deleted, and the operator has no way to
      // know which.
      result.failed.push(sid);
      result.ok = false;
      result.reason = result.reason ?? `${status ?? "error"}: ${err?.message ?? "unknown"}`;
      log.error("dsr_recording_delete_failed", {
        // The SID is a Twilio identifier for a stored object. The audio behind
        // it, and the number that left it, are not in this line.
        recordingSid: sid,
        status,
        message: err?.message,
        severity: "warn",
      });
    }
  }

  return result;
}
