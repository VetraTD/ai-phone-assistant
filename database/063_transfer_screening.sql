-- ============================================================
-- Migration 063: LVX192 fix 4 -- inbound transfer screening.
--
-- A business can ask us to screen its transfers: the dispatcher's phone
-- rings, they hear a short whisper and must press 1 to take the call. A
-- voicemail greeting, or no press, then counts as "nobody answered" and the
-- caller gets our message step instead of a silent hand-off to a mailbox.
--
-- businesses.transfer_screening: off by default (WE set it, through
--   scripts/set-business-config.js; no dashboard screen). Refused together with
--   transfer_no_answer = own_voicemail by the operator scripts, and ignored at
--   call time if the two are ever both set.
-- businesses.transfer_whisper: the spoken text; NULL = the built-in wording.
--   Capped at 200 characters so a whisper cannot run past the dial window.
-- pending_dials.screened: this dial carries a whisper.
-- pending_dials.accepted_at: when the dispatcher pressed 1.
--
-- Four NEW SECURITY DEFINER functions; the 054 functions are untouched.
-- pending_dials stays a platform table that vetra_app cannot read directly.
--
--   app_record_screened_pending_dial   a screened twin of app_record_pending_dial.
--     A twin, not a flag on the 054 function and not a second "mark it
--     screened" call: the row must be born screened, in one statement. A
--     separate mark would leave a window in which a screened dial is
--     indistinguishable from a plain one, and a failed second call would leave
--     it that way for good. A new argument would change the signature of a
--     function the running service already calls, so a rolling deploy would
--     break on the old image. The twin leaves app_record_pending_dial exactly
--     as it was.
--   app_pending_dial_business          business of the newest open screened dial
--     for a parent call sid, else NULL (the whisper route's only way to find
--     the business, because the dispatcher leg carries no tenant scope).
--   app_accept_pending_dial            stamps accepted_at on the open screened
--     rows of a call; returns how many.
--   app_pending_dial_outcome           'unscreened' | 'accepted' | 'not_accepted',
--     judged on the newest dial row of that call; no row = 'unscreened'.
--
-- None of them reads a tenant table, so none needs the app.business_id dance
-- the 054 functions that read `calls` carry.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; CREATE OR REPLACE FUNCTION.
-- ============================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS transfer_screening boolean NOT NULL DEFAULT false;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS transfer_whisper text CHECK (char_length(transfer_whisper) <= 200);
ALTER TABLE pending_dials ADD COLUMN IF NOT EXISTS screened boolean NOT NULL DEFAULT false;
ALTER TABLE pending_dials ADD COLUMN IF NOT EXISTS accepted_at timestamptz;

CREATE OR REPLACE FUNCTION app_record_screened_pending_dial(
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
    RAISE EXCEPTION 'app_record_screened_pending_dial: business, call sid and dialled number are required';
  END IF;
  DELETE FROM pending_dials WHERE started_at < now() - interval '1 day';
  INSERT INTO pending_dials (business_id, call_sid, caller_number, dialled_number, expires_at, screened)
  VALUES (
    p_business,
    p_call_sid,
    NULLIF(btrim(p_caller), ''),
    btrim(p_dialled),
    now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_timeout_sec, 20), 5), 120) + 15),
    true
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION app_record_screened_pending_dial(uuid, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_screened_pending_dial(uuid, text, text, text, integer) TO vetra_app;
COMMENT ON FUNCTION app_record_screened_pending_dial(uuid, text, text, text, integer) IS
  'Transfer screening: app_record_pending_dial for a dial that carries a whisper; the row is born screened. Expires at timeout + 15 s.';

CREATE OR REPLACE FUNCTION app_pending_dial_business(p_call_sid text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT pd.business_id
    FROM pending_dials pd
   WHERE pd.call_sid = p_call_sid
     AND pd.screened
     AND pd.ended_at IS NULL
   ORDER BY pd.id DESC
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION app_pending_dial_business(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_pending_dial_business(text) TO vetra_app;
COMMENT ON FUNCTION app_pending_dial_business(text) IS
  'Transfer screening: the business of the newest open screened dial of this parent call, else NULL.';

CREATE OR REPLACE FUNCTION app_accept_pending_dial(p_call_sid text)
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
  UPDATE pending_dials
     SET accepted_at = now()
   WHERE call_sid = p_call_sid
     AND screened
     AND ended_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

REVOKE ALL ON FUNCTION app_accept_pending_dial(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_accept_pending_dial(text) TO vetra_app;
COMMENT ON FUNCTION app_accept_pending_dial(text) IS
  'Transfer screening: stamps accepted_at on the open screened dials of a parent call (the dispatcher pressed 1); returns how many.';

CREATE OR REPLACE FUNCTION app_pending_dial_outcome(p_call_sid text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT CASE
              WHEN NOT pd.screened THEN 'unscreened'
              WHEN pd.accepted_at IS NOT NULL THEN 'accepted'
              ELSE 'not_accepted'
            END
       FROM pending_dials pd
      WHERE pd.call_sid = p_call_sid
      ORDER BY pd.id DESC
      LIMIT 1),
    'unscreened'
  );
$$;

REVOKE ALL ON FUNCTION app_pending_dial_outcome(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_pending_dial_outcome(text) TO vetra_app;
COMMENT ON FUNCTION app_pending_dial_outcome(text) IS
  'Transfer screening: unscreened, accepted or not_accepted, judged on the newest dial row of this parent call; no row is unscreened.';
