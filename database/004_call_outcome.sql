-- ============================================================
-- Migration: Add outcome column to calls (call outcome tagging)
-- Run this in the Supabase SQL Editor if the column does not exist.
-- ============================================================

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS outcome text;

COMMENT ON COLUMN calls.outcome IS 'Call outcome: general_inquiry, appointment, sales, support, message, callback, after_hours, emergency, transfer, spam, unknown';
