-- ============================================================
-- AI Phone Assistant — Multi-Tenant Schema
-- ============================================================
--
-- Plain PostgreSQL. It was written for the Supabase SQL Editor and contains
-- nothing Supabase-specific — verified across migrations 002-027 — which is
-- what makes a local PG16 container a valid stand-in for Cloud SQL.
--
-- THIS FILE REPRESENTS THE FULLY-MIGRATED STATE (schema + every migration in
-- this directory, 002 through 027, already applied). A fresh install runs
-- ONLY this file and needs no migrations afterwards; the numbered migration
-- files exist solely to move an EXISTING database forward.
--
-- The "002 through NNN" above went stale at 018 and stayed stale for nine
-- migrations, which is the failure mode this whole comment warns about, one
-- level up. tests/schema.test.js now checks the columns and indexes
-- rather than the sentence, so the sentence being wrong is a documentation
-- bug instead of a silent install bug.
--
-- Consequently: whenever you add a migration that changes a table's shape,
-- fold the result into this file in the same commit. Columns/indexes that
-- live only in a migration make a fresh install silently broken — the app
-- reads them and gets "column does not exist" at runtime. Columns added and
-- later dropped (e.g. tts_voice/google_tts_voice/barge_in in 011, dropped by
-- 012; the whole `services` table, dropped by 018) correctly appear nowhere
-- here, since this is the end state, not the history.
-- ============================================================

-- 1. Businesses (tenant root + per-business config)
CREATE TABLE businesses (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                         text NOT NULL,
  phone_number                 text,
  timezone                     text DEFAULT 'America/Chicago',
  -- Explicit locale override (migration 025). NULL = derive from the chosen
  -- voice's accent, the phone numbers and the timezone. Drives date phrasing,
  -- currency, phone grouping, ringback and the STT language.
  locale                       text CHECK (locale IS NULL OR locale IN ('en-US', 'en-GB', 'es-US')),
  -- migration 028. What THIS TENANT requires. The effective tier for a call is
  -- the STRICTER of this and DEPLOYMENT_MODE — a tenant row can tighten the
  -- stack's posture, never relax it (lib/compliance.js effectiveTier).
  compliance_tier              text NOT NULL DEFAULT 'standard'
                                 CHECK (compliance_tier IN ('standard', 'hipaa')),
  greeting                     text,
  -- Weekly shape (migration 014). NULL still means "always open" — see
  -- services/gemini.js isBusinessOpen().
  business_hours               jsonb DEFAULT '{"mon":{"open":"09:00","close":"17:00","closed":false},"tue":{"open":"09:00","close":"17:00","closed":false},"wed":{"open":"09:00","close":"17:00","closed":false},"thu":{"open":"09:00","close":"17:00","closed":false},"fri":{"open":"09:00","close":"17:00","closed":false},"sat":{"open":null,"close":null,"closed":true},"sun":{"open":null,"close":null,"closed":true}}',
  transfer_phone_number        text,
  -- Modules-only (migration 013): CORE tasks (general_question, take_message,
  -- callback_request, transfer_human) are injected unconditionally by
  -- services/supabase.js normalizeAllowedTasks and are NOT stored here.
  allowed_tasks                jsonb DEFAULT '["book_appointment"]',
  main_phone                   text,
  general_info                 text,
  recording_disclosure_enabled boolean DEFAULT false,
  recording_disclosure_text    text,
  after_hours_policy           text DEFAULT 'take_message',
  transfer_policy              text DEFAULT 'always',
  languages_spoken             jsonb DEFAULT '["en"]',
  custom_instructions          text,
  -- Notification settings (migration 006) — read/written by
  -- services/notifications.js, services/supabase.js, server.js, and the
  -- dashboard's settings whitelist.
  notification_email           text,
  notification_phone           text,
  notifications_enabled        boolean DEFAULT true,
  -- Per-business voice selection (migration 015) — see lib/voice/session.js
  -- resolveVoice() and config/voices.js VOICE_CATALOG.
  voice_provider               text DEFAULT 'elevenlabs',
  voice_id                     text,
  -- Caller-facing SMS follow-ups (migration 017) — see
  -- services/notifications.js sendCallerSms(). Opt-in per business.
  sms_followup_enabled         boolean DEFAULT false,
  sms_templates                jsonb DEFAULT '{}'::jsonb,
  created_at                   timestamptz DEFAULT now()
);

-- 2. Users (dashboard users per business)
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email       text UNIQUE NOT NULL,
  full_name   text,
  role        text DEFAULT 'staff',
  -- The identity provider's account id (Identity Platform localId), migration
  -- 035. NOT `id` above: that is this system's own staff identifier, generated
  -- here and written into the PHI audit trail. The two were the same string
  -- under Supabase Auth only because it issued uuids. Nullable until the user
  -- import backfills existing rows.
  auth_uid    text,
  created_at  timestamptz DEFAULT now()
);

-- Nullable + UNIQUE: many NULLs are allowed, which is what lets rows predating
-- Identity Platform coexist with new ones. It is also the duplicate guard in
-- app_create_business_for_user, because a unique index is not subject to row
-- visibility and an unscoped SELECT under FORCE RLS is.
CREATE UNIQUE INDEX IF NOT EXISTS users_auth_uid_key ON users (auth_uid);

-- 3. Calls (one row per phone call)
CREATE TABLE calls (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  twilio_call_sid  text UNIQUE NOT NULL,
  caller_number    text,
  twilio_number    text,
  status           text NOT NULL DEFAULT 'in-progress',
  started_at       timestamptz DEFAULT now(),
  ended_at         timestamptz,
  duration_seconds int,
  summary          text,
  sentiment        text,
  outcome          text,
  -- Per-call turn-latency rollup (migration 017), written from server.js's
  -- /twilio/status handler using lib/voice/metrics.js getCallStats().
  avg_turn_latency_ms int,
  p95_turn_latency_ms int
);

-- 4. Call transcripts (conversation turns)
CREATE TABLE call_transcripts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id    uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  speaker    text NOT NULL,
  message    text NOT NULL,
  sequence   int  NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 5. Appointments
-- (service_id below is a plain nullable uuid with no FK — the "services"
-- table this originally referenced was dropped, unused, in migration 018;
-- see that file. The column itself is kept since services/supabase.js's
-- createAppointment() still writes to it (always null in practice — no
-- caller ever passes a serviceId; the service type is a free-text field
-- folded into notes instead).)
CREATE TABLE appointments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_id      uuid REFERENCES calls(id) ON DELETE SET NULL,
  service_id   uuid,
  client_name  text,
  client_phone text,
  scheduled_at timestamptz NOT NULL,
  status       text DEFAULT 'scheduled',
  notes        text,
  google_event_id text,        -- 021: set once pushed to Google Calendar; NULL = unsynced (dedup key)
  synced_at    timestamptz,    -- 021: when it was pushed to the connected calendar
  created_at   timestamptz DEFAULT now()
);

-- 6. Customer requests (messages, callbacks, etc.)
CREATE TABLE customer_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_id         uuid REFERENCES calls(id) ON DELETE SET NULL,
  request_type    text NOT NULL,
  caller_name     text,
  callback_number text,
  message         text,
  preferred_time  text,
  notes           text,
  created_at      timestamptz DEFAULT now()
);

-- 7. Business knowledge (Q&A pairs injected into AI prompt)
CREATE TABLE business_knowledge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  question    text NOT NULL,
  answer      text NOT NULL,
  category    text,
  priority    int DEFAULT 0,
  enabled     boolean DEFAULT true,
  created_at  timestamptz DEFAULT now()
);

-- 8. Integrations (per-business: webhooks, athenahealth, mcp)
CREATE TABLE integrations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider    text NOT NULL,
  name        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  config      jsonb NOT NULL DEFAULT '{}',
  -- migration 027. NULL means no Business Associate Agreement is recorded for
  -- this endpoint's operator, which blocks dispatch in DEPLOYMENT_MODE=hipaa.
  -- A record that one was asserted, not evidence that one exists.
  baa_recorded_at timestamptz,
  baa_reference   text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  UNIQUE(business_id, name)
);

-- The first question an audit asks is "which integrations are uncovered?".
-- Partial: the rows that matter are the NULLs.
CREATE INDEX idx_integrations_no_baa ON integrations (business_id) WHERE baa_recorded_at IS NULL;

-- "Which tenants require covered handling" is the first question an audit asks.
CREATE INDEX idx_businesses_hipaa_tier ON businesses (id) WHERE compliance_tier = 'hipaa';

-- 9. Calendar connections (per-business OAuth tokens; migration 016)
-- INERT since A1.1 deleted Google Calendar sync. Nothing reads or writes these
-- rows. Kept because migrations are append-only history: dropping the table
-- would rewrite the past to remove four columns nobody pays for.
CREATE TABLE calendar_connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  enabled       boolean NOT NULL DEFAULT true,
  updated_at    timestamptz DEFAULT now(),
  UNIQUE (business_id, provider)
);

-- Migration 019: single-use server-side OAuth `state` nonces. The connect
-- flow must never derive identity from the (unauthenticated) callback's
-- request input — the authenticated initiate route records the business the
-- nonce was issued for here, and the callback consumes the row and trusts
-- only business_id below.
CREATE TABLE oauth_states (
  state       text PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     uuid,
  provider    text NOT NULL,
  created_at  timestamptz DEFAULT now(),
  consumed_at timestamptz
);

-- Migration 020: per-business capability configuration. Replaces
-- businesses.allowed_tasks as the source of truth for what a business can do
-- and how it does it — allowed_tasks could say THAT a business books
-- appointments, never HOW, and could not express "does not do appointments"
-- at all.
CREATE TABLE business_capabilities (
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  capability_id  text NOT NULL,
  enabled        boolean NOT NULL DEFAULT true,
  adapter        text,
  adapter_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, capability_id)
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX idx_calls_business_started ON calls (business_id, started_at DESC);
CREATE INDEX idx_transcripts_call ON call_transcripts (call_id);
CREATE INDEX idx_appointments_business_scheduled ON appointments (business_id, scheduled_at);
-- Migration 008: speeds up listAppointmentsByCaller (business + status filter).
CREATE INDEX idx_appointments_business_status ON appointments (business_id, status);
CREATE INDEX idx_customer_requests_business_created ON customer_requests (business_id, created_at DESC);
CREATE INDEX idx_business_knowledge_business_enabled ON business_knowledge (business_id, enabled, priority DESC);
CREATE INDEX idx_integrations_business ON integrations (business_id);
CREATE INDEX idx_integrations_business_enabled ON integrations (business_id, enabled) WHERE enabled = true;
CREATE INDEX idx_calendar_connections_business ON calendar_connections (business_id);
-- Migration 019: supports periodic cleanup of expired/consumed OAuth nonces.
CREATE INDEX idx_oauth_states_created_at ON oauth_states (created_at);
-- Migration 020: capability lookup is on the hot path — every call loads it.
CREATE INDEX idx_business_capabilities_business ON business_capabilities (business_id);
-- Migration 021: the calendar sync worker's hot query is "unsynced upcoming
-- appointments for this business"; this partial index keeps it cheap.
CREATE INDEX idx_appointments_unsynced ON appointments (business_id, scheduled_at) WHERE google_event_id IS NULL;
-- Migration 026: tenant-scoped read of a caller's appointments. Not unique —
-- the last-10-digit suffix match is applied in the application, so this serves
-- the business_id scoping rather than the phone comparison itself.
CREATE INDEX idx_appointments_business_client_phone ON appointments (business_id, client_phone);
-- Migration 024: phone_number is the tenant-routing key — lookupBusinessByPhone
-- matches Twilio's `To` against it on every inbound call. Two businesses sharing
-- a number means the caller reaches whichever row the planner happened to return.
-- Partial because onboarding creates the business row before a number is attached.
CREATE UNIQUE INDEX businesses_phone_number_unique ON businesses (phone_number) WHERE phone_number IS NOT NULL;

-- ============================================================
-- Phone-number normalization (migration 024)
-- ============================================================
-- Numbers are edited by hand in the Supabase table editor, which renders a text
-- column as a multi-line textarea and saves a pasted newline verbatim. Every
-- hand-entered business was stored as "\n+442079460958", which the equality
-- match in lookupBusinessByPhone could never find — so those businesses answered
-- with the generic "our office" config instead of their own. The same damage
-- silently breaks <Dial> transfers and notification SMS.
--
-- The trigger is the only layer that can defend a hand-edit, because it bypasses
-- every application-level validator. Keep in step with lib/phone.js and
-- AI-phone-dashboard/backend/src/phone.js.
CREATE OR REPLACE FUNCTION normalize_phone_value(v text)
RETURNS text AS $$
DECLARE
  s text;
BEGIN
  IF v IS NULL THEN
    RETURN NULL;
  END IF;
  s := regexp_replace(v, '[[:space:]]', '', 'g');
  s := translate(s, E'()./ ​‌‍﻿‐‑‒–—―−-', '');
  IF s = '' THEN
    RETURN NULL;
  END IF;
  IF left(s, 2) = '00' THEN
    s := '+' || substr(s, 3);
  END IF;
  RETURN s;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION businesses_normalize_phones()
RETURNS trigger AS $$
BEGIN
  NEW.phone_number          := normalize_phone_value(NEW.phone_number);
  NEW.transfer_phone_number := normalize_phone_value(NEW.transfer_phone_number);
  NEW.main_phone            := normalize_phone_value(NEW.main_phone);
  NEW.notification_phone    := normalize_phone_value(NEW.notification_phone);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS businesses_normalize_phones_trg ON businesses;

CREATE TRIGGER businesses_normalize_phones_trg
  BEFORE INSERT OR UPDATE OF phone_number, transfer_phone_number, main_phone, notification_phone
  ON businesses
  FOR EACH ROW
  EXECUTE FUNCTION businesses_normalize_phones();

-- Migration 026: the same defence for appointments.client_phone, which is the
-- column the caller-appointment lookup reads. NOT unique — many appointments
-- legitimately share a number (a returning caller, a family, an office
-- landline), so a duplicate here is the normal case rather than a conflict.
CREATE OR REPLACE FUNCTION appointments_normalize_phones()
RETURNS trigger AS $$
BEGIN
  NEW.client_phone := normalize_phone_value(NEW.client_phone);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointments_normalize_phones_trg ON appointments;

CREATE TRIGGER appointments_normalize_phones_trg
  BEFORE INSERT OR UPDATE OF client_phone
  ON appointments
  FOR EACH ROW
  EXECUTE FUNCTION appointments_normalize_phones();

-- Double-booking is prevented by the create_appointment_if_available function
-- (migration 022), not a unique index: per-business slot capacity and
-- appointment length cannot be expressed by any static constraint. Migration
-- 009's exact-timestamp unique index was dropped there because it wrongly blocked
-- capacity > 1. Every internal booking goes through the function, which counts
-- overlaps under a per-slot advisory lock and inserts only if there is room.
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
  PERFORM pg_advisory_xact_lock(hashtext(p_business_id::text || p_scheduled_at::text)::bigint);

  IF COALESCE(p_length_min, 0) <= 0 THEN
    SELECT count(*) INTO v_overlap
    FROM appointments
    WHERE business_id = p_business_id AND status = 'scheduled'
      AND scheduled_at = p_scheduled_at;
  ELSE
    SELECT count(*) INTO v_overlap
    FROM appointments
    WHERE business_id = p_business_id AND status = 'scheduled'
      AND scheduled_at > p_scheduled_at - make_interval(mins => p_length_min)
      AND scheduled_at < p_scheduled_at + make_interval(mins => p_length_min);
  END IF;

  IF v_overlap >= v_capacity THEN
    RETURN NULL;
  END IF;

  INSERT INTO appointments (business_id, call_id, client_name, client_phone, scheduled_at, notes)
  VALUES (p_business_id, p_call_id, p_client_name, p_client_phone, p_scheduled_at, p_notes)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;


-- ============================================================
-- 14. Row-level security (migration 029)
-- ============================================================
-- Folded in here because this file is the fully-migrated state and a fresh
-- install runs ONLY this file. RLS living solely in the migration would mean a
-- new database has tenant isolation on paper and not in the schema, which is
-- the precise failure mode the header of this file warns about — and the worst
-- possible one to get wrong, since everything would appear to work.
--
-- The reasoning behind every choice below is in
-- database/029_row_level_security.sql and is not repeated.
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

-- Routing only: dialled number -> tenant. NO row-level security, and NOT
-- granted to vetra_app — only the SECURITY DEFINER function below reads it.
--
-- It exists because a tenant cannot be discovered through a policy that
-- requires the tenant. SECURITY DEFINER alone does not solve that here: the
-- policies are FORCE, which applies to the table owner too, and a BYPASSRLS
-- owner is unavailable on Cloud SQL (only `cloudsqladmin` has it). See
-- migration 033.
--
-- MUST NEVER carry anything beyond a phone number and a business id.
CREATE TABLE IF NOT EXISTS business_directory (
  phone_number text PRIMARY KEY,
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS business_directory_business_id_idx
  ON business_directory (business_id);

REVOKE ALL ON business_directory FROM PUBLIC;

-- A routing table that drifts is worse than none: a stale row sends a caller to
-- the wrong tenant, a missing row sends them to voicemail.
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

-- Routing only: verified login address -> tenant. The same shape as
-- business_directory and for the same reason, one bootstrap along: `users` is
-- FORCE RLS on `business_id = app_current_business_id()`, and the business_id
-- is the very thing an authenticating request is trying to discover. NO
-- row-level security, NOT granted to vetra_app. See migration 034.
--
-- MUST NEVER carry anything beyond an email and a business id.
CREATE TABLE IF NOT EXISTS user_directory (
  email       text PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS user_directory_business_id_idx
  ON user_directory (business_id);

REVOKE ALL ON user_directory FROM PUBLIC;

-- A stale row here is the serious direction: it would resolve somebody's login
-- to an employer they have left, which is a cross-tenant read with a valid
-- session behind it. A missing row only locks somebody out.
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

  -- Adopt the discovered tenant only when the caller has not declared one.
  -- Never repoint a transaction that already knows which tenant it serves.
  IF v_current IS NULL OR v_current = '' THEN
    PERFORM set_config('app.business_id', v_id::text, true);
  END IF;

  RETURN QUERY SELECT * FROM businesses WHERE id = v_id;
END;
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

-- Reads user_directory, adopts the tenant it finds, and only then reads `users`
-- — so the read SATISFIES the policy rather than bypassing it. The plain
-- SELECT this replaced returned ZERO rows on Cloud SQL, which meant every
-- authenticated request resolved to no business and 403'd. Migration 034.
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

-- ============================================================
-- Migration 030: PHI-access audit logging — §164.312(b)
-- ============================================================
-- §164.312(b) "Audit controls" is a REQUIRED implementation specification, not
-- an addressable one: "implement hardware, software, and/or procedural
-- mechanisms that record and examine activity in information systems that
-- contain or use electronic protected health information."
--
-- Nothing in this system did. lib/logger.js records EVENTS — a call started, a
-- tool ran, a notification dropped. None of that answers the question an audit
-- control exists to answer, which is: WHO read WHICH patient's data, and WHEN.
--
-- ------------------------------------------------------------
-- 1. What is recorded, and what is deliberately not
-- ------------------------------------------------------------
-- Who (actor_id + actor_type), what (operations + resources + resource_ids),
-- when (occurred_at), and which tenant (business_id).
--
-- NOT the protected health information itself. No phone number, no caller name,
-- no transcript, no summary. Row IDs instead, on the same reasoning
-- middleware/requireBusinessAccess.js already applies when it logs `userId`
-- rather than `email`: an id resolves to a person THROUGH the database rather
-- than through the log, so the trail stays useful to an investigator with
-- database access and useless to anyone who only has the logs.
--
-- This is the single worst place in the system to leak PHI into. It is designed
-- to be retained longest and read by the most people — auditors, counsel,
-- incident responders — so services/db.js REFUSES a PHI-typed key here rather
-- than redacting it. Redaction would make a leak survivable; refusal makes it
-- impossible to write in the first place.
--
-- ------------------------------------------------------------
-- 2. Why there is no foreign key on business_id
-- ------------------------------------------------------------
-- The obvious `REFERENCES businesses(id) ON DELETE CASCADE` would mean that
-- deleting a tenant deletes the record of everything ever done to that tenant's
-- patient data. An audit trail a DELETE can cascade away is not an audit trail.
-- ON DELETE RESTRICT is no better: it makes offboarding a clinic impossible.
--
-- So business_id is recorded as a VALUE, not a reference. It resolves while the
-- tenant exists and stops resolving afterwards, which is the correct behaviour:
-- the trail outlives the tenancy, as HIPAA's six-year documentation retention
-- expects it to.
--
-- ------------------------------------------------------------
-- 3. Append-only, with two independent locks
-- ------------------------------------------------------------
-- Migration 029 granted vetra_app SELECT/INSERT/UPDATE/DELETE on all tables AND
-- set ALTER DEFAULT PRIVILEGES to hand the same four to every FUTURE table. So
-- this table is writable-and-erasable by the application the instant it is
-- created, silently, by a decision made in a different file. That is exactly
-- the kind of inherited permission nobody re-reads, so it is revoked here
-- explicitly and loudly.
--
-- Two locks, because either one alone is one edit away from gone:
--
--   a. Table privileges: SELECT + INSERT granted, UPDATE/DELETE/TRUNCATE
--      revoked.
--   b. RLS policies: a SELECT policy and an INSERT policy exist. There is NO
--      UPDATE policy and NO DELETE policy, so even a role that somehow held the
--      privilege matches zero rows.
--
-- Neither substitutes for the real answer to "a compromised project cannot
-- erase its own trail" — that is the copy Cloud Run ships to stdout, which
-- lands in the vetra-logging project's sink (B0w) under different IAM. This
-- table is the QUERYABLE copy; the log sink is the DURABLE one. They fail
-- independently, which is the property worth having.
-- ============================================================

CREATE TABLE IF NOT EXISTS phi_access_log (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  business_id   uuid NOT NULL,

  -- WHO. §164.312(a)(2)(i) requires unique user identification, and an audit
  -- trail that cannot name a unique actor does not satisfy §164.312(b) either.
  --   user   a staff member acting through the dashboard  -> users.id
  --   voice  the receptionist acting during a call        -> the Twilio call SID
  --   system a background job with no human behind it     -> null
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'voice', 'system')),
  actor_id      text,

  -- WHAT. The strongest action taken in the unit of work, ordered
  -- read < write < export < erase, plus every data-layer operation that ran.
  -- One row describes one unit of work rather than one statement: a statement
  -- has no subject and a pickup would emit dozens.
  action        text NOT NULL CHECK (action IN ('read', 'write', 'export', 'erase')),
  operations    text[] NOT NULL,
  resources     text[] NOT NULL,

  -- WHICH RECORDS. Capped by the writer; row_count stays authoritative, so a
  -- truncated id list reads as "200 rows, here are the first 100" rather than
  -- as "100 rows".
  resource_ids  uuid[],
  row_count     integer NOT NULL DEFAULT 0,

  -- Correlation back to the rest of the logs. Neither is PHI: a request id is
  -- random, and a call SID resolves to a person only through the database —
  -- the same judgement lib/phiFields.js already records for callSid.
  request_id    text,
  call_sid      text
);

COMMENT ON TABLE phi_access_log IS
  'HIPAA 164.312(b) audit controls. One row per unit of work that touched PHI. Append-only for the application role. Carries identifiers, never protected health information.';

-- "Show me this tenant's access trail, most recent first" — the accounting a
-- covered entity asks its business associate for.
CREATE INDEX IF NOT EXISTS idx_phi_access_business_time
  ON phi_access_log (business_id, occurred_at DESC);

-- "What did this user access?" — the question asked after a workforce incident.
CREATE INDEX IF NOT EXISTS idx_phi_access_actor_time
  ON phi_access_log (actor_id, occurred_at DESC);

-- "Who accessed THIS record?" — the question §164.312(b) exists for, and the
-- one that is unanswerable without an index on the id array.
CREATE INDEX IF NOT EXISTS idx_phi_access_resource_ids
  ON phi_access_log USING gin (resource_ids);

-- ------------------------------------------------------------
-- Lock 1: table privileges
-- ------------------------------------------------------------
-- The REVOKE is the load-bearing half. Migration 029's ALTER DEFAULT PRIVILEGES
-- has already granted UPDATE and DELETE on this table by the time these lines
-- run.
GRANT SELECT, INSERT ON phi_access_log TO vetra_app;
REVOKE UPDATE, DELETE, TRUNCATE ON phi_access_log FROM vetra_app;
GRANT USAGE, SELECT ON SEQUENCE phi_access_log_id_seq TO vetra_app;

-- ------------------------------------------------------------
-- Lock 2: row-level security
-- ------------------------------------------------------------
ALTER TABLE phi_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE phi_access_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_read ON phi_access_log;
DROP POLICY IF EXISTS tenant_append ON phi_access_log;

-- A tenant may read its own trail. That is a feature, not a concession: the
-- clinic is the covered entity and we are the business associate, so an
-- accounting of who touched their patients' records is theirs to see.
CREATE POLICY tenant_read ON phi_access_log
  FOR SELECT USING (business_id = app_current_business_id());

-- A tenant may add to its own trail, and cannot forge another tenant's.
CREATE POLICY tenant_append ON phi_access_log
  FOR INSERT WITH CHECK (business_id = app_current_business_id());

-- Deliberately absent: any policy FOR UPDATE or FOR DELETE. Their absence is
-- the lock. Adding one later should require explaining, in writing, why an
-- audit record needs to change after the fact.

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
  p_auth_uid text,
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
  IF p_auth_uid IS NULL OR btrim(p_auth_uid) = ''
     OR p_email IS NULL OR p_name IS NULL OR p_timezone IS NULL THEN
    RAISE EXCEPTION 'app_create_business_for_user: all arguments are required';
  END IF;

  -- Become the tenant being created, for the length of this transaction only.
  PERFORM set_config('app.business_id', v_id::text, true);

  -- Explicit id, because the policy compares against it. Letting the DEFAULT
  -- generate one is exactly what made 031 unsatisfiable.
  INSERT INTO businesses (id, name, timezone)
  VALUES (v_id, p_name, p_timezone)
  RETURNING * INTO v_business;

  -- THE DUPLICATE GUARD. On the auth account, not on users.id — the staff row's
  -- id is generated here and could never collide, so keying the guard on it
  -- after the retype would have meant no guard at all while still looking like
  -- one.
  --
  -- ON CONFLICT rather than a SELECT: `users` is under FORCE row-level security
  -- and an unscoped SELECT returns no rows for a user who definitely exists,
  -- so the guard would silently stop firing in the case it exists for. A unique
  -- index is not subject to visibility. DO NOTHING rather than DO UPDATE:
  -- updating is what 031's header describes as silently repointing an account
  -- at a newer tenant and stranding the previous one.
  INSERT INTO users (email, business_id, auth_uid)
  VALUES (p_email, v_id, p_auth_uid)
  ON CONFLICT DO NOTHING;

  IF NOT FOUND THEN
    -- Rolls back the business inserted moments ago, so a refused call leaves
    -- nothing behind. Covers BOTH unique indexes: the auth account already has
    -- a staff row, or the email address is already taken by another account.
    RAISE EXCEPTION 'app_create_business_for_user: this account or email already belongs to a business'
      USING ERRCODE = '23505';
  END IF;

  -- Hand the caller back the scope it arrived with. COALESCE because
  -- current_setting(..., true) returns NULL when unset and set_config wants a
  -- string; '' is what app_current_business_id() already treats as unset.
  PERFORM set_config('app.business_id', COALESCE(v_previous, ''), true);

  RETURN v_business;
END;
$$;

COMMENT ON FUNCTION app_create_business_for_user(text, text, text, text) IS
  'Bootstrap: creates a tenant and attaches the signing-up AUTH ACCOUNT to it. Takes the identity provider''s id as text — Identity Platform''s is not a uuid, and the previous uuid signature typechecked only because Supabase Auth happened to issue uuids. SECURITY DEFINER is not sufficient on its own because migration 029 uses FORCE ROW LEVEL SECURITY, so this generates the business id first and adopts it as the transaction-local tenant, making the insert satisfy the policy rather than bypass it. Restores the caller''s previous scope before returning.';

REVOKE ALL ON FUNCTION app_create_business_for_user(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_create_business_for_user(text, text, text, text) TO vetra_app;

-- ------------------------------------------------------------
-- The other half: reading a business the caller has just been told they own
-- ------------------------------------------------------------
-- GET /api/me answers "which business is this, and does it need onboarding" —
-- and the businesses read inside it CAN be scoped, because by then
-- app_lookup_user_by_email has already produced the tenant id. No new function
-- is needed for it; the route simply has to open a scope. Recorded here so the
-- next person does not add a third definer function for a read that does not
-- need one.
