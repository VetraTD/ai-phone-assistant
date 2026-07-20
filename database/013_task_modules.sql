-- Migration 013: Task model — CORE (always-on) vs MODULES (opt-in)
--
-- Application code (services/supabase.js normalizeAllowedTasks) now splits
-- the task model in two:
--   CORE tasks    — general_question, take_message, callback_request,
--                   transfer_human. Always available on every call,
--                   regardless of business configuration. Not stored in
--                   businesses.allowed_tasks anymore — the app injects them
--                   unconditionally.
--   MODULE tasks  — book_appointment, check_appointment, cancel_reschedule,
--                   quote_request, directions_location, form_document_request.
--                   Opt-in per business; this is what allowed_tasks now
--                   stores.
--
-- This migration rewrites existing businesses.allowed_tasks rows to the new
-- modules-only shape:
--   - legacy "appointments" bundle expands to the three appointment modules
--   - legacy core entries (general_question, take_message, callback_request)
--     are dropped silently — they're implied by application code now
--   - remaining module entries are kept, deduped
--   - unrecognized entries are dropped

UPDATE businesses AS b
SET allowed_tasks = (
  SELECT COALESCE(jsonb_agg(DISTINCT task_name), '[]'::jsonb)
  FROM (
    SELECT unnest(
      CASE WHEN elem = 'appointments'
           THEN ARRAY['book_appointment', 'check_appointment', 'cancel_reschedule']
           ELSE ARRAY[elem]
      END
    ) AS task_name
    FROM jsonb_array_elements_text(COALESCE(b.allowed_tasks, '[]'::jsonb)) AS elem
  ) AS expanded
  WHERE task_name IN (
    'book_appointment',
    'check_appointment',
    'cancel_reschedule',
    'quote_request',
    'directions_location',
    'form_document_request'
  )
)
WHERE b.allowed_tasks IS NOT NULL;

-- New businesses (or rows with allowed_tasks left NULL) default to
-- ["book_appointment"] via normalizeAllowedTasks — update the column default
-- to match so a fresh row's default value is self-consistent with the new
-- modules-only model.
ALTER TABLE businesses
  ALTER COLUMN allowed_tasks SET DEFAULT '["book_appointment"]';

COMMENT ON COLUMN businesses.allowed_tasks IS 'JSON array of opt-in MODULE task keys only, e.g. ["book_appointment","check_appointment"]. Core tasks (general_question, take_message, callback_request, transfer via request_transfer) are always available and are not stored here — see services/supabase.js CORE_TASKS/MODULE_TASKS. NULL/empty = default ["book_appointment"].';
