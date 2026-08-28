-- ============================================================
-- Migration 038: shared call state, so `/twilio/status` works on a second instance
-- ============================================================
-- THE BUG THIS CLOSES IS LIVE TODAY AND SILENT.
--
-- `lib/callStateStore.js` has one implementation, `createMemoryStore()`, and it
-- is a Map in one process. That is correct for exactly as long as there is one
-- process. `/twilio/status` is an ordinary HTTP POST, so the moment a second
-- Cloud Run instance exists the load balancer sends the status callback to
-- whichever instance is free — which is usually NOT the one holding the
-- WebSocket. That instance reads an empty state and the handler silently
-- produces:
--
--   * no call summary        (`dbCallId` is null, so the summary path is skipped)
--   * no missed-call notice  (`businessId` is null, so nothing is notified)
--   * every short call tagged spam
--                            (`sawCallerFinal` reads false on a caller who spoke)
--
-- None of those log an error. It is not a capacity limit; it is wrong behaviour
-- that a single instance is currently hiding.
--
-- ------------------------------------------------------------
-- 1. Why FOUR columns, and why that is the whole cost argument
-- ------------------------------------------------------------
-- `SHARED_FIELDS` is `dbCallId`, `businessId`, `sawCallerFinal` — three scalars,
-- and the reason there are three rather than thirty is that every one of them is
-- written at a CALL BOUNDARY and never inside the turn loop. `sawCallerFinal`
-- looks like an exception and is not: it is a latch, written once on the first
-- caller utterance.
--
-- That property is what makes Postgres sufficient and Memorystore unnecessary
-- ($70-100/month avoided). A per-turn write would put a network round trip
-- inside a 3,062 ms voice-to-voice p50 and would be the only thing in this
-- migration that made the product worse.
--
-- `app_call_state_merge` therefore REFUSES a patch containing any other key.
-- The constraint that makes this design free is enforced at the database rather
-- than described in a comment, because a fourth field would be added by someone
-- who never read this file.
--
-- ------------------------------------------------------------
-- 2. `text`, not `uuid`, and no foreign key
-- ------------------------------------------------------------
-- Deliberate, and the reasons are not the same as each other.
--
--   * `text` because this table must accept EXACTLY what `createMemoryStore()`
--     accepts. If the Postgres store rejects a value the memory store takes,
--     the two are not one interface and `CALL_STATE_STORE` is not a switch, it
--     is a behaviour change. A cast failure would surface at a call boundary,
--     in the fire-and-forget write, where nothing is watching.
--
--   * No FK to `calls(id)` or `businesses(id)` because this is a coordination
--     cache with a TTL, not a record. A row here outliving its business for up
--     to an hour is harmless; a foreign key that can fail a boundary write is
--     not. The record of the call is `calls`, and it is unaffected.
--
-- ------------------------------------------------------------
-- 3. No row-level security, and no grant to the application role
-- ------------------------------------------------------------
-- This is the same category as `business_directory` (migration 033): a table
-- read BEFORE the tenant is known, because it is HOW the tenant becomes known.
-- A policy of the form `business_id = app_current_business_id()` would return
-- zero rows to the status handler — which has no tenant yet, that being the
-- entire point — and would defeat the fix completely while looking careful.
--
-- So access goes through SECURITY DEFINER functions, and the table itself is
-- revoked. The property that buys: `vetra_app` cannot ENUMERATE. A caller must
-- already hold a Twilio call SID to learn anything, and holding one means it
-- already handled that call.
--
-- The REVOKE below is explicit rather than assumed, because migration 029 ran
-- `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES
-- TO vetra_app`, so every table created afterwards is granted to the
-- application role AUTOMATICALLY. A table that means to be unreadable has to
-- say so. tests/db/callStatePgStore.test.js asserts the revoke actually holds,
-- rather than trusting this comment.
--
-- ------------------------------------------------------------
-- 4. TTL
-- ------------------------------------------------------------
-- Two halves, matching `createMemoryStore()`:
--   * a read filter, so an expired row is invisible the moment it expires; and
--   * `app_call_state_prune()`, so expired rows are actually removed rather
--     than merely ignored.
-- The read filter is the one that matters for correctness. The prune is what
-- stops an abandoned-call row surviving for the life of the instance.
-- ============================================================

CREATE TABLE IF NOT EXISTS call_state (
  call_sid         text PRIMARY KEY,
  db_call_id       text,
  business_id      text,
  saw_caller_final boolean,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- The prune scans by age. Without this it is a sequential scan every five
-- minutes on every instance.
CREATE INDEX IF NOT EXISTS call_state_updated_at_idx ON call_state (updated_at);

COMMENT ON TABLE call_state IS
  'Cross-instance call-state slice: the three scalars /twilio/status reads. Deliberately has NO row-level security and is deliberately NOT granted to vetra_app — only the SECURITY DEFINER functions below reach it, because the status handler must read this BEFORE it knows the tenant. Written at call boundaries only, never per turn: that is what makes Postgres sufficient here instead of Memorystore. Must never carry anything beyond SHARED_FIELDS (lib/callStateStore.js), which app_call_state_merge enforces.';

REVOKE ALL ON call_state FROM PUBLIC;
REVOKE ALL ON call_state FROM vetra_app;

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
  WHERE k NOT IN ('dbCallId', 'businessId', 'sawCallerFinal');

  IF unknown_keys IS NOT NULL THEN
    RAISE EXCEPTION
      'app_call_state_merge: refusing unknown shared field(s): %. The shared slice is dbCallId, businessId, sawCallerFinal and is written at call boundaries only — see database/038_call_state.sql', unknown_keys;
  END IF;

  INSERT INTO call_state AS cs (call_sid, db_call_id, business_id, saw_caller_final, updated_at)
  VALUES (
    p_call_sid,
    p_patch ->> 'dbCallId',
    p_patch ->> 'businessId',
    (p_patch ->> 'sawCallerFinal')::boolean,
    now()
  )
  ON CONFLICT (call_sid) DO UPDATE SET
    db_call_id       = CASE WHEN p_patch ? 'dbCallId'       THEN EXCLUDED.db_call_id       ELSE cs.db_call_id       END,
    business_id      = CASE WHEN p_patch ? 'businessId'     THEN EXCLUDED.business_id      ELSE cs.business_id      END,
    saw_caller_final = CASE WHEN p_patch ? 'sawCallerFinal' THEN EXCLUDED.saw_caller_final ELSE cs.saw_caller_final END,
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
           'dbCallId', cs.db_call_id,
           'businessId', cs.business_id,
           'sawCallerFinal', cs.saw_caller_final
         ))
    INTO result
    FROM call_state cs
   WHERE cs.call_sid = p_call_sid
     AND cs.updated_at > now() - make_interval(secs => p_ttl_seconds);

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION app_call_state_delete(p_call_sid text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM call_state WHERE call_sid = p_call_sid;
END;
$$;

-- Returns the row count so a caller can log a number instead of asserting a
-- sweep happened. A cleanup that reports nothing is a cleanup nobody notices
-- has stopped running.
CREATE OR REPLACE FUNCTION app_call_state_prune(p_ttl_seconds integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  removed integer;
BEGIN
  DELETE FROM call_state
   WHERE updated_at <= now() - make_interval(secs => p_ttl_seconds);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

-- EXECUTE, and nothing else. The application can operate on a call SID it
-- already holds and cannot list the table.
GRANT EXECUTE ON FUNCTION app_call_state_merge(text, jsonb)   TO vetra_app;
GRANT EXECUTE ON FUNCTION app_call_state_get(text, integer)   TO vetra_app;
GRANT EXECUTE ON FUNCTION app_call_state_delete(text)         TO vetra_app;
GRANT EXECUTE ON FUNCTION app_call_state_prune(integer)       TO vetra_app;
