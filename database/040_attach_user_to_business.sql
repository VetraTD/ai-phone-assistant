-- ---------------------------------------------------------------------------
-- 040 — the missing flow: attach a dashboard user to an already-imported tenant.
--
-- THE GAP (ledger P25). scripts/import-tenant.js creates a business and
-- DELIBERATELY no dashboard user; its own header says "Attaching one later
-- needs a flow that does not exist yet." Both DSR routes sit behind
-- requireBusinessAccess, which needs an Identity Platform session, and
-- migration 036 keys the tenant lookup on auth_uid. So an imported tenant has
-- no user, therefore no session, therefore NO WAY to exercise Art. 15 or
-- Art. 17 — which is why Phase 5's DSR gate could not run at all, and why a
-- real clinic migrated by import could not serve a subject access request.
--
-- app_create_business_for_user cannot be reused: it CREATES the business. Here
-- the business already exists and must not be duplicated.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS NOT GRANTED TO vetra_app, AND MUST NEVER BE.
--
-- app_create_business_for_user is safe to expose to the application because the
-- tenant it attaches you to is one it just generated — you can only ever reach
-- a business that did not exist a moment ago. THIS function takes a business id
-- as an argument. Exposed on a request path it is a tenant-hopping primitive:
-- sign up, call it with somebody else's business id, inherit their clinic.
--
-- So it is REVOKEd from PUBLIC and granted to nobody. It runs as the migrate
-- job or an operator on an admin connection, via
-- scripts/attach-tenant-user.js. If a self-serve flow ever needs this, it needs
-- an invitation token checked INSIDE this function — not a grant.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_attach_user_to_business(
  p_auth_uid    text,
  p_email       text,
  p_business_id uuid
)
RETURNS users
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_previous text := current_setting('app.business_id', true);
  v_exists   boolean;
  v_user     users;
BEGIN
  IF p_auth_uid IS NULL OR btrim(p_auth_uid) = ''
     OR p_email IS NULL OR btrim(p_email) = ''
     OR p_business_id IS NULL THEN
    RAISE EXCEPTION 'app_attach_user_to_business: all arguments are required';
  END IF;

  -- Adopt the target tenant for this transaction, exactly as
  -- app_create_business_for_user does. SECURITY DEFINER alone is NOT enough:
  -- migration 029 uses FORCE ROW LEVEL SECURITY, so even the owner is subject
  -- to the policy and an unscoped INSERT into users is refused.
  PERFORM set_config('app.business_id', p_business_id::text, true);

  -- Checked INSIDE the adopted scope and with FOUND rather than a bare SELECT
  -- count: businesses is under FORCE RLS too, so an unscoped existence check
  -- returns nothing for a business that definitely exists — the guard would
  -- silently stop firing in exactly the case it exists for.
  SELECT true INTO v_exists FROM businesses WHERE id = p_business_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'app_attach_user_to_business: no such business %', p_business_id
      USING ERRCODE = '23503';
  END IF;

  -- Same duplicate guard, and the same reasoning as 035: ON CONFLICT rather
  -- than a SELECT, because a unique index is not subject to row visibility and
  -- a scoped SELECT cannot see a row belonging to a DIFFERENT tenant — which is
  -- the collision that matters here. DO NOTHING, never DO UPDATE: repointing an
  -- existing account at a new tenant is how you strand the old one.
  INSERT INTO users (email, business_id, auth_uid)
  VALUES (p_email, p_business_id, p_auth_uid)
  ON CONFLICT DO NOTHING
  RETURNING * INTO v_user;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'app_attach_user_to_business: this account or email already belongs to a business'
      USING ERRCODE = '23505';
  END IF;

  PERFORM set_config('app.business_id', COALESCE(v_previous, ''), true);

  RETURN v_user;
END;
$$;

COMMENT ON FUNCTION app_attach_user_to_business(text, text, uuid) IS
  'Operator-only: attaches an EXISTING Identity Platform account to an EXISTING business, so a tenant created by scripts/import-tenant.js can have a dashboard user and therefore a DSR path (ledger P25). Deliberately granted to NOBODY — it takes a business id as an argument, so on a request path it would be a tenant-hopping primitive. Run it as the migrate job or an operator via scripts/attach-tenant-user.js. Adopts the target tenant transaction-locally because FORCE row-level security applies to the owner too, and restores the caller''s scope before returning.';

REVOKE ALL ON FUNCTION app_attach_user_to_business(text, text, uuid) FROM PUBLIC;
-- No GRANT. See the header. This is the security property, not an omission.
