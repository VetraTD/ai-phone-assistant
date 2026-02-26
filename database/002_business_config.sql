-- ============================================================
-- Migration: Add per-business config columns to businesses
-- Run this in the Supabase SQL Editor if the table already exists.
-- ============================================================
-- Defaults:
--   greeting              → NULL (app uses a generic greeting)
--   business_hours        → 9 AM – 5 PM  (set NULL for "always open")
--   transfer_phone_number → NULL (falls back to env TRANSFER_NUMBER)
--   allowed_tasks         → all tasks enabled
--   voice_style           → NULL (default professional tone)
--   main_phone            → NULL (no separate public number)
--   general_info          → NULL (no extended info)
--   address_*             → NULL (no structured address)
-- ============================================================

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS greeting              text,
  ADD COLUMN IF NOT EXISTS business_hours        jsonb DEFAULT '{"open_time":"09:00","close_time":"17:00"}',
  ADD COLUMN IF NOT EXISTS transfer_phone_number text,
  ADD COLUMN IF NOT EXISTS allowed_tasks         jsonb DEFAULT '["book_appointment","general_question"]',
  ADD COLUMN IF NOT EXISTS voice_style           text,
  ADD COLUMN IF NOT EXISTS main_phone            text,
  ADD COLUMN IF NOT EXISTS general_info          text,
  ADD COLUMN IF NOT EXISTS address_line1         text,
  ADD COLUMN IF NOT EXISTS address_line2         text,
  ADD COLUMN IF NOT EXISTS city                  text,
  ADD COLUMN IF NOT EXISTS state_region          text,
  ADD COLUMN IF NOT EXISTS postal_code           text,
  ADD COLUMN IF NOT EXISTS country               text;

COMMENT ON COLUMN businesses.greeting IS 'Custom greeting text spoken at call start. NULL = default AI greeting.';
COMMENT ON COLUMN businesses.business_hours IS 'JSON {"open_time":"HH:MM","close_time":"HH:MM"} in 24-hour format. NULL = always open.';
COMMENT ON COLUMN businesses.transfer_phone_number IS 'E.164 phone number for live transfer. NULL = use env TRANSFER_NUMBER or disable transfer.';
COMMENT ON COLUMN businesses.allowed_tasks IS 'JSON array of allowed AI tasks, e.g. ["book_appointment","general_question"]. NULL = all allowed.';
COMMENT ON COLUMN businesses.voice_style IS 'Optional tone/style instruction for the AI, e.g. "warm and empathetic". NULL = default professional tone.';
COMMENT ON COLUMN businesses.main_phone IS 'Public office phone number for the business. May differ from Twilio phone_number.';
COMMENT ON COLUMN businesses.general_info IS 'Free-form information about the business for callers (about, providers, directions, insurance, etc.).';
COMMENT ON COLUMN businesses.address_line1 IS 'Business street address line 1.';
COMMENT ON COLUMN businesses.address_line2 IS 'Business street address line 2 (suite, floor, etc.).';
COMMENT ON COLUMN businesses.city IS 'Business city.';
COMMENT ON COLUMN businesses.state_region IS 'Business state, province, or region.';
COMMENT ON COLUMN businesses.postal_code IS 'Business postal / ZIP code.';
COMMENT ON COLUMN businesses.country IS 'Business country.';
