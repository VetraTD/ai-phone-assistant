-- 041_business_live_voice.sql
--
-- Give a business its own Gemini Live voice, so the voice a caller hears is a
-- tenant setting rather than a platform-wide constant.
--
-- Migration 025 did this for the LANGUAGE and stopped there. The result, found
-- on 2026-09-04: the accent a tenant is pinned to could be corrected per tenant
-- while the voice speaking it could not, because lib/voice/live/index.js held
-- one module-scope `const VOICE` for every business on the platform. A UK demo
-- tenant and an American dental practice were answered by the same voice.
--
-- NULL means "use the per-language default", which is correct for the entire
-- existing estate and is why there is no backfill — writing today's default
-- into every row would freeze a choice nobody made, and a wrong value in data
-- is far harder to notice than a wrong value in code. Same reasoning as 025's.
--
-- NO CHECK CONSTRAINT, deliberately, and this is the one place it differs from
-- 025. `locale` has a closed set this repository owns (lib/voice/localeProfiles
-- PROFILE_IDS). The prebuilt voice names are Google's, they are added to
-- without asking us, and a CHECK would mean a migration every time the vendor
-- ships a voice. The failure mode is also mild rather than sharp: an
-- unrecognised name is not rejected by the Live API, it is silently ignored and
-- the session speaks in the default voice anyway (backlog LVX13). A constraint
-- would convert a cosmetic miss into a refused write.
--
-- Read by services/db.js loadConfig -> config.liveVoice, consumed by
-- lib/voice/live/index.js resolveLiveVoice(). Precedence there is
-- LIVE_VOICE (env) -> this column -> the per-language default.

BEGIN;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS live_voice text;

COMMENT ON COLUMN businesses.live_voice IS
  'Gemini Live prebuilt voice name for this tenant (e.g. ''Kore''). NULL = use the per-language default. Speech-to-speech front-end only; the cascade''s TTS voice is voice_provider/voice_id.';

COMMIT;
