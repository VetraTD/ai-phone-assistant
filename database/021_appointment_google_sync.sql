-- Migration 021: track Google Calendar sync state per appointment
--
-- Enables automatic, deduplicated sync of booked appointments into a
-- business's connected Google Calendar (AI-phone-dashboard/backend's
-- calendarSync.js background worker + the manual /api/calendar/sync route).
--
-- Before this, the manual "Sync now" button re-POSTed an event for every
-- upcoming appointment on every click — Google does not dedupe by content, so
-- repeated syncs created duplicate calendar events. `google_event_id` makes
-- sync idempotent: only rows where it IS NULL are pushed, and the created
-- event id is stored so the same appointment is never sent twice.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS google_event_id text,
  ADD COLUMN IF NOT EXISTS synced_at        timestamptz;

-- The worker's hot query is "unsynced upcoming appointments for this business".
-- A partial index keeps that scan cheap as synced rows accumulate.
CREATE INDEX IF NOT EXISTS idx_appointments_unsynced
  ON appointments (business_id, scheduled_at)
  WHERE google_event_id IS NULL;

COMMENT ON COLUMN appointments.google_event_id IS 'Google Calendar event id once this appointment has been pushed. NULL = not yet synced; the sync worker only touches NULL rows, making sync idempotent (no duplicate events).';
COMMENT ON COLUMN appointments.synced_at IS 'When this appointment was pushed to the connected calendar.';
