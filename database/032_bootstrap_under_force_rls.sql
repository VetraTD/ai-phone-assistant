-- ============================================================
-- Migration 032: make the onboarding bootstrap actually work
-- ============================================================
-- Migration 031 created `app_create_business_for_user` to solve the WRITE
-- bootstrap — how a brand-new tenant gets created when every policy requires a
-- tenant to already exist. Its reasoning is correct and its header is worth
-- re-reading. Its implementation does not work.
--
-- SECURITY DEFINER makes the function run as its OWNER. That is enough to get
-- past ordinary row-level security, because a table's owner is exempt by
-- default. It is NOT enough here, because migration 029 does this:
--
--   ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE businesses FORCE  ROW LEVEL SECURITY;   -- <- the relevant line
--
-- FORCE applies the policies to the table owner as well. The only role that
-- escapes is one with BYPASSRLS, and Cloud SQL does not grant superuser — its
-- `postgres` is a `cloudsqlsuperuser` with rolbypassrls = false. So the
-- function's own INSERT is refused by the very policy it was written to work
-- around:
--
--   ERROR:  new row violates row-level security policy for table "businesses"
--   CONTEXT: SQL statement "INSERT INTO businesses (name, timezone) ..."
--            PL/pgSQL function app_create_business_for_user(...) line 4
--
-- CONSEQUENCE, and it is larger than it looks: **no business can be created at
-- all** in any database where 029 has run. That is the dashboard's
-- POST /api/onboarding/create-business — the entire signup path. 031's own
-- header notes the flow "has never been run against a database where row-level
-- security applies", and that remained true, so nothing caught it. It was found
-- by trying to seed one row into staging.
--
-- ------------------------------------------------------------------
-- The fix, and why it is not "grant BYPASSRLS"
-- ------------------------------------------------------------------
--
-- The policy is `WITH CHECK (id = app_current_business_id())`. It is not
-- unsatisfiable for a new row — it is unsatisfiable for a row whose id you do
-- not know yet. Generate the id first, declare it as the current tenant, and
-- the insert then satisfies the policy on its own terms. The bootstrap becomes
-- a normal scoped write instead of an exception to the rule.
--
-- Granting BYPASSRLS to the migration role would also "work", and it would
-- create a login that can read and write every tenant's data with no policy
-- applied — permanently, for the sake of one INSERT. 029 argues at length
-- against a policy that relaxes when the scope is unset; this is the same
-- argument with a bigger blast radius.
--
-- The scope is SET LOCAL (set_config's third argument is `true`) and the
-- caller's previous value is captured and RESTORED before returning. Without
-- the restore, calling this inside an existing transaction would silently
-- repoint the rest of that transaction at the newly created tenant — a
-- function that quietly changes which tenant its caller is writing to is worse
-- than one that fails.
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
  v_id       uuid := gen_random_uuid();
  v_previous text := current_setting('app.business_id', true);
  v_business businesses;
BEGIN
  IF p_user_id IS NULL OR p_email IS NULL OR p_name IS NULL OR p_timezone IS NULL THEN
    RAISE EXCEPTION 'app_create_business_for_user: all arguments are required';
  END IF;

  -- Become the tenant being created, for the length of this transaction only.
  PERFORM set_config('app.business_id', v_id::text, true);

  -- Explicit id, because the policy compares against it. Letting the DEFAULT
  -- generate one is exactly what made 031 unsatisfiable.
  INSERT INTO businesses (id, name, timezone)
  VALUES (v_id, p_name, p_timezone)
  RETURNING * INTO v_business;

  -- THE DUPLICATE GUARD, and it has to live here rather than in a SELECT above.
  --
  -- 031 checked first: `SELECT business_id FROM users WHERE id = p_user_id`.
  -- `users` is under the same FORCE row-level security, so with no tenant scope
  -- set that SELECT returns NO ROWS for a user who definitely exists — the
  -- guard silently stops firing in exactly the case it was written for, and
  -- the failure then surfaces as an RLS error from deep inside the function
  -- instead of the intended message.
  --
  -- ON CONFLICT detects the collision on the unique index, which is not subject
  -- to visibility, so this works with or without a scope. DO NOTHING rather
  -- than DO UPDATE: updating is what 031's header describes as silently
  -- repointing an account at a newer tenant and stranding the previous one.
  INSERT INTO users (id, email, business_id)
  VALUES (p_user_id, p_email, v_id)
  ON CONFLICT (id) DO NOTHING;

  IF NOT FOUND THEN
    -- Rolls back the business inserted moments ago, so a refused call leaves
    -- nothing behind.
    RAISE EXCEPTION 'app_create_business_for_user: user already belongs to a business'
      USING ERRCODE = '23505';
  END IF;

  -- Hand the caller back the scope it arrived with. COALESCE because
  -- current_setting(..., true) returns NULL when unset and set_config wants a
  -- string; '' is what app_current_business_id() already treats as unset.
  PERFORM set_config('app.business_id', COALESCE(v_previous, ''), true);

  RETURN v_business;
END;
$$;

COMMENT ON FUNCTION app_create_business_for_user(uuid, text, text, text) IS
  'Bootstrap: creates a tenant and attaches the signing-up account to it. SECURITY DEFINER is not sufficient on its own because migration 029 uses FORCE ROW LEVEL SECURITY, which applies to the table owner too — so this generates the id first and adopts it as the transaction-local tenant, making the insert satisfy the policy rather than bypass it. Restores the caller''s previous scope before returning.';
