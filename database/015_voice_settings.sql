-- Migration 015: Per-business voice selection
--
-- Lets each business pick which TTS voice callers hear, instead of every
-- call using the single global ELEVENLABS_DEFAULT_VOICE_ID. voice_provider
-- selects the synthesis backend (see lib/voice/session.js resolveVoice());
-- voice_id is the provider-specific voice identifier (an ElevenLabs voice ID
-- when voice_provider = 'elevenlabs' — see config/voices.js VOICE_CATALOG for
-- the curated picker list; ignored/unused when voice_provider = 'google',
-- which always uses the fixed Google TTS fallback voice).

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS voice_provider text DEFAULT 'elevenlabs',
  ADD COLUMN IF NOT EXISTS voice_id text;

COMMENT ON COLUMN businesses.voice_provider IS
  'TTS backend for this business''s calls: "elevenlabs" (default, streaming, '
  'highest quality) or "google" (skips ElevenLabs entirely, uses the fixed '
  'Google TTS fallback voice). See lib/voice/session.js resolveVoice().';

COMMENT ON COLUMN businesses.voice_id IS
  'ElevenLabs voice ID to use when voice_provider = ''elevenlabs'' (e.g. '
  '"21m00Tcm4TlvDq8ikWAM" for Rachel — see config/voices.js VOICE_CATALOG). '
  'NULL falls back to ELEVENLABS_DEFAULT_VOICE_ID. Unused when '
  'voice_provider = ''google''.';
