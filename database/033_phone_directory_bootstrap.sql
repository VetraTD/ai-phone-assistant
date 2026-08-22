-- ============================================================
-- Migration 033: let a dialled number find its tenant
-- ============================================================
-- Migration 029 solved the READ bootstrap with `app_lookup_business_by_phone`,
-- a SECURITY DEFINER function: resolving a dialled number to a tenant is what
-- makes scoping possible, so it cannot itself be scoped.
--
-- It does not work on Cloud SQL, for the same reason migration 032 had to fix
-- the write bootstrap. SECURITY DEFINER runs as the function's OWNER, which
-- clears ORDINARY row security — but 029 uses FORCE ROW LEVEL SECURITY, which
-- applies to the owner too. Only BYPASSRLS escapes.
--
-- Measured on the live staging instance rather than assumed:
--
--   postgres:  rolsuper = false, rolbypassrls = false, rolcreaterole = true
--   roles that can bypass RLS:  cloudsqladmin   (Google's own, not ours)
--   app_lookup_business_by_phone('+1817...') with no scope:  0 rows
--
-- CONSEQUENCE: the receptionist cannot resolve ANY dialled number to a
-- business. Every call takes the unrouted path and is answered by voicemail —
-- which is exactly what a real test call did.
--
-- ------------------------------------------------------------------
-- Why this is not "give the function a BYPASSRLS owner"
-- ------------------------------------------------------------------
--
-- That is the textbook fix and it is UNAVAILABLE here. Postgres requires you to
-- hold BYPASSRLS in order to grant it, and `postgres` on Cloud SQL does not
-- hold it. The only role that does is `cloudsqladmin`, which Google operates
-- and we cannot own objects as. So the design cannot relocate the bypass; it
-- has to stop needing one.
--
-- ------------------------------------------------------------------
-- The shape of the fix
-- ------------------------------------------------------------------
--
-- The policy is `USING (id = app_current_business_id())`. The lookup is
-- impossible only because the id is the very thing being discovered. So the one
-- fact needed to break the deadlock — which business owns this phone number —
-- moves OUT of the policy-protected table and into a tiny routing table that
-- carries nothing worth protecting:
--
--   business_directory(phone_number -> business_id)
--
-- The function reads the directory, adopts the answer as the transaction-local
-- tenant, and then reads `businesses` normally. Nothing bypasses the policy;
-- the policy is SATISFIED, because by then the scope is known.
--
-- WHAT THE DIRECTORY MAY NOT BECOME: it holds a business phone number and a
-- business id, and must never hold anything else. No patient data, no clinic
-- detail, nothing that would make reading it worth doing.
--
-- It is deliberately NOT granted to the application role. `vetra_app` cannot
-- SELECT it at all — only the SECURITY DEFINER function, which runs as its
-- owner, can. So a table without row-level security does not become a
-- cross-tenant window: the application cannot enumerate other businesses'
-- numbers, because it cannot read the table in the first place.
-- ============================================================

CREATE TABLE IF NOT EXISTS business_directory (
  phone_number text PRIMARY KEY,
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS business_directory_business_id_idx
  ON business_directory (business_id);

COMMENT ON TABLE business_directory IS
  'Routing only: dialled number -> tenant. Deliberately has NO row-level security, and is deliberately NOT granted to vetra_app — only the SECURITY DEFINER bootstrap function reads it. It exists because a tenant cannot be discovered through a policy that requires the tenant. Must never carry anything beyond a phone number and a business id.';

-- No policy-protected data, and no application access.
REVOKE ALL ON business_directory FROM PUBLIC;

-- ------------------------------------------------------------------
-- Keeping it true.
--
-- A routing table that drifts is worse than none: a stale row sends a caller to
-- the wrong tenant, and a missing row sends them to voicemail. The trigger is
-- SECURITY DEFINER because the application role has no rights on the directory
-- and must not be given any.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_sync_business_directory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM business_directory WHERE business_id = OLD.id;
    RETURN OLD;
  END IF;

  -- Drop any previous number for this business first: a business that CHANGES
  -- its number must stop answering on the old one, or two numbers route to the
  -- same tenant and one of them is a number somebody else may later be issued.
  DELETE FROM business_directory WHERE business_id = NEW.id;

  IF NEW.phone_number IS NOT NULL AND btrim(NEW.phone_number) <> '' THEN
    INSERT INTO business_directory (phone_number, business_id)
    VALUES (btrim(NEW.phone_number), NEW.id)
    ON CONFLICT (phone_number) DO UPDATE SET business_id = EXCLUDED.business_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS business_directory_sync ON businesses;
CREATE TRIGGER business_directory_sync
  AFTER INSERT OR UPDATE OF phone_number OR DELETE ON businesses
  FOR EACH ROW EXECUTE FUNCTION app_sync_business_directory();

-- ------------------------------------------------------------------
-- Backfill, and the one place FORCE is briefly stood down.
--
-- The migration role OWNS `businesses`, but FORCE means it is subject to the
-- policy like anyone else, so a plain SELECT here would see ZERO rows and
-- silently backfill nothing — leaving every existing business unroutable while
-- the migration reported success.
--
-- NO FORCE restores the ordinary owner exemption for the length of this
-- migration, and only for the owner: the policy itself stays enabled and every
-- other role remains fully constrained throughout. scripts/migrate.js wraps
-- each migration in BEGIN/COMMIT, so a failure anywhere below rolls this back
-- with everything else and FORCE is never left off.
-- ------------------------------------------------------------------
ALTER TABLE businesses NO FORCE ROW LEVEL SECURITY;

INSERT INTO business_directory (phone_number, business_id)
SELECT btrim(b.phone_number), b.id
  FROM businesses b
 WHERE b.phone_number IS NOT NULL AND btrim(b.phone_number) <> ''
ON CONFLICT (phone_number) DO UPDATE SET business_id = EXCLUDED.business_id;

ALTER TABLE businesses FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------
-- The lookup itself.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_lookup_business_by_phone(p_phone text)
RETURNS SETOF businesses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id      uuid;
  v_current text := current_setting('app.business_id', true);
BEGIN
  IF p_phone IS NULL OR btrim(p_phone) = '' THEN
    RETURN;
  END IF;

  SELECT business_id INTO v_id
    FROM business_directory
   WHERE phone_number = btrim(p_phone);

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  -- Adopt the discovered tenant ONLY when the caller has not already declared
  -- one. If a scope is already set, respect it: this function must never
  -- repoint a transaction that already knows which tenant it is working for,
  -- and in that case the row is visible only if it genuinely belongs to that
  -- tenant — which is the correct answer, not a limitation.
  IF v_current IS NULL OR v_current = '' THEN
    PERFORM set_config('app.business_id', v_id::text, true);
  END IF;

  -- Now an ordinary, policy-satisfying read. Note this also makes the
  -- capability subquery in the same statement work: services/db.js calls
  -- `SELECT b.*, app_business_capabilities(b.id) FROM app_lookup_business_by_phone($1) b`,
  -- and business_capabilities is FORCE RLS too, so it returned nothing for the
  -- same reason until a scope existed.
  RETURN QUERY SELECT * FROM businesses WHERE id = v_id;
END;
$$;

COMMENT ON FUNCTION app_lookup_business_by_phone(text) IS
  'Bootstrap: dialled number -> tenant. Reads business_directory, which has no row-level security and is unreadable by the application role, then adopts that tenant for the transaction so the read of `businesses` SATISFIES the policy instead of bypassing it. SECURITY DEFINER alone is not enough under FORCE ROW LEVEL SECURITY, and a BYPASSRLS owner is unavailable on Cloud SQL — see migration 033.';
