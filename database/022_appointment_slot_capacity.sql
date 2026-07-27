-- ============================================================
-- Migration 022: per-business slot capacity + duration-aware availability
-- ============================================================
-- Replaces migration 009's exact-timestamp unique index.
--
-- Migration 009 enforced "at most one scheduled appointment per exact
-- timestamp". That is right for capacity 1 and zero duration, but:
--   * it WRONGLY blocks a legitimate 2nd booking when a business allows more
--     than one appointment per slot (capacity > 1), and
--   * it MISSES duration overlap — 10:00 and 10:15 never collide under it.
--
-- No static UNIQUE/EXCLUSION constraint can express per-business capacity AND
-- appointment length, so enforcement moves into an advisory-locked function.
-- Every internal booking goes through it (services/supabase.js
-- createAppointmentIfAvailable -> adapters/scheduling/internal.js book), so the
-- capacity check and the insert are one atomic, race-safe step.

DROP INDEX IF EXISTS uniq_appointments_business_scheduled_at_active;

-- Book only if the slot still has capacity. Returns the new appointment id, or
-- NULL when the slot is full (the caller turns NULL into a "pick another time").
--
-- p_length_min <= 0 means "exact-timestamp guard": count only an appointment at
-- the identical instant, reproducing migration 009 for a business that has not
-- turned availability on. Otherwise two equal-length slots overlap iff their
-- starts are less than p_length_min apart.
CREATE OR REPLACE FUNCTION create_appointment_if_available(
  p_business_id  uuid,
  p_scheduled_at timestamptz,
  p_length_min   int,
  p_capacity     int,
  p_call_id      uuid,
  p_client_name  text,
  p_client_phone text,
  p_notes        text
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_overlap  int;
  v_id       uuid;
  v_capacity int := GREATEST(COALESCE(p_capacity, 1), 1);
BEGIN
  -- Serialize concurrent bookings for the same business + slot, so two callers
  -- cannot both pass the capacity check and both insert.
  PERFORM pg_advisory_xact_lock(hashtext(p_business_id::text || p_scheduled_at::text)::bigint);

  IF COALESCE(p_length_min, 0) <= 0 THEN
    SELECT count(*) INTO v_overlap
    FROM appointments
    WHERE business_id = p_business_id
      AND status = 'scheduled'
      AND scheduled_at = p_scheduled_at;
  ELSE
    SELECT count(*) INTO v_overlap
    FROM appointments
    WHERE business_id = p_business_id
      AND status = 'scheduled'
      AND scheduled_at > p_scheduled_at - make_interval(mins => p_length_min)
      AND scheduled_at < p_scheduled_at + make_interval(mins => p_length_min);
  END IF;

  IF v_overlap >= v_capacity THEN
    RETURN NULL; -- full
  END IF;

  INSERT INTO appointments (business_id, call_id, client_name, client_phone, scheduled_at, notes)
  VALUES (p_business_id, p_call_id, p_client_name, p_client_phone, p_scheduled_at, p_notes)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
