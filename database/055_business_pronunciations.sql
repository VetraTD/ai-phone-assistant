-- 055_business_pronunciations.sql
--
-- The pronunciation box (2026-10-20): per business, how a written name is SAID.
--
--   { "Digile": "Dij-aisle" }
--   { "Digile": { "say": "Dij-aisle", "ipa": "<IPA phonemes>" } }
--
-- gemini-3.8-live has no pronunciation control; the text it reads is the only
-- lever. In a blind listening test the model said "Digile Media" right 1 time
-- in 10, and 7 in 10 when its prompt said "Dij-aisle Media"
-- (.superpowers/sdd/2026-10-20-pronunciation/ledger.md). So the MODEL is given
-- the spoken form and everything a person reads keeps the written one
-- (lib/voice/pronunciation.js). The optional "ipa" is used only when rendering
-- recorded clips with Google TTS; the live model never sees it.
--
-- Empty object = no map, which is correct for the whole existing estate, so no
-- backfill. No CHECK constraint: the shape is validated where it is written
-- (dashboard settingsValidation, scripts/set-business-config.js) and again where
-- it is read (pronunciationEntries drops anything it cannot use), and a
-- constraint here would only turn a bad value into a failed settings save.

BEGIN;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS pronunciations jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN businesses.pronunciations IS
  'Written -> spoken names for the AI (e.g. {"Digile": "Dij-aisle"} or {"Digile": {"say": "Dij-aisle", "ipa": "..."}}). The live model reads only the spoken form; tools, emails and transcripts keep the written one.';

COMMIT;
