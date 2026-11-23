-- 061_call_handled.sql
--
-- Dashboard overhaul (2026-11-22, spec §9): a call's open item can be marked
-- done.
--
-- A call "needs you" when it left a message or call-back request
-- (customer_requests) that nobody has dealt with. The dashboard's Home and
-- Inbox list those, and the team clears them with Done (and can Reopen).
--
-- handled_at: when the open item was marked done; NULL = still open.
-- handled_by: the Identity Platform uid of whoever marked it done, or 'launch'
--   for the backfill below. The first person to mark an item done keeps it;
--   a second Done is harmless (the endpoint uses COALESCE).
--
-- LAUNCH BACKFILL (owner, 2026-11-22): when this ships, open items from the
-- last 7 days stay under "Needs you"; older ones start as done, marked as set
-- at launch rather than by a person, and can be reopened. Run this migration
-- only as part of the deploy that ships the new dashboard, so the 7 days are
-- measured from launch.
--
-- THE FORCE TRAP (migrations 034 and 036). On Cloud SQL the migrating role
-- owns these tables and does not bypass row-level security, and with FORCE on
-- an owner's UPDATE matches no row and reports no error. FORCE is stood down
-- for the one UPDATE and put straight back. tests/db/callHandled.test.js runs
-- this file as such an owner.
--
-- Additive, and safe if applied twice: it never overwrites an item someone has
-- already marked done. It is NOT meant to be run again by hand: a later run
-- would close requests that have since passed 7 days. The migration ledger
-- (schema_migrations) applies it once.
--
-- LOCKS. ADD COLUMN and the index builds lock calls, customer_requests and
-- appointments, which the voice engine writes mid-call. Rather than queue
-- behind a long transaction (and hold live calls' writes behind it), give up
-- after 5 seconds and let the deploy be retried (migrations 042, 052, 054).

SET LOCAL lock_timeout = '5s';

ALTER TABLE calls ADD COLUMN IF NOT EXISTS handled_at timestamptz;
ALTER TABLE calls ADD COLUMN IF NOT EXISTS handled_by text;

-- Home and the Inbox's "Needs you" read open items per business, oldest first.
CREATE INDEX IF NOT EXISTS idx_calls_open_items ON calls (business_id, started_at) WHERE handled_at IS NULL;

-- Every Home and Inbox read joins a call to its requests and bookings by call
-- id; without these each join scans the business's whole table.
CREATE INDEX IF NOT EXISTS idx_customer_requests_call ON customer_requests (call_id);
CREATE INDEX IF NOT EXISTS idx_appointments_call ON appointments (call_id);

ALTER TABLE calls NO FORCE ROW LEVEL SECURITY;
ALTER TABLE customer_requests NO FORCE ROW LEVEL SECURITY;

UPDATE calls c
   SET handled_at = now(),
       handled_by = 'launch'
 WHERE c.handled_at IS NULL
   AND c.started_at < now() - interval '7 days'
   AND EXISTS (SELECT 1 FROM customer_requests cr WHERE cr.call_id = c.id);

ALTER TABLE customer_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE calls FORCE ROW LEVEL SECURITY;
