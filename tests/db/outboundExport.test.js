// tests/db/outboundExport.test.js
/**
 * S4-3 B: Art. 15 export (services/db.js exportCallerData) covers the outbound
 * tables the Art. 17 erasure already covers, on real Postgres, as vetra_app
 * (NOBYPASSRLS) under withTenant -- the same rigor as
 * tests/db/outboundErasure.test.js, whose seeding this file mirrors.
 *
 * Also the drift guard: every table eraseCallerData touches must be exported
 * (or explicitly listed as not exported, with a reason), and every column of
 * the outbound tables must appear in the export or in NOT_EXPORTED with a
 * reason. A new personal-data column or table that erasure learns about and
 * export does not turns this red.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const HERE = path.dirname(fileURLToPath(import.meta.url));

const BUSINESS = "0e0e5500-0000-4000-8000-0000000000e1";
const OTHER_BUSINESS = "0e0e5500-0000-4000-8000-0000000000e2";
const SUBJECT = "+447700900777";
const BYSTANDER = "+447700900778";
const HASH_KEY = "vitest-db-suite-fixed-suppression-hash-key-32chars-min";

let admin, db;

async function seed(business, phone, name) {
  const camp = await admin.query(
    `INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
     VALUES ($1,'export-camp','speed_to_lead','solicited','business','active',1) RETURNING id`,
    [business]
  );
  const campaignId = camp.rows[0].id;
  await admin.query(
    `INSERT INTO campaign_versions (campaign_id, business_id, version, config) VALUES ($1,$2,1,$3)`,
    [campaignId, business, JSON.stringify({ retries: { schedule: ["+0m"] } })]
  );
  const con = await admin.query(
    `INSERT INTO contacts (business_id, phone_e164, first_name, last_name, email, timezone, external_ids, attributes)
     VALUES ($1,$2,$3,$4,$5,'Europe/London',$6,$7) RETURNING id`,
    [
      business,
      phone,
      name,
      `${name}Last`,
      `${name.toLowerCase()}@example.com`,
      JSON.stringify({ crm_id: `crm-${name}` }),
      JSON.stringify({ note: `${name}'s attribute` }),
    ]
  );
  const contactId = con.rows[0].id;
  await admin.query(
    `INSERT INTO consents (business_id,contact_id,purpose,channels,covers_automated,source,wording_text,captured_at)
     VALUES ($1,$2,'enquiry_followup','{call}',true,'manual',$3,now())`,
    [business, contactId, `${name} agreed to a call`]
  );
  const out = await admin.query(
    `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,details,idempotency_key)
     VALUES ($1,$2,1,$3,'dialing',$4,$5,$6) RETURNING id`,
    [
      business,
      campaignId,
      contactId,
      JSON.stringify({ source: "webhook", data: { situation: `${name}'s boiler is broken` } }),
      JSON.stringify({ topic_detail: `${name}'s enquiry` }),
      `export-${phone}`,
    ]
  );
  const outreachId = out.rows[0].id;
  const att = await admin.query(
    `INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,dialed_at,opener_audio,voicemail_audio,transfer_miss_audio)
     VALUES ($1,$2,1,'+441372656055',$3,now(),'\\x01'::bytea,'\\x02'::bytea,'\\x03'::bytea) RETURNING id`,
    [business, outreachId, phone]
  );
  const attemptId = att.rows[0].id;
  const call = await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status, summary, answers,
                        direction, campaign_id, campaign_version, outreach_id, attempt_id, contact_id, outcome_code)
     VALUES ($1,$2,$3,'completed',$4,$5,'outbound',$6,1,$7,$8,$9,'interested') RETURNING id`,
    [
      business,
      `CA-export-${name}`,
      phone,
      `Spoke with ${name}.`,
      JSON.stringify({ clinic_name: `${name}'s clinic` }),
      campaignId,
      outreachId,
      attemptId,
      contactId,
    ]
  );
  const callId = call.rows[0].id;
  await admin.query(`INSERT INTO call_transcripts (call_id, speaker, message, sequence) VALUES ($1,'caller',$2,1)`, [callId, `${name} speaking`]);
  await admin.query(
    `INSERT INTO appointments (business_id, call_id, client_name, client_phone, scheduled_at, notes) VALUES ($1,$2,$3,$4,now(),'n')`,
    [business, callId, name, phone]
  );
  await admin.query(
    `INSERT INTO customer_requests (business_id, call_id, request_type, caller_name, callback_number, message) VALUES ($1,$2,'message',$3,$4,'m')`,
    [business, callId, name, phone]
  );
  await admin.query(
    `INSERT INTO sms_consents (business_id, call_id, phone_number, granted, script, script_version) VALUES ($1,$2,$3,true,'s','t.1')`,
    [business, callId, phone]
  );
  const ep = await admin.query(
    `INSERT INTO webhook_endpoints (business_id, url, secret_ciphertext, events, active) VALUES ($1,'https://example.com/hook','\\x00','{}',true) RETURNING id`,
    [business]
  );
  const ob = await admin.query(
    `INSERT INTO outbox (business_id, kind, target_id, event_type, payload, idempotency_key, status)
     VALUES ($1,'webhook',$2,'call.completed',$3,$4,'pending') RETURNING id`,
    [
      business,
      ep.rows[0].id,
      JSON.stringify({ event: "call.completed", contact: { id: contactId, phone, first_name: name }, answers: { clinic_name: `${name}'s clinic` } }),
      `export-ob-${phone}`,
    ]
  );
  await admin.query(
    `INSERT INTO suppressions (business_id, phone_e164, reason, created_by) VALUES ($1,$2,'opted_out','tool')`,
    [business, phone]
  );
  return { contactId, outreachId, attemptId, callId, outboxId: ob.rows[0].id };
}

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);
  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
}, 40000);

afterAll(async () => {
  if (!admin) return;
  process.env.DATABASE_URL = url;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [BUSINESS, OTHER_BUSINESS]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
  await db?.close();
});

let subject, bystander, other;

beforeEach(async () => {
  if (!url) return;
  process.env.SUPPRESSION_HASH_KEY = HASH_KEY;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [BUSINESS, OTHER_BUSINESS]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Export Co'), ($2,'Other Export Co')`, [BUSINESS, OTHER_BUSINESS]);
  subject = await seed(BUSINESS, SUBJECT, "Jane");
  bystander = await seed(BUSINESS, BYSTANDER, "Bystander");
  other = await seed(OTHER_BUSINESS, SUBJECT, "OtherTenantJane");
});

const exportSubject = () => db.withTenant(BUSINESS, () => db.exportCallerData(BUSINESS, SUBJECT));

d("Art. 15 export reaches outbound calling's tables (S4-3)", () => {
  it("returns the subject's rows for every outbound table, and the old keys still", async () => {
    const data = await exportSubject();
    expect(data).not.toBeNull();
    for (const k of ["calls", "transcripts", "appointments", "customerRequests", "smsConsents"]) {
      expect(data[k], k).toHaveLength(1);
    }

    expect(data.contacts).toHaveLength(1);
    expect(data.contacts[0]).toMatchObject({
      id: subject.contactId,
      phone_e164: SUBJECT,
      first_name: "Jane",
      last_name: "JaneLast",
      email: "jane@example.com",
      timezone: "Europe/London",
      external_ids: { crm_id: "crm-Jane" },
      attributes: { note: "Jane's attribute" },
    });

    expect(data.consents).toHaveLength(1);
    expect(data.consents[0]).toMatchObject({ contact_id: subject.contactId, purpose: "enquiry_followup", wording_text: "Jane agreed to a call" });

    expect(data.outreach).toHaveLength(1);
    expect(data.outreach[0]).toMatchObject({
      id: subject.outreachId,
      state: "dialing",
      details: { topic_detail: "Jane's enquiry" },
      trigger: { source: "webhook", data: { situation: "Jane's boiler is broken" } },
    });

    expect(data.callAttempts).toHaveLength(1);
    expect(data.callAttempts[0]).toMatchObject({ id: subject.attemptId, to_number: SUBJECT, attempt_no: 1 });
    expect(data.callAttempts[0]).not.toHaveProperty("opener_audio");
    expect(data.callAttempts[0]).not.toHaveProperty("voicemail_audio");
    expect(data.callAttempts[0]).not.toHaveProperty("transfer_miss_audio");

    expect(data.suppressions).toHaveLength(1);
    expect(data.suppressions[0]).toMatchObject({ phone_e164: SUBJECT, reason: "opted_out", created_by: "tool" });

    expect(data.outbox).toHaveLength(1);
    expect(data.outbox[0]).toMatchObject({ id: subject.outboxId, status: "pending", kind: "webhook" });
    expect(data.outbox[0].payload.contact.first_name).toBe("Jane");
  });

  it("calls carry the outbound link columns and answers", async () => {
    const [call] = (await exportSubject()).calls;
    expect(call).toMatchObject({
      direction: "outbound",
      campaign_version: 1,
      outreach_id: subject.outreachId,
      attempt_id: subject.attemptId,
      contact_id: subject.contactId,
      outcome_code: "interested",
      answers: { clinic_name: "Jane's clinic" },
    });
    expect(call.campaign_id).toBeTruthy();
  });

  it("holds nothing of the bystander or of the same number at another tenant", async () => {
    const data = await exportSubject();
    const s = JSON.stringify(data);
    expect(s).not.toContain("Bystander");
    expect(s).not.toContain(BYSTANDER);
    expect(s).not.toContain("OtherTenantJane");
    expect(s).not.toContain(other.contactId);
    expect(s).not.toContain(other.outboxId);
    expect(s).not.toContain(bystander.contactId);
  });

  it("finds an ERASED subject's suppression by hash", async () => {
    await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));
    const data = await exportSubject();
    expect(data.suppressions).toHaveLength(1);
    expect(data.suppressions[0].phone_e164).toBeNull();
    expect(data.suppressions[0].phone_hash).toBe(createHmac("sha256", HASH_KEY).update(SUBJECT).digest("hex"));
    expect(data.suppressions[0].reason).toBe("opted_out");
  });

  it("throws (fails closed) when a hashed suppression exists and the key is missing", async () => {
    await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));
    delete process.env.SUPPRESSION_HASH_KEY;
    await expect(exportSubject()).rejects.toThrow(/SUPPRESSION_HASH_KEY/);
  });

  it("needs no hash key when the tenant has no erased suppression", async () => {
    delete process.env.SUPPRESSION_HASH_KEY;
    const data = await exportSubject();
    expect(data.suppressions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Drift guard.
// ---------------------------------------------------------------------------
d("export/erasure coverage drift guard", () => {
  // table -> key in the export result
  const EXPORT_KEY = {
    calls: "calls",
    call_transcripts: "transcripts",
    appointments: "appointments",
    customer_requests: "customerRequests",
    sms_consents: "smsConsents",
    contacts: "contacts",
    consents: "consents",
    outreach: "outreach",
    call_attempts: "callAttempts",
    suppressions: "suppressions",
    outbox: "outbox",
  };
  // Tables erase touches that export intentionally omits (none today).
  const TABLE_NOT_EXPORTED = {};

  // Columns of the checked tables that are intentionally absent from the
  // export, each with its reason.
  const NOT_EXPORTED = {
    calls: {
      business_id: "tenant scope, implicit in the request",
      avg_turn_latency_ms: "aggregate latency telemetry, not about the person",
      p95_turn_latency_ms: "aggregate latency telemetry, not about the person",
      handled_at: "when the business's staff dealt with the call's message (dashboard workflow), not about the caller",
      handled_by: "the staff account (or 'launch') that marked it done; staff data, not the caller's",
    },
    contacts: { business_id: "tenant scope, implicit in the request" },
    consents: { business_id: "tenant scope, implicit in the request" },
    outreach: {
      business_id: "tenant scope, implicit in the request",
      idempotency_key: "internal dedupe key derived from the trigger, not personal data",
    },
    call_attempts: {
      business_id: "tenant scope, implicit in the request",
      opener_audio: "synthesized agent script audio, not the subject's voice or data",
      voicemail_audio: "synthesized agent script audio, not the subject's voice or data",
      transfer_miss_audio: "synthesized agent script audio, not the subject's voice or data",
    },
    suppressions: { business_id: "tenant scope, implicit in the request" },
    outbox: {
      business_id: "tenant scope, implicit in the request",
      target_id: "the tenant's own webhook endpoint id, not about the subject",
      idempotency_key: "internal delivery dedupe key, not personal data",
    },
  };

  function eraseTables() {
    const src = fs.readFileSync(path.join(HERE, "..", "..", "services", "db.js"), "utf8");
    const start = src.indexOf("export async function eraseCallerData");
    const end = src.indexOf("// Tenant scoping (migration 029)", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const tables = new Set();
    // SQL only: UPDATE needs SET after the name, so prose ("touches itself") never matches.
    for (const re of [/DELETE FROM\s+([a-z_]+)/g, /UPDATE\s+([a-z_]+)\s+SET/g, /SELECT[^`]*?\bFROM\s+([a-z_]+)/g]) {
      for (const m of body.matchAll(re)) tables.add(m[1]);
    }
    return tables;
  }

  it("every table eraseCallerData touches is exported or explicitly listed as not exported", () => {
    const tables = eraseTables();
    // Sanity: the walk found the ones we know about (a broken regex must not pass by finding nothing).
    for (const t of ["calls", "contacts", "consents", "outreach", "call_attempts", "outbox", "suppressions", "call_transcripts"]) {
      expect(tables.has(t), `walk missed ${t}`).toBe(true);
    }
    const missing = [...tables].filter((t) => !(t in EXPORT_KEY) && !(t in TABLE_NOT_EXPORTED));
    expect(missing, `erasure touches these tables but export neither covers nor excuses them: ${missing.join(", ")}`).toEqual([]);
  });

  it("every column of each outbound table (and calls) is exported or listed in NOT_EXPORTED with a reason", async () => {
    const data = await exportSubject();
    const findings = [];
    for (const [table, excused] of Object.entries(NOT_EXPORTED)) {
      const rows = data[EXPORT_KEY[table]];
      expect(rows.length, `seeded ${table} row expected in the export`).toBeGreaterThan(0);
      const exported = new Set(Object.keys(rows[0]));
      const { rows: cols } = await admin.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
        [table]
      );
      const real = new Set(cols.map((c) => c.column_name));
      for (const c of real) if (!exported.has(c) && !(c in excused)) findings.push(`${table}.${c} is neither exported nor excused`);
      for (const c of Object.keys(excused)) if (!real.has(c)) findings.push(`${table}.${c} in NOT_EXPORTED does not exist`);
      for (const c of Object.keys(excused)) if (exported.has(c)) findings.push(`${table}.${c} is excused but IS exported`);
      for (const c of exported) if (!real.has(c)) findings.push(`${table}.${c} exported but not a real column`);
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });
});
