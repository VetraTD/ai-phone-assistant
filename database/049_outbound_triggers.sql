-- ============================================================
-- Migration 049: outbound -- S3-9, the leads-in link
-- (POST /v1/triggers/:triggerToken + per-person details)
-- ============================================================
-- Renumbered from the plan's 047: half 2 runs S3-6 (047, missing_goal) and
-- S3-11 (048, erasure) first, so this is 049.
--
-- Three additions:
--
--   campaigns.trigger_token_hash -- sha256(32 random bytes), hex. NULL until
--     `scripts/outbound-admin.js trigger-token-rotate` sets one; the raw
--     token is never stored, only the hash (services/db.js compares it in
--     constant time -- lib/outbound/triggerRoute.js's compareTokenHash).
--     A partial unique index (most campaigns have none) stops two campaigns
--     ever sharing one hash, which the directory's ON CONFLICT DO UPDATE
--     below would otherwise resolve by silently reassigning ownership.
--
--   campaign_trigger_directory + app_campaign_by_trigger_hash(hash) -- the
--     SAME no-RLS-directory-plus-SECURITY-DEFINER pattern migration 044 uses
--     (call_attempt_directory / app_outbound_attempt_by_call_sid): the route
--     resolves a hash to a tenant BEFORE the tenant is known, and FORCE RLS
--     binds a definer function's OWNER too (033), so a plain SELECT against
--     the RLS'd `campaigns` table would return nothing on Cloud SQL. Kept
--     true by a trigger on campaigns, revoked from vetra_app, holds ids and
--     the hash only -- never a phone number or a name.
--
--   outreach.details jsonb NOT NULL DEFAULT '{}' -- the per-person facts the
--     trigger body's `data` carries, filtered to the campaign's
--     `details_fields` keys at write time (lib/outbound/triggerRoute.js).
--     Read by lib/outbound/callContext.js (resolveOutboundContext) onto
--     `ctx.outboundCall.details`, and rendered by lib/outbound/prompt.js
--     (S3-6) as `DETAILS: label: value` lines -- never in the opener or the
--     voicemail.
--
-- Idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS
-- throughout), so it can re-run over its own folded copy in schema.sql.

SET LOCAL lock_timeout = '5s';

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS trigger_token_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_trigger_token_hash_idx
  ON campaigns (trigger_token_hash) WHERE trigger_token_hash IS NOT NULL;

ALTER TABLE outreach ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS campaign_trigger_directory (
  trigger_token_hash text PRIMARY KEY,
  campaign_id        uuid NOT NULL,
  business_id        uuid NOT NULL
);

REVOKE ALL ON campaign_trigger_directory FROM PUBLIC;
REVOKE ALL ON campaign_trigger_directory FROM vetra_app;

COMMENT ON TABLE campaign_trigger_directory IS
  'Routing only: a campaign trigger token''s sha256 hash -> campaign and tenant, for POST /v1/triggers/:triggerToken (S3-9), before the tenant is known. Deliberately has NO row-level security and NO grant to vetra_app: only app_campaign_by_trigger_hash reads it, and a trigger on campaigns keeps it true. Holds ids and the hash only. Must never carry a phone number or a name.';

-- Keeping it true. SECURITY DEFINER because the writer (vetra_app, under RLS
-- on campaigns) has no rights on the directory. Fires on the one column that
-- decides membership (trigger_token_hash) and on DELETE, the same trigger
-- shape 044's app_sync_outbound_directories uses.
CREATE OR REPLACE FUNCTION app_sync_campaign_trigger_directory()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    IF OLD.trigger_token_hash IS NOT NULL THEN
      DELETE FROM campaign_trigger_directory WHERE trigger_token_hash = OLD.trigger_token_hash;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    IF NEW.trigger_token_hash IS NOT NULL THEN
      INSERT INTO campaign_trigger_directory (trigger_token_hash, campaign_id, business_id)
      VALUES (NEW.trigger_token_hash, NEW.id, NEW.business_id)
      ON CONFLICT (trigger_token_hash) DO UPDATE SET campaign_id = EXCLUDED.campaign_id, business_id = EXCLUDED.business_id;
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS campaign_trigger_directory_sync ON campaigns;
CREATE TRIGGER campaign_trigger_directory_sync
  AFTER INSERT OR UPDATE OF trigger_token_hash OR DELETE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION app_sync_campaign_trigger_directory();

-- The route's one entry point: hash in, tenant + campaign out, adopting the
-- scope for the rest of the transaction (the 033 rule -- never repoint a
-- caller that already knows its tenant). Returns the directory's own
-- trigger_token_hash too, so the route can re-verify the match in
-- application code with a constant-time comparator rather than trusting the
-- SQL equality alone (lib/outbound/triggerRoute.js's compareTokenHash).
CREATE OR REPLACE FUNCTION app_campaign_by_trigger_hash(p_hash text)
RETURNS TABLE (business_id uuid, campaign_id uuid, trigger_token_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_biz uuid;
  v_camp uuid;
  v_hash text;
  v_current text := current_setting('app.business_id', true);
BEGIN
  IF p_hash IS NULL OR btrim(p_hash) = '' THEN RETURN; END IF;
  SELECT d.business_id, d.campaign_id, d.trigger_token_hash INTO v_biz, v_camp, v_hash
    FROM campaign_trigger_directory d WHERE d.trigger_token_hash = btrim(p_hash);
  IF v_biz IS NULL THEN RETURN; END IF;
  IF v_current IS NULL OR v_current = '' THEN
    PERFORM set_config('app.business_id', v_biz::text, true);
  END IF;
  RETURN QUERY SELECT v_biz, v_camp, v_hash;
END $$;

REVOKE ALL ON FUNCTION app_campaign_by_trigger_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_campaign_by_trigger_hash(text) TO vetra_app;
