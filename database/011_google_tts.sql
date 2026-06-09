ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS tts_voice text,
  ADD COLUMN IF NOT EXISTS barge_in boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS google_tts_voice text;

COMMENT ON COLUMN businesses.tts_voice IS
  'Twilio Polly voice ID used for TTS when Google TTS is not configured '
  '(e.g. "Polly.Joanna"). Defaults to "Polly.Joanna" in application code.';

COMMENT ON COLUMN businesses.barge_in IS
  'When true, callers can interrupt the AI mid-speech by speaking. '
  'Implemented by placing the Say/Play verb inside Gather.';

COMMENT ON COLUMN businesses.google_tts_voice IS
  'Google Cloud TTS voice name for higher-quality audio output '
  '(e.g. "en-US-Neural2-F", "en-US-Chirp3-HD-Aoede"). '
  'When set, Twilio <Play> is used instead of <Say>. '
  'Requires GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_TTS_API_KEY env var. '
  'Falls back to Twilio Polly if null or if credentials are missing.';
