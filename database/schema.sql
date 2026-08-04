-- ============================================================
-- AI Phone Assistant — Multi-Tenant Schema
-- Run this in the Supabase SQL Editor to create all tables.
-- ============================================================
--
-- THIS FILE REPRESENTS THE FULLY-MIGRATED STATE (schema + every migration in
-- this directory, 002 through 018, already applied). A fresh install runs
-- ONLY this file and needs no migrations afterwards; the numbered migration
-- files exist solely to move an EXISTING database forward.
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
  created_at  timestamptz DEFAULT now()
);

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
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  UNIQUE(business_id, name)
);

-- 9. Calendar connections (per-business OAuth tokens; migration 016)
-- Backs the dashboard backend's Google Calendar integration
-- (AI-phone-dashboard/backend/src/routes/calendar.js). One row per
-- (business_id, provider).
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
