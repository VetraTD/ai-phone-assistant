// lib/outbound/callContext.js
/**
 * The Live session's outbound call context (spec §9.2), resolved BY CALLSID.
 *
 * IDENTITY. The only input is the CallSid the signed stream token bound
 * (`ws.authorizedCallSid`, server.js). Stream parameters -- `businessPhone`,
 * `callerPhone`, even `direction` -- are chosen by whoever opened the socket,
 * and LIVE_BUSINESS_PHONE is a developer override; none of them is read here.
 * The tenant comes from Task 12's resolver (`outboundAttemptByCallSid`, the
 * `app_outbound_attempt_by_call_sid` definer, Ruling P-0), and every read
 * after it runs under `withTenant(<that tenant>)`, so RLS only ever shows this
 * call's own rows.
 *
 * THE BUSINESS CONFIG is built the way inbound builds it: the business row
 * plus its `business_capabilities` rows (the shape `lookupBusinessByPhone`
 * returns), handed to the SAME `loadConfig` by the session. Plan correction
 * C7: `fetchBusinessById` + `fetchBusinessCapabilities`, no new lookup. The
 * campaign's own config is a separate field (`config`) and never replaces it.
 *
 * THE OPENER TEXT is re-rendered from the CURRENT values at call time (owner
 * decision O-4): a business renamed since dispatch can push it over its
 * 120-character budget, and then the stored clip is not used -- the session
 * takes the prompt path (`outbound_backstop_missing`) -- and the refusal is
 * logged. The text itself is never truncated.
 */
import { renderCampaignLine, CAMPAIGN_LIMITS } from "./campaignSchema.js";
import { contactTimezone } from "./schedule.js";
import { log as defaultLog } from "../logger.js";

/** The trigger summary's length cap, in characters. It goes into the prompt. */
export const TRIGGER_SUMMARY_MAX = 300;

/**
 * The opener TEXT, rendered by the SAME function dispatch renders the clip
 * text with (campaignSchema.js renderCampaignLine; fix round 2, O-9). They must
 * agree -- the seeded text is what Live believes it said, and the clip is what
 * the person heard.
 *
 * @param {{config: object, firstName: string|null, businessName: string}} args
 * @returns {string|null} null when there is no usable line (no first name and
 *   the remainder lacks the business name or the AI disclosure)
 */
export function renderOpenerText({ config, firstName, businessName }) {
  return renderCampaignLine(config?.opener, { firstName, businessName, config });
}

/**
 * A one-line summary of why this person is being called, from
 * `outreach.trigger` (spec §6: "source plus the raw normalised payload").
 * Scalar data fields only -- nested objects and nulls are skipped -- and
 * bounded, because it is prompt text.
 *
 * @param {object|null} trigger
 * @returns {string}
 */
export function summarizeTrigger(trigger) {
  if (!trigger || typeof trigger !== "object") return "";
  const parts = [];
  if (typeof trigger.source === "string" && trigger.source.trim()) parts.push(`source: ${trigger.source.trim()}`);
  const data = trigger.data && typeof trigger.data === "object" && !Array.isArray(trigger.data) ? trigger.data : null;
  if (data) {
    for (const [key, value] of Object.entries(data)) {
      if (value === null || value === undefined || typeof value === "object") continue;
      parts.push(`${key}: ${String(value)}`);
    }
  }
  const summary = parts.join("; ");
  return summary.length > TRIGGER_SUMMARY_MAX ? summary.slice(0, TRIGGER_SUMMARY_MAX) : summary;
}

/**
 * @param {string} callSid - the CallSid the stream token bound, never a stream parameter
 * @param {{db: object, log?: object}} deps - `db` is services/db.js (or a fake with the same functions)
 * @returns {Promise<null | {
 *   businessId: string, attemptId: string, outreachId: string, campaignId: string, campaignVersion: number,
 *   contactId: string, attemptNo: number, config: object,
 *   campaign: {templateKey: string, complianceClass: string, audience: string},
 *   contact: {firstName: string|null, lastName: string|null, timezone: string, rawTimezone: string|null, phone: string},
 *   triggerSummary: string, details: object, openerText: string|null, openerAudio: Buffer|null, openerRefused: boolean,
 *   business: object,
 * }>} null when the CallSid is not an outbound attempt this service placed. Throws on a database error.
 */
export async function resolveOutboundContext(callSid, { db, log = defaultLog } = {}) {
  if (!callSid) return null;

  const hit = await db.outboundAttemptByCallSid(callSid);
  if (!hit) return null;

  return db.withTenant(
    hit.businessId,
    async () => {
      const row = await db.outboundCallContext(hit.attemptId);
      if (!row) return null;
      const business = await db.fetchBusinessById(hit.businessId);
      if (!business) return null;
      const capabilityRows = await db.fetchBusinessCapabilities(hit.businessId);

      const openerText = renderOpenerText({ config: row.config, firstName: row.firstName, businessName: business.name });
      let openerAudio = row.openerAudio ?? null;
      let openerRefused = false;
      if (openerText === null) {
        // O-9: no usable line (no first name, and what is left lacks the
        // business name or the disclosure). Dispatch refused it with the same
        // renderer, so no clip should exist; if one does, it is not used.
        log.error("outbound_backstop_render_refused", { attemptId: hit.attemptId, reason: "unusable_line" });
        openerAudio = null;
        openerRefused = true;
      } else if (openerText.length > CAMPAIGN_LIMITS.rendered_opener) {
        // O-4 at call time: refused, never truncated -- the same outcome as a
        // failed render. The session prompts Live with the (full) line instead,
        // and must not re-read a stored clip later either (openerRefused).
        log.error("outbound_backstop_render_refused", { attemptId: hit.attemptId, chars: openerText.length });
        openerAudio = null;
        openerRefused = true;
      }

      return {
        businessId: hit.businessId,
        attemptId: hit.attemptId,
        outreachId: hit.outreachId,
        campaignId: hit.campaignId,
        campaignVersion: hit.campaignVersion,
        contactId: row.contactId,
        attemptNo: row.attemptNo,
        config: row.config,
        campaign: { templateKey: row.templateKey, complianceClass: row.complianceClass, audience: row.audience },
        contact: {
          // Blank is absent (O-9): the prompt must never be handed "" to say.
          firstName: typeof row.firstName === "string" && row.firstName.trim() ? row.firstName.trim() : null,
          // 2026-10-02: the surname the lead typed, so a booking made for them
          // uses the name on file instead of asking them to spell it
          // (services/tools.js outboundNameOnFile). Blank is absent, as above.
          lastName: typeof row.lastName === "string" && row.lastName.trim() ? row.lastName.trim() : null,
          timezone: contactTimezone({ timezone: row.contactTimezone, phone_e164: row.toNumber }, business.timezone),
          // S3-7 fix round 1 (review Important #2): the RAW contacts.timezone
          // column (row.contactTimezone is already null-safe -- db.js's
          // outboundCallContext does `row.contact_timezone ?? null`), kept
          // ALONGSIDE the resolved `timezone` above rather than replacing it.
          // capabilities/callback.js's floor check needs the true absence to
          // apply the US "no timezone on file" dual-zone rule; every other
          // reader (parsing, display) keeps using the resolved `timezone`.
          rawTimezone: row.contactTimezone,
          // The DIALLED number (call_attempts.to_number): "the other party"
          // for calls.caller_number (spec §6.2) and the future ctx.party.
          phone: row.toNumber,
        },
        triggerSummary: summarizeTrigger(row.trigger),
        // S3-9: the per-person facts (S3-6) stored on the outreach row,
        // carried onto ctx.outboundCall.details -- lib/voice/live/index.js's
        // onStart spreads this WHOLE object (minus `business`) onto
        // state.outboundCall, and lib/outbound/prompt.js's outboundCallBlock
        // reads outbound.details from there. Never in the opener/voicemail:
        // renderOpenerText above has no access to it at all.
        details: row.details && typeof row.details === "object" && !Array.isArray(row.details) ? row.details : {},
        openerText,
        openerAudio,
        openerRefused,
        // lookupBusinessByPhone's shape (b.* + business_capabilities), for the
        // session's own loadConfig(business) -- one argument, as inbound.
        business: { ...business, business_capabilities: capabilityRows },
      };
    },
    { actor: { type: "voice", id: callSid }, callSid }
  );
}
