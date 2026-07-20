-- Migration 014: business_hours -> weekly shape
--
-- Converts businesses.business_hours from the legacy single-window shape
-- {"open_time":"09:00","close_time":"17:00"} (applied identically every
-- day) to a weekly schedule keyed by lowercase 3-letter day:
--   {"mon":{"open":"09:00","close":"17:00","closed":false}, ...,
--    "sun":{"open":null,"close":null,"closed":true}}
--
-- Backfill: existing open_time/close_time carry over to Mon-Fri; Sat/Sun
-- default to closed. Rows with business_hours = NULL are left untouched
-- (NULL still means "always open" — see services/gemini.js isBusinessOpen).
--
-- Idempotent: rows already in the weekly shape (detected via the "mon" key)
-- are skipped, so re-running this migration is a no-op for already-migrated
-- rows.

UPDATE businesses
SET business_hours = jsonb_build_object(
  'mon', jsonb_build_object('open', business_hours->>'open_time', 'close', business_hours->>'close_time', 'closed', false),
  'tue', jsonb_build_object('open', business_hours->>'open_time', 'close', business_hours->>'close_time', 'closed', false),
  'wed', jsonb_build_object('open', business_hours->>'open_time', 'close', business_hours->>'close_time', 'closed', false),
  'thu', jsonb_build_object('open', business_hours->>'open_time', 'close', business_hours->>'close_time', 'closed', false),
  'fri', jsonb_build_object('open', business_hours->>'open_time', 'close', business_hours->>'close_time', 'closed', false),
  'sat', jsonb_build_object('open', null, 'close', null, 'closed', true),
  'sun', jsonb_build_object('open', null, 'close', null, 'closed', true)
)
WHERE business_hours IS NOT NULL
  AND NOT (business_hours ? 'mon');

-- New businesses should default to the weekly shape too (09:00-17:00
-- Mon-Fri, closed Sat/Sun), matching the backfilled default above.
ALTER TABLE businesses
  ALTER COLUMN business_hours SET DEFAULT jsonb_build_object(
    'mon', jsonb_build_object('open', '09:00', 'close', '17:00', 'closed', false),
    'tue', jsonb_build_object('open', '09:00', 'close', '17:00', 'closed', false),
    'wed', jsonb_build_object('open', '09:00', 'close', '17:00', 'closed', false),
    'thu', jsonb_build_object('open', '09:00', 'close', '17:00', 'closed', false),
    'fri', jsonb_build_object('open', '09:00', 'close', '17:00', 'closed', false),
    'sat', jsonb_build_object('open', null, 'close', null, 'closed', true),
    'sun', jsonb_build_object('open', null, 'close', null, 'closed', true)
  );

COMMENT ON COLUMN businesses.business_hours IS
  'Weekly business-hours schedule keyed by lowercase 3-letter day (mon..sun); '
  'each value is {"open":"HH:MM","close":"HH:MM","closed":boolean}. NULL = '
  'always open (no restriction). The legacy single-window shape '
  '{open_time,close_time} is still read by services/gemini.js isBusinessOpen() '
  'for any row that predates this migration.';
