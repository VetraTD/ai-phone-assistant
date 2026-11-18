/**
 * Caller-facing SMS: the consent disclosure, and what an SMS template may say.
 *
 * The pure half of ledger O25. The store lives in `services/db.js`
 * (`recordSmsConsent` / `latestSmsConsent`, migration 037), the gate lives in
 * `services/notifications.js` (`sendCallerSms`), and the question itself is
 * asked by `capabilities/smsConsent.js`. What lives here is the part all three
 * have to agree on, so that they cannot drift: the words, their version, and
 * the placeholder vocabulary a template is allowed to use.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCRIPT IS A CONSTANT AND NOT PROMPT TEXT
 * ---------------------------------------------------------------------------
 * A prompt is a request; a constant is a record. The disclosure has to be
 * reproducible years later next to a specific consent row, which means the
 * words have to be stored with the row and the version has to change when the
 * words do. `capabilities/smsConsent.js` puts this exact sentence in the prompt
 * AND `services/db.js` writes this exact sentence to `sms_consents.script`, so
 * a change to the wording changes both at once or neither.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SCRIPT DELIBERATELY DOES NOT SAY
 * ---------------------------------------------------------------------------
 * It does not say "from this number". The templates used to promise "Reply to
 * this number", and no inbound SMS route exists anywhere in this repo — a
 * patient who replied got silence. Worse, the text is sent from the single
 * global `TWILIO_SMS_FROM`, not from the number the caller dialled, so "this
 * number" was wrong in two independent ways at once. The templates no longer
 * promise a reply, and the script does not name a number it cannot honour.
 */

/**
 * The disclosure the receptionist must give before any caller-facing SMS.
 *
 * Three things have to be in it and each is load-bearing:
 *   - it is a QUESTION, so the answer is the caller's, not an opt-out;
 *   - it names the sensitive content ("your name and appointment details"), so
 *     the agreement is to what will actually be sent rather than to "a text";
 *   - it says rates may apply, which is the ordinary standard for express
 *     consent to an automated text.
 *
 * Kept to one breath. A disclosure a caller talks over is not one they gave.
 */
export const SMS_CONSENT_SCRIPT =
  "Can I send you a text confirmation? It may include your name and appointment " +
  "details, and standard message and data rates may apply.";

/**
 * Bump this whenever SMS_CONSENT_SCRIPT changes.
 *
 * Stored per row, so a later rewording does not retroactively claim that past
 * callers were told the new words. The row also stores the full text — the
 * version exists to make "which callers heard the old wording" a query rather
 * than a string comparison.
 */
export const SMS_CONSENT_SCRIPT_VERSION = "2026-08-22.1";

/**
 * The placeholder vocabulary each template kind may use.
 *
 * This is the enforceable half of the third O25 defect: `businesses.sms_templates`
 * is owner-overridable and had no guard at all. It is NOT a PHI detector — no
 * check can tell that "your chemotherapy appointment" is more disclosive than
 * "your appointment", and a keyword denylist pretending otherwise would be
 * false confidence in the one place that cannot afford it. What it CAN do is
 * bound the identifiers the system itself will substitute in, so an override
 * cannot pull a field into a kind that never carried it.
 *
 * Enforced in two places on purpose. The dashboard validator rejects the write,
 * and `sendCallerSms` falls back to the built-in default at SEND time — because
 * the column can also be written by an operator with a SQL client, and the
 * validator is not in that path.
 */
export const SMS_TEMPLATE_PLACEHOLDERS = Object.freeze({
  appointment_confirmation: Object.freeze(["name", "business", "datetime"]),
  appointment_cancelled: Object.freeze(["name", "business", "datetime"]),
  message_received: Object.freeze(["name_part", "business", "sla"]),
  missed_call: Object.freeze(["business"]),
  // A booking the call owed and never wrote. {business} AND NOTHING ELSE, which
  // is a judgement rather than an omission.
  //
  // No {datetime}: there is no confirmed row, so any time in this message would
  // assert a booking that does not exist -- the failure it is sent to correct.
  // No {name}: this message exists because something went wrong, and a name is
  // the field most likely to be the thing that went wrong. A model read back
  // "D I L L A N B H A K T A" from 20 ms of caller audio on the verification
  // call of 2026-09-11; greeting somebody by a misheard name while apologising
  // for losing their appointment is worse than not greeting them.
  appointment_request_pending: Object.freeze(["business"]),
});

/** Every template kind `sendCallerSms` knows how to send. */
export const SMS_TEMPLATE_KINDS = Object.freeze(Object.keys(SMS_TEMPLATE_PLACEHOLDERS));

/** Longest an override may be. Two SMS segments; beyond that carriers split it. */
export const SMS_TEMPLATE_MAX_LENGTH = 320;

/** `{placeholder}` occurrences in a template, in order, deduplicated. */
export function templatePlaceholders(template) {
  const out = [];
  for (const m of String(template ?? "").matchAll(/\{(\w+)\}/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Is this override safe to send for this kind?
 *
 * Returns `null` when it is, or a human-readable reason when it is not. A
 * reason rather than a boolean because the dashboard shows it to the owner, and
 * "invalid" is not a thing anyone can act on.
 *
 * @param {string} kind
 * @param {string} template
 * @returns {string|null}
 */
export function smsTemplateProblem(kind, template) {
  const allowed = SMS_TEMPLATE_PLACEHOLDERS[kind];
  if (!allowed) return `unknown template kind "${kind}"`;
  if (typeof template !== "string") return "must be a string";
  if (template.length > SMS_TEMPLATE_MAX_LENGTH) {
    return `must be ${SMS_TEMPLATE_MAX_LENGTH} characters or fewer`;
  }
  const unknown = templatePlaceholders(template).filter((p) => !allowed.includes(p));
  if (unknown.length) {
    return (
      `uses placeholders this message does not carry: ${unknown.map((p) => `{${p}}`).join(", ")}. ` +
      `Available: ${allowed.map((p) => `{${p}}`).join(", ")}`
    );
  }
  return null;
}
