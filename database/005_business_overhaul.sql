-- ============================================================
-- Migration 005: Business overhaul — new config columns + business_knowledge table
-- Run this in the Supabase SQL Editor.
-- ============================================================

-- 1. New columns on businesses
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS business_summary          text,
  ADD COLUMN IF NOT EXISTS recording_disclosure_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS recording_disclosure_text  text,
  ADD COLUMN IF NOT EXISTS off_limits_topics          jsonb,
  ADD COLUMN IF NOT EXISTS after_hours_policy         text DEFAULT 'take_message',
  ADD COLUMN IF NOT EXISTS escalation_message         text,
  ADD COLUMN IF NOT EXISTS booking_policy             text,
  ADD COLUMN IF NOT EXISTS transfer_policy            text DEFAULT 'always',
  ADD COLUMN IF NOT EXISTS staff_names                jsonb,
  ADD COLUMN IF NOT EXISTS service_area               text,
  ADD COLUMN IF NOT EXISTS services                   jsonb,
  ADD COLUMN IF NOT EXISTS languages_spoken           jsonb DEFAULT '["en"]',
  ADD COLUMN IF NOT EXISTS booking_url                text,
  ADD COLUMN IF NOT EXISTS caller_data_policy         text;

COMMENT ON COLUMN businesses.business_summary IS 'Short description of the business for the AI prompt (~150 tokens max).';
COMMENT ON COLUMN businesses.recording_disclosure_enabled IS 'Whether the AI should announce the call is recorded.';
COMMENT ON COLUMN businesses.recording_disclosure_text IS 'Custom recording disclosure text. NULL → default.';
COMMENT ON COLUMN businesses.off_limits_topics IS 'JSON array of topic strings the AI must refuse to discuss.';
COMMENT ON COLUMN businesses.after_hours_policy IS 'One of: take_message, offer_callback, book_later, transfer_if_possible.';
COMMENT ON COLUMN businesses.escalation_message IS 'Custom message when the AI cannot help and no transfer is available.';
COMMENT ON COLUMN businesses.booking_policy IS 'Free-text rules the AI must follow when booking (e.g. "no same-day appointments").';
COMMENT ON COLUMN businesses.transfer_policy IS 'One of: always, business_hours_only, never.';
COMMENT ON COLUMN businesses.staff_names IS 'JSON array of staff names the AI can reference.';
COMMENT ON COLUMN businesses.service_area IS 'Geographic area the business serves.';
COMMENT ON COLUMN businesses.services IS 'JSON array of service objects [{name, duration_minutes, price}].';
COMMENT ON COLUMN businesses.languages_spoken IS 'JSON array of language codes. Default ["en"].';
COMMENT ON COLUMN businesses.booking_url IS 'URL for online booking (the AI can mention it).';
COMMENT ON COLUMN businesses.caller_data_policy IS 'Instructions for what caller data the AI may/may not collect.';

-- 2. business_knowledge table — Q&A pairs injected into AI prompt
CREATE TABLE IF NOT EXISTS business_knowledge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  question    text NOT NULL,
  answer      text NOT NULL,
  category    text,
  priority    int DEFAULT 0,
  enabled     boolean DEFAULT true,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_business_knowledge_business_enabled
  ON business_knowledge (business_id, enabled, priority DESC);

COMMENT ON TABLE business_knowledge IS 'Business-specific Q&A knowledge pairs injected into the AI system prompt.';
