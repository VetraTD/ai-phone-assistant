-- 025_business_locale.sql
--
-- Give a business an explicit locale, so an operator can correct a wrong guess.
--
-- Everything about how a business sounds and how its callers are heard was
-- previously DERIVED, through a chain of four fallbacks: the chosen voice's
-- accent, the business's own number, the caller's number, the timezone. That
-- chain is right nearly always and wrong in exactly the cases that matter — a
-- London business on a US-numbered line, a US business that likes a British
-- voice — and until now there was no way to say so.
--
-- NULL means "derive", which is correct for the entire existing estate and is
-- why there is no backfill: writing a guess into a column freezes it, and a
-- wrong guess in data is much harder to notice than a wrong guess in code.
--
-- Read by services/supabase.js loadConfig -> config.locale, consumed by
-- lib/voice/voiceLocale.js (resolveSpeechLocale / resolveProfile). The values
-- match lib/voice/localeProfiles.js PROFILE_IDS; keep the CHECK in step with it.

BEGIN;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS locale text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'businesses_locale_check'
  ) THEN
    ALTER TABLE businesses
      ADD CONSTRAINT businesses_locale_check
      CHECK (locale IS NULL OR locale IN ('en-US', 'en-GB', 'es-US'));
  END IF;
END $$;

COMMENT ON COLUMN businesses.locale IS
  'Explicit locale override (en-US | en-GB | es-US). NULL = derive from voice accent, phone numbers and timezone. Drives date phrasing, currency, phone grouping, ringback and the STT language.';

COMMIT;
