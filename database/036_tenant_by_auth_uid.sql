-- ============================================================
-- Migration 036: resolve a session's tenant by ACCOUNT, not by address
-- ============================================================
-- Migration 034 keyed the tenant lookup on the email address in a verified
-- token. That is safe only while every address in `users` also has an account
-- at the identity provider — and signup is OPEN.
--
-- THE HOLE, concretely. Suppose `alice@clinic.test` has a `users` row and no
-- Identity Platform account. A stranger signs up with that address, gets a
-- genuinely valid token carrying `email: alice@clinic.test`, and
-- `app_lookup_user_by_email` hands them Alice's clinic. Every layer behaves
-- correctly; the token is real, the lookup is correct, the tenant is wrong.
--
-- The defect is that AN EMAIL ADDRESS IS SOMETHING A STRANGER CAN CHOOSE. So
-- the lookup moves onto something they cannot: `auth_uid`, the account id the
-- identity provider assigned. A newly signed-up account gets an id that is in
-- no directory, resolves to nothing, and gets a 403.
--
-- ------------------------------------------------------------------
-- Why this can run BEFORE the user import, and why that is better
-- ------------------------------------------------------------------
--
-- Because `auth_uid` is already derivable. EVERY path that has ever created a
-- `users` row set `users.id` from the auth provider's id:
--
--   pre-031 onboarding   INSERT INTO users (id, email) VALUES ($1, $2)
--                        with $1 = req.authUser.id, the Supabase auth uid
--   031 / 032            INSERT INTO users (id, email, business_id)
--                        VALUES (p_user_id, ...), same argument
--
-- Only migration 035 separated them, correctly, and rows it created already
-- carry a real `auth_uid`. So for every older row, `users.id` IS the account id
-- and the backfill below needs no export and no credentials.
--
-- Running this BEFORE the import means the hole never opens, rather than being
-- closed in a race with it. It also downgrades the import's worst failure: with
-- the lookup on `auth_uid`, a mistake there locks somebody out — recoverable —
-- instead of exposing a tenant, which is not.
--
-- ------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES NOT PROVE, stated so nobody assumes it does
-- ------------------------------------------------------------------
--
-- It enforces "every staff row carries an account id". It CANNOT check that the
-- id corresponds to an account that actually exists at Google — SQL cannot see
-- Identity Platform. If `users.id` was ever set to something that is not a
-- Supabase auth uid, that row gets a plausible-looking wrong `auth_uid` and that
-- person is locked out.
--
-- That check lives in `scripts/import-users.js`, which compares the export's id
-- against this column and REFUSES on disagreement rather than proceeding. The
-- two halves are deliberate: this migration makes the invariant exist, the
-- import proves it is true.
--
-- ------------------------------------------------------------------
-- A side effect worth having
-- ------------------------------------------------------------------
--
-- `user_directory` stops holding email addresses. It becomes an opaque account
-- id and a tenant id — no personal data at all, which is a better thing for a
-- table that deliberately has no row-level security on it.
-- ============================================================

-- ------------------------------------------------------------------
-- 1. Backfill, with FORCE stood down for the same reason as 033 and 034.
--
-- The migration role OWNS `users`, and FORCE binds the owner too, so an UPDATE
-- with no tenant scope matches ZERO ROWS and reports success — leaving every
-- row unbackfilled while the migration looks fine, and then failing at the NOT
-- NULL below for a reason that names the wrong thing. Fourth appearance of this
-- trap; scripts/migrate.js wraps each migration in BEGIN/COMMIT, so a failure
-- anywhere rolls this back and FORCE is never left off.
-- ------------------------------------------------------------------
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;

UPDATE users SET auth_uid = id::text WHERE auth_uid IS NULL;

ALTER TABLE users FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------
-- 2. Refuse to continue if anything is still unaccounted for.
--
-- `users.id` is NOT NULL so the statement above should have covered everything,
-- which is exactly why this is worth asserting: a guard that can only fire when
-- something has gone genuinely wrong is the kind worth keeping.
-- ------------------------------------------------------------------
DO $$
DECLARE
  v_missing bigint;
BEGIN
  ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
  SELECT count(*) INTO v_missing FROM users WHERE auth_uid IS NULL OR btrim(auth_uid) = '';
  ALTER TABLE users FORCE ROW LEVEL SECURITY;

  IF v_missing > 0 THEN
    RAISE EXCEPTION
      'migration 036: % staff row(s) have no auth_uid. Import them first — moving the tenant lookup now would lock them out.',
      v_missing;
  END IF;
END $$;

ALTER TABLE users ALTER COLUMN auth_uid SET NOT NULL;

-- ------------------------------------------------------------------
-- 3. Re-key the routing table.
--
-- Rebuilt rather than altered: it is derived data, and the trigger below keeps
-- it true from here on. Dropped BEFORE `users` is read so the trigger cannot
-- fire against a half-migrated table.
-- ------------------------------------------------------------------
DROP TRIGGER IF EXISTS user_directory_sync ON users;
DROP TABLE IF EXISTS user_directory;

CREATE TABLE user_directory (
  auth_uid    text PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE INDEX user_directory_business_id_idx ON user_directory (business_id);

COMMENT ON TABLE user_directory IS
  'Routing only: identity-provider account id -> tenant. Deliberately has NO row-level security, and is deliberately NOT granted to vetra_app — only the SECURITY DEFINER bootstrap function reads it. Keyed on auth_uid rather than email since migration 036: an email address is something a stranger can choose at signup, an account id is not. Holds no personal data.';

REVOKE ALL ON user_directory FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_sync_user_directory()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM user_directory WHERE auth_uid = OLD.auth_uid;
    RETURN OLD;
  END IF;

  -- An account CHANGE must stop the old one resolving, or a decommissioned
  -- login stays routable.
  IF TG_OP = 'UPDATE' AND NEW.auth_uid IS DISTINCT FROM OLD.auth_uid THEN
    DELETE FROM user_directory WHERE auth_uid = OLD.auth_uid;
  END IF;

  IF NEW.auth_uid IS NULL OR btrim(NEW.auth_uid) = '' THEN
    RETURN NEW;
  END IF;

  INSERT INTO user_directory (auth_uid, business_id)
  VALUES (NEW.auth_uid, NEW.business_id)
  ON CONFLICT (auth_uid) DO UPDATE SET business_id = EXCLUDED.business_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER user_directory_sync
  AFTER INSERT OR UPDATE OF auth_uid, business_id OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION app_sync_user_directory();

-- Backfill the rebuilt table. Same FORCE stand-down, same reason: a plain
-- SELECT here reads zero rows and silently routes nobody.
ALTER TABLE users NO FORCE ROW LEVEL SECURITY;

INSERT INTO user_directory (auth_uid, business_id)
SELECT u.auth_uid, u.business_id
  FROM users u
 WHERE btrim(u.auth_uid) <> ''
ON CONFLICT (auth_uid) DO UPDATE SET business_id = EXCLUDED.business_id;

ALTER TABLE users FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------
-- 4. The lookup itself, re-keyed.
--
-- Same shape as 034 — read the scope-free directory, adopt the tenant it names,
-- then read `users` as an ordinary policy-satisfying statement. Only the key
-- changes.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_lookup_user_by_auth_uid(p_auth_uid text)
RETURNS TABLE (id uuid, business_id uuid, email text, role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_business uuid;
  v_current  text := current_setting('app.business_id', true);
BEGIN
  IF p_auth_uid IS NULL OR btrim(p_auth_uid) = '' THEN
    RETURN;
  END IF;

  -- Qualified with `d.`, because RETURNS TABLE puts `business_id` in scope as an
  -- OUT parameter and an unqualified reference would resolve to it.
  SELECT d.business_id INTO v_business
    FROM user_directory d
   WHERE d.auth_uid = p_auth_uid;

  IF v_business IS NULL THEN
    RETURN;
  END IF;

  -- Adopt the discovered tenant ONLY when the caller has not already declared
  -- one. This must never repoint a transaction that already knows which tenant
  -- it is working for.
  IF v_current IS NULL OR v_current = '' THEN
    PERFORM set_config('app.business_id', v_business::text, true);
  END IF;

  RETURN QUERY
    SELECT u.id, u.business_id, u.email, u.role
      FROM users u
     WHERE u.auth_uid = p_auth_uid
     LIMIT 1;
END;
$$;

COMMENT ON FUNCTION app_lookup_user_by_auth_uid(text) IS
  'Bootstrap: a verified account id -> the tenant it may act on. Replaces app_lookup_user_by_email, because an email address is something a stranger can choose at an open signup and an account id is not. Reads user_directory, which has no row-level security and is unreadable by the application role, then adopts that tenant so the read of `users` SATISFIES the policy instead of bypassing it — see migrations 034 and 036.';

REVOKE ALL ON FUNCTION app_lookup_user_by_auth_uid(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_lookup_user_by_auth_uid(text) TO vetra_app;

-- ------------------------------------------------------------------
-- 5. Remove the old one.
--
-- DROPPED rather than left in place. Leaving it would be a second answer to the
-- question this migration exists to re-answer, still reachable, still granted,
-- and still resolving a tenant from an address a stranger can pick.
-- ------------------------------------------------------------------
DROP FUNCTION IF EXISTS app_lookup_user_by_email(text);
