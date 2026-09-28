-- ============================================================
-- Migration 048: outbound -- P5 erasure support (S3-11, spec §13.5 amendment)
-- ============================================================
-- Art. 17 erasure has to reach outbound calling's own tables too
-- (services/db.js's eraseCallerData). Everything else it touches (contacts,
-- consents, outreach, call_attempts audio) is an ordinary UPDATE/DELETE on
-- existing columns and needs no schema change. `suppressions` does:
--
--   phone_e164  DROP NOT NULL -- an erased row keeps the ROW (a do-not-call
--               decision must outlive the person who is the reason for it),
--               but loses the phone.
--   phone_hash  ADD COLUMN, nullable text -- HMAC-SHA256(SUPPRESSION_HASH_KEY,
--               the canonical E.164 phone), hex (services/db.js's
--               suppressionHash). NULL on every row written before this
--               migration and on every row that is never erased; set instead
--               of phone_e164 on erasure, and matched by isSuppressed
--               alongside phone_e164 so the do-not-call check still refuses
--               the number afterwards.
--
-- A row must carry ONE of the two identifiers, or a write path could leave a
-- suppression that matches nothing at all -- CHECK
-- (phone_e164 IS NOT NULL OR phone_hash IS NOT NULL).
--
-- The unique index on (business_id, phone_hash) is PARTIAL (WHERE phone_hash
-- IS NOT NULL): most rows have phone_hash NULL, and Postgres already treats
-- every NULL as distinct under a plain UNIQUE constraint, so a non-partial
-- index would do nothing extra and cost every un-erased row a pointless
-- comparison.
--
-- outreach.close_reason gains 'erased' (this task, P5: erasure closes any
-- open outreach for the contact) and 'no_legal_floor' (reserved for S3-7, so
-- that task does not need a second CHECK rewrite). Re-created with EVERY
-- existing value, read from the live constraint rather than copied from an
-- older draft -- 047 (S3-6 fix round 1) already added 'missing_goal' to this
-- same list, and dropping it here would silently break dispatch.js's own
-- missing-goal refusal.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS on the real (looked-up) constraint
-- name, matching 047's own pattern --
--   SELECT conname FROM pg_constraint WHERE conrelid = 'outreach'::regclass AND contype = 'c';
-- returned `outreach_close_reason_check` (Postgres's own <table>_<column>_check
-- naming for an unnamed inline CHECK).

SET LOCAL lock_timeout = '5s';

ALTER TABLE suppressions ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE suppressions ADD COLUMN IF NOT EXISTS phone_hash text;

ALTER TABLE suppressions DROP CONSTRAINT IF EXISTS suppressions_phone_present_check;
ALTER TABLE suppressions ADD CONSTRAINT suppressions_phone_present_check
  CHECK (phone_e164 IS NOT NULL OR phone_hash IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS suppressions_business_phone_hash_idx
  ON suppressions (business_id, phone_hash) WHERE phone_hash IS NOT NULL;

ALTER TABLE outreach DROP CONSTRAINT IF EXISTS outreach_close_reason_check;
ALTER TABLE outreach ADD CONSTRAINT outreach_close_reason_check
  CHECK (close_reason IS NULL OR close_reason IN (
    'terminal_outcome','attempts_exhausted','give_up_window','consent_missing',
    'consent_expired','consent_not_automated','suppressed','called_back',
    'campaign_deleted','global_disabled','business_disabled','caller_id_invalid',
    'missing_goal','erased','no_legal_floor'
  ));
