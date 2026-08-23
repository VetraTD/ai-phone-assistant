-- ============================================================
-- Migration 037: express consent for caller-facing SMS (ledger O25)
-- ============================================================
-- THE PROBLEM THIS TABLE EXISTS FOR, stated once.
--
-- `DEFAULT_SMS_TEMPLATES.appointment_confirmation` reads
--
--     "Hi {name}, your appointment with {business} is confirmed for {datetime}."
--
-- A patient's name, the name of a cardiology clinic, and an appointment time,
-- sent unencrypted to whatever number arrived in the caller ID. That is the
-- only remaining PHI disclosure in this system that leaves it addressed to a
-- person rather than to the covered entity, and it sits on top of a second,
-- unrelated exposure: 47 U.S.C. 227 (TCPA) statutory damages of $500-$1,500
-- PER MESSAGE, with no cap, for an automated text to a mobile number without
-- prior express consent.
--
-- Both close on the SAME fact, which is why this is one table and not two
-- projects:
--
--   * HIPAA permits a covered entity to communicate with an individual about
--     their own care, and 45 CFR 164.522(b) contemplates the individual
--     REQUESTING an alternative means of communication. A patient who asks to
--     be texted is the specific thing that makes a name and an appointment time
--     lawful in an SMS body. Without the request it is a disclosure by an
--     unsecured channel that nobody asked for.
--   * TCPA express consent is exactly the same event: the called party agreeing,
--     to this sender, at this number.
--
-- So the receptionist asks, in the call, and the answer is recorded here.
--
-- WHAT WAS DELIBERATELY NOT DONE: stripping the templates down to a link. A
-- link-only text ("you have an update, sign in to see it") is compliant and
-- useless — a clinic's patients will not sign in, so the feature would exist
-- and change nothing. The design decision is to keep the useful message and
-- earn the right to send it.
--
-- ------------------------------------------------------------
-- 1. Why a row per ANSWER, not a boolean on `businesses` or `calls`
-- ------------------------------------------------------------
-- Consent is evidence. What has to survive is not "may we text this number"
-- but "who was asked, when, at which number, on which call, and in what
-- words" — because that is what an FCC complaint or an OCR enquiry asks for,
-- and a boolean answers none of it.
--
-- A "no" is recorded too, and that is not bookkeeping. The most recent row
-- wins, so a later "no" REVOKES an earlier "yes" by being newer; a schema that
-- only stored grants could not express a revocation at all. It also stops the
-- receptionist re-asking a caller who has already declined.
--
-- Revocation is therefore an INSERT, never an UPDATE, and the table is
-- append-only-plus-erase (see section 3).
--
-- ------------------------------------------------------------
-- 2. `script` — the wording, and the honest limit on it
-- ------------------------------------------------------------
-- `script` stores the canonical disclosure the receptionist was INSTRUCTED to
-- use (lib/smsConsent.js SMS_CONSENT_SCRIPT), together with `script_version`
-- so a change to the wording does not retroactively rewrite what past callers
-- were told.
--
-- It is NOT a recording of what the model actually said, and pretending
-- otherwise would be the more dangerous design: a language model paraphrases,
-- and a field labelled "the exact wording used" that is really "the wording we
-- asked for" is a lie in the one table whose whole job is to be believed.
--
-- What actually evidences the words spoken is `call_id` -> `call_transcripts`,
-- which is written per turn and holds both sides verbatim. This row says which
-- disclosure was required and which call to look in. Retention on transcripts
-- is shorter than the limitation period on a TCPA claim, and that gap is
-- recorded in the ledger for counsel (O18) rather than papered over here.
--
-- ------------------------------------------------------------
-- 3. Privileges: append and erase, never update
-- ------------------------------------------------------------
-- Two independent locks, the shape migration 030 established:
--
--   a. Privileges: SELECT, INSERT and DELETE granted; UPDATE revoked. Migration
--      029's ALTER DEFAULT PRIVILEGES has already granted UPDATE on this table
--      by the time these lines run, so the REVOKE is load-bearing rather than
--      decorative.
--   b. Policies: SELECT, INSERT and DELETE policies exist. There is NO UPDATE
--      policy, so a role that somehow held the privilege still matches zero
--      rows.
--
-- DELETE is granted, unlike phi_access_log, and the difference is deliberate.
-- This table holds a phone number, so it is within the scope of an Art. 17
-- erasure — a caller who asks to be forgotten and whose number survives in a
-- consent table has not been forgotten. `eraseCallerData` deletes these rows,
-- which also fails the gate closed for that number afterwards, which is the
-- correct end state. The cost is that erasing a caller destroys the evidence
-- that they consented to texts already sent; that trade is flagged to counsel
-- in the ledger and is not decided here.
--
-- ------------------------------------------------------------
-- 4. No FK on phone_number, exact match on the value
-- ------------------------------------------------------------
-- The lookup is an EXACT match on the stored E.164 string, not the last-10-
-- digits suffix match `exportCallerData` uses. A suffix match is right for
-- "find everything about this person" and wrong for "may I text this number":
-- it is deliberately loose, and loose on a consent gate means texting somebody
-- who never agreed. Both sides normalise through lib/phone.js first, so the
-- exactness costs nothing real.
-- ============================================================

CREATE TABLE IF NOT EXISTS sms_consents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- The call the answer was given on. ON DELETE SET NULL rather than CASCADE:
  -- deleting a call must not delete the evidence that the caller consented,
  -- because the consent outlives the conversation it was given in.
  call_id        uuid REFERENCES calls(id) ON DELETE SET NULL,

  -- The number consent covers. E.164, normalised by lib/phone.js on both the
  -- write and the read, and never a number the caller merely spoke aloud — see
  -- capabilities/smsConsent.js.
  phone_number   text NOT NULL,

  -- true = express consent, false = refusal or revocation. The most recent row
  -- for (business_id, phone_number) is the current state.
  granted        boolean NOT NULL,

  -- The disclosure the receptionist was required to give, and its version.
  script         text NOT NULL,
  script_version text NOT NULL,

  -- How the answer was collected. One value today; the column exists because
  -- the second one (a dashboard-entered paper consent) is a foreseeable
  -- addition and a CHECK is cheaper than a migration that has to backfill.
  source         text NOT NULL DEFAULT 'voice' CHECK (source IN ('voice')),

  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE sms_consents IS
  'Express consent to receive SMS, captured in the call. One row per answer; the most recent row for (business_id, phone_number) is the current state and a later granted=false revokes an earlier grant. Gates services/notifications.js sendCallerSms. Closes both the PHI-in-SMS exposure and TCPA prior express consent.';

-- The gate's only query: "the most recent answer for this number, for this
-- tenant". It runs before every caller-facing SMS, so it is an index and not a
-- sort over the tenant's history.
CREATE INDEX IF NOT EXISTS idx_sms_consents_lookup
  ON sms_consents (business_id, phone_number, created_at DESC);

-- ------------------------------------------------------------
-- Lock 1: table privileges
-- ------------------------------------------------------------
GRANT SELECT, INSERT, DELETE ON sms_consents TO vetra_app;
REVOKE UPDATE ON sms_consents FROM vetra_app;

-- ------------------------------------------------------------
-- Lock 2: row-level security
-- ------------------------------------------------------------
ALTER TABLE sms_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_consents FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_read ON sms_consents;
DROP POLICY IF EXISTS tenant_append ON sms_consents;
DROP POLICY IF EXISTS tenant_erase ON sms_consents;

CREATE POLICY tenant_read ON sms_consents
  FOR SELECT USING (business_id = app_current_business_id());

CREATE POLICY tenant_append ON sms_consents
  FOR INSERT WITH CHECK (business_id = app_current_business_id());

-- Erasure only. Art. 17 has to be able to reach this table; nothing else does.
CREATE POLICY tenant_erase ON sms_consents
  FOR DELETE USING (business_id = app_current_business_id());

-- Deliberately absent: any policy FOR UPDATE. A consent record that can be
-- edited after the fact is not evidence. Revocation is a new row.
