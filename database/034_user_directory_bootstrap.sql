-- ============================================================
-- Migration 034: let a verified login find its tenant
-- ============================================================
-- The third and last of migration 029's bootstrap paths to be defeated by 029's
-- own FORCE ROW LEVEL SECURITY. 032 fixed the write path
-- (`app_create_business_for_user`), 033 fixed the dialled-number path
-- (`app_lookup_business_by_phone`), and this one was still live.
--
-- SECURITY DEFINER runs the function as its OWNER, which clears ORDINARY row
-- security because a table's owner is exempt by default. FORCE removes that
-- exemption. The only role that still escapes is one holding BYPASSRLS, and on
-- Cloud SQL nobody we control holds it — `postgres` there is a
-- `cloudsqlsuperuser` with rolsuper = false, rolbypassrls = false, and the only
-- role with BYPASSRLS is Google's own `cloudsqladmin`.
--
-- Measured on local PG16 in both directions rather than assumed, because the
-- local database is exactly the thing that hides this:
--
--   app_lookup_user_by_email('...') with no tenant scope
--     owner = vetra   (superuser, rolbypassrls = true)   ->  1 row
--     owner = a role with rolbypassrls = false           ->  0 rows
--
-- CONSEQUENCE: `users` is under `USING (business_id = app_current_business_id())`,
-- and this lookup is how the tenant BECOMES known — so it runs with no scope
-- set, and the policy is therefore false for every row. Both servers read it:
--
--   AI-phone-dashboard/backend/src/utils.js  getBusinessIdForUser
--   middleware/requireBusinessAccess.js      via services/db.js fetchUserByEmail
--
-- so on Cloud SQL every authenticated request resolved to no business and
-- returned 403 "No business linked to this user". A signed-in member of staff
-- would reach an empty dashboard, and the failure reads as an authorisation bug
-- rather than a scoping one. Nothing caught it because the local database
-- cannot reproduce it.
--
-- ------------------------------------------------------------------
-- Why this is not "give the function a BYPASSRLS owner"
-- ------------------------------------------------------------------
--
-- Same as 033: Postgres requires you to hold BYPASSRLS in order to grant it,
-- and `postgres` on Cloud SQL does not hold it. The design cannot relocate the
-- bypass; it has to stop needing one.
--
-- ------------------------------------------------------------------
-- The shape of the fix — deliberately identical to 033
-- ------------------------------------------------------------------
--
-- The policy is `USING (business_id = app_current_business_id())`. The lookup is
-- impossible only because the business_id is the very thing being discovered.
-- So that one fact — which tenant this address belongs to — moves OUT of the
-- policy-protected table into a routing table:
--
--   user_directory(email -> business_id)
--
-- The function reads the directory, adopts the answer as the transaction-local
-- tenant, and then reads `users` normally. Nothing bypasses the policy; the
-- policy is SATISFIED, because by then the scope is known.
--
-- Two bootstraps, one pattern. A second shape here would mean two things to
-- keep true instead of one.
--
-- WHAT THE DIRECTORY MAY NOT BECOME: an address and a business id, and nothing
-- else. It duplicates one column that already exists on `users` and adds no
-- fact that was not already there. No name, no role, no credential — a role
-- would make it worth reading, and a credential would make it worth stealing.
--
-- It is deliberately NOT granted to the application role. `vetra_app` cannot
-- SELECT it at all — only the SECURITY DEFINER function, which runs as its
-- owner, can. So a table without row-level security is not a cross-tenant
-- window: the application cannot enumerate other businesses' staff, because it
-- cannot read the table in the first place.
--
-- ------------------------------------------------------------------
-- Matching is EXACT, and stays exact
-- ------------------------------------------------------------------
--
-- 029 compared with `=`. This keeps that. Folding case or trimming here would
-- change which address resolves to which tenant, silently, in a function whose
-- answer decides what a session may read — and it would do it during a
-- migration whose stated job is to change nothing about who resolves to what.
-- `btrim` appears only in the emptiness guards, never in a comparison.
-- ============================================================

CREATE TABLE IF NOT EXISTS user_directory (
  email       text PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS user_directory_business_id_idx
  ON user_directory (business_id);

COMMENT ON TABLE user_directory IS
  'Routing only: verified login address -> tenant. Deliberately has NO row-level security, and is deliberately NOT granted to vetra_app — only the SECURITY DEFINER bootstrap function reads it. It exists because a tenant cannot be discovered through a policy that requires the tenant. Must never carry anything beyond an email and a business id.';

-- No policy-protected data, and no application access.
REVOKE ALL ON user_directory FROM PUBLIC;

-- ------------------------------------------------------------------
-- Keeping it true.
--
-- A routing table that drifts is worse than none. A stale row is the serious
-- direction here: it would resolve somebody's login to an employer they have
-- left, which is a cross-tenant read with a valid session behind it. A missing
-- row only locks somebody out.
--
-- SECURITY DEFINER because the application role has no rights on the directory
-- and must not be given any.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_sync_user_directory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM user_directory WHERE email = OLD.email;
    RETURN OLD;
  END IF;

  -- An address CHANGE must stop the old one resolving. Without this the
  -- previous address keeps a live mapping to the tenant, and a decommissioned
  -- login stays routable.
  IF TG_OP = 'UPDATE' AND NEW.email IS DISTINCT FROM OLD.email THEN
    DELETE FROM user_directory WHERE email = OLD.email;
  END IF;

  -- users.email is NOT NULL, which does not stop it being empty.
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN
    RETURN NEW;
  END IF;

  INSERT INTO user_directory (email, business_id)
  VALUES (NEW.email, NEW.business_id)
  ON CONFLICT (email) DO UPDATE SET business_id = EXCLUDED.business_id;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_directory_sync ON users;
CREATE TRIGGER user_directory_sync
  AFTER INSERT OR UPDATE OF email, business_id OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION app_sync_user_directory();

-- ------------------------------------------------------------------
-- Backfill, and the one place FORCE is briefly stood down.
--
-- The migration role OWNS `users`, but FORCE means it is subject to the policy
-- like anyone else, so a plain SELECT here would see ZERO rows and silently
-- backfill nothing — leaving every existing login unable to resolve while the
-- migration reported success. This is 033's trap, repeated verbatim because it
-- is the same trap.
--
-- NO FORCE restores the ordinary owner exemption for the length of this
-- migration, and only for the owner: the policy itself stays enabled and every
-- other role remains fully constrained throughout. scripts/migrate.js wraps each
-- migration in BEGIN/COMMIT, so a failure anywhere below rolls this back with
-- everything else and FORCE is never left off.
-- ------------------------------------------------------------------
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;

INSERT INTO user_directory (email, business_id)
SELECT u.email, u.business_id
  FROM users u
 WHERE u.email IS NOT NULL AND btrim(u.email) <> ''
ON CONFLICT (email) DO UPDATE SET business_id = EXCLUDED.business_id;

ALTER TABLE users FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------
-- The lookup itself.
--
-- Signature and column names are unchanged from 029 — `CREATE OR REPLACE`
-- cannot alter them, and both servers select `*` from it. The body changes and
-- the contract does not.
--
-- No longer STABLE: it calls set_config. Declaring it stable while it writes a
-- session setting invites the planner to fold the call away.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_lookup_user_by_email(p_email text)
RETURNS TABLE (id uuid, business_id uuid, email text, role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_business uuid;
  v_current  text := current_setting('app.business_id', true);
BEGIN
  IF p_email IS NULL OR btrim(p_email) = '' THEN
    RETURN;
  END IF;

  -- Qualified with `d.`, because RETURNS TABLE puts `email` and `business_id`
  -- in scope as OUT parameters and an unqualified reference would resolve to
  -- those rather than to the column.
  SELECT d.business_id INTO v_business
    FROM user_directory d
   WHERE d.email = p_email;

  IF v_business IS NULL THEN
    RETURN;
  END IF;

  -- Adopt the discovered tenant ONLY when the caller has not already declared
  -- one. If a scope is already set, respect it: this function must never
  -- repoint a transaction that already knows which tenant it is working for,
  -- and in that case the row is visible only if the user genuinely belongs to
  -- that tenant — which is the correct answer, not a limitation.
  IF v_current IS NULL OR v_current = '' THEN
    PERFORM set_config('app.business_id', v_business::text, true);
  END IF;

  -- Now an ordinary, policy-satisfying read.
  RETURN QUERY
    SELECT u.id, u.business_id, u.email, u.role
      FROM users u
     WHERE u.email = p_email
     LIMIT 1;
END;
$$;

COMMENT ON FUNCTION app_lookup_user_by_email(text) IS
  'Bootstrap: a verified login address -> the tenant it may act on. Reads user_directory, which has no row-level security and is unreadable by the application role, then adopts that tenant for the transaction so the read of `users` SATISFIES the policy instead of bypassing it. SECURITY DEFINER alone is not enough under FORCE ROW LEVEL SECURITY, and a BYPASSRLS owner is unavailable on Cloud SQL — see migration 034.';
