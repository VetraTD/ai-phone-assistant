-- 062_appointment_changes.sql
--
-- Dashboard overhaul part 2 (2026-11-23, spec §8 Inbox and Calendar): booking
-- moves and cancellations, recorded against the call that made them.
--
-- appointments.call_id is the call that BOOKED: a later call that moves or
-- cancels the booking leaves no trace on the row except the new time or
-- status. This table is that trace, one row per change, so the dashboard can
-- say "Moved her check-up from Wednesday 9:00 am to Tuesday 9:00 am" on the
-- call that did it, and the Calendar can say "Cancelled by VetraTD on a call".
--
-- Written only by services/db.js's rescheduleAppointmentRecorded and
-- cancelAppointmentRecorded, each a single statement that changes the booking
-- and writes its row together: a change row exists only if the booking really
-- changed. Only VetraTD's own calendar (the internal scheduling adapter)
-- records here; bookings in an outside system are not in VetraTD's calendar.
--
-- Append-only for the application role: SELECT and INSERT, no UPDATE or
-- DELETE. Rows go with their booking (ON DELETE CASCADE). They carry times and
-- ids only, never a name or a number, so erasing a caller (which blanks the
-- booking's name, phone and notes) leaves nothing personal here.
--
-- Additive and safe to apply twice. LOCKS: the foreign keys take a brief lock
-- on appointments and calls, which the voice engine writes mid-call. Give up
-- after 5 seconds rather than queue live calls' writes behind a long
-- transaction, and let the deploy be retried (migrations 042, 052, 054, 061).

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS appointment_changes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  appointment_id   uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  call_id          uuid REFERENCES calls(id) ON DELETE SET NULL,
  kind             text NOT NULL CONSTRAINT appointment_changes_kind_check CHECK (kind IN ('moved', 'cancelled')),
  old_scheduled_at timestamptz NOT NULL,
  new_scheduled_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- A move has a new time; a cancellation has none.
  CONSTRAINT appointment_changes_new_time_check CHECK ((kind = 'moved') = (new_scheduled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_appointment_changes_business_time ON appointment_changes (business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_appointment_changes_appointment ON appointment_changes (appointment_id);
CREATE INDEX IF NOT EXISTS idx_appointment_changes_call ON appointment_changes (call_id);

ALTER TABLE appointment_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON appointment_changes;
CREATE POLICY tenant_isolation ON appointment_changes
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());

-- Migration 029's default privileges grant vetra_app everything on a new
-- table; take back all but SELECT and INSERT.
REVOKE ALL ON appointment_changes FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON appointment_changes FROM vetra_app;
GRANT SELECT, INSERT ON appointment_changes TO vetra_app;

COMMENT ON TABLE appointment_changes IS
  'Booking moves and cancellations on VetraTD''s own calendar, one row per change, against the call that made it (call_id NULL for a change outside a call). Append-only for vetra_app. Times and ids only.';
