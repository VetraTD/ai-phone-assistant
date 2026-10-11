-- ============================================================
-- Migration 052: batch 3 launch guards -- what happens when nobody answers a
-- transfer, and when a call was transferred.
--
-- businesses.transfer_no_answer: per-business choice, set by us through
-- scripts/set-business-config.js (no dashboard screen). 'take_message'
-- (default, ring 20 s, then the AI takes a message) or 'own_voicemail'
-- (ring 45 s so the business's own voicemail can pick up; if nothing answers,
-- fall back to the message). Owner decision 2026-10-10.
--
-- calls.transferred_at: stamped by markCallTransferred, first transfer wins.
-- Feeds the 30-AI-minute alert and, later, billing. NULL = never transferred.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. schema.sql carries both columns
-- inside the CREATE TABLE bodies (same unnamed inline CHECK, so Postgres
-- gives the same businesses_transfer_no_answer_check name in both).
-- ============================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS transfer_no_answer text NOT NULL DEFAULT 'take_message'
  CHECK (transfer_no_answer IN ('take_message', 'own_voicemail'));
ALTER TABLE calls ADD COLUMN IF NOT EXISTS transferred_at timestamptz;
