-- 059_customer_request_details.sql
--
-- Ilija inbound (2026-11-07): a message or callback taken by the receptionist
-- can carry the answers the caller gave to the business's own questions
-- (`details`), and the call-end hook must be able to claim a request the owner
-- has not yet been told about (`owner_notice_pending`).
--
-- details: { callerType?: string, answers: Array<{ label: string, answer: string }> }
--   NULL for every row filed before this migration, and for any row whose call
--   asked no questions. Erasure nulls it (eraseCallerData); export returns it.
--
-- owner_notice_pending: false for every existing row, so no backfill is needed.
--   An unscoped data UPDATE would match zero rows under FORCE RLS anyway.

ALTER TABLE customer_requests
  ADD COLUMN IF NOT EXISTS details jsonb,
  ADD COLUMN IF NOT EXISTS owner_notice_pending boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_customer_requests_notice_pending
  ON customer_requests (business_id, created_at) WHERE owner_notice_pending;
