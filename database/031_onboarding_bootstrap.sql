-- ============================================================
-- Migration 031: the onboarding bootstrap
-- ============================================================
-- Migration 029 solved the READ bootstrap — how a dialled number or an
-- authenticated identity becomes a tenant before any tenant is set. It did not
-- solve the WRITE one, and nothing had noticed, because the only code that
-- performs it lives in the dashboard backend, which has its own pool and has
-- never been run against a database where row-level security applies.
--
-- POST /api/onboarding/create-business does three writes, in this order:
--
--   1. INSERT INTO users (id, email)            -- business_id is NULL
--   2. INSERT INTO businesses (name, timezone)  -- a brand-new id
--   3. UPDATE users SET business_id = ...
--
-- Under FORCE row security every one of them fails:
--
--   (1) users' WITH CHECK is `business_id = app_current_business_id()`. NULL
--       never equals anything, so the row is refused.
--   (2) businesses' WITH CHECK is `id = app_current_business_id()`. The new id
--       is by definition not the current tenant, which is not set anyway.
--   (3) the row from (1) does not exist, and would not be visible if it did.
--
-- There is no scope that makes this work, because the whole operation is what
-- CREATES the scope. That is the definition of a bootstrap.
--
-- The tempting fix is a policy allowing writes when app.business_id is unset.
-- Migration 029 argues against the read version of that at length and the same
-- argument applies harder here: it would make "forgot to scope" mean "may write
-- anything, to any tenant", which is worse than the read case, not better.
--
-- So: one SECURITY DEFINER function, narrow and named, doing exactly the three
-- writes above and nothing else. Pinned search_path, because an unpinned one on
-- a SECURITY DEFINER function lets the caller decide which `users` table the
-- body means.
-- ============================================================

CREATE OR REPLACE FUNCTION app_create_business_for_user(
  p_user_id  uuid,
  p_email    text,
  p_name     text,
  p_timezone text
)
RETURNS businesses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing uuid;
  v_business businesses;
BEGIN
  IF p_user_id IS NULL OR p_email IS NULL OR p_name IS NULL OR p_timezone IS NULL THEN
    RAISE EXCEPTION 'app_create_business_for_user: all arguments are required';
  END IF;

  -- REFUSE if this account already has a business.
  --
  -- The function is SECURITY DEFINER, so it is the one place in the system that
  -- can create a tenant, and it must not be usable to create a second one. The
  -- old route had no such check: calling it twice made an orphaned business
  -- every time and silently repointed the user at the newest, stranding the
  -- previous tenant's data behind an account that could no longer see it.
  SELECT business_id INTO v_existing FROM users WHERE id = p_user_id;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'app_create_business_for_user: user already belongs to a business'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO businesses (name, timezone) VALUES (p_name, p_timezone)
  RETURNING * INTO v_business;

  -- One statement rather than the route's insert-then-update, so a users row
  -- with a NULL business_id never exists — not even briefly, and not at all if
  -- anything downstream fails.
  INSERT INTO users (id, email, business_id)
  VALUES (p_user_id, p_email, v_business.id)
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, business_id = EXCLUDED.business_id;

  RETURN v_business;
END;
$$;

COMMENT ON FUNCTION app_create_business_for_user(uuid, text, text, text) IS
  'Bootstrap: creates a tenant and attaches the signing-up account to it. SECURITY DEFINER because the operation is what establishes the scope it would otherwise need. Refuses if the account already has a business.';

REVOKE ALL ON FUNCTION app_create_business_for_user(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_create_business_for_user(uuid, text, text, text) TO vetra_app;

-- ------------------------------------------------------------
-- The other half: reading a business the caller has just been told they own
-- ------------------------------------------------------------
-- GET /api/me answers "which business is this, and does it need onboarding" —
-- and the businesses read inside it CAN be scoped, because by then
-- app_lookup_user_by_email has already produced the tenant id. No new function
-- is needed for it; the route simply has to open a scope. Recorded here so the
-- next person does not add a third definer function for a read that does not
-- need one.
