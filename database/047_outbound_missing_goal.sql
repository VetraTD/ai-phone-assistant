-- ============================================================
-- Migration 047: outbound -- 'missing_goal' joins outreach.close_reason
-- (S3-6 fix round 1, Critical)
-- ============================================================
-- S3-6 (spec §19, S3-D4) made campaign `goal` a required field, and taught
-- lib/outbound/dispatch.js to refuse -- explicitly, closing the outreach --
-- rather than dial a campaign_versions row saved before `goal` existed (the
-- 14 paused R1 production campaigns, and any local harness config not yet
-- migrated; named risk 5). dispatch.js calls
-- `db.closeOutreach(outreachId, "missing_goal")`, but the CHECK constraint
-- on outreach.close_reason (below, unchanged since it was first added) never
-- listed that value: on real Postgres the UPDATE itself fails the CHECK,
-- `services/db.js`'s `q()` returns an error, `closeOutreach` throws, and
-- that throw propagates out of dispatch() uncaught -- the exact "crash the
-- sweep, Cloud Tasks retries the SAME broken outreach forever" failure mode
-- named risk 5's own Ruling was written to avoid. Only `fakeDb` (an
-- unconstrained vi.fn()) covered the write before this migration, which is
-- how it shipped: the DB's own constraint on the string was never checked
-- (a wire test proves a wire only if both ends are real).
--
-- Idempotent: DROP CONSTRAINT IF EXISTS on the real (auto-generated) name --
-- looked up on the live database with
--   SELECT conname FROM pg_constraint WHERE conrelid = 'outreach'::regclass AND contype = 'c';
-- which returned `outreach_close_reason_check` (Postgres's own
-- <table>_<column>_check naming for an unnamed inline CHECK) -- then
-- ADD CONSTRAINT with every existing value plus 'missing_goal'. Safe to
-- re-run after the fold (schema.sql carries the same constraint under the
-- same name, so a second run drops and re-adds the identical definition).

SET LOCAL lock_timeout = '5s';

ALTER TABLE outreach DROP CONSTRAINT IF EXISTS outreach_close_reason_check;
ALTER TABLE outreach ADD CONSTRAINT outreach_close_reason_check
  CHECK (close_reason IS NULL OR close_reason IN (
    'terminal_outcome','attempts_exhausted','give_up_window','consent_missing',
    'consent_expired','consent_not_automated','suppressed','called_back',
    'campaign_deleted','global_disabled','business_disabled','caller_id_invalid',
    'missing_goal'
  ));
