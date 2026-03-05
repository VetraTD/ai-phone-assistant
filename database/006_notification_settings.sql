-- ============================================================
-- Migration 006: Per-business notification settings (email/SMS)
-- Run this in the Supabase SQL Editor.
-- ============================================================

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS notification_email    text,
  ADD COLUMN IF NOT EXISTS notification_phone    text,
  ADD COLUMN IF NOT EXISTS notifications_enabled boolean DEFAULT true;

COMMENT ON COLUMN businesses.notification_email IS 'Primary email address for call-related alerts (appointments, messages, missed calls, summaries).';
COMMENT ON COLUMN businesses.notification_phone IS 'E.164 phone number for SMS alerts.';
COMMENT ON COLUMN businesses.notifications_enabled IS 'When false, no email/SMS notifications are sent for this business.';
