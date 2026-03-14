-- ============================================================
-- Migration 008: Index for listing appointments by business and status
-- ============================================================
-- Speeds up listAppointmentsByCaller(businessId, { clientPhone, clientName }).

CREATE INDEX IF NOT EXISTS idx_appointments_business_status
  ON appointments (business_id, status);
