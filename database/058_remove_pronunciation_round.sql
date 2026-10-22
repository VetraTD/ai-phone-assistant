-- 058_remove_pronunciation_round.sql
--
-- Owner decision (2026-10-22): the pronunciation round is reverted in full --
-- the pronunciation box, the recorded greeting and the fixed lines in the
-- receptionist's voice. Production went back to voice-uk-prod-00112-boh, whose
-- code never reads any of these, and the owner chose to remove them rather than
-- leave them unused.
--
-- 055/056/057 stay in the repository because the migration ledger records them
-- as applied; this file undoes them. Idempotent (IF EXISTS), and no CASCADE: if
-- anything has come to depend on these objects, the migration fails loudly
-- instead of dropping that too.
--
-- lock_timeout: ALTER TABLE businesses takes a brief exclusive lock while live
-- calls read the table; wait at most 5 s for it rather than queueing behind a
-- long transaction.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS app_upsert_fixed_line_clip(text, text, text, bytea);
DROP FUNCTION IF EXISTS app_fixed_line_clips(text[]);
DROP TABLE IF EXISTS fixed_line_clips;
DROP TABLE IF EXISTS greeting_clips;
ALTER TABLE businesses DROP COLUMN IF EXISTS pronunciations;

COMMIT;
