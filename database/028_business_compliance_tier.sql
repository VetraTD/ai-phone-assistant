-- ============================================================
-- Migration 028: per-tenant compliance tier
-- ============================================================
-- DEPLOYMENT_MODE says what the STACK is allowed to do. This says what a
-- particular tenant requires. They are different questions and they need
-- different answers, because a `standard` stack can legitimately host a tenant
-- who needs covered handling, and a `hipaa` stack hosts nothing else.
--
-- THE RULE, implemented in lib/compliance.js effectiveTier(): the STRICTER of
-- the two wins, always. A tenant row cannot relax the deployment.
--
-- That direction is the entire point. A row is data, and data is editable by
-- anyone with dashboard access — if a `standard` row could soften a `hipaa`
-- deployment, the compliance posture of the whole stack would be one UPDATE
-- statement away from gone. The reverse is allowed and useful: a `standard`
-- deployment hosting a `hipaa` tenant treats that tenant's calls as covered.
-- The ratchet only ever tightens.
--
-- DEFAULT 'standard', and NOT NULL, because a null tier is a question with no
-- answer and every read would have to invent one. Existing rows are US
-- businesses on a stack with no BAA-covered vendors configured, so 'standard'
-- is the accurate description of what they are today, not an assumption.
--
-- The spec's decision that "the US stack runs the HIPAA config for every US
-- tenant initially" is expressed by DEPLOYMENT_MODE=hipaa on that stack, not
-- by backfilling this column. Which is the point of having both: the stack's
-- posture is deployment configuration, the tenant's is a fact about the tenant.
-- ============================================================

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS compliance_tier text NOT NULL DEFAULT 'standard';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'businesses_compliance_tier_check'
  ) THEN
    ALTER TABLE businesses
      ADD CONSTRAINT businesses_compliance_tier_check
      CHECK (compliance_tier IN ('standard', 'hipaa'));
  END IF;
END $$;

COMMENT ON COLUMN businesses.compliance_tier IS
  'standard | hipaa. What THIS TENANT requires. The effective tier for a call is the stricter of this and DEPLOYMENT_MODE — a tenant row can tighten the stack''s posture, never relax it.';

-- Answering "which tenants require covered handling" is the first question an
-- audit asks. Partial, because hipaa rows are the minority on a mixed stack
-- and the whole index is then a handful of pages.
CREATE INDEX IF NOT EXISTS idx_businesses_hipaa_tier
  ON businesses (id)
  WHERE compliance_tier = 'hipaa';
