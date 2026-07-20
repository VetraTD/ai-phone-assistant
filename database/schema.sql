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

-- Partial unique index (migration 009): a business cannot hold two
-- 'scheduled' appointments at the same instant. Cancelled/completed rows do
-- not block the slot from being reused. services/tools.js's book_appointment
-- catches the resulting Postgres 23505 to tell the caller the slot is no
-- longer available — WITHOUT this index, concurrent double-bookings both
-- succeed silently.
CREATE UNIQUE INDEX uniq_appointments_business_scheduled_at_active
  ON appointments (business_id, scheduled_at)
  WHERE status = 'scheduled';
