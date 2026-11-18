-- Migration 018: drop the unused `services` table
--
-- Grepped both apps (root + AI-phone-dashboard/backend and /frontend) for
-- any reference to a `services` DB table (`.from("services")`, `FROM
-- services`, etc.) — none found. `appointments.service_id` (FK ->
-- services.id) is written by services/supabase.js's createAppointment(),
-- but its only caller (services/tools.js) never passes a serviceId, so the
-- column is always null in practice. Booking instead stores a free-text
-- service_type in the appointment's notes (see lib/voice/session.js /
-- lib/mediaStream.js appointmentArgs handling) — the `services` table was
-- an earlier design that was abandoned without ever being wired up.
--
-- appointments.service_id already ON DELETE SET NULL — dropping the table
-- alone would leave a dangling FK error, so drop the constraint first. This
-- does NOT touch the appointments table's rows or any other column; only
-- the always-null service_id FK enforcement goes away.

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_service_id_fkey;

DROP TABLE IF EXISTS services;
