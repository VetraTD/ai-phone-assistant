-- ============================================================
-- Migration 051: outbound -- Stage 4, S4-2. 'held_for_review' joins
-- outreach.close_reason.
--
-- A caller who spoke during the opener clip and hung up, whose words neither
-- Gemini Live nor Deepgram could transcribe, may have said "stop calling me".
-- The lead is never silently re-dialled: post-call closes it with
-- close_reason 'held_for_review' (and an ERROR event for the alert policy),
-- and the operator re-adds it by hand if it turns out to be fine. Owner rule
-- 2026-09-29. calls.outcome_code is unconstrained, so the matching outcome
-- needs no schema change.
--
-- Same drop/add pattern as 047 and 048: outreach_close_reason_check is
-- Postgres's own <table>_<column>_check name for the unnamed inline CHECK.
-- The list is re-created with EVERY value the live constraint carries as of
-- 048 (047's 'missing_goal', 048's 'erased' and 'no_legal_floor' included --
-- dropping one would silently break the writer that uses it), plus the new
-- one.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS then ADD; schema.sql carries the same
-- constraint under the same name, so a re-run after the fold drops and
-- re-adds the identical definition.
-- ============================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE outreach DROP CONSTRAINT IF EXISTS outreach_close_reason_check;
ALTER TABLE outreach ADD CONSTRAINT outreach_close_reason_check
  CHECK (close_reason IS NULL OR close_reason IN (
    'terminal_outcome','attempts_exhausted','give_up_window','consent_missing',
    'consent_expired','consent_not_automated','suppressed','called_back',
    'campaign_deleted','global_disabled','business_disabled','caller_id_invalid',
    'missing_goal','erased','no_legal_floor','held_for_review'
  ));
