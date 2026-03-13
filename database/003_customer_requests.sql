-- ============================================================
-- Migration: Add customer_requests table (for take_message / callback_request)
-- Run this in the Supabase SQL Editor if the table does not exist.
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_id         uuid REFERENCES calls(id) ON DELETE SET NULL,
  request_type    text NOT NULL,
  caller_name     text,
  callback_number text,
  message         text,
  preferred_time  text,
  notes           text,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_requests_business_created
  ON customer_requests (business_id, created_at DESC);

COMMENT ON TABLE customer_requests IS 'Messages and callback requests recorded by the AI via record_customer_request tool.';
