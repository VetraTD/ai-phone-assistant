-- ============================================================
-- Migration 057: LVX174 -- the fixed lines in the receptionist's voice.
--
-- One recorded clip per CALL_LINES line (lib/twiml.js), TTS voice and language:
-- Google TTS in the Chirp 3 HD voice with the same name as the live voice
-- (lib/voice/fixedLines.js). The lines are generic -- no business, no caller --
-- so a clip is shared by every business on that voice and keyed by a hash of
-- exactly what it says and in which voice. Twilio fetches it through
-- GET /media/line/<hash>.wav; Polly stays the fallback when a clip is missing.
--
-- A PLATFORM table (no business_id, no RLS, no grant to vetra_app), reachable
-- only through the two SECURITY DEFINER functions below -- the pending_dials /
-- blocked_callers shape (migration 054). No RLS is involved anywhere, so the
-- NOBYPASSRLS definer trap 054 documents does not apply here.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE.
-- ============================================================

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS fixed_line_clips (
  hash        text        PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{32}$'),
  line_key    text        NOT NULL CHECK (line_key IN ('noAnswer', 'cantTransfer', 'technical', 'technicalOutbound', 'timeUp')),
  voice_name  text        NOT NULL,
  audio       bytea       NOT NULL CHECK (octet_length(audio) BETWEEN 1 AND 1048576),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION app_fixed_line_clips(p_hashes text[])
RETURNS TABLE (hash text, audio bytea)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT c.hash, c.audio FROM fixed_line_clips c WHERE c.hash = ANY (p_hashes[1:10]);
$$;

CREATE OR REPLACE FUNCTION app_upsert_fixed_line_clip(p_hash text, p_line_key text, p_voice_name text, p_audio bytea)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO fixed_line_clips (hash, line_key, voice_name, audio)
  VALUES (p_hash, p_line_key, p_voice_name, p_audio)
  ON CONFLICT (hash) DO UPDATE
    SET line_key = EXCLUDED.line_key, voice_name = EXCLUDED.voice_name, audio = EXCLUDED.audio, created_at = now();
$$;

REVOKE ALL ON fixed_line_clips FROM PUBLIC;
REVOKE ALL ON fixed_line_clips FROM vetra_app;
REVOKE ALL ON FUNCTION app_fixed_line_clips(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_upsert_fixed_line_clip(text, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_fixed_line_clips(text[]) TO vetra_app;
GRANT EXECUTE ON FUNCTION app_upsert_fixed_line_clip(text, text, text, bytea) TO vetra_app;

COMMENT ON TABLE fixed_line_clips IS
  'LVX174: recorded CALL_LINES clips (Google TTS, mu-law 8k), shared across businesses, keyed by content hash. Platform table: definer functions only.';
