-- Migration 017: SMS follow-ups + per-call turn-latency rollup
--
-- Backs services/notifications.js's sendCallerSms() (caller-facing SMS
-- follow-ups: appointment confirmations, message-received acks, missed-call
-- text-back) and lib/voice/metrics.js's getCallStats() rollup, written from
-- server.js's /twilio/status handler.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS sms_followup_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_templates jsonb DEFAULT '{}'::jsonb;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS avg_turn_latency_ms integer,
  ADD COLUMN IF NOT EXISTS p95_turn_latency_ms integer;

COMMENT ON COLUMN businesses.sms_followup_enabled IS 'When true, the caller (not just the business owner) is texted follow-ups: appointment confirmations, message-received acks, and missed-call text-back. Off by default — opt-in per business.';
COMMENT ON COLUMN businesses.sms_templates IS 'Per-business overrides for caller SMS templates, keyed by kind (appointment_confirmation | message_received | missed_call). Missing keys fall back to the built-in default template for that kind.';
COMMENT ON COLUMN calls.avg_turn_latency_ms IS 'Average voice-to-voice turn latency (ms) for this call, computed from the in-process metrics ring buffer at call-end. Null if no turns were recorded (e.g. degraded-mode voicemail calls).';
COMMENT ON COLUMN calls.p95_turn_latency_ms IS 'p95 voice-to-voice turn latency (ms) for this call, computed from the in-process metrics ring buffer at call-end.';
