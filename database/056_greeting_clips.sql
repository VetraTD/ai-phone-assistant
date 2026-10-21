-- 056_greeting_clips.sql
--
-- The recorded greeting (pronunciation build, Step 2, 2026-10-20).
--
-- One clip per business, greeting variant and language: "custom" for the
-- business's own greeting, or "morning" / "afternoon" / "evening" for the
-- time-of-day default. Raw 8 kHz mu-law, made by Google TTS in the Chirp 3 HD
-- voice with the same name as the business's live voice
-- (lib/voice/greetingClip.js). Played at pickup on an inbound call instead of
-- the AI speaking the greeting.
--
-- input_hash identifies exactly what the clip says and in which voice (a hash
-- of the SSML and the TTS voice). The voice service plays a clip ONLY when its
-- input_hash equals the one it computes for the call; any other row is stale,
-- the AI greets as before, and the clip is remade in the background. That is
-- what stops a greeting the business has since changed from ever playing.
--
-- Tenant data like call_attempts' audio columns: ENABLE + FORCE row level
-- security, the standard tenant_isolation policy, vetra_app grants.

BEGIN;

CREATE TABLE IF NOT EXISTS greeting_clips (
  business_id    uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  variant        text        NOT NULL CHECK (variant IN ('custom', 'morning', 'afternoon', 'evening')),
  language_code  text        NOT NULL,
  input_hash     text        NOT NULL,
  spoken_text    text        NOT NULL,
  voice_name     text        NOT NULL,
  audio          bytea       NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, variant, language_code)
);

ALTER TABLE greeting_clips ENABLE ROW LEVEL SECURITY;
ALTER TABLE greeting_clips FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON greeting_clips;
CREATE POLICY tenant_isolation ON greeting_clips
  USING (business_id = app_current_business_id())
  WITH CHECK (business_id = app_current_business_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON greeting_clips TO vetra_app;

COMMENT ON TABLE greeting_clips IS
  'Pre-recorded greeting per business/variant/language (Google TTS, mu-law 8k). Played only when input_hash matches what the voice service computes for the call.';

COMMIT;
