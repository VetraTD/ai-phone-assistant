-- ============================================================
-- Migration 045: outbound -- the sweep's stale-attempt backstop (spec §6.3,
-- §11, §13.2-13.4, owner decision O-5, the 044 pattern)
-- ============================================================
-- The sweep (lib/outbound/internalRoutes.js) runs with NO tenant and across
-- every business, and 042-044 give it no way to LIST stuck attempts: 044's
-- dial_registry feeds only two COUNTS (app_active_dial_counts) and drops a
-- row the moment ended_at/result is set, and there is no directory for "a
-- call whose post-call has not started yet". FORCE RLS binds a SECURITY
-- DEFINER function's OWNER too (033, carried by 044), so this follows the
-- SAME shape: one more no-RLS routing table, kept true by a trigger, read
-- only by one definer function, ids and a timestamp only -- never a phone
-- number or a name.

-- Fail fast instead of queueing inbound queries behind an ACCESS EXCLUSIVE wait; the migrate job is retried.
SET LOCAL lock_timeout = '5s';

-- Supports app_outbound_stale_attempts' "sidless" LEFT JOIN below: whether a
-- dial_registry row (044) has a matching directory entry at all. 044 created
-- call_attempt_directory keyed on twilio_call_sid only; this is additive.
CREATE INDEX IF NOT EXISTS call_attempt_directory_attempt_idx ON call_attempt_directory (attempt_id);

CREATE TABLE IF NOT EXISTS postcall_pending (
  attempt_id          uuid PRIMARY KEY,
  business_id         uuid NOT NULL,
  status_completed_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS postcall_pending_due_idx ON postcall_pending (status_completed_at);

REVOKE ALL ON postcall_pending FROM PUBLIC;
REVOKE ALL ON postcall_pending FROM vetra_app;

COMMENT ON TABLE postcall_pending IS
  'Routing only: attempts whose post-call has not started yet, for the sweep''s postcall_pending backstop. Deliberately has NO row-level security and NO grant to vetra_app: only app_outbound_stale_attempts reads it, and a trigger on call_attempts keeps it true. A row exists iff call_attempts.status_completed_at IS NOT NULL AND post_call_started_at IS NULL. Holds ids and a timestamp. Must never carry a phone number or a name.';

-- Keeping it true. SECURITY DEFINER because the writer (vetra_app, under RLS
-- on call_attempts) has no rights on this table. Fires on the two columns
-- that decide membership (status_completed_at, post_call_started_at) and on
-- DELETE, the same trigger shape 044's app_sync_outbound_directories uses.
CREATE OR REPLACE FUNCTION app_sync_postcall_pending()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    DELETE FROM postcall_pending WHERE attempt_id = OLD.id;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    IF NEW.status_completed_at IS NOT NULL AND NEW.post_call_started_at IS NULL THEN
      INSERT INTO postcall_pending (attempt_id, business_id, status_completed_at)
      VALUES (NEW.id, NEW.business_id, NEW.status_completed_at)
      ON CONFLICT (attempt_id) DO UPDATE SET status_completed_at = EXCLUDED.status_completed_at;
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS postcall_pending_sync ON call_attempts;
CREATE TRIGGER postcall_pending_sync
  AFTER INSERT OR UPDATE OF status_completed_at, post_call_started_at OR DELETE ON call_attempts
  FOR EACH ROW EXECUTE FUNCTION app_sync_postcall_pending();

-- The sweep's one entry point (spec §6.3's C1 pattern, extended): every kind
-- of stuck attempt it needs to find, in one call, ids only.
--   sidless       -- a dial_registry row (044) with no call_attempt_directory
--                    row for that attempt (no CallSid ever landed) and
--                    dialed_at older than p_sidless_minutes.
--   lost_callback -- a dial_registry row that DOES have a directory SID
--                    (Twilio was told to call, and a CallSid came back) but
--                    is still older than p_lost_minutes (Ruling P-8: longer
--                    than sidless, because a real ringing/in-progress call
--                    can legitimately run this long).
--   postcall_pending -- a postcall_pending row (this migration) older than
--                    p_postcall_seconds.
-- b34/O-18 (fix wave, checkpoint 2b, owner decision): ORDER BY the stale
-- timestamp ASCENDING (oldest first) before the LIMIT, rather than an
-- unordered UNION ALL clipped by Postgres in whatever order it happens to
-- produce rows -- a business whose rows sort late in the plan could starve
-- under load. Each branch projects the SAME timestamp that decided its own
-- WHERE clause (dial_registry.dialed_at for sidless/lost_callback,
-- postcall_pending.status_completed_at for postcall_pending), so "oldest"
-- means the same thing the staleness check itself means. M6 caveat (the
-- review that asked for this): with oldest-first, >= p_limit PERSISTENTLY
-- FAILING postcall_pending rows (each released and re-listed every tick)
-- can starve newer rows -- irrelevant at Part 1 volume, and the ONLY schema
-- edit this fix wave is allowed to make.
CREATE OR REPLACE FUNCTION app_outbound_stale_attempts(p_limit int, p_sidless_minutes int, p_lost_minutes int, p_postcall_seconds int)
RETURNS TABLE (business_id uuid, attempt_id uuid, kind text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH lim AS (SELECT LEAST(GREATEST(p_limit, 1), 500) AS n)
  SELECT stale.business_id, stale.attempt_id, stale.kind FROM (
    SELECT r.business_id, r.attempt_id, 'sidless'::text AS kind, r.dialed_at AS stale_since
      FROM dial_registry r
      LEFT JOIN call_attempt_directory d ON d.attempt_id = r.attempt_id
     WHERE d.attempt_id IS NULL
       AND r.dialed_at < now() - make_interval(mins => GREATEST(p_sidless_minutes, 0))
    UNION ALL
    SELECT r.business_id, r.attempt_id, 'lost_callback'::text AS kind, r.dialed_at AS stale_since
      FROM dial_registry r
      JOIN call_attempt_directory d ON d.attempt_id = r.attempt_id
     WHERE r.dialed_at < now() - make_interval(mins => GREATEST(p_lost_minutes, 0))
    UNION ALL
    SELECT p.business_id, p.attempt_id, 'postcall_pending'::text AS kind, p.status_completed_at AS stale_since
      FROM postcall_pending p
     WHERE p.status_completed_at < now() - make_interval(secs => GREATEST(p_postcall_seconds, 0))
  ) stale
  ORDER BY stale.stale_since ASC
  LIMIT (SELECT n FROM lim);
$$;

REVOKE ALL ON FUNCTION app_outbound_stale_attempts(int, int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_outbound_stale_attempts(int, int, int, int) TO vetra_app;
