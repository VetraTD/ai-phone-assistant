-- ============================================================
-- Migration 053: batch 3 launch guards, S3 -- the number block.
--
-- businesses.allow_pricier_numbers: per-client switch WE set (through
-- scripts/set-business-config.js; no dashboard screen) that lets a number
-- costing 10-60 cents/min be dialled. Default false: only numbers at or under
-- 10 cents/min are dialled automatically. Anything over 60 cents/min, or a
-- premium/personal/special-rate number, is never dialled whatever this says.
-- Owner decision 2026-10-10.
--
-- outreach.close_reason gains 'blocked_destination': the outbound gate closes
-- a lead whose number the price check refuses, and closeOutreach writes that
-- reason, so without it every refusal would throw on the CHECK.
--
-- Same drop/add pattern as 047, 048 and 051: the list is re-created with EVERY
-- value the live constraint carries as of 051, plus the new one.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; DROP CONSTRAINT IF EXISTS then ADD.
-- schema.sql carries both (same constraint name), so a re-run after the fold
-- drops and re-adds the identical definition.
-- ============================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS allow_pricier_numbers boolean NOT NULL DEFAULT false;
ALTER TABLE outreach DROP CONSTRAINT IF EXISTS outreach_close_reason_check;
ALTER TABLE outreach ADD CONSTRAINT outreach_close_reason_check
  CHECK (close_reason IS NULL OR close_reason IN (
    'terminal_outcome','attempts_exhausted','give_up_window','consent_missing',
    'consent_expired','consent_not_automated','suppressed','called_back',
    'campaign_deleted','global_disabled','business_disabled','caller_id_invalid',
    'missing_goal','erased','no_legal_floor','held_for_review','blocked_destination'
  ));
