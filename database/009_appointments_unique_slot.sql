-- ============================================================
-- Migration 009: Prevent double-booking at the same date/time
-- ============================================================
-- Enforces that a business cannot have two 'scheduled' appointments
-- at the exact same scheduled_at timestamp.
--
-- This is a partial unique index, so cancelled (or other non-scheduled)
-- appointments do not block a time slot from being reused.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_appointments_business_scheduled_at_active
  ON appointments (business_id, scheduled_at)
  WHERE status = 'scheduled';

