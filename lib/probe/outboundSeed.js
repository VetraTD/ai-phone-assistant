// ---------------------------------------------------------------------------
// The DATABASE half of scripts/live-call-harness.js --outbound: seed an
// attempt the local server can answer, render its backstop clip exactly as
// dispatch would, read the call back afterwards, and clean up.
//
// LOCAL ONLY. seedOutboundAttempt re-checks assertLocalDatabase at the point
// of writing (the CLI already refused at startup): a fake tenant must never be
// written anywhere but the vetra-pg16 container.
//
// SEEDED THROUGH THE EXISTING WRITERS, not a parallel copy of them:
//   - the business: plain SQL (nothing in services/db.js creates one), then
//     scripts/outbound-admin.js setBusinessOutbound;
//   - the campaign and its version: outbound-admin.js upsertCampaign, which
//     runs validateCampaign on the speed_to_lead template, then
//     setCampaignStatus active;
//   - the contact and the outreach: outbound-admin.js triggerOutreach;
//   - the attempt: services/db.js insertCallAttempt + markOutreachDialing +
//     setAttemptCallSid inside withTenant, the same calls dispatch makes --
//     so the directory trigger routes the CallSid exactly as it would for a
//     real dial, and outboundAttemptByCallSid (the door's own resolver) is
//     what the read-back uses.
// Every write is asserted: the admin functions read back inside their own
// transaction, the db.js ones throw on a zero-row write, and the seed ends by
// resolving the CallSid the way the server will.
// ---------------------------------------------------------------------------
import { upsertCampaign, setCampaignStatus, setBusinessOutbound, triggerOutreach } from "../../scripts/outbound-admin.js";
import { TEMPLATES } from "../outbound/templates.js";
import { assertLocalDatabase, dispatchLines, createRenderTap, summarizeRenderSessions } from "./outboundHarness.js";

/** A clearly-labelled test tenant: the name is spoken in the clip, so it is a plausible one. */
export const HARNESS_BUSINESS_NAME = "Harness Test Clinic";
export const HARNESS_CAMPAIGN_NAME = "live-call-harness: speed to lead";
export const HARNESS_FIRST_NAME = "Sam";

const ACTOR = { actor: { type: "system", id: "live-call-harness" } };

function must(result, step) {
  if (!result?.ok) {
    const why = result?.error || JSON.stringify(result?.errors ?? result);
    throw new Error(`seed: ${step} refused: ${why}`);
  }
  return result;
}

/** The dispatch row shape dispatchLines and the render adapter read. */
export function dispatchRowFor(seed) {
  return {
    id: seed.outreachId,
    business_id: seed.businessId,
    config: seed.config,
    first_name: seed.firstName,
    business_name: seed.businessName,
    compliance_class: seed.complianceClass,
  };
}

/**
 * @param {object} a
 * @param {import("pg").Client} a.admin - a connected client on the LOCAL database
 * @param {typeof import("../../services/db.js")} a.db - services/db.js, on the same database
 * @param {string} a.databaseUrl - what both were connected with; re-checked here
 * @param {string} a.callSid - the synthetic CAharness... SID
 * @param {string} a.callerId - OUR number, 07700 900xxx
 * @param {string} a.contact - the person's number, 07700 900yyy
 */
export async function seedOutboundAttempt({ admin, db, databaseUrl, callSid, callerId, contact, firstName = HARNESS_FIRST_NAME, businessName = HARNESS_BUSINESS_NAME, configPatch = null }) {
  assertLocalDatabase(databaseUrl);

  const clash = await admin.query("SELECT 1 FROM business_directory WHERE phone_number = $1", [callerId]);
  if (clash.rowCount > 0) throw new Error(`seed: ${callerId} already belongs to a business; not seeding over it`);

  const biz = await admin.query(
    "INSERT INTO businesses (name, phone_number, timezone) VALUES ($1, $2, 'Europe/London') RETURNING id",
    [businessName, callerId]
  );
  if (biz.rowCount !== 1) throw new Error(`seed: business insert landed ${biz.rowCount} rows`);
  const businessId = biz.rows[0].id;

  try {
    must(await setBusinessOutbound(admin, { businessPhone: callerId, enabled: true, max: 2, confirm: true }), "setBusinessOutbound");

    // 2026-10-01: a script may patch the template (lib/probe/script.js OUTBOUND_SCRIPT_CONFIG).
    const config = { ...structuredClone(TEMPLATES.speed_to_lead), ...structuredClone(configPatch || {}), caller_id: callerId };
    const meta = { name: HARNESS_CAMPAIGN_NAME, template_key: "speed_to_lead", compliance_class: "solicited", audience: "business" };
    const camp = must(await upsertCampaign(admin, { businessPhone: callerId, meta, config, confirm: true }), "upsertCampaign");
    if (camp.businessId !== businessId) throw new Error("seed: the campaign landed on a different business");
    must(await setCampaignStatus(admin, { businessPhone: callerId, campaignId: camp.campaignId, status: "active", confirm: true }), "setCampaignStatus");

    const trig = must(
      await triggerOutreach(admin, { businessPhone: callerId, campaignId: camp.campaignId, phone: contact, timezone: null, firstName, consentManual: false, confirm: true }),
      "triggerOutreach"
    );
    if (!trig.created) throw new Error("seed: triggerOutreach found an existing outreach instead of creating one");

    // Attempt 1, as dispatch writes it: the insert and the state move in one
    // unit of work, then the CallSid Twilio "returned".
    const attemptId = await db.withTenant(
      businessId,
      async () => {
        const ins = await db.insertCallAttempt({ outreachId: trig.outreachId, attemptNo: 1, fromNumber: callerId, toNumber: contact });
        if (ins.conflict) throw new Error("seed: insertCallAttempt conflicted");
        await db.markOutreachDialing(trig.outreachId);
        return ins.id;
      },
      ACTOR
    );
    await db.withTenant(businessId, () => db.setAttemptCallSid(attemptId, callSid), ACTOR);

    // Read back the way the server will: the door's by-CallSid resolver.
    const hit = await db.outboundAttemptByCallSid(callSid);
    if (!hit || hit.attemptId !== attemptId || hit.businessId !== businessId || hit.outreachId !== trig.outreachId) {
      throw new Error("seed: the CallSid does not resolve to the seeded attempt");
    }
    const check = await admin.query(
      `SELECT a.attempt_no, a.from_number, a.to_number, o.state, b.outbound_enabled, c.status AS campaign_status
         FROM call_attempts a
         JOIN outreach o ON o.id = a.outreach_id
         JOIN campaigns c ON c.id = o.campaign_id
         JOIN businesses b ON b.id = a.business_id
        WHERE a.twilio_call_sid = $1`,
      [callSid]
    );
    const r = check.rows[0];
    if (!r || r.attempt_no !== 1 || r.from_number !== callerId || r.to_number !== contact || r.state !== "dialing" || r.outbound_enabled !== true || r.campaign_status !== "active") {
      throw new Error(`seed: read-back mismatch ${JSON.stringify(r ?? null)}`);
    }

    return {
      seeded: true,
      businessId,
      campaignId: camp.campaignId,
      campaignVersion: camp.version,
      contactId: trig.contactId,
      outreachId: trig.outreachId,
      attemptId,
      attemptNo: 1,
      callSid,
      callerId,
      contact,
      firstName,
      businessName,
      config,
      complianceClass: "solicited",
      personaName: config.persona_name,
    };
  } catch (err) {
    // Nothing half-seeded is left behind: the business cascades to the rest.
    await admin.query("DELETE FROM businesses WHERE id = $1", [businessId]).catch(() => {});
    throw err;
  }
}

/**
 * --call-sid: an attempt that already exists. Read through the same functions
 * the session uses (the by-CallSid resolver, then outboundCallContext under
 * that tenant); nothing is written, and nothing is cleaned up afterwards.
 */
export async function loadOutboundAttempt({ db, callSid }) {
  const hit = await db.outboundAttemptByCallSid(callSid);
  if (!hit) throw new Error(`--call-sid ${callSid} is not an outbound attempt in this database`);
  const { row, business } = await db.withTenant(
    hit.businessId,
    async () => ({ row: await db.outboundCallContext(hit.attemptId), business: await db.fetchBusinessById(hit.businessId) }),
    ACTOR
  );
  if (!row || !business) throw new Error(`--call-sid ${callSid}: its attempt or business could not be read`);
  return {
    seeded: false,
    businessId: hit.businessId,
    campaignId: hit.campaignId,
    campaignVersion: hit.campaignVersion,
    contactId: row.contactId,
    outreachId: hit.outreachId,
    attemptId: hit.attemptId,
    attemptNo: row.attemptNo,
    callSid,
    callerId: row.config?.caller_id,
    contact: row.toNumber,
    firstName: row.firstName,
    businessName: business.name,
    config: row.config,
    complianceClass: row.complianceClass,
    personaName: row.config?.persona_name || "",
  };
}

/**
 * Render the backstop clip (and the voicemail when due) EXACTLY as dispatch
 * would: the same text (dispatchLines), through the real renderAudio adapter
 * (lib/outbound/liveRender.js createLiveRenderAudio, the one buildOutboundDeps
 * wires), each verified clip stored with storeAttemptAudio the moment it is
 * ready. PAID: every line is a short Gemini Live session.
 *
 * `connect` is tapped (createRenderTap) to measure each line without changing
 * the renderer; the renderer's own log lines are captured, not printed.
 *
 * @returns {Promise<{lines: object, refused: object[], stored: {opener: number|null, voicemail: number|null, transfer_miss: number|null}, sessions: object[], events: object[], total_ms: number, failed: string|null}>}
 */
export async function renderAttemptClips({ db, seed, env = process.env, connect, settleMs = 750 }) {
  const { createLiveRenderAudio } = await import("../outbound/liveRender.js");
  const realConnect = connect ?? (await import("../voice/live/client.js")).connectLive;
  const tap = createRenderTap(realConnect);
  const events = [];
  const log = {
    debug() {},
    info: (event, fields = {}) => events.push({ level: "INFO", event, ...fields }),
    error: (event, fields = {}) => events.push({ level: "ERROR", event, ...fields }),
  };
  const row = dispatchRowFor(seed);
  const { lines, refused } = dispatchLines({ row, attemptNo: seed.attemptNo });

  // dispatch.js storeClip: once per kind, the moment each verified clip exists.
  const stored = {};
  const storeClip = async (kind, buf) => {
    if (!Buffer.isBuffer(buf) || buf.length === 0 || kind in stored) return;
    stored[kind] = null;
    try {
      await db.withTenant(seed.businessId, () => db.storeAttemptAudio(seed.attemptId, { [kind]: buf }), ACTOR);
      stored[kind] = buf.length;
    } catch (err) {
      events.push({ level: "ERROR", event: "outbound_backstop_store_refused", kind, error: err?.message });
    }
  };

  const t0 = Date.now();
  let out = null;
  let failed = null;
  if (Object.keys(lines).length > 0) {
    try {
      const renderAudio = createLiveRenderAudio({ db, env, connect: tap.connect, log });
      out = await renderAudio({ row, attemptNo: seed.attemptNo, lines, onClip: storeClip });
    } catch (err) {
      failed = err?.message || String(err);
      events.push({ level: "ERROR", event: "outbound_backstop_render_failed", error: failed });
    }
  }
  // S3-4 (D6): transfer_miss joins the two dispatch.js already stores this way.
  if (out) for (const kind of ["opener", "voicemail", "transfer_miss"]) await storeClip(kind, out[kind]);
  const totalMs = Date.now() - t0;
  // Usage that arrives AFTER turnComplete is exactly what M2 needs to know
  // about; give it a moment to land before the sessions are summarised.
  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));

  return {
    lines,
    refused,
    stored: { opener: stored.opener ?? null, voicemail: stored.voicemail ?? null, transfer_miss: stored.transfer_miss ?? null },
    sessions: summarizeRenderSessions(tap.sessions(), lines, events),
    events,
    total_ms: totalMs,
    failed,
  };
}

/**
 * Is a backstop clip stored on the attempt right now? What the session will
 * find at pickup -- so the verdict judges the clip path or the prompt path by
 * what is actually there, whether this run rendered it or --call-sid found it.
 * @returns {Promise<number>} the clip's bytes, 0 when there is none
 */
export async function openerClipBytes({ admin, callSid }) {
  const res = await admin.query("SELECT COALESCE(octet_length(opener_audio), 0)::int AS n FROM call_attempts WHERE twilio_call_sid = $1", [callSid]);
  return res.rows[0]?.n ?? 0;
}

/**
 * The call, read back from Postgres after it ended: the `calls` row the Live
 * session created (direction and the link columns) and the attempt the door
 * stamped. Phone numbers are left out -- the verdict line is printed.
 */
export async function readBackOutbound({ admin, callSid }) {
  const calls = await admin.query(
    `SELECT id, direction, campaign_id, campaign_version, outreach_id, attempt_id, contact_id,
            status, started_at, ended_at, duration_seconds, answered_by, outcome_code, answers
       FROM calls WHERE twilio_call_sid = $1`,
    [callSid]
  );
  const attempt = await admin.query(
    `SELECT id, attempt_no, twilio_status, dialed_at, answered_at, ended_at, status_completed_at, result,
            answered_by, amd_duration_ms, first_audio_ms, silent, call_id, session_finished_at, post_call_started_at,
            octet_length(opener_audio) AS opener_audio_bytes, octet_length(voicemail_audio) AS voicemail_audio_bytes,
            octet_length(transfer_miss_audio) AS transfer_miss_audio_bytes
       FROM call_attempts WHERE twilio_call_sid = $1`,
    [callSid]
  );
  return { calls: calls.rows[0] ?? null, attempt: attempt.rows[0] ?? null };
}

/**
 * Delete the seeded tenant (everything cascades from the business, and the
 * directory triggers empty the routing tables) and PROVE it: every table the
 * seed or the call touched is counted afterwards. phi_access_log is the audit
 * trail and is append-only by design; its rows are counted, not deleted.
 */
export async function cleanupOutboundSeed({ admin, seed }) {
  await admin.query("DELETE FROM businesses WHERE id = $1", [seed.businessId]);
  const res = await admin.query(
    `SELECT
       (SELECT count(*) FROM businesses WHERE id = $1)::int AS businesses,
       (SELECT count(*) FROM business_directory WHERE business_id = $1)::int AS business_directory,
       (SELECT count(*) FROM campaigns WHERE business_id = $1)::int AS campaigns,
       (SELECT count(*) FROM campaign_versions WHERE business_id = $1)::int AS campaign_versions,
       (SELECT count(*) FROM contacts WHERE business_id = $1)::int AS contacts,
       (SELECT count(*) FROM consents WHERE business_id = $1)::int AS consents,
       (SELECT count(*) FROM outreach WHERE business_id = $1)::int AS outreach,
       (SELECT count(*) FROM outreach_schedule WHERE business_id = $1)::int AS outreach_schedule,
       (SELECT count(*) FROM call_attempts WHERE business_id = $1)::int AS call_attempts,
       (SELECT count(*) FROM call_attempt_directory WHERE business_id = $1 OR twilio_call_sid = $2)::int AS call_attempt_directory,
       (SELECT count(*) FROM dial_registry WHERE business_id = $1)::int AS dial_registry,
       (SELECT count(*) FROM calls WHERE business_id = $1 OR twilio_call_sid = $2)::int AS calls,
       (SELECT count(*) FROM phi_access_log WHERE business_id = $1)::int AS phi_access_log_kept`,
    [seed.businessId, seed.callSid]
  );
  const counts = res.rows[0];
  const { phi_access_log_kept: kept, ...remaining } = counts;
  return { clean: Object.values(remaining).every((n) => n === 0), remaining, phi_access_log_kept: kept };
}
