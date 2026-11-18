-- ============================================================
-- Migration 029: row-level security, and an application role to enforce it on
-- ============================================================
-- Until now tenant isolation has been app-layer discipline: 33 exported
-- functions, each of which has to remember its `business_id` filter, with a
-- credential underneath that bypasses row security by design. That is a single
-- point of failure spread across a codebase, and §164.312 is not satisfied by
-- everyone being careful.
--
-- This adds the second line of defence: a query that FORGETS its filter returns
-- nothing instead of returning everybody.
--
-- ------------------------------------------------------------
-- 1. How the tenant is communicated
-- ------------------------------------------------------------
-- `current_setting('app.business_id', true)` — a session/transaction GUC the
-- connection sets before it queries. The `true` argument means "return NULL if
-- unset" rather than raising, and that NULL is doing real work: every policy
-- below compares against it, NULL comparisons are never true, so an UNSCOPED
-- connection sees ZERO ROWS rather than all of them. Default-deny falls out of
-- the semantics instead of needing its own rule.
--
-- ------------------------------------------------------------
-- 2. Why FORCE, not just ENABLE
-- ------------------------------------------------------------
-- ENABLE exempts the table OWNER. The owner is exactly who a naive connection
-- string connects as, so ENABLE alone protects against everyone except the most
-- likely caller. FORCE closes that.
--
-- Superusers still bypass RLS unconditionally — that cannot be turned off, and
-- it is why `vetra_app` below is deliberately NOSUPERUSER NOBYPASSRLS.
--
-- ------------------------------------------------------------
-- 3. The bootstrap problem, and why two SECURITY DEFINER functions exist
-- ------------------------------------------------------------
-- Two reads necessarily happen BEFORE the tenant is known — they are how the
-- tenant becomes known:
--
--   lookupBusinessByPhone()  the dialled number -> which clinic is this?
--   fetchUserByEmail()       an authenticated identity -> which clinic may they act on?
--
-- Under a strict policy both return nothing, and the system cannot answer a
-- call or authenticate anybody. The tempting fix is a policy that allows reads
-- when `app.business_id` is unset. That is much worse than it looks: it makes
-- "forgot to scope" the same as "allowed to see everything", which is the exact
-- failure this migration exists to prevent, re-introduced as a feature.
--
-- Instead: two SECURITY DEFINER functions, each returning ONE row, each with a
-- pinned `search_path` (an unpinned one on a SECURITY DEFINER function is a
-- privilege-escalation vector, since the caller controls name resolution).
-- They are narrow, they are named, and they are the complete list of places
-- that read across tenants.
-- ============================================================

-- ------------------------------------------------------------
-- The application role
-- ------------------------------------------------------------
-- NOSUPERUSER and NOBYPASSRLS are the point of it. The migration user is a
-- superuser and therefore ignores every policy below; the application must not
-- be. NOLOGIN here because the password belongs in Secret Manager, not in a
-- migration file that lives in git — B2/B4 grants login with a real credential.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vetra_app') THEN
    CREATE ROLE vetra_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOLOGIN;
  ELSE
    -- Idempotent, and it re-asserts the two attributes that matter in case an
    -- earlier hand-created role had them wrong.
    ALTER ROLE vetra_app NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO vetra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vetra_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vetra_app;
-- Tables created by future migrations, so a new table is not accidentally
-- unreadable — or, worse, readable only because somebody granted it broadly in
-- a hurry when the application broke.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vetra_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO vetra_app;

-- ------------------------------------------------------------
-- The current tenant, as a function
-- ------------------------------------------------------------
-- STABLE, not IMMUTABLE: it depends on session state, and marking it IMMUTABLE
-- would let the planner cache it across a change of tenant on a pooled
-- connection. That is a cross-tenant read produced by an optimisation.
CREATE OR REPLACE FUNCTION app_current_business_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.business_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION app_current_business_id() IS
  'The tenant the current connection is scoped to, or NULL when unscoped. NULL makes every RLS policy false, so an unscoped connection sees nothing.';

-- ------------------------------------------------------------
-- Policies: the tables that carry business_id directly
-- ------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'calls', 'appointments', 'customer_requests', 'business_knowledge',
    'business_capabilities', 'integrations', 'users'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    -- USING governs what is visible to SELECT/UPDATE/DELETE; WITH CHECK governs
    -- what may be written. Both are required: USING alone would let a scoped
    -- connection INSERT a row belonging to another tenant, which it could then
    -- not see — a write-only cross-tenant leak, and the kind that is discovered
    -- much later than a read one.
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (business_id = app_current_business_id())
        WITH CHECK (business_id = app_current_business_id())
    $f$, t);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- businesses: the tenant row itself
-- ------------------------------------------------------------
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON businesses;
CREATE POLICY tenant_isolation ON businesses
  USING (id = app_current_business_id())
  WITH CHECK (id = app_current_business_id());

-- ------------------------------------------------------------
-- call_transcripts: the join-away table
-- ------------------------------------------------------------
-- Nothing on the row says which tenant it belongs to, which is exactly why a
-- hand-written filter forgets it — and why the negative tests single it out.
-- The policy reaches through call_id rather than trusting anybody to remember
-- the join.
ALTER TABLE call_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_transcripts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON call_transcripts;
CREATE POLICY tenant_isolation ON call_transcripts
  USING (EXISTS (
    SELECT 1 FROM calls c
     WHERE c.id = call_transcripts.call_id
       AND c.business_id = app_current_business_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM calls c
     WHERE c.id = call_transcripts.call_id
       AND c.business_id = app_current_business_id()
  ));

-- The subquery runs per row, so it needs the index that makes it free.
CREATE INDEX IF NOT EXISTS idx_calls_id_business ON calls (id, business_id);

-- ------------------------------------------------------------
-- oauth_states: inert since A1.1, and locked down rather than left open
-- ------------------------------------------------------------
-- A1.1 deleted the only code that read or wrote this table. Enabling RLS with
-- no policy means NOBODY except a superuser can touch it, which is the
-- accurate description of a table nothing uses.
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states FORCE ROW LEVEL SECURITY;

-- calendar_connections is the same story (A1.1), same treatment.
ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_connections FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- The two bootstrap lookups
-- ------------------------------------------------------------
-- SECURITY DEFINER, so they run with the definer's rights and see across
-- tenants. Both return exactly one row. `SET search_path` is pinned: an
-- unpinned search_path on a SECURITY DEFINER function lets the caller decide
-- which `calls` table the body means, which is a privilege-escalation vector
-- rather than a style issue.

CREATE OR REPLACE FUNCTION app_lookup_business_by_phone(p_phone text)
RETURNS SETOF businesses
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT * FROM businesses WHERE phone_number = p_phone LIMIT 1;
$$;

COMMENT ON FUNCTION app_lookup_business_by_phone(text) IS
  'Bootstrap: the dialled number to a tenant, before any tenant is known. SECURITY DEFINER because a scoped connection cannot yet be scoped. Returns at most one row.';

-- The capability rows for one business, also as a bootstrap read.
--
-- Needed because `business_capabilities` is itself RLS-protected, so the
-- capability subquery that rides along with the business lookup returns NOTHING
-- at pickup — when no tenant is set yet. Losing it is not cosmetic: capability
-- rows decide which tools exist and which requirements are enforced BEFORE
-- turn one, and the alternative is a second round trip on the latency-critical
-- pickup path, which services/db.js argues against at length and correctly.
--
-- Scoped to one business id, and capability rows are configuration rather than
-- patient data — which is what makes a definer function acceptable here and
-- would not make one acceptable over `calls`.
CREATE OR REPLACE FUNCTION app_business_capabilities(p_business_id uuid)
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT COALESCE(json_agg(bc.*), '[]'::json)
    FROM business_capabilities bc
   WHERE bc.business_id = p_business_id;
$$;

COMMENT ON FUNCTION app_business_capabilities(uuid) IS
  'Bootstrap: one business''s capability rows, needed before a tenant is set. Configuration, not patient data.';

CREATE OR REPLACE FUNCTION app_lookup_user_by_email(p_email text)
RETURNS TABLE (id uuid, business_id uuid, email text, role text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT u.id, u.business_id, u.email, u.role
    FROM users u WHERE u.email = p_email LIMIT 1;
$$;

COMMENT ON FUNCTION app_lookup_user_by_email(text) IS
  'Bootstrap: an authenticated identity to the tenant it may act on. SECURITY DEFINER for the same reason as app_lookup_business_by_phone. Returns at most one row.';

REVOKE ALL ON FUNCTION app_lookup_business_by_phone(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_lookup_user_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_lookup_business_by_phone(text) TO vetra_app;
REVOKE ALL ON FUNCTION app_business_capabilities(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_business_capabilities(uuid) TO vetra_app;
GRANT EXECUTE ON FUNCTION app_lookup_user_by_email(text) TO vetra_app;
GRANT EXECUTE ON FUNCTION app_current_business_id() TO vetra_app;

-- create_appointment_if_available (migration 022) inserts into appointments,
-- so under FORCE RLS it needs the tenant set by the caller like any other
-- write. It is intentionally NOT made SECURITY DEFINER: it takes p_business_id
-- as an argument, so a scoped connection passing its own tenant satisfies the
-- policy, and making it definer would hand it the ability to book into any
-- tenant.
GRANT EXECUTE ON FUNCTION create_appointment_if_available(uuid, timestamptz, int, int, uuid, text, text, text) TO vetra_app;
