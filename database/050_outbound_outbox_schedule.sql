-- ============================================================
-- Migration 050: outbound -- S3-8 fix round 1, I3(a). The sweep's outbox
-- backstop, done the 044/045 way (a no-RLS routing table + one SECURITY
-- DEFINER function), so a lost delivery task is rescued for EVERY tenant,
-- not only tenants the tick already touched for due outreach or a stale
-- attempt (the per-tenant backstop S3-8 shipped, blocked from doing this
-- because it would have needed a migration mid-task -- the brief's own
-- STOP-and-propose rule. This is that proposal, approved by the controller.)
-- ============================================================
-- Same reasoning as outreach_schedule (044): FORCE RLS on `outbox` binds a
-- SECURITY DEFINER function's OWNER, so a definer SELECT on `outbox` itself
-- returns 0 rows in production even though it passes locally as `vetra`.
-- Hence a routing table with NO row-level security, revoked from the
-- application, kept true by a trigger, read only by the function below. It
-- holds ids, a status word and a timestamp -- never a payload, a phone
-- number or a name.

CREATE TABLE IF NOT EXISTS outbox_schedule (
  outbox_id       uuid PRIMARY KEY,
  business_id     uuid NOT NULL,
  status          text NOT NULL,
  next_attempt_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_schedule_due_idx ON outbox_schedule (status, next_attempt_at);

REVOKE ALL ON outbox_schedule FROM PUBLIC;
REVOKE ALL ON outbox_schedule FROM vetra_app;

COMMENT ON TABLE outbox_schedule IS
  'Routing only: which outbox row is due, for the sweep''s cross-tenant webhook backstop (S3-8 fix round 1, I3). Deliberately has NO row-level security and NO grant to vetra_app: only app_outbound_webhook_due reads it, and a trigger on outbox keeps it true. Holds ids, a status word and a timestamp. Must never carry a payload, a phone number or a name.';

-- Keeping it true. SECURITY DEFINER because the writer (vetra_app, under RLS
-- on outbox) has no rights on the routing table. A row exists ONLY while the
-- outbox row is 'pending' -- delivered/dead rows are removed outright, so
-- app_outbound_webhook_due below never has to filter status itself (it does
-- anyway, defensively, in case a future writer ever inserts a non-pending
-- row by mistake).
CREATE OR REPLACE FUNCTION app_sync_outbox_schedule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.status <> 'pending' THEN
    DELETE FROM outbox_schedule WHERE outbox_id = COALESCE(OLD.id, NEW.id);
  ELSE
    INSERT INTO outbox_schedule (outbox_id, business_id, status, next_attempt_at)
    VALUES (NEW.id, NEW.business_id, NEW.status, NEW.next_attempt_at)
    ON CONFLICT (outbox_id) DO UPDATE SET status = EXCLUDED.status, next_attempt_at = EXCLUDED.next_attempt_at;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS outbox_schedule_sync ON outbox;
CREATE TRIGGER outbox_schedule_sync
  AFTER INSERT OR UPDATE OF status, next_attempt_at OR DELETE ON outbox
  FOR EACH ROW EXECUTE FUNCTION app_sync_outbox_schedule();

-- Every tenant's due outbox rows, cross-tenant, ids and a timestamp only --
-- the same shape app_outbound_due already has for outreach. `p_grace_seconds`
-- mirrors app_outbound_due's own signature even though the sweep calls it
-- with 0 today; kept for parity and so a future caller can add slack without
-- a new function.
CREATE OR REPLACE FUNCTION app_outbound_webhook_due(p_limit int, p_grace_seconds int)
RETURNS TABLE (business_id uuid, outbox_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.business_id, s.outbox_id
    FROM outbox_schedule s
   WHERE s.status = 'pending'
     AND s.next_attempt_at IS NOT NULL
     AND s.next_attempt_at <= now() - make_interval(secs => GREATEST(p_grace_seconds, 0))
   ORDER BY s.next_attempt_at
   LIMIT LEAST(GREATEST(p_limit, 1), 500);
$$;

REVOKE ALL ON FUNCTION app_outbound_webhook_due(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_outbound_webhook_due(int, int) TO vetra_app;
