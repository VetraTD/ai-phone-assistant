/**
 * The tenant-config read behind `scripts/db-inspect.js --business <e164>`.
 *
 * A module rather than inline script code for the same reason as its siblings
 * (recordingClaimAudit.js, outboundPreflight.js): it can be tested as a
 * non-bypassing role against a real PostgreSQL, which is the only way to know
 * the SECURITY DEFINER lookup path works under FORCE row-level security.
 *
 * THE LAST-4 RULE. db-inspect runs as a Cloud Run job and everything it prints
 * is a Cloud Logging line. The transfer number and the main number are masked
 * to their last four digits IN SQL (right(...)), so the full numbers never
 * leave the database and no caller of this function can print them by mistake.
 */

/**
 * @param {{ query: (text: string, values?: unknown[]) => Promise<{ rows: object[] }> }} queryable a pg Pool or Client
 * @param {string} phone the business's E.164 number
 * @returns {Promise<object[]>} the result rows (empty when no business routes to the number)
 */
export async function inspectBusinessConfig(queryable, phone) {
  // app_lookup_business_by_phone RETURNS SETOF businesses, so every column of
  // the table is already selectable here -- allowed_tasks and general_info
  // cost no second query and no scope, because the function is SECURITY
  // DEFINER and sets app.business_id itself when it is unset.
  //
  // allowed_tasks is the one that could never be read back after being
  // written: import-tenant sets it and nothing could confirm it landed. The
  // default for an unconfigured tenant is book_appointment ONLY, which is why
  // cancelling was impossible on Brightwork Studio until 2026-09-09.
  //
  // general_info is printed as a LENGTH, not as text. It is tenant copy
  // rather than caller speech, but this file's line is "config and numbers",
  // and "is there a price configured" is answered by a number.
  const result = await queryable.query(
    `SELECT id, phone_number, name, timezone, after_hours_policy, business_hours,
              allowed_tasks,
              -- DOES THIS TENANT SEND SMS AT ALL. Off by default, and
              -- services/notifications.js returns on it with no log and no
              -- counter -- so POSTCALL_VERIFY=send on a tenant with this false
              -- drops every caller message in silence, and "nothing was sent"
              -- and "sending is switched off" look identical from outside the
              -- VPC. Exactly the blind spot this file exists to close.
              sms_followup_enabled,
              -- LVX133. WHICH LANGUAGES IS THIS TENANT CONFIGURED FOR.
              --
              -- On CAd48d7b the assistant answered an English caller in Spanish
              -- and then argued about it for forty seconds of a 3m39s call. The
              -- apology it kept repeating -- "I apologize, but we must continue
              -- in English" -- is the model's own words: that sentence does not
              -- exist in any prompt in this repository, looksNonEnglish is
              -- count-only with no note and no gate, and it excludes Spanish
              -- from its markers by design.
              --
              -- The ONE thing we do say about language is in
              -- services/gemini.js's identity section, and it is emitted only
              -- when this array has more than one entry -- in which case the
              -- prompt reads "ALWAYS reply in the language of the caller's most
              -- recent message -- if they speak Spanish, reply in Spanish."
              -- Whether that sentence was in front of the model on that call is
              -- the entire diagnosis, and until now no tool outside the VPC
              -- could answer it: this column is in neither this query nor
              -- scripts/set-business-config.js's field whitelist.
              --
              -- Printed verbatim rather than as a fact, because it is a short
              -- list of language codes. It is tenant configuration and carries
              -- nothing a caller said.
              languages_spoken,
              (general_info IS NOT NULL AND general_info <> '') AS has_general_info,
              coalesce(length(general_info), 0) AS general_info_chars,
              -- IS THERE A PRICE IN THE PROMPT? LVX66, and the $3,000 question.
              --
              -- On two consecutive calls on 2026-09-09 the assistant said
              -- "our branding and web design projects typically start around
              -- three thousand dollars", once contradicting itself inside a
              -- single turn ("...I can't quote a figure directly here"). A
              -- price is the worst thing on the list to invent, and nothing
              -- outside the VPC could say whether it was configured.
              --
              -- A BOOLEAN, not the text. general_info and custom_instructions
              -- are the tenant's own copy rather than caller speech, so they
              -- are on the safe side of this file's line -- but they are free
              -- text of arbitrary length, and "does a price appear in it" is
              -- the whole question. A fact answers it; a dump would answer it
              -- and a great deal else.
              --
              -- Both fields, because both reach the model: general_info is
              -- knowledge and custom_instructions is instruction, and a figure
              -- in either one is a figure the assistant may repeat.
              -- NOTE the doubled backslashes. This is a JS template literal, so
              -- a single \s reaches Postgres as a bare "s" and the pattern
              -- silently stops matching a currency symbol followed by a space.
              -- Same family as the heredoc trap already recorded for this repo.
              (general_info ~* '[$£€]\\s*[0-9]|[0-9][0-9,. ]*\\s*(dollars|pounds|usd|gbp)|thousand') AS general_info_mentions_price,
              coalesce(length(custom_instructions), 0) AS custom_instructions_chars,
              (custom_instructions ~* '[$£€]\\s*[0-9]|[0-9][0-9,. ]*\\s*(dollars|pounds|usd|gbp)|thousand') AS custom_instructions_mentions_price,
              -- CAN THE ESCALATION REACH A HUMAN AT ALL? LVX142.
              --
              -- The abandoned-write escalation inserts a customer_requests row
              -- and then calls notifyUnconfirmedClaim, which loads these two
              -- columns and RETURNS SILENTLY when both are empty -- no log, no
              -- counter. So "a caller was told something was done, it was not,
              -- and nobody was told" and "the owner was emailed" look identical
              -- from outside the VPC. Same blind spot as sms_followup_enabled
              -- above, on the other half of the net.
              --
              -- notifications_enabled is the tenant's own master switch and is
              -- checked before either: false there and neither column matters.
              --
              -- PRESENCE, NOT VALUES. This file's line is config and numbers,
              -- and "is there somewhere to send it" is answered by a boolean.
              -- The addresses themselves are the owner's contact details and
              -- are no more printable here than a caller's.
              notifications_enabled,
              (notification_email IS NOT NULL AND notification_email <> '') AS has_notification_email,
              (notification_phone IS NOT NULL AND notification_phone <> '') AS has_notification_phone,
              right(transfer_phone_number, 4) AS transfer_phone_last4,   -- never the whole number: this output is a log line
              transfer_policy,
              right(main_phone, 4) AS main_phone_last4,                  -- same rule: last 4 only
              live_voice,
              locale,
              outbound_enabled,
              to_jsonb(b) ->> 'transfer_no_answer' AS transfer_no_answer -- migration 052; via to_jsonb so this still runs on a DB before 052
         FROM app_lookup_business_by_phone($1) b`,
    [phone]
  );
  return result.rows;
}
