/**
 * Filing a degraded-mode voicemail (ledger O32).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT TWENTY LINES INSIDE THE ROUTE
 * ---------------------------------------------------------------------------
 * It was twenty lines inside the route, and that is how it stayed the last
 * unscoped PHI write in the system after every other one had been wrapped.
 * Code reachable only through an Express handler gets "tested" by reading it,
 * and a source scan describes shape rather than behaviour — the lesson
 * `lib/twilioSignature.js` was extracted for. Behind a plain function this is
 * callable from a test running as the unprivileged `vetra_app` role, under the
 * row-level security that is the whole point.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS ACTUALLY WRONG
 * ---------------------------------------------------------------------------
 * `db.createCustomerRequest` ran with no tenant scope. Two consequences, and
 * the second is the one that reads as a feature working:
 *
 *   On Cloud SQL there is no superuser and migration 029 uses FORCE row-level
 *   security, so the INSERT is REFUSED — "new row violates row-level security
 *   policy for table customer_requests". `createCustomerRequest` logs and
 *   returns null, the route answers Twilio 200, and a real person's voicemail
 *   is nowhere. Exactly the failure migration 032/033/034 fixed three times
 *   over on other paths.
 *
 *   And in `hipaa` mode it is a PHI write with nowhere to record itself
 *   (§164.312(b)). `recordPhiAccess` announces that as `phi_access_unaudited`
 *   rather than writing a row, because the audit record's grain is the unit of
 *   work and there was no unit of work here at all.
 *
 * Both close the same way: one short unit of work around the write. Not around
 * the whole handler — the business lookup before it is a bootstrap that MUST be
 * unscoped (it is how the tenant becomes known), and the notifications after it
 * are floating promises the route does not await, so a scope spanning them
 * would commit and release its connection mid-send.
 *
 * The recording URL is the only pointer to what the caller said, so
 * `listCallerRecordingMessages` reads it back out of `customer_requests.message`
 * when an Art. 17 erasure has to reach Twilio. Keep the prefix in step with
 * `tests/recordingPathLint.test.js`.
 */

/** The literal that makes a voicemail row findable by the erasure path. */
export const VOICEMAIL_MESSAGE_PREFIX = "Voicemail recording: ";

/**
 * File a degraded-mode voicemail against its tenant, and tell people about it.
 *
 * Returns the new `customer_requests` id, or null when nothing was written —
 * which the caller may treat as "there is nothing to notify about", because the
 * notification is deliberately gated on the row actually landing. Promising a
 * clinic a message that was never stored is the failure this capability has.
 *
 * Never throws: it is called from a Twilio webhook, and a 500 there makes
 * Twilio retry the callback.
 *
 * @param {object} params
 * @param {object} params.deps - { db, notifications, log, captureException }
 * @param {{ id: string }} params.business - the resolved tenant
 * @param {string|null} params.callerNumber
 * @param {string} params.recordingUrl
 * @param {string|null} [params.callSid]
 * @returns {Promise<string|null>}
 */
export async function fileDegradedVoicemail({
  deps,
  business,
  callerNumber,
  recordingUrl,
  callSid = null,
}) {
  const { db, notifications, log, captureException } = deps;
  if (!business?.id) return null;

  const message = `${VOICEMAIL_MESSAGE_PREFIX}${recordingUrl}`;

  // THE UNIT OF WORK. Short by design: one statement, one audit row, one
  // connection held for the length of an INSERT.
  //
  // withTenantSafe rather than withTenant because this is a webhook — a call
  // that could not reach the real-time pipeline is already the degraded path,
  // and turning a failed write into a 500 would make Twilio retry it rather
  // than making it succeed.
  const id = await db.withTenantSafe(
    business.id,
    () =>
      db.createCustomerRequest({
        businessId: business.id,
        requestType: "message",
        callbackNumber: callerNumber,
        message,
      }),
    { operation: "createCustomerRequest", callSid }
  );

  if (!id) return null;

  try {
    notifications
      .notifyCustomerRequest({
        businessId: business.id,
        customerRequest: {
          request_type: "message",
          caller_name: null,
          callback_number: callerNumber,
          message,
          preferred_time: null,
        },
        call: { callerNumber },
      })
      .catch(() => {});

    const config = db.loadConfig(business);
    notifications
      .sendCallerSms(config, callerNumber, "message_received", {
        name_part: "",
        business: config.businessName,
        sla: notifications.MESSAGE_SLA_TEXT,
      })
      .catch((err) =>
        log.error("sms_followup_failed", { callSid, kind: "message_received", reason: err?.message })
      );
  } catch (err) {
    // The row is already committed at this point, so a notification failure
    // must not look like a filing failure.
    log.error("degraded_voicemail_notify_failed", { callSid, message: err?.message });
    captureException?.(err, { callSid });
  }

  return id;
}
