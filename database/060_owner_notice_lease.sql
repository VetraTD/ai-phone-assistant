-- 060_owner_notice_lease.sql
--
-- Ilija inbound (2026-11-07, Task L): a claimed owner notice survives a dead
-- instance.
--
-- Before this, claimOwnerNotices set owner_notice_pending = false in the same
-- UPDATE that handed the rows to the flush. An instance that died after the
-- claim and before the send (or the release) left the row not pending and never
-- emailed: no retry, no alert.
--
-- owner_notice_claimed_at: when the call-end hook last claimed the row; NULL =
--   not claimed. A claim is now a lease: it stamps this and leaves
--   owner_notice_pending true. Only completeOwnerNotices (sent, or the business
--   takes no notice) clears pending. releaseOwnerNotices clears this column so a
--   failed send is free at once. A claim older than the lease (2 minutes,
--   services/db.js) is claimable again by the business's next completed call.
--
-- NULL for every existing row, so no backfill is needed. The partial index on
-- owner_notice_pending (059) still serves the claim: a leased row stays pending.

ALTER TABLE customer_requests
  ADD COLUMN IF NOT EXISTS owner_notice_claimed_at timestamptz;
