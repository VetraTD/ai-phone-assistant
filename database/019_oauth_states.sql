-- Migration 019: oauth_states table
--
-- Security fix. The Google Calendar connect flow previously encoded the
-- business id directly into the OAuth `state` parameter (plain base64url,
-- unsigned). The OAuth callback is necessarily unauthenticated — Google
-- redirects the browser to it — so it trusted attacker-controllable input
-- for identity: forging another tenant's business id in `state` pointed that
-- tenant's calendar_connections row at an attacker-controlled Google account,
-- leaking every synced appointment's client name, phone and notes.
--
-- Identity now lives server-side. The authenticated initiate route mints an
-- opaque single-use nonce and stores it here alongside the business id it was
-- issued for; the callback looks the nonce up and uses the stored business_id,
-- never anything from the request.
--
-- Used by AI-phone-dashboard/backend/src/routes/calendar.js:
--   - INSERT INTO oauth_states (state, business_id, user_id, provider)
--     (GET /api/calendar/auth-url, authenticated)
--   - UPDATE oauth_states SET consumed_at = now() WHERE state = $1 AND
--     provider = $2 AND consumed_at IS NULL AND created_at > now() -
--     interval '10 minutes' RETURNING business_id
--     (GET /api/calendar/callback — atomic consume; zero rows means unknown,
--     replayed or expired state and the flow is rejected)

CREATE TABLE IF NOT EXISTS oauth_states (
  state       text PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     uuid,
  provider    text NOT NULL,
  created_at  timestamptz DEFAULT now(),
  consumed_at timestamptz
);

-- Supports periodic cleanup of expired/consumed nonces.
CREATE INDEX IF NOT EXISTS idx_oauth_states_created_at ON oauth_states (created_at);

COMMENT ON TABLE oauth_states IS 'Single-use server-side OAuth `state` nonces. The authenticated initiate route inserts a row; the unauthenticated callback consumes it and takes identity from business_id here — never from request input.';
COMMENT ON COLUMN oauth_states.state IS 'Opaque nonce (crypto.randomBytes(32), base64url). Carries no identity information itself.';
COMMENT ON COLUMN oauth_states.consumed_at IS 'Set when the callback redeems the nonce. A non-NULL value means any further use is a replay and must be rejected.';
