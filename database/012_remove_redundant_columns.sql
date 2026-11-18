-- Migration 012: Remove redundant business columns
-- Columns moved to general_info (free-form text) or custom_instructions (AI behavior rules),
-- or replaced by hardcoded values in application code.

ALTER TABLE businesses
  -- Address fields → use general_info
  DROP COLUMN IF EXISTS address_line1,
  DROP COLUMN IF EXISTS address_line2,
  DROP COLUMN IF EXISTS city,
  DROP COLUMN IF EXISTS state_region,
  DROP COLUMN IF EXISTS postal_code,
  DROP COLUMN IF EXISTS country,

  -- Informational fields → use general_info
  DROP COLUMN IF EXISTS service_area,
  DROP COLUMN IF EXISTS staff_names,
  DROP COLUMN IF EXISTS booking_url,
  DROP COLUMN IF EXISTS business_summary,
  DROP COLUMN IF EXISTS services,

  -- AI behavior fields → use custom_instructions
  DROP COLUMN IF EXISTS voice_style,
  DROP COLUMN IF EXISTS booking_policy,
  DROP COLUMN IF EXISTS caller_data_policy,
  DROP COLUMN IF EXISTS off_limits_topics,
  DROP COLUMN IF EXISTS escalation_message,

  -- TTS config → hardcoded in application code
  -- Twilio: Polly.Joanna, Google: en-US-Chirp3-HD-Aoede
  DROP COLUMN IF EXISTS tts_voice,
  DROP COLUMN IF EXISTS google_tts_voice,

  -- Barge-in → hardcoded false in application code
  DROP COLUMN IF EXISTS barge_in;
