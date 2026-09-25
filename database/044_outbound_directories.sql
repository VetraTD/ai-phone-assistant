-- ============================================================
-- Migration 044: outbound -- the cross-tenant reads, done the 033 way
-- ============================================================
-- Three questions are asked before a tenant is known, or across all tenants:
--   * which tenant/attempt does this Twilio CallSid belong to (door, callbacks, session)
--   * which outreach is due (the sweep)
--   * how many outbound calls are live (the capacity check)
-- FORCE RLS binds a SECURITY DEFINER function's OWNER (033:8-31), and Cloud
-- SQL's postgres cannot bypass it -- so a definer SELECT on call_attempts or
-- outreach returns 0 rows in production while passing locally as `vetra`.
-- Hence three routing tables with NO row-level security, revoked from the
-- application, kept true by triggers, and read only by the functions below.
-- They hold ids, timestamps and a state word. Never a phone number or a name.

CREATE TABLE IF NOT EXISTS call_attempt_directory (
  twilio_call_sid text PRIMARY KEY,
  attempt_id      uuid NOT NULL,
  business_id     uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS dial_registry (
  attempt_id  uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  dialed_at   timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS outreach_schedule (
  outreach_id     uuid PRIMARY KEY,
  business_id     uuid NOT NULL,
  state           text NOT NULL,
  next_attempt_at timestamptz
);
CREATE INDEX IF NOT EXISTS outreach_schedule_due_idx ON outreach_schedule (state, next_attempt_at);

REVOKE ALL ON call_attempt_directory, dial_registry, outreach_schedule FROM PUBLIC;
REVOKE ALL ON call_attempt_directory, dial_registry, outreach_schedule FROM vetra_app;

COMMENT ON TABLE call_attempt_directory IS
  'Routing only: Twilio CallSid -> outbound attempt and tenant, for the answer door, status callbacks and the session. Deliberately has NO row-level security and NO grant to vetra_app: only the migration 044 SECURITY DEFINER functions read it, and a trigger on call_attempts keeps it true. Holds ids only. Must never carry a phone number or a name.';
COMMENT ON TABLE dial_registry IS
  'Routing only: live outbound dials of the last hour, for the capacity check. Deliberately has NO row-level security and NO grant to vetra_app: only app_active_dial_counts(p_business) reads it, and it returns two counts, never another tenant''s id; a trigger on call_attempts keeps it true. Holds ids and a timestamp. Must never carry a phone number or a name.';
COMMENT ON TABLE outreach_schedule IS
  'Routing only: which outreach is due, for the sweep. Deliberately has NO row-level security and NO grant to vetra_app: only app_outbound_due reads it, and a trigger on outreach keeps it true. Holds ids, a timestamp and a state word. Must never carry a phone number or a name.';

-- Keeping them true. SECURITY DEFINER because the writer (vetra_app, under
-- RLS on call_attempts / outreach) has no rights on the directories.
CREATE OR REPLACE FUNCTION app_sync_outbound_directories()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    IF OLD.twilio_call_sid IS NOT NULL THEN
      DELETE FROM call_attempt_directory WHERE twilio_call_sid = OLD.twilio_call_sid;
    END IF;
    DELETE FROM dial_registry WHERE attempt_id = OLD.id;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    IF NEW.twilio_call_sid IS NOT NULL THEN
      INSERT INTO call_attempt_directory (twilio_call_sid, attempt_id, business_id)
      VALUES (NEW.twilio_call_sid, NEW.id, NEW.business_id)
      ON CONFLICT (twilio_call_sid) DO UPDATE SET attempt_id = EXCLUDED.attempt_id, business_id = EXCLUDED.business_id;
    END IF;
    IF NEW.ended_at IS NULL AND NEW.result IS NULL THEN
      INSERT INTO dial_registry (attempt_id, business_id, dialed_at)
      VALUES (NEW.id, NEW.business_id, COALESCE(NEW.dialed_at, now()))
      ON CONFLICT (attempt_id) DO UPDATE SET dialed_at = EXCLUDED.dialed_at;
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS outbound_directories_sync ON call_attempts;
CREATE TRIGGER outbound_directories_sync
  AFTER INSERT OR UPDATE OF twilio_call_sid, ended_at, result, dialed_at OR DELETE ON call_attempts
  FOR EACH ROW EXECUTE FUNCTION app_sync_outbound_directories();

CREATE OR REPLACE FUNCTION app_sync_outreach_schedule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.state = 'closed' THEN
    DELETE FROM outreach_schedule WHERE outreach_id = COALESCE(OLD.id, NEW.id);
  ELSE
    INSERT INTO outreach_schedule (outreach_id, business_id, state, next_attempt_at)
    VALUES (NEW.id, NEW.business_id, NEW.state, NEW.next_attempt_at)
    ON CONFLICT (outreach_id) DO UPDATE SET state = EXCLUDED.state, next_attempt_at = EXCLUDED.next_attempt_at;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS outreach_schedule_sync ON outreach;
CREATE TRIGGER outreach_schedule_sync
  AFTER INSERT OR UPDATE OF state, next_attempt_at OR DELETE ON outreach
  FOR EACH ROW EXECUTE FUNCTION app_sync_outreach_schedule();

CREATE OR REPLACE FUNCTION app_outbound_attempt_by_call_sid(p_sid text)
RETURNS TABLE (business_id uuid, attempt_id uuid, outreach_id uuid, campaign_id uuid, campaign_version int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_biz uuid;
  v_att uuid;
  v_current text := current_setting('app.business_id', true);
BEGIN
  IF p_sid IS NULL OR btrim(p_sid) = '' THEN RETURN; END IF;
  SELECT d.business_id, d.attempt_id INTO v_biz, v_att
    FROM call_attempt_directory d WHERE d.twilio_call_sid = btrim(p_sid);
  IF v_biz IS NULL THEN RETURN; END IF;
  -- Adopt only when no scope is declared (the 033 rule): never repoint a
  -- transaction that already knows its tenant.
  IF v_current IS NULL OR v_current = '' THEN
    PERFORM set_config('app.business_id', v_biz::text, true);
  END IF;
  RETURN QUERY
    SELECT a.business_id, a.id, a.outreach_id, o.campaign_id, o.campaign_version
      FROM call_attempts a JOIN outreach o ON o.id = a.outreach_id
     WHERE a.id = v_att;
END $$;

CREATE OR REPLACE FUNCTION app_outbound_due(p_limit int, p_grace_seconds int)
RETURNS TABLE (business_id uuid, outreach_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.business_id, s.outreach_id
    FROM outreach_schedule s
   WHERE s.state = 'waiting'
     AND s.next_attempt_at IS NOT NULL
     AND s.next_attempt_at <= now() - make_interval(secs => GREATEST(p_grace_seconds, 0))
   ORDER BY s.next_attempt_at
   LIMIT LEAST(GREATEST(p_limit, 1), 500);
$$;

-- Two counts and never a business id: the caller learns the global total and
-- its own, nothing about which other tenants are dialing. Always one row.
DROP FUNCTION IF EXISTS app_active_dial_counts();
CREATE OR REPLACE FUNCTION app_active_dial_counts(p_business uuid)
RETURNS TABLE (global_active int, business_active int)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::int,
         (count(*) FILTER (WHERE r.business_id = p_business))::int
    FROM dial_registry r
   WHERE r.dialed_at > now() - interval '1 hour';
$$;

REVOKE ALL ON FUNCTION app_outbound_attempt_by_call_sid(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_outbound_due(int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_active_dial_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_outbound_attempt_by_call_sid(text) TO vetra_app;
GRANT EXECUTE ON FUNCTION app_outbound_due(int, int) TO vetra_app;
GRANT EXECUTE ON FUNCTION app_active_dial_counts(uuid) TO vetra_app;
