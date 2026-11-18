-- ============================================================
-- Migration 024: normalize phone numbers, and keep them normalized
-- ============================================================
-- Root cause of "the AI answers as 'our office' for every business except the
-- one we bought through the app":
--
--   lookupBusinessByPhone (services/supabase.js) matches the Twilio `To` value
--   against businesses.phone_number with STRING EQUALITY. Twilio always sends
--   clean E.164 ("+442079460958"). Every hand-entered row was stored with a
--   LEADING NEWLINE ("\n+442079460958"), because Supabase's table editor renders
--   a text column as a multi-line textarea and saves a pasted newline verbatim.
--   A newline is a character, so the row was invisible to the lookup and the
--   call fell through to loadConfig(null) -> businessName "our office".
--
--   The one business that worked was the one whose number was written by the
--   Twilio buy flow (server.js) rather than typed by a human.
--
-- The same damage silently breaks more than routing: transfer_phone_number is
-- injected into a <Dial> verb and notification_phone is handed to Twilio for
-- SMS, so a stray newline there kills transfers and text alerts too.
--
-- Three things happen below, in order:
--   1. a normalizer function mirroring lib/phone.js normalizePhoneNumber()
--   2. a one-time backfill of all four phone columns, reporting what it changed
--   3. a BEFORE trigger so a future bad paste cannot persist
--
-- Step 3 is the part that matters long-term: numbers are edited by hand in the
-- Supabase table editor, which bypasses every application-level validator.
-- Only the database can defend that path.

-- ALL OR NOTHING. Without this wrapper each statement commits on its own, and
-- the duplicate check in step 3 aborts AFTER the backfill has already
-- committed — leaving cleaned data with no unique index and no trigger, which
-- is a state nobody chose and which reads as "the migration failed" while
-- having half-succeeded. Postgres DDL is transactional, so the index, the
-- functions and the trigger all roll back cleanly too. Resolve the duplicates
-- and re-run.
BEGIN;

-- ------------------------------------------------------------
-- 1. Normalizer — must stay in step with lib/phone.js
-- ------------------------------------------------------------
-- Strips characters that carry no dialling information (whitespace, the
-- punctuation humans format numbers with, and the unicode dashes a word
-- processor substitutes), then rewrites a leading "00" international prefix to
-- "+". Deliberately does NOT guess a country code: an ambiguous national number
-- is left as-is so it stays visibly wrong rather than becoming a valid number
-- in the wrong country. Validation is the application's job (isValidE164);
-- this function only cleans.
CREATE OR REPLACE FUNCTION normalize_phone_value(v text)
RETURNS text AS $$
DECLARE
  s text;
BEGIN
  IF v IS NULL THEN
    RETURN NULL;
  END IF;

  -- All whitespace: space, tab, newline, carriage return, form feed, vertical tab.
  s := regexp_replace(v, '[[:space:]]', '', 'g');

  -- Formatting punctuation, NBSP, zero-width characters, BOM, unicode dashes.
  s := translate(
         s,
         E'()./ ​‌‍﻿‐‑‒–—―−-',
         ''
       );

  IF s = '' THEN
    RETURN NULL;
  END IF;

  -- "00" is the international access prefix; "+" is the E.164 spelling of the
  -- same thing. No valid E.164 number starts with 0, so this is unambiguous.
  IF left(s, 2) = '00' THEN
    s := '+' || substr(s, 3);
  END IF;

  RETURN s;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ------------------------------------------------------------
-- 2. Backfill — report every row being changed, then change it
-- ------------------------------------------------------------
-- The NOTICEs are the audit trail. Read them: a row whose normalized value is
-- still not valid E.164 (no leading +, or non-digits) was more than whitespace
-- damaged and needs a human decision, not a silent rewrite.
DO $$
DECLARE
  r record;
  changed int := 0;
BEGIN
  FOR r IN
    SELECT id, name, phone_number, transfer_phone_number, main_phone, notification_phone
      FROM businesses
     WHERE phone_number          IS DISTINCT FROM normalize_phone_value(phone_number)
        OR transfer_phone_number IS DISTINCT FROM normalize_phone_value(transfer_phone_number)
        OR main_phone            IS DISTINCT FROM normalize_phone_value(main_phone)
        OR notification_phone    IS DISTINCT FROM normalize_phone_value(notification_phone)
  LOOP
    changed := changed + 1;
    -- quote_nullable, not %L: RAISE only understands %, and %L renders as the
    -- value followed by a literal "L". The quoting matters here more than
    -- usual — the whole point is to make an invisible leading newline visible.
    RAISE NOTICE 'normalizing business % (%): phone_number % -> %, transfer % -> %, main % -> %, notification % -> %',
      r.id, r.name,
      quote_nullable(r.phone_number),          quote_nullable(normalize_phone_value(r.phone_number)),
      quote_nullable(r.transfer_phone_number), quote_nullable(normalize_phone_value(r.transfer_phone_number)),
      quote_nullable(r.main_phone),            quote_nullable(normalize_phone_value(r.main_phone)),
      quote_nullable(r.notification_phone),    quote_nullable(normalize_phone_value(r.notification_phone));
  END LOOP;

  RAISE NOTICE 'phone normalization: % row(s) need changes', changed;
END $$;

UPDATE businesses
   SET phone_number          = normalize_phone_value(phone_number),
       transfer_phone_number = normalize_phone_value(transfer_phone_number),
       main_phone            = normalize_phone_value(main_phone),
       notification_phone    = normalize_phone_value(notification_phone)
 WHERE phone_number          IS DISTINCT FROM normalize_phone_value(phone_number)
    OR transfer_phone_number IS DISTINCT FROM normalize_phone_value(transfer_phone_number)
    OR main_phone            IS DISTINCT FROM normalize_phone_value(main_phone)
    OR notification_phone    IS DISTINCT FROM normalize_phone_value(notification_phone);

-- Surface anything still not dialable. These are NOT fixed automatically —
-- guessing a country code is how a UK number becomes a US one.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id, name, phone_number
      FROM businesses
     WHERE phone_number IS NOT NULL
       AND phone_number !~ '^\+[1-9][0-9]{1,14}$'
  LOOP
    RAISE WARNING 'business % (%) has a phone_number that is not valid E.164: % — calls to it will NOT route until fixed by hand',
      r.id, r.name, quote_nullable(r.phone_number);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 3. Duplicate check, then the unique index
-- ------------------------------------------------------------
-- Two businesses sharing a number means lookupBusinessByPhone's .limit(1) picks
-- one arbitrarily — a caller reaches whichever row the planner returned first.
-- Fail the migration rather than create an index that cannot be built, so the
-- operator sees the conflict instead of a confusing index error.
DO $$
DECLARE
  dupes text;
BEGIN
  SELECT string_agg(phone_number || ' (' || cnt || ' businesses)', ', ')
    INTO dupes
    FROM (
      SELECT phone_number, count(*) AS cnt
        FROM businesses
       WHERE phone_number IS NOT NULL
       GROUP BY phone_number
      HAVING count(*) > 1
    ) d;

  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate phone_number values must be resolved by hand before this migration can complete: %', dupes;
  END IF;
END $$;

-- Partial: many businesses legitimately have no number yet (onboarding creates
-- the row before a number is attached), and NULLs must not collide.
CREATE UNIQUE INDEX IF NOT EXISTS businesses_phone_number_unique
  ON businesses (phone_number)
  WHERE phone_number IS NOT NULL;

-- ------------------------------------------------------------
-- 4. Keep it normalized — including hand-edits in the Supabase table editor
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION businesses_normalize_phones()
RETURNS trigger AS $$
BEGIN
  NEW.phone_number          := normalize_phone_value(NEW.phone_number);
  NEW.transfer_phone_number := normalize_phone_value(NEW.transfer_phone_number);
  NEW.main_phone            := normalize_phone_value(NEW.main_phone);
  NEW.notification_phone    := normalize_phone_value(NEW.notification_phone);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS businesses_normalize_phones_trg ON businesses;

CREATE TRIGGER businesses_normalize_phones_trg
  BEFORE INSERT OR UPDATE OF phone_number, transfer_phone_number, main_phone, notification_phone
  ON businesses
  FOR EACH ROW
  EXECUTE FUNCTION businesses_normalize_phones();

COMMIT;
