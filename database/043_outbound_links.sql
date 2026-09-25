-- ============================================================
-- Migration 043: outbound calling -- links on existing tables (spec §6.2)
-- ============================================================
-- calls: `caller_number` KEEPS meaning "the other party" and `twilio_number`
-- "our number" on outbound calls too, so the data-subject export/erase paths
-- and analytics keyed on caller_number work unchanged (§6.2).

-- Fail fast instead of queueing inbound queries behind an ACCESS EXCLUSIVE wait; the migrate job is retried.
SET LOCAL lock_timeout = '5s';

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound','outbound')),
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS campaign_version int,
  ADD COLUMN IF NOT EXISTS outreach_id uuid REFERENCES outreach(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attempt_id uuid REFERENCES call_attempts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS answered_by text,
  ADD COLUMN IF NOT EXISTS outcome_code text,
  ADD COLUMN IF NOT EXISTS answers jsonb;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS outbound_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS outbound_max_concurrent int NOT NULL DEFAULT 2;

-- call_state: two more shared scalars, written once at session start.
ALTER TABLE call_state
  ADD COLUMN IF NOT EXISTS direction text,
  ADD COLUMN IF NOT EXISTS attempt_id text;

-- ------------------------------------------------------------------
-- merge — `{...existing, ...patch}`, in SQL
-- ------------------------------------------------------------------
-- The patch is jsonb rather than three parameters so that ABSENT and NULL stay
-- distinguishable. They are different instructions: an absent key means "leave
-- whatever is there", a null means "set it to null". `sharedSlice()` drops
-- `undefined` for exactly this reason — the two writers are concurrent (the
-- tenant is resolved at pickup, the latch fires whenever the caller first
-- speaks) and neither may clobber the other with nothing.
--
-- Three positional parameters could not express that without a fourth
-- parameter listing which of them were supplied.
CREATE OR REPLACE FUNCTION app_call_state_merge(p_call_sid text, p_patch jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  unknown_keys text;
BEGIN
  IF p_call_sid IS NULL OR btrim(p_call_sid) = '' THEN
    RAISE EXCEPTION 'app_call_state_merge: call_sid is required';
  END IF;

  -- The design constraint, enforced. See section 1: this table is only free
  -- because nothing in it is written per turn, and the way that stops being
  -- true is a fourth field arriving quietly.
  SELECT string_agg(k, ', ') INTO unknown_keys
  FROM jsonb_object_keys(p_patch) AS k
  WHERE k NOT IN ('dbCallId', 'businessId', 'sawCallerFinal', 'direction', 'attemptId');

  IF unknown_keys IS NOT NULL THEN
    RAISE EXCEPTION
      'app_call_state_merge: refusing unknown shared field(s): %. The shared slice is dbCallId, businessId, sawCallerFinal, direction, attemptId and is written at call boundaries only — see database/038_call_state.sql', unknown_keys;
  END IF;

  INSERT INTO call_state AS cs (call_sid, db_call_id, business_id, saw_caller_final, direction, attempt_id, updated_at)
  VALUES (p_call_sid, p_patch ->> 'dbCallId', p_patch ->> 'businessId', (p_patch ->> 'sawCallerFinal')::boolean,
          p_patch ->> 'direction', p_patch ->> 'attemptId', now())
  ON CONFLICT (call_sid) DO UPDATE SET
    db_call_id       = CASE WHEN p_patch ? 'dbCallId'       THEN EXCLUDED.db_call_id       ELSE cs.db_call_id       END,
    business_id      = CASE WHEN p_patch ? 'businessId'     THEN EXCLUDED.business_id      ELSE cs.business_id      END,
    saw_caller_final = CASE WHEN p_patch ? 'sawCallerFinal' THEN EXCLUDED.saw_caller_final ELSE cs.saw_caller_final END,
    direction        = CASE WHEN p_patch ? 'direction'      THEN EXCLUDED.direction        ELSE cs.direction        END,
    attempt_id       = CASE WHEN p_patch ? 'attemptId'      THEN EXCLUDED.attempt_id       ELSE cs.attempt_id       END,
    updated_at       = now();
END;
$$;

COMMENT ON FUNCTION app_call_state_merge(text, jsonb) IS
  'Merge the shared call-state slice. Absent key = leave alone; explicit null = set null. Raises on any key outside SHARED_FIELDS.';

-- ------------------------------------------------------------------
-- get — the cold instance's read
-- ------------------------------------------------------------------
-- `jsonb_strip_nulls` so the shape matches what `createMemoryStore()` returns
-- for the same sequence of merges: a field that was never written is ABSENT,
-- not null. `false` is not stripped, which is the case that matters —
-- `sawCallerFinal = false` on a genuinely silent call is a real answer and must
-- not read as "unknown".
--
-- Returns NULL (not '{}') for a call this store never saw, so the JS layer can
-- keep distinguishing "no record" from "a record with nothing in it".
CREATE OR REPLACE FUNCTION app_call_state_get(p_call_sid text, p_ttl_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_strip_nulls(jsonb_build_object(
           'dbCallId', cs.db_call_id, 'businessId', cs.business_id, 'sawCallerFinal', cs.saw_caller_final,
           'direction', cs.direction, 'attemptId', cs.attempt_id))
    INTO result
    FROM call_state cs
   WHERE cs.call_sid = p_call_sid
     AND cs.updated_at > now() - make_interval(secs => p_ttl_seconds);

  RETURN result;
END;
$$;
