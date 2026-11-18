-- ============================================================
-- Migration 026: normalize appointments.client_phone, and keep it normalized
-- ============================================================
-- Migration 024 cleaned the businesses table's four phone columns and put a
-- BEFORE trigger on it so a hand-edit could not undo the work. It left
-- appointments.client_phone alone — and that is the column two DIFFERENT
-- lookup rules read to answer the same question:
--
--   services/supabase.js fetchCallerContext   matched it with string equality
--   services/supabase.js listAppointmentsByCaller  matches the last 10 digits
--
-- So the prompt's "Upcoming appointments" line and the
-- get_caller_appointments_from_db tool could disagree about whether a caller
-- had an appointment at all: the tool found the row, the prompt did not, and
-- the receptionist cheerfully offered to book a second one. fetchCallerContext
-- now calls listAppointmentsByCaller, so there is one rule; this migration
-- makes the stored data match it.
--
-- Three deviations from 024, all deliberate:
--
--   1. NO UNIQUE INDEX. Many appointments legitimately share a phone number —
--      a returning caller, a family on one handset, an office landline. That is
--      the normal case, not a conflict. 024's duplicate check exists because
--      two businesses on one number breaks call routing; nothing here breaks.
--
--   2. The per-row NOTICE audit trail is CAPPED. 024 printed every business
--      because there are tens of them. There can be hundreds of thousands of
--      appointments, and an unbounded RAISE NOTICE loop is its own outage. A
--      sample plus an exact count is the same audit trail at survivable size.
--
--   3. normalize_phone_value() is NOT redefined. It is 024's function and has
--      to stay in step with lib/phone.js in exactly ONE place — two copies
--      drifting apart is how the original bug would come back wearing a
--      different hat. This migration REQUIRES 024 and fails loudly without it.
--
-- ALL OR NOTHING, for 024's reason: a backfill that commits without its trigger
-- leaves cleaned data with nothing defending it, which reads as "the migration
-- failed" while having half-succeeded. Postgres DDL is transactional.
BEGIN;

-- ------------------------------------------------------------
-- 0. Require migration 024's normalizer. Do not recreate it.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF to_regprocedure('normalize_phone_value(text)') IS NULL THEN
    RAISE EXCEPTION
      'normalize_phone_value(text) is missing — run database/024_normalize_phone_numbers.sql first';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. Backfill — report a bounded sample, then change everything
-- ------------------------------------------------------------
-- Read the NOTICEs. The quoting is the point: it is what makes an invisible
-- leading newline or a trailing space visible.
DO $$
DECLARE
  r record;
  changed int := 0;
  shown int := 0;
BEGIN
  FOR r IN
    SELECT id, business_id, client_phone
      FROM appointments
     WHERE client_phone IS DISTINCT FROM normalize_phone_value(client_phone)
     ORDER BY created_at
  LOOP
    changed := changed + 1;
    IF shown < 50 THEN
      shown := shown + 1;
      RAISE NOTICE 'normalizing appointment % (business %): client_phone % -> %',
        r.id, r.business_id,
        quote_nullable(r.client_phone),
        quote_nullable(normalize_phone_value(r.client_phone));
    END IF;
  END LOOP;

  RAISE NOTICE 'appointment phone normalization: % row(s) need changes (% shown)', changed, shown;
END $$;

UPDATE appointments
   SET client_phone = normalize_phone_value(client_phone)
 WHERE client_phone IS DISTINCT FROM normalize_phone_value(client_phone);

-- Surface what normalization could not fix. These are NOT auto-corrected: a
-- bare national number ("5551234567") does not become E.164 by guessing a
-- country code — that is how a UK appointment becomes a US one. They stay
-- findable meanwhile because the single lookup rule matches the last 10 digits.
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
    FROM appointments
   WHERE client_phone IS NOT NULL
     AND client_phone !~ '^\+[1-9][0-9]{1,14}$';

  IF n > 0 THEN
    RAISE WARNING
      '% appointment row(s) have a client_phone that is not valid E.164 — they remain findable only by the last-10-digit match',
      n;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 2. Keep it normalized — including hand-edits in the Supabase table editor
-- ------------------------------------------------------------
-- The application-level path is already clean (client_phone is written from the
-- Twilio `From` value), so this defends the paths that bypass every validator:
-- the Supabase table editor, an import, a hand-written UPDATE. That is exactly
-- the route that produced the original routing bug.
--
-- It also normalizes writes from create_appointment_if_available (migration
-- 022), which INSERTs into this table — a BEFORE trigger sees those too.
CREATE OR REPLACE FUNCTION appointments_normalize_phones()
RETURNS trigger AS $$
BEGIN
  NEW.client_phone := normalize_phone_value(NEW.client_phone);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointments_normalize_phones_trg ON appointments;

-- UPDATE OF client_phone, not a bare UPDATE: updateAppointmentStatus and
-- updateAppointment never touch this column and should pay nothing.
CREATE TRIGGER appointments_normalize_phones_trg
  BEFORE INSERT OR UPDATE OF client_phone
  ON appointments
  FOR EACH ROW
  EXECUTE FUNCTION appointments_normalize_phones();

-- Deliberately NOT unique (see the header). Supports the tenant-scoped read;
-- the last-10-digit suffix match is filtered in the application, so this index
-- serves the business_id scoping rather than the phone comparison itself.
CREATE INDEX IF NOT EXISTS idx_appointments_business_client_phone
  ON appointments (business_id, client_phone);

COMMIT;
