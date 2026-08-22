-- ============================================================
-- Migration 027: record the BAA behind a tenant webhook
-- ============================================================
-- A `webhook` integration posts the tool's arguments and the caller's phone
-- number to a URL the tenant chose. In a HIPAA deployment that is a disclosure
-- of PHI to a third party, and a disclosure to a third party is exactly what a
-- Business Associate Agreement exists to authorise. There was nowhere to record
-- whether one existed, so there was no way for the code to refuse.
--
-- Two columns, on `integrations` rather than on `businesses`, because the
-- agreement is with the operator of THAT endpoint. One tenant can have a
-- covered webhook and an uncovered one, and the covered one should keep working.
--
-- What this deliberately does NOT do:
--
--   * It does not verify anything. A timestamp in a database is a record that
--     somebody asserted a BAA exists, not evidence that it does. The value is
--     that it makes the assertion explicit, attributable and auditable — and
--     that the absence of one is now a refusal instead of a silent send.
--
--   * It does not backfill. Every existing row gets NULL, which means every
--     existing webhook stops dispatching the moment a stack runs in `hipaa`
--     mode. That is the correct direction to fail: an unrecorded BAA is
--     indistinguishable from no BAA, and there are no live HIPAA tenants today,
--     so the cost of failing closed is zero and the cost of failing open is a
--     reportable disclosure.
--
--   * It changes NOTHING in `standard` mode. Existing deployments are
--     unaffected; the gate is mode-scoped in integrations/webhook.js.
-- ============================================================

ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS baa_recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS baa_reference   text;

COMMENT ON COLUMN integrations.baa_recorded_at IS
  'When a Business Associate Agreement with the operator of this endpoint was recorded. NULL means none is recorded, which blocks dispatch in DEPLOYMENT_MODE=hipaa. Not proof of a BAA — a record that one was asserted.';

COMMENT ON COLUMN integrations.baa_reference IS
  'Human-readable pointer to the agreement: counterparty, contract reference, or document location. Free text on purpose — it is read by a person during an audit, not by the code.';

-- Finding every uncovered integration is the first question an audit asks, and
-- it is the query the dashboard will want too. Partial, because the rows that
-- matter are the NULLs and they are expected to be the minority over time.
CREATE INDEX IF NOT EXISTS idx_integrations_no_baa
  ON integrations (business_id)
  WHERE baa_recorded_at IS NULL;
