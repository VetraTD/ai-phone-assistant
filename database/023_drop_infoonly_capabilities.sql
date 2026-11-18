-- ============================================================
-- Migration 023: drop the info-only capabilities
-- ============================================================
-- general_question, directions, and forms were prompt-only "capabilities" — a
-- business could toggle them off, but they contributed nothing except a
-- sentence in the receptionist's capabilities list. Answering general
-- questions, giving directions, and explaining forms are all answered from the
-- knowledge base / business info regardless, so these are now BASELINE behavior
-- in the engine (services/gemini.js), not configurable packs.
--
-- Removing the packs orphans their business_capabilities rows (applyCapabilityRows
-- logs capability_row_unknown for each). Worse, a general_question row with
-- enabled=false could strip general Q&A even though it is a CORE task. Delete
-- them.

DELETE FROM business_capabilities
 WHERE capability_id IN ('general_question', 'directions', 'forms');

-- The retired module tasks (directions_location, form_document_request) may
-- still sit in businesses.allowed_tasks. No cleanup is required: normalizeAllowedTasks
-- filters to the known MODULE_TASKS and silently drops anything else, so a stale
-- key is inert. Left in place to keep this migration a single safe statement.
