-- ============================================================
-- Migration 054: batch 3 launch guards, S4 -- loop guard, block list,
-- repeat-caller counts.
--
-- pending_dials: every transfer records a "pending dial" (the caller and the
-- number we dialled). A call that reaches the same business from either of
-- those numbers while the dial is still ringing is our own transfer bouncing
-- back, and is rejected. Rows expire at dial timeout + 15 s and are deleted
-- after a day, so a crash before the action fires can never block a real
-- caller for long.
--
-- blocked_callers: numbers WE refuse, set by scripts/block-caller.js through
-- the migrate job. business_id NULL = blocked for every business.
--
-- Both are PLATFORM tables (no RLS, no grant to vetra_app), reachable only
-- through SECURITY DEFINER functions -- the business_directory / outbox_schedule
-- shape.
--
-- THE BYPASSRLS TRAP: production connects as vetra_app (NOBYPASSRLS) and these
-- functions are owned by Cloud SQL's postgres, which ALSO cannot bypass RLS. A
-- definer function reading a FORCE-RLS table (calls) with no app.business_id
-- set sees ZERO rows. So every function that reads calls sets the tenant scope
-- itself and puts the previous scope back (the app_create_business_for_user
-- pattern). Locally vetra is a superuser and hides this; tests/db/loopGuard.test.js
-- re-owns the functions to a NOBYPASSRLS role.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE. "Today" is the UTC day.
-- ============================================================

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS pending_dials (
  id             bigserial PRIMARY KEY,
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_sid       text NOT NULL,
  caller_number  text,
  dialled_number text NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  ended_at       timestamptz
);
CREATE INDEX IF NOT EXISTS pending_dials_open_idx ON pending_dials (business_id, expires_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS pending_dials_call_sid_idx ON pending_dials (call_sid);

REVOKE ALL ON pending_dials FROM PUBLIC;
REVOKE ALL ON pending_dials FROM vetra_app;
REVOKE ALL ON SEQUENCE pending_dials_id_seq FROM vetra_app;

COMMENT ON TABLE pending_dials IS
  'Loop guard: a transfer dial that may still be ringing. Platform table: deliberately NO row-level security and NO grant to vetra_app; reachable only through app_record_pending_dial / app_end_pending_dial / app_dial_bounced. Rows expire at dial timeout + 15 s and are deleted after one day.';

CREATE TABLE IF NOT EXISTS blocked_callers (
  phone       text PRIMARY KEY,
  business_id uuid NULL REFERENCES businesses(id) ON DELETE CASCADE,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NULL
);

REVOKE ALL ON blocked_callers FROM PUBLIC;
REVOKE ALL ON blocked_callers FROM vetra_app;

COMMENT ON TABLE blocked_callers IS
  'Numbers we refuse. Platform table: deliberately NO row-level security and NO grant to vetra_app; set only by scripts/block-caller.js through the migrate job, read only through app_caller_blocked. business_id NULL blocks the number for every business.';

CREATE OR REPLACE FUNCTION app_record_pending_dial(
  p_business    uuid,
  p_call_sid    text,
  p_caller      text,
  p_dialled     text,
  p_timeout_sec integer
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_business IS NULL OR p_call_sid IS NULL OR btrim(p_call_sid) = ''
     OR p_dialled IS NULL OR btrim(p_dialled) = '' THEN
    RAISE EXCEPTION 'app_record_pending_dial: business, call sid and dialled number are required';
  END IF;
  DELETE FROM pending_dials WHERE started_at < now() - interval '1 day';
  INSERT INTO pending_dials (business_id, call_sid, caller_number, dialled_number, expires_at)
  VALUES (
    p_business,
    p_call_sid,
    NULLIF(btrim(p_caller), ''),
    btrim(p_dialled),
    now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_timeout_sec, 20), 5), 120) + 15)
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION app_record_pending_dial(uuid, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_pending_dial(uuid, text, text, text, integer) TO vetra_app;
COMMENT ON FUNCTION app_record_pending_dial(uuid, text, text, text, integer) IS
  'Loop guard: records a transfer dial that may still be ringing; expires at timeout + 15 s.';

CREATE OR REPLACE FUNCTION app_end_pending_dial(p_call_sid text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_call_sid IS NULL OR btrim(p_call_sid) = '' THEN
    RETURN 0;
  END IF;
  UPDATE pending_dials SET ended_at = now() WHERE call_sid = p_call_sid AND ended_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION app_end_pending_dial(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_end_pending_dial(text) TO vetra_app;
COMMENT ON FUNCTION app_end_pending_dial(text) IS
  'Loop guard: marks the open pending dials of a parent call as ended; returns how many.';

CREATE OR REPLACE FUNCTION app_dial_bounced(p_business uuid, p_from text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_business IS NULL OR p_from IS NULL OR btrim(p_from) = '' THEN false
    ELSE EXISTS (
      SELECT 1
        FROM pending_dials pd
       WHERE pd.business_id = p_business
         AND pd.ended_at IS NULL
         AND pd.expires_at > now()
         AND (pd.caller_number = btrim(p_from) OR pd.dialled_number = btrim(p_from))
    )
  END;
$$;

REVOKE ALL ON FUNCTION app_dial_bounced(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_dial_bounced(uuid, text) TO vetra_app;
COMMENT ON FUNCTION app_dial_bounced(uuid, text) IS
  'Loop guard: true when this business has an unexpired, unended pending dial involving this number.';

CREATE OR REPLACE FUNCTION app_caller_blocked(p_from text, p_business uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_from IS NULL OR btrim(p_from) = '' THEN false
    ELSE EXISTS (
      SELECT 1
        FROM blocked_callers bc
       WHERE bc.phone = btrim(p_from)
         AND (bc.business_id IS NULL OR bc.business_id = p_business)
         AND (bc.expires_at IS NULL OR bc.expires_at > now())
    )
  END;
$$;

REVOKE ALL ON FUNCTION app_caller_blocked(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_caller_blocked(text, uuid) TO vetra_app;
COMMENT ON FUNCTION app_caller_blocked(text, uuid) IS
  'Block list: true when this number is blocked for every business or for this one, and the block has not expired.';

CREATE OR REPLACE FUNCTION app_calls_from_today(p_from text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_day_start timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_previous  text := current_setting('app.business_id', true);
  v_id        uuid;
  v_total     integer := 0;
  v_n         integer;
BEGIN
  IF p_from IS NULL OR btrim(p_from) = '' THEN
    RETURN 0;
  END IF;
  FOR v_id IN SELECT DISTINCT business_id FROM business_directory LOOP
    PERFORM set_config('app.business_id', v_id::text, true);
    SELECT count(*)::integer INTO v_n
      FROM calls
     WHERE business_id = v_id
       AND caller_number = btrim(p_from)
       AND direction = 'inbound'
       AND started_at >= v_day_start;
    v_total := v_total + v_n;
  END LOOP;
  PERFORM set_config('app.business_id', COALESCE(v_previous, ''), true);
  RETURN v_total;
END $$;

REVOKE ALL ON FUNCTION app_calls_from_today(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_calls_from_today(text) TO vetra_app;
COMMENT ON FUNCTION app_calls_from_today(text) IS
  'Repeat-caller alert: prior inbound calls today (UTC) from this number across every tenant; walks each tenant and restores the previous scope.';

CREATE OR REPLACE FUNCTION app_ai_seconds_today(
  p_business         uuid,
  p_caller           text,
  p_exclude_call_sid text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_day_start timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_previous  text := current_setting('app.business_id', true);
  v_secs      integer;
BEGIN
  IF p_business IS NULL OR p_caller IS NULL OR btrim(p_caller) = '' THEN
    RETURN 0;
  END IF;
  IF v_previous IS NOT NULL AND v_previous <> '' AND v_previous <> p_business::text THEN
    RAISE EXCEPTION 'app_ai_seconds_today: connection is already scoped to another tenant';
  END IF;
  PERFORM set_config('app.business_id', p_business::text, true);
  SELECT COALESCE(SUM(GREATEST(EXTRACT(EPOCH FROM COALESCE(transferred_at, ended_at) - started_at), 0)), 0)::integer
    INTO v_secs
    FROM calls
   WHERE business_id = p_business
     AND caller_number = btrim(p_caller)
     AND direction = 'inbound'
     AND started_at >= v_day_start
     AND (p_exclude_call_sid IS NULL OR twilio_call_sid <> p_exclude_call_sid);
  PERFORM set_config('app.business_id', COALESCE(v_previous, ''), true);
  RETURN v_secs;
END $$;

REVOKE ALL ON FUNCTION app_ai_seconds_today(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_ai_seconds_today(uuid, text, text) TO vetra_app;
COMMENT ON FUNCTION app_ai_seconds_today(uuid, text, text) IS
  'Repeat-caller alert: AI seconds this caller used at this business today (UTC); time after a transfer is not counted.';
