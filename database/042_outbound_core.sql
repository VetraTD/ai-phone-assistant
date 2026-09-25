-- ============================================================
-- Migration 042: outbound calling -- the tables (spec §6.1)
-- ============================================================
-- Nine tenant tables. All are ENABLE + FORCE row level security with the
-- 029 tenant_isolation idiom. SELECT, INSERT, UPDATE, DELETE are granted to
-- vetra_app EXPLICITLY at the end (the 030/037 precedent), not left to 029's
-- ALTER DEFAULT PRIVILEGES: those bind only objects created by the role that
-- ran 029, which is unproven for whichever role runs this on Cloud SQL.
--
-- Cross-tenant reads (the sweep, capacity, resolving a CallSid) do NOT happen
-- on these tables -- FORCE RLS binds a definer's owner too (033:8-31). They
-- go through the no-RLS directories of migration 044.

-- Fail fast instead of queueing inbound queries behind an ACCESS EXCLUSIVE wait; the migrate job is retried.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name             text NOT NULL,
  template_key     text NOT NULL CHECK (template_key IN ('speed_to_lead','missed_call_callback','reminder','no_show','aftercare','review_request','reactivation','custom')),
  compliance_class text NOT NULL CHECK (compliance_class IN ('solicited','service','marketing_consented')),
  audience         text NOT NULL CHECK (audience IN ('business','patient')),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  current_version  int  NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaigns_business_idx ON campaigns (business_id);

CREATE TABLE IF NOT EXISTS campaign_versions (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  version     int  NOT NULL,
  config      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, version)
);

CREATE TABLE IF NOT EXISTS contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone_e164   text NOT NULL,
  first_name   text,
  last_name    text,
  email        text,
  timezone     text,
  external_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, phone_e164)
);

CREATE TABLE IF NOT EXISTS consents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  purpose          text NOT NULL,
  channels         text[] NOT NULL DEFAULT '{}',
  covers_automated boolean NOT NULL DEFAULT false,
  source           text NOT NULL CHECK (source IN ('form','api','inbound_call','manual')),
  source_ref       text,
  wording_version  text,
  wording_text     text,
  captured_at      timestamptz NOT NULL,
  expires_at       timestamptz,
  revoked_at       timestamptz
);
CREATE INDEX IF NOT EXISTS consents_contact_idx ON consents (contact_id);

CREATE TABLE IF NOT EXISTS suppressions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone_e164     text NOT NULL,
  reason         text NOT NULL CHECK (reason IN ('opted_out','wrong_number','complaint','manual','tps')),
  source_call_id uuid,
  created_by     text NOT NULL CHECK (created_by IN ('tool','detector','dashboard','api')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, phone_e164)
);

CREATE TABLE IF NOT EXISTS outreach (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_version int  NOT NULL,
  contact_id       uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  state            text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','dialing','in_call','closed')),
  attempts_made    int  NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  last_attempt_at  timestamptz,
  hold_until       timestamptz,
  outcome          text,
  close_reason     text CHECK (close_reason IS NULL OR close_reason IN ('terminal_outcome','attempts_exhausted','give_up_window','consent_missing','consent_expired','consent_not_automated','suppressed','called_back','campaign_deleted','global_disabled','business_disabled','caller_id_invalid')),
  trigger          jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  UNIQUE (business_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS outreach_state_next_idx ON outreach (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS outreach_contact_idx ON outreach (contact_id);

CREATE TABLE IF NOT EXISTS call_attempts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  outreach_id           uuid NOT NULL REFERENCES outreach(id) ON DELETE CASCADE,
  attempt_no            int  NOT NULL,
  twilio_call_sid       text UNIQUE,
  from_number           text NOT NULL,
  to_number             text NOT NULL,
  dialed_at             timestamptz,
  answered_at           timestamptz,
  ended_at              timestamptz,
  twilio_status         text,
  answered_by           text CHECK (answered_by IS NULL OR answered_by IN ('human','machine_start','machine_end_beep','machine_end_silence','machine_end_other','fax','unknown')),
  amd_duration_ms       int,
  first_audio_ms        int,
  silent                boolean NOT NULL DEFAULT false,
  result                text CHECK (result IS NULL OR result IN ('no_answer','busy','failed','canceled','voicemail_left','voicemail_skipped','connected')),
  call_id               uuid REFERENCES calls(id) ON DELETE SET NULL,
  status_completed_at   timestamptz,
  session_finished_at   timestamptz,
  post_call_started_at  timestamptz,
  opener_audio          bytea,
  voicemail_audio       bytea,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outreach_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS call_attempts_to_number_idx ON call_attempts (to_number, dialed_at);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url               text NOT NULL CHECK (url LIKE 'https://%'),
  secret_ciphertext bytea NOT NULL,
  events            text[] NOT NULL DEFAULT '{}',
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('webhook','crm')),
  target_id       uuid NOT NULL,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','dead')),
  attempts        int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  UNIQUE (business_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS outbox_due_idx ON outbox (status, next_attempt_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaigns','campaign_versions','contacts','consents','suppressions','outreach','call_attempts','webhook_endpoints','outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (business_id = app_current_business_id()) WITH CHECK (business_id = app_current_business_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON campaigns, campaign_versions, contacts, consents, suppressions, outreach, call_attempts, webhook_endpoints, outbox TO vetra_app;
