-- ============================================================
-- AI Phone Assistant — Multi-Tenant Schema
-- Run this in the Supabase SQL Editor to create all tables.
-- ============================================================

-- 1. Businesses (tenant root + per-business config)
CREATE TABLE businesses (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                         text NOT NULL,
  phone_number                 text,
  timezone                     text DEFAULT 'America/Chicago',
  greeting                     text,
  business_hours               jsonb DEFAULT '{"open_time":"09:00","close_time":"17:00"}',
  transfer_phone_number        text,
  allowed_tasks                jsonb DEFAULT '["book_appointment","general_question"]',
  voice_style                  text,
  main_phone                   text,
  general_info                 text,
  address_line1                text,
  address_line2                text,
  city                         text,
  state_region                 text,
  postal_code                  text,
  country                      text,
  -- Phase 6: overhaul columns
  business_summary             text,
  recording_disclosure_enabled boolean DEFAULT false,
  recording_disclosure_text    text,
  off_limits_topics            jsonb,
  after_hours_policy           text DEFAULT 'take_message',
  escalation_message           text,
  booking_policy               text,
  transfer_policy              text DEFAULT 'always',
  staff_names                  jsonb,
  service_area                 text,
  services                     jsonb,
  languages_spoken             jsonb DEFAULT '["en"]',
  booking_url                  text,
  caller_data_policy           text,
  custom_instructions          text,
  tts_voice                    text,
  barge_in                     boolean DEFAULT false,
  google_tts_voice             text,
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
  outcome          text
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

-- 5. Services (service types a business offers)
CREATE TABLE services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name             text NOT NULL,
  duration_minutes int DEFAULT 30,
  active           boolean DEFAULT true,
  created_at       timestamptz DEFAULT now()
);

-- 6. Appointments
CREATE TABLE appointments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_id      uuid REFERENCES calls(id) ON DELETE SET NULL,
  service_id   uuid REFERENCES services(id) ON DELETE SET NULL,
  client_name  text,
  client_phone text,
  scheduled_at timestamptz NOT NULL,
  status       text DEFAULT 'scheduled',
  notes        text,
  created_at   timestamptz DEFAULT now()
);

-- 7. Customer requests (messages, callbacks, etc.)
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

-- 8. Business knowledge (Q&A pairs injected into AI prompt)
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

-- 9. Integrations (per-business: webhooks, athenahealth, mcp)
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

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX idx_calls_business_started ON calls (business_id, started_at DESC);
CREATE INDEX idx_transcripts_call ON call_transcripts (call_id);
CREATE INDEX idx_appointments_business_scheduled ON appointments (business_id, scheduled_at);
CREATE INDEX idx_customer_requests_business_created ON customer_requests (business_id, created_at DESC);
CREATE INDEX idx_business_knowledge_business_enabled ON business_knowledge (business_id, enabled, priority DESC);
CREATE INDEX idx_integrations_business ON integrations (business_id);
CREATE INDEX idx_integrations_business_enabled ON integrations (business_id, enabled) WHERE enabled = true;
