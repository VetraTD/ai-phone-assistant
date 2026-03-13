-- ============================================================
-- Migration 007: Integrations table for per-business integrations
-- Run this in the Supabase SQL Editor.
-- ============================================================
-- Supports custom webhooks (v1) and future first-party connectors
-- (athenahealth, mcp). provider = 'webhook' for custom integrations;
-- config shape depends on provider.
-- ============================================================

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

CREATE INDEX idx_integrations_business ON integrations(business_id);
CREATE INDEX idx_integrations_business_enabled ON integrations(business_id, enabled) WHERE enabled = true;

COMMENT ON TABLE integrations IS 'Per-business integrations: webhooks (custom), athenahealth, mcp (future).';
COMMENT ON COLUMN integrations.provider IS 'webhook | athenahealth | mcp. For webhook: config has url, method, headers, params_schema, description.';
COMMENT ON COLUMN integrations.name IS 'Tool name exposed to AI (e.g. get_caller_appointments). Must be unique per business.';
COMMENT ON COLUMN integrations.config IS 'Provider-specific config. webhook: { url, method, headers?, params_schema?, description? }.';
