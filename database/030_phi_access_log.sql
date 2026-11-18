-- ============================================================
-- Migration 030: PHI-access audit logging — §164.312(b)
-- ============================================================
-- §164.312(b) "Audit controls" is a REQUIRED implementation specification, not
-- an addressable one: "implement hardware, software, and/or procedural
-- mechanisms that record and examine activity in information systems that
-- contain or use electronic protected health information."
--
-- Nothing in this system did. lib/logger.js records EVENTS — a call started, a
-- tool ran, a notification dropped. None of that answers the question an audit
-- control exists to answer, which is: WHO read WHICH patient's data, and WHEN.
--
-- ------------------------------------------------------------
-- 1. What is recorded, and what is deliberately not
-- ------------------------------------------------------------
-- Who (actor_id + actor_type), what (operations + resources + resource_ids),
-- when (occurred_at), and which tenant (business_id).
--
-- NOT the protected health information itself. No phone number, no caller name,
-- no transcript, no summary. Row IDs instead, on the same reasoning
-- middleware/requireBusinessAccess.js already applies when it logs `userId`
-- rather than `email`: an id resolves to a person THROUGH the database rather
-- than through the log, so the trail stays useful to an investigator with
-- database access and useless to anyone who only has the logs.
--
-- This is the single worst place in the system to leak PHI into. It is designed
-- to be retained longest and read by the most people — auditors, counsel,
-- incident responders — so services/db.js REFUSES a PHI-typed key here rather
-- than redacting it. Redaction would make a leak survivable; refusal makes it
-- impossible to write in the first place.
--
-- ------------------------------------------------------------
-- 2. Why there is no foreign key on business_id
-- ------------------------------------------------------------
-- The obvious `REFERENCES businesses(id) ON DELETE CASCADE` would mean that
-- deleting a tenant deletes the record of everything ever done to that tenant's
-- patient data. An audit trail a DELETE can cascade away is not an audit trail.
-- ON DELETE RESTRICT is no better: it makes offboarding a clinic impossible.
--
-- So business_id is recorded as a VALUE, not a reference. It resolves while the
-- tenant exists and stops resolving afterwards, which is the correct behaviour:
-- the trail outlives the tenancy, as HIPAA's six-year documentation retention
-- expects it to.
--
-- ------------------------------------------------------------
-- 3. Append-only, with two independent locks
-- ------------------------------------------------------------
-- Migration 029 granted vetra_app SELECT/INSERT/UPDATE/DELETE on all tables AND
-- set ALTER DEFAULT PRIVILEGES to hand the same four to every FUTURE table. So
-- this table is writable-and-erasable by the application the instant it is
-- created, silently, by a decision made in a different file. That is exactly
-- the kind of inherited permission nobody re-reads, so it is revoked here
-- explicitly and loudly.
--
-- Two locks, because either one alone is one edit away from gone:
--
--   a. Table privileges: SELECT + INSERT granted, UPDATE/DELETE/TRUNCATE
--      revoked.
--   b. RLS policies: a SELECT policy and an INSERT policy exist. There is NO
--      UPDATE policy and NO DELETE policy, so even a role that somehow held the
--      privilege matches zero rows.
--
-- Neither substitutes for the real answer to "a compromised project cannot
-- erase its own trail" — that is the copy Cloud Run ships to stdout, which
-- lands in the vetra-logging project's sink (B0w) under different IAM. This
-- table is the QUERYABLE copy; the log sink is the DURABLE one. They fail
-- independently, which is the property worth having.
-- ============================================================

CREATE TABLE IF NOT EXISTS phi_access_log (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  business_id   uuid NOT NULL,

  -- WHO. §164.312(a)(2)(i) requires unique user identification, and an audit
  -- trail that cannot name a unique actor does not satisfy §164.312(b) either.
  --   user   a staff member acting through the dashboard  -> users.id
  --   voice  the receptionist acting during a call        -> the Twilio call SID
  --   system a background job with no human behind it     -> null
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'voice', 'system')),
  actor_id      text,

  -- WHAT. The strongest action taken in the unit of work, ordered
  -- read < write < export < erase, plus every data-layer operation that ran.
  -- One row describes one unit of work rather than one statement: a statement
  -- has no subject and a pickup would emit dozens.
  action        text NOT NULL CHECK (action IN ('read', 'write', 'export', 'erase')),
  operations    text[] NOT NULL,
  resources     text[] NOT NULL,

  -- WHICH RECORDS. Capped by the writer; row_count stays authoritative, so a
  -- truncated id list reads as "200 rows, here are the first 100" rather than
  -- as "100 rows".
  resource_ids  uuid[],
  row_count     integer NOT NULL DEFAULT 0,

  -- Correlation back to the rest of the logs. Neither is PHI: a request id is
  -- random, and a call SID resolves to a person only through the database —
  -- the same judgement lib/phiFields.js already records for callSid.
  request_id    text,
  call_sid      text
);

COMMENT ON TABLE phi_access_log IS
  'HIPAA 164.312(b) audit controls. One row per unit of work that touched PHI. Append-only for the application role. Carries identifiers, never protected health information.';

-- "Show me this tenant's access trail, most recent first" — the accounting a
-- covered entity asks its business associate for.
CREATE INDEX IF NOT EXISTS idx_phi_access_business_time
  ON phi_access_log (business_id, occurred_at DESC);

-- "What did this user access?" — the question asked after a workforce incident.
CREATE INDEX IF NOT EXISTS idx_phi_access_actor_time
  ON phi_access_log (actor_id, occurred_at DESC);

-- "Who accessed THIS record?" — the question §164.312(b) exists for, and the
-- one that is unanswerable without an index on the id array.
CREATE INDEX IF NOT EXISTS idx_phi_access_resource_ids
  ON phi_access_log USING gin (resource_ids);

-- ------------------------------------------------------------
-- Lock 1: table privileges
-- ------------------------------------------------------------
-- The REVOKE is the load-bearing half. Migration 029's ALTER DEFAULT PRIVILEGES
-- has already granted UPDATE and DELETE on this table by the time these lines
-- run.
GRANT SELECT, INSERT ON phi_access_log TO vetra_app;
REVOKE UPDATE, DELETE, TRUNCATE ON phi_access_log FROM vetra_app;
GRANT USAGE, SELECT ON SEQUENCE phi_access_log_id_seq TO vetra_app;

-- ------------------------------------------------------------
-- Lock 2: row-level security
-- ------------------------------------------------------------
ALTER TABLE phi_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE phi_access_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_read ON phi_access_log;
DROP POLICY IF EXISTS tenant_append ON phi_access_log;

-- A tenant may read its own trail. That is a feature, not a concession: the
-- clinic is the covered entity and we are the business associate, so an
-- accounting of who touched their patients' records is theirs to see.
CREATE POLICY tenant_read ON phi_access_log
  FOR SELECT USING (business_id = app_current_business_id());

-- A tenant may add to its own trail, and cannot forge another tenant's.
CREATE POLICY tenant_append ON phi_access_log
  FOR INSERT WITH CHECK (business_id = app_current_business_id());

-- Deliberately absent: any policy FOR UPDATE or FOR DELETE. Their absence is
-- the lock. Adding one later should require explaining, in writing, why an
-- audit record needs to change after the fact.
