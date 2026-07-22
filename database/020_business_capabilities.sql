-- Migration 020: per-business capability configuration
--
-- Replaces businesses.allowed_tasks as the source of truth for what a business
-- can do and how it does it. allowed_tasks was a flat list of enabled module
-- names: it could say THAT a business books appointments, never HOW, so two
-- businesses could not book differently without a code change.
--
-- Each row is one capability for one business:
--   enabled        -- explicitly on or off. This is the fix for the defect
--                     where services/supabase.js normalizeAllowedTasks treated
--                     an empty allowed_tasks array and an unset one
--                     identically, both defaulting to ["book_appointment"].
--                     There was therefore NO representable state meaning "this
--                     business does not do appointments", which made every
--                     non-appointment business unexpressible.
--   adapter        -- which backend this capability reads and writes
--                     (internal DB, athenahealth, a webhook, ...). Swapping it
--                     must not change the prompt.
--   adapter_config -- settings for that backend. Credentials stay in the
--                     integrations table; this holds the non-secret bits.
--   config         -- the capability's own settings: the enforced `require`
--                     block, and the free-text `notes` that go into the prompt.
--                     Validated against each pack's configSchema at load time.
--
-- Core capabilities (messages, transfer) get no rows: they are always on and
-- cannot be disabled, so a row could only ever express something untrue.

CREATE TABLE IF NOT EXISTS business_capabilities (
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

CREATE INDEX IF NOT EXISTS idx_business_capabilities_business
  ON business_capabilities (business_id);

COMMENT ON TABLE business_capabilities IS
  'Per-business capability configuration. capability_id matches a pack id in capabilities/ (appointments, quotes, directions, forms, general_question). Core packs (messages, transfer) are always on and are not stored here.';
COMMENT ON COLUMN business_capabilities.config IS
  'Capability settings: require{} (enforced in code by lib/capabilities/requirements.js) and notes (prose, injected into the prompt, NOT enforced).';

-- ---------------------------------------------------------------------------
-- Backfill
--
-- Deliberately reproduces each business's CURRENT effective behavior rather
-- than the corrected semantics, so running this migration changes no live call.
-- That means a business whose allowed_tasks is NULL or [] is backfilled as
-- having appointments enabled, because that is what normalizeAllowedTasks does
-- for it today. The corrected empty-vs-unset distinction applies to
-- configuration made from here on, through this table.
-- ---------------------------------------------------------------------------

WITH effective AS (
  SELECT
    b.id AS business_id,
    CASE
      WHEN b.allowed_tasks IS NULL OR jsonb_array_length(b.allowed_tasks) = 0
        THEN '["book_appointment"]'::jsonb
      ELSE b.allowed_tasks
    END AS tasks
  FROM businesses b
),
expanded AS (
  SELECT
    e.business_id,
    CASE
      -- The legacy "appointments" bundle expands to the three modules, all of
      -- which map to the single appointments capability.
      WHEN t IN ('book_appointment', 'check_appointment', 'cancel_reschedule', 'appointments')
        THEN 'appointments'
      WHEN t = 'quote_request'         THEN 'quotes'
      WHEN t = 'directions_location'   THEN 'directions'
      WHEN t = 'form_document_request' THEN 'forms'
      WHEN t = 'general_question'      THEN 'general_question'
      ELSE NULL
    END AS capability_id
  FROM effective e, jsonb_array_elements_text(e.tasks) AS t
)
INSERT INTO business_capabilities (business_id, capability_id, enabled)
SELECT DISTINCT business_id, capability_id, true
FROM expanded
WHERE capability_id IS NOT NULL
ON CONFLICT (business_id, capability_id) DO NOTHING;

-- The appointments capability inherits whichever scheduling backend the
-- business already had, so the adapter column is true from the first read
-- rather than after someone remembers to set it.
UPDATE business_capabilities bc
SET adapter = 'athenahealth'
WHERE bc.capability_id = 'appointments'
  AND bc.adapter IS NULL
  AND EXISTS (
    SELECT 1 FROM integrations i
    WHERE i.business_id = bc.business_id
      AND i.provider = 'athenahealth'
      AND i.enabled
  );

UPDATE business_capabilities
SET adapter = 'internal'
WHERE capability_id = 'appointments' AND adapter IS NULL;

-- ---------------------------------------------------------------------------
-- businesses.allowed_tasks is NOT dropped here.
--
-- services/supabase.js dual-reads for one release: it uses these rows when a
-- business has any, and falls back to allowed_tasks when it has none. A partial
-- deploy — new code against an un-migrated database, or migrated rows read by
-- old code — must not silently disable a business's capabilities mid-call.
-- Drop the column in a later migration, once every environment is on this one.
-- ---------------------------------------------------------------------------
