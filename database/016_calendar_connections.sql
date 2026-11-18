-- Migration 016: calendar_connections table
--
-- Backs the dashboard backend's Google Calendar OAuth integration
-- (AI-phone-dashboard/backend/src/routes/calendar.js): stores per-business,
-- per-provider OAuth tokens used to create calendar events for booked
-- appointments. Columns match backend usage exactly:
--   - INSERT ... ON CONFLICT (business_id, provider) DO UPDATE (token
--     exchange callback)
--   - SELECT access_token, refresh_token, expires_at ... WHERE business_id =
--     $1 AND provider = 'google' AND enabled = true (token refresh / sync)
--   - DELETE ... WHERE business_id = $1 AND provider = 'google' (disconnect)

CREATE TABLE IF NOT EXISTS calendar_connections (
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

CREATE INDEX IF NOT EXISTS idx_calendar_connections_business ON calendar_connections (business_id);

COMMENT ON TABLE calendar_connections IS 'Per-business OAuth connections to external calendars (currently Google Calendar only). One row per (business_id, provider).';
COMMENT ON COLUMN calendar_connections.provider IS 'Calendar provider key, e.g. "google".';
COMMENT ON COLUMN calendar_connections.enabled IS 'When false, the connection is treated as disconnected even though tokens are retained.';
