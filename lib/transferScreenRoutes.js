// transferScreenRoutes.js -- the two documents behind inbound transfer screening.
//
// A screened transfer dials the dispatcher with <Number url=".../transfer-whisper">.
// Twilio asks that URL what the dispatcher's leg should do before it bridges:
//   1. /twilio/transfer-whisper plays the sentence twice inside a one-digit gather.
//   2. /twilio/transfer-accept is the gather's action. Digit 1, stamped on the
//      pending dial, answers with an empty Response (Twilio bridges). Anything
//      else hangs up the dispatcher's leg and nothing is stamped, which is what
//      /twilio/transfer-result later reads to send the caller to our message step.
//
// Every failure answers with a hangup, never a bridge: a dispatcher leg that
// cannot be confirmed is not connected to the caller.
//
// Fields read from Twilio, each as the outbound whisper route already reads
// them (lib/outbound/doorRoutes.js): ParentCallSid (the caller's call; the
// request's own CallSid is the new child leg and is registered nowhere) and, on
// the gather action, Digits. No caller data is logged.

import { buildTransferWhisperTwiml, buildTransferAcceptTwiml, TRANSFER_WHISPER_PATH, TRANSFER_ACCEPT_PATH } from "./twiml.js";
import { resolveProfile } from "./voice/voiceLocale.js";

const HANGUP = "<Response><Hangup/></Response>";

/**
 * @param {import("express").Express} app
 * @param {{ validate: Function, db: object, log: object, baseUrl: string }} deps
 */
export function registerTransferScreenRoutes(app, { validate, db, log, baseUrl }) {
  app.post(TRANSFER_WHISPER_PATH, validate, async (req, res) => {
    res.type("text/xml");
    const parentCallSid = req.body?.ParentCallSid || "";
    const queryBusiness = req.query?.b || "";
    try {
      const businessId = await db.pendingDialBusiness(parentCallSid);
      if (!businessId || (queryBusiness && queryBusiness !== businessId)) {
        log.info("transfer_whisper_refused", { parentCallSid, reason: !businessId ? "no_dial" : "business_mismatch" });
        return res.send(HANGUP);
      }
      const business = await db.withTenant(businessId, () => db.fetchBusinessById(businessId));
      if (!business) {
        log.error("transfer_whisper_no_business", { parentCallSid, severity: "warn" });
        return res.send(HANGUP);
      }
      const config = db.loadConfig(business);
      const text = config.transferWhisper || `Call from the ${config.businessName} AI receptionist. Press 1 to take it.`;
      return res.send(
        buildTransferWhisperTwiml({
          text,
          sayVoice: resolveProfile(config).twimlSayVoice,
          actionUrl: `${baseUrl}${TRANSFER_ACCEPT_PATH}`,
        })
      );
    } catch (err) {
      log.error("transfer_whisper_failed", { parentCallSid, message: err?.message, severity: "warn" });
      return res.send(HANGUP);
    }
  });

  app.post(TRANSFER_ACCEPT_PATH, validate, async (req, res) => {
    res.type("text/xml");
    const parentCallSid = req.body?.ParentCallSid || "";
    if (req.body?.Digits !== "1") {
      log.info("transfer_not_accepted", { parentCallSid, pressed: req.body?.Digits ? "other" : "none" });
      return res.send(buildTransferAcceptTwiml(false));
    }
    // One retry: a transient database error must not cost a real accept.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const stamped = await db.acceptPendingDial(parentCallSid);
        if (stamped > 0) return res.send(buildTransferAcceptTwiml(true));
        log.error("transfer_accept_not_stamped", { parentCallSid, attempt, rows: stamped ?? null, severity: "warn" });
      } catch (err) {
        log.error("transfer_accept_stamp_failed", { parentCallSid, attempt, message: err?.message, severity: "warn" });
      }
    }
    // Never bridge an accept that was not stamped: the caller would then be
    // told nobody could get to the phone after a real conversation.
    log.error("transfer_accept_failed_closed", { parentCallSid, severity: "error" });
    return res.send(buildTransferAcceptTwiml(false));
  });
}
