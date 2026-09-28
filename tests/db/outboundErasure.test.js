// tests/db/outboundErasure.test.js
/**
 * S3-11, spec §13.5 amendment, P5: Art. 17 erasure (services/db.js's
 * eraseCallerData) reaches outbound calling's own tables, on real Postgres,
 * as vetra_app (NOBYPASSRLS) -- the same rigor tests/db/outboundSuppression.test.js
 * already holds insertSuppression to (memory unscoped-writes-now-fail-closed:
 * a tenantless write matches 0 rows and "succeeds").
 *
 * Covers:
 *   - consents deleted, contacts anonymised (first_name/attributes only),
 *     open outreach closed with close_reason='erased' (an ALREADY-closed
 *     outreach is left exactly as it was), call_attempts audio nulled --
 *     for the SUBJECT's contact only, at the SUBJECT's business only.
 *   - suppressions: the row survives, phone_e164 -> NULL, phone_hash set to
 *     HMAC-SHA256(SUPPRESSION_HASH_KEY, canonical E.164), matching what this
 *     file computes independently.
 *   - isSuppressed (the gate's do-not-call check) still refuses the SUBJECT
 *     after erasure, by hash alone -- named risk 2/3's own gate.
 *   - fail-closed (Ruling S3-11b): a missing/short SUPPRESSION_HASH_KEY, or a
 *     phone that cannot normalize to E.164, throws BEFORE any write reaches
 *     the database when a matching suppression row exists to hash -- proven
 *     by re-reading every row afterward and finding it unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { createHmac } from "node:crypto";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";

const BUSINESS = "0e0e5500-0000-4000-8000-000000000001";
const OTHER_BUSINESS = "0e0e5500-0000-4000-8000-000000000002";
const SUBJECT = "+447700900555";
const SUBJECT_NATIONAL = "07700900555"; // same number, no country code -- phoneMatch finds it, normalizePhoneNumber cannot
const BYSTANDER = "+447700900556";

const HASH_KEY = "vitest-db-suite-fixed-suppression-hash-key-32chars-min";
/** Independent of services/db.js's own suppressionHash -- what the test expects it to compute. */
function expectedHash(e164) {
  return createHmac("sha256", HASH_KEY).update(e164).digest("hex");
}

let admin, db;

async function seedContact(business, phone, name) {
  const camp = await admin.query(
    `INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
     VALUES ($1,'erasure-camp','speed_to_lead','solicited','business','active',1) RETURNING id`,
    [business]
  );
  const campaignId = camp.rows[0].id;
  await admin.query(
    `INSERT INTO campaign_versions (campaign_id, business_id, version, config) VALUES ($1,$2,1,$3)`,
    [campaignId, business, JSON.stringify({ retries: { schedule: ["+0m"] } })]
  );
  // I3 (review, controller ruling): last_name/email/timezone/external_ids
  // join first_name/attributes as personal fields this erasure must reach.
  const con = await admin.query(
    `INSERT INTO contacts (business_id, phone_e164, first_name, last_name, email, timezone, external_ids, attributes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      business,
      phone,
      name,
      `${name}Last`,
      `${name.toLowerCase()}@example.com`,
      "Europe/London",
      JSON.stringify({ crm_id: `crm-${name}` }),
      JSON.stringify({ note: `${name}'s attribute` }),
    ]
  );
  const contactId = con.rows[0].id;
  await admin.query(
    `INSERT INTO consents (business_id,contact_id,purpose,channels,covers_automated,source,captured_at)
     VALUES ($1,$2,'enquiry_followup','{call}',true,'manual',now())`,
    [business, contactId]
  );
  // The OPEN outreach this erasure must close. I3 (review): `details` and
  // `trigger.data` both carry the lead-form's own facts -- populated here so
  // the erasure test can prove they are actually cleared, not just the
  // pre-fix fields.
  const openTrigger = JSON.stringify({ source: "webhook", data: { situation: `${name}'s boiler is broken` } });
  const openDetails = JSON.stringify({ topic_detail: `${name}'s enquiry` });
  const openOut = await admin.query(
    `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,details,idempotency_key)
     VALUES ($1,$2,1,$3,'dialing',$4,$5,$6) RETURNING id`,
    [business, campaignId, contactId, openTrigger, openDetails, `erasure-open-${phone}`]
  );
  const openOutreachId = openOut.rows[0].id;
  await admin.query(
    `INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,dialed_at,opener_audio,voicemail_audio,transfer_miss_audio)
     VALUES ($1,$2,1,'+441372656055',$3,now(),'\\x01'::bytea,'\\x02'::bytea,'\\x03'::bytea)`,
    [business, openOutreachId, phone]
  );
  // An ALREADY-closed outreach -- erasure must leave close_reason/state
  // alone but STILL clear details/trigger.data (I3: the pre-fix code never
  // touched an already-closed row at all).
  const closedTrigger = JSON.stringify({ source: "webhook", data: { situation: `${name}'s old enquiry` } });
  const closedDetails = JSON.stringify({ topic_detail: `${name}'s old enquiry` });
  const closedOut = await admin.query(
    `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,details,idempotency_key,close_reason,closed_at)
     VALUES ($1,$2,1,$3,'closed',$4,$5,$6,'terminal_outcome',now()) RETURNING id`,
    [business, campaignId, contactId, closedTrigger, closedDetails, `erasure-closed-${phone}`]
  );
  // A calls row (I3): `answers` (S3-3/S3-10's qualification pack) is a PII
  // sink the pre-fix erasure never touched at all.
  await admin.query(
    `INSERT INTO calls (business_id, twilio_call_sid, caller_number, status, summary, answers)
     VALUES ($1,$2,$3,'completed',$4,$5)`,
    [
      business,
      `CA-erasure-${name}`,
      phone,
      `Spoke with ${name} about their enquiry.`,
      JSON.stringify({ clinic_name: `${name}'s clinic`, _outcome_note: `${name} said call back Tuesday` }),
    ]
  );

  // I4 (S3-8 fix round 1, controller ruling): one outbox row per status, a
  // FROZEN copy of this contact's phone/name/answers in `payload` -- the
  // exact shape lib/outbound/postCall.js's buildResultsPayload writes.
  const ep = await admin.query(
    `INSERT INTO webhook_endpoints (business_id, url, secret_ciphertext, events, active) VALUES ($1,'https://example.com/hook','\\x00','{}',true) RETURNING id`,
    [business]
  );
  const endpointId = ep.rows[0].id;
  const mkOutboxPayload = () =>
    JSON.stringify({
      event: "call.completed",
      contact: { id: contactId, phone, first_name: name, external_ids: { crm_id: "42" } },
      answers: { clinic_name: `${name}'s clinic` },
      summary: `Spoke with ${name} about rescheduling.`,
      direction: "outbound",
    });
  const outboxIds = {};
  for (const status of ["pending", "dead", "delivered"]) {
    const row = await admin.query(
      `INSERT INTO outbox (business_id, kind, target_id, event_type, payload, idempotency_key, status, attempts, next_attempt_at, delivered_at)
       VALUES ($1,'webhook',$2,'call.completed',$3,$4,$5,0,now(),CASE WHEN $5='delivered' THEN now() ELSE NULL END) RETURNING id`,
      [business, endpointId, mkOutboxPayload(), `erasure-ob-${status}-${phone}`, status]
    );
    outboxIds[status] = row.rows[0].id;
  }

  return { contactId, openOutreachId, closedOutreachId: closedOut.rows[0].id, outboxIds };
}

async function outboxRow(id) {
  return (await admin.query(`SELECT status, payload FROM outbox WHERE id = $1`, [id])).rows[0];
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

let subject, bystander, otherSubject;

beforeEach(async () => {
  if (!url) return;
  process.env.SUPPRESSION_HASH_KEY = HASH_KEY;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [BUSINESS, OTHER_BUSINESS]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, 'Erasure Co'), ($2, 'Other Erasure Co')`, [
    BUSINESS,
    OTHER_BUSINESS,
  ]);

  subject = await seedContact(BUSINESS, SUBJECT, "Jane");
  bystander = await seedContact(BUSINESS, BYSTANDER, "Bystander");
  otherSubject = await seedContact(OTHER_BUSINESS, SUBJECT, "SameNumberOtherTenant");

  await admin.query(
    `INSERT INTO suppressions (business_id, phone_e164, reason, created_by) VALUES ($1,$2,'opted_out','tool')`,
    [BUSINESS, SUBJECT]
  );
  await admin.query(
    `INSERT INTO suppressions (business_id, phone_e164, reason, created_by) VALUES ($1,$2,'wrong_number','tool')`,
    [BUSINESS, BYSTANDER]
  );
  await admin.query(
    `INSERT INTO suppressions (business_id, phone_e164, reason, created_by) VALUES ($1,$2,'opted_out','tool')`,
    [OTHER_BUSINESS, SUBJECT]
  );
});

async function contactRow(id) {
  return (
    await admin.query(`SELECT first_name, last_name, email, timezone, external_ids, attributes FROM contacts WHERE id = $1`, [id])
  ).rows[0];
}
async function outreachRow(id) {
  return (await admin.query(`SELECT state, close_reason, closed_at, details, trigger FROM outreach WHERE id = $1`, [id])).rows[0];
}
async function callRow(twilioCallSid) {
  return (await admin.query(`SELECT caller_number, summary, answers FROM calls WHERE twilio_call_sid = $1`, [twilioCallSid])).rows[0];
}
async function attemptAudio(outreachId) {
  return (await admin.query(
    `SELECT opener_audio, voicemail_audio, transfer_miss_audio FROM call_attempts WHERE outreach_id = $1`,
    [outreachId]
  )).rows[0];
}
/** An UNTOUCHED row -- still has its own phone_e164, no hash. */
async function suppressionByPhone(business, phone) {
  return (await admin.query(
    `SELECT phone_e164, phone_hash FROM suppressions WHERE business_id = $1 AND phone_e164 = $2`,
    [business, phone]
  )).rows;
}
/** The erased row for ONE business -- found by hash, since phone_e164 is gone. */
async function suppressionByHash(business) {
  return (await admin.query(
    `SELECT phone_e164, phone_hash FROM suppressions WHERE business_id = $1 AND phone_hash IS NOT NULL`,
    [business]
  )).rows;
}
async function consentCount(contactId) {
  return (await admin.query(`SELECT count(*)::int AS n FROM consents WHERE contact_id = $1`, [contactId])).rows[0].n;
}
/** The row seedContact(business, phone, name) writes -- matched against an UNTOUCHED contact. */
function seededContactRow(name) {
  return {
    first_name: name,
    last_name: `${name}Last`,
    email: `${name.toLowerCase()}@example.com`,
    timezone: "Europe/London",
    external_ids: { crm_id: `crm-${name}` },
    attributes: { note: `${name}'s attribute` },
  };
}

d("Art. 17 erasure reaches outbound calling's own tables (P5, S3-11)", () => {
  it("deletes consents, anonymises the contact, closes the OPEN outreach, nulls call_attempts audio -- for the subject only", async () => {
    const counts = await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));

    expect(counts.consents).toBe(1);
    expect(counts.contacts).toBe(1);
    // I3 (this wave): BOTH outreach rows now count -- the widened UPDATE
    // clears details/trigger on every one of the contact's rows, not just
    // the ones it is newly closing. The already-closed row is touched for
    // details/trigger but its close_reason stays 'terminal_outcome' (see
    // below).
    expect(counts.outreach).toBe(2);
    expect(counts.callAttempts).toBe(1);
    expect(counts.outbox).toBe(2); // pending + dead, deleted outright
    expect(counts.outboxRedacted).toBe(1); // delivered, kept and redacted
    expect(counts.suppressions).toBe(1);

    expect(await consentCount(subject.contactId)).toBe(0);
    // I3 (this wave): last_name/email/timezone/external_ids join
    // first_name/attributes.
    expect(await contactRow(subject.contactId)).toEqual({
      first_name: null,
      last_name: null,
      email: null,
      timezone: null,
      external_ids: {},
      attributes: {},
    });

    const open = await outreachRow(subject.openOutreachId);
    expect(open.state).toBe("closed");
    expect(open.close_reason).toBe("erased");
    expect(open.closed_at).not.toBeNull();
    // I3 (this wave): details cleared, trigger reduced to {source} -- the
    // lead-form's own facts (`data.situation`) are gone.
    expect(open.details).toEqual({});
    expect(open.trigger).toEqual({ source: "webhook" });

    // The already-closed row's state/close_reason is UNCHANGED -- erasure
    // must not overwrite an existing close_reason with 'erased' -- but I3
    // (this wave) its details/trigger ARE cleared, the fix's whole point.
    const alreadyClosed = await outreachRow(subject.closedOutreachId);
    expect(alreadyClosed.state).toBe("closed");
    expect(alreadyClosed.close_reason).toBe("terminal_outcome");
    expect(alreadyClosed.details).toEqual({});
    expect(alreadyClosed.trigger).toEqual({ source: "webhook" });

    const audio = await attemptAudio(subject.openOutreachId);
    expect(audio).toEqual({ opener_audio: null, voicemail_audio: null, transfer_miss_audio: null });

    // I3 (this wave): calls.answers -- the qualification pack's own PII
    // sink -- is nulled alongside caller_number/summary.
    const call = await callRow("CA-erasure-Jane");
    expect(call).toEqual({ caller_number: null, summary: null, answers: null });
  });

  it("keeps the suppression row, hashes the phone, nulls phone_e164 -- matching an independently computed hash", async () => {
    await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));

    const rows = await suppressionByHash(BUSINESS);
    expect(rows).toHaveLength(1); // the row survives -- not deleted
    expect(rows[0].phone_e164).toBeNull();
    expect(rows[0].phone_hash).toBe(expectedHash(SUBJECT));
  });

  it("the gate (isSuppressed) still refuses the erased number, by hash alone", async () => {
    await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));

    const stillSuppressed = await db.withTenant(BUSINESS, () => db.isSuppressed(SUBJECT));
    expect(stillSuppressed).toBe(true);
  });

  // S3-11 fix round 1 (review Important finding, services/db.js:2608): before
  // this fix, isSuppressed fell back to hashing the RAW phone when it could
  // not normalize to E.164, instead of throwing -- named risk 2's own failure
  // mode, on the READ side this time (eraseCallerData's write side already
  // threw). Once erased, this suppression is findable ONLY by hash (its
  // phone_e164 is NULL) -- so a non-canonical query phone can never compute
  // the matching hash, and the fixed function must throw rather than
  // silently answer "not suppressed" for a number that genuinely is.
  it("fail-closed (review Important finding): a non-canonical phone for a suppressed-BY-HASH contact throws, not silently reads not-suppressed", async () => {
    await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));

    // Before the fix this resolved to `false` (fail open, undetected) --
    // SUBJECT_NATIONAL cannot normalize, so the old `?? phone` fallback
    // hashed the raw string and never matched expectedHash(SUBJECT).
    await expect(db.withTenant(BUSINESS, () => db.isSuppressed(SUBJECT_NATIONAL))).rejects.toThrow();
  });

  it("does not touch another contact at the same business (BYSTANDER)", async () => {
    await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));

    expect(await contactRow(bystander.contactId)).toEqual(seededContactRow("Bystander"));
    expect(await consentCount(bystander.contactId)).toBe(1);
    const bystanderOpen = await outreachRow(bystander.openOutreachId);
    expect(bystanderOpen.state).toBe("dialing");
    // I3 (this wave): the bystander's own outreach.details/trigger untouched too.
    expect(bystanderOpen.details).toEqual({ topic_detail: "Bystander's enquiry" });
    expect(bystanderOpen.trigger).toEqual({ source: "webhook", data: { situation: "Bystander's boiler is broken" } });
    const rows = await suppressionByPhone(BUSINESS, BYSTANDER);
    expect(rows[0].phone_e164).toBe(BYSTANDER);
    expect(rows[0].phone_hash).toBeNull();
    // I4: the bystander's own outbox rows, all three statuses, untouched.
    for (const status of ["pending", "dead", "delivered"]) {
      const row = await outboxRow(bystander.outboxIds[status]);
      expect(row.status).toBe(status);
      expect(row.payload.contact.first_name).toBe("Bystander");
    }
  });

  it("does not touch the same number at another tenant (OTHER_BUSINESS) -- named risk 3", async () => {
    await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));

    expect(await contactRow(otherSubject.contactId)).toEqual(seededContactRow("SameNumberOtherTenant"));
    expect(await consentCount(otherSubject.contactId)).toBe(1);
    const otherOpen = await outreachRow(otherSubject.openOutreachId);
    expect(otherOpen.state).toBe("dialing");
    expect(otherOpen.details).toEqual({ topic_detail: "SameNumberOtherTenant's enquiry" });
    const rows = await suppressionByPhone(OTHER_BUSINESS, SUBJECT);
    expect(rows[0].phone_e164).toBe(SUBJECT);
    expect(rows[0].phone_hash).toBeNull();

    // And the reverse: erasing under BUSINESS's scope must not even find
    // OTHER_BUSINESS's row via isSuppressed on ITS own tenant scope.
    const otherStillHasPhone = await db.withTenant(OTHER_BUSINESS, () => db.isSuppressed(SUBJECT));
    expect(otherStillHasPhone).toBe(true); // unaffected -- still matches by phone_e164, not by hash
  });

  it("fail-closed (Ruling S3-11b): a missing SUPPRESSION_HASH_KEY throws, and NOTHING is written -- not even the tables that need no key", async () => {
    delete process.env.SUPPRESSION_HASH_KEY;
    try {
      await expect(db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT))).rejects.toThrow();
    } finally {
      process.env.SUPPRESSION_HASH_KEY = HASH_KEY;
    }

    // The whole transaction rolled back -- consents/contacts/outreach/audio
    // untouched too, not just the suppression row.
    expect(await consentCount(subject.contactId)).toBe(1);
    expect((await contactRow(subject.contactId)).first_name).toBe("Jane");
    expect((await outreachRow(subject.openOutreachId)).state).toBe("dialing");
    const rows = await suppressionByPhone(BUSINESS, SUBJECT);
    expect(rows[0].phone_e164).toBe(SUBJECT);
    expect(rows[0].phone_hash).toBeNull();
  });

  it("fail-closed: a too-short SUPPRESSION_HASH_KEY throws the same way", async () => {
    process.env.SUPPRESSION_HASH_KEY = "too-short";
    try {
      await expect(db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT))).rejects.toThrow(/SUPPRESSION_HASH_KEY/);
    } finally {
      process.env.SUPPRESSION_HASH_KEY = HASH_KEY;
    }
  });

  it("fail-closed: a phone that phoneMatch finds but cannot normalize to E.164 throws rather than hashing an unusable value", async () => {
    // SUBJECT_NATIONAL shares SUBJECT's last 10 digits (phoneMatch finds the
    // same suppression row) but carries no country code (normalizePhoneNumber
    // refuses to guess one, so it returns null) -- exactly named risk 2's
    // "hash computed on a non-normalised phone", caught before it can write.
    await expect(db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT_NATIONAL))).rejects.toThrow();

    const rows = await suppressionByPhone(BUSINESS, SUBJECT);
    expect(rows[0].phone_e164).toBe(SUBJECT); // untouched
    expect(rows[0].phone_hash).toBeNull();
  });

  it("an erasure for a phone with NO matching suppression row needs no key at all (does not regress ordinary inbound-only DSAR erasure)", async () => {
    delete process.env.SUPPRESSION_HASH_KEY;
    try {
      const counts = await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, "+447700900999"));
      expect(counts.suppressions).toBe(0);
    } finally {
      process.env.SUPPRESSION_HASH_KEY = HASH_KEY;
    }
  });

  it("is idempotent: erasing twice reports the second run's suppressions count as 0 (nothing left with phone_e164 set to re-match)", async () => {
    await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));
    const second = await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));
    expect(second.suppressions).toBe(0);
    // I3 (this wave): the outreach UPDATE no longer filters on
    // `state <> 'closed'` (it must reach an already-closed row's
    // details/trigger too), so BOTH rows still match the WHERE clause on a
    // replay -- Postgres counts a row as affected whenever it matches, even
    // when every assigned value equals what was already there. Idempotent
    // in EFFECT (content unchanged, asserted below), not in reported count.
    expect(second.outreach).toBe(2);
    const rows = await suppressionByHash(BUSINESS);
    expect(rows).toHaveLength(1); // still exactly one row -- never duplicated
    const open = await outreachRow(subject.openOutreachId);
    expect(open.details).toEqual({});
    expect(open.trigger).toEqual({ source: "webhook" });
    expect(open.close_reason).toBe("erased"); // unchanged by the replay
  });
});

// S3-8 fix round 1, I4 (controller ruling): outbox.payload carries a frozen
// copy of the contact's phone/name/answers -- erasure must reach it too.
d("Art. 17 erasure reaches outbox (S3-8 fix round 1, I4)", () => {
  it("a pending row is DELETED outright -- never delivered after erasure", async () => {
    const pendingId = subject.outboxIds.pending;
    await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));
    expect(await outboxRow(pendingId)).toBeUndefined();

    // The delivery route's own read confirms it too: getOutboxRow (tenant-
    // scoped, the same function lib/outbound/internalRoutes.js's
    // deliverOutboxRow calls first) finds nothing -- a "not_found" no-op,
    // never a delivery.
    const fresh = await db.withTenant(BUSINESS, () => db.getOutboxRow(pendingId));
    expect(fresh).toBeNull();
  });

  it("a dead row is also deleted outright", async () => {
    const deadId = subject.outboxIds.dead;
    await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));
    expect(await outboxRow(deadId)).toBeUndefined();
  });

  it("a delivered row is KEPT, but no personal field remains in its payload", async () => {
    const deliveredId = subject.outboxIds.delivered;
    await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));

    const row = await outboxRow(deliveredId);
    expect(row).toBeDefined();
    expect(row.status).toBe("delivered"); // kept, not deleted

    const p = row.payload;
    expect(p.contact.id).toBe(subject.contactId); // the opaque reference is kept
    expect(p.contact.phone).toBeNull();
    expect(p.contact.first_name).toBeNull();
    expect(p.contact.external_ids).toEqual({});
    expect(p.answers).toEqual({});
    expect(p.summary).toBeNull();
    // No personal field remains ANYWHERE in the redacted payload -- the
    // subject's own name/phone must not survive as a stray string either.
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("Jane");
    expect(serialized).not.toContain(SUBJECT);
  });

  it("the outbox_schedule routing row for a deleted (pending) outbox row is also gone (migration 050's trigger)", async () => {
    const pendingId = subject.outboxIds.pending;
    const before = (await admin.query(`SELECT 1 FROM outbox_schedule WHERE outbox_id = $1`, [pendingId])).rows;
    expect(before).toHaveLength(1); // seeded as pending -- the trigger put it there

    await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));

    const after = (await admin.query(`SELECT 1 FROM outbox_schedule WHERE outbox_id = $1`, [pendingId])).rows;
    expect(after).toHaveLength(0);
  });

  it("does not touch the same number's outbox rows at another tenant (OTHER_BUSINESS)", async () => {
    await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));

    const row = await outboxRow(otherSubject.outboxIds.pending);
    expect(row).toBeDefined(); // untouched -- different tenant
    expect(row.payload.contact.first_name).toBe("SameNumberOtherTenant");
  });
});

// ---------------------------------------------------------------------------
// E6 (review, I3's own fix direction): the schema-walking redaction-drift
// test. Rather than hardcoding "these are the columns erasure clears" --
// exactly the kind of list that went stale between S3-11 (P5 shipped first)
// and S3-9 (added outreach.details/trigger.data and never told P5 about it)
// -- this asks the DATABASE what text/jsonb columns actually exist on the
// four tables eraseCallerData touches, and fails if any column outside a
// small, DOCUMENTED allowlist still holds content for an erased subject. Add
// a new personal-data column to one of these tables without updating
// eraseCallerData (or without adding it to ALLOWED, if it is genuinely
// structural), and THIS test goes red.
// ---------------------------------------------------------------------------
d("E6: schema-walking redaction-drift test", () => {
  // Columns an erased row is ALLOWED to keep content in -- either structural
  // (an id, a status enum, a timestamp, a foreign key) or an explicit OWNER
  // decision (services/db.js's eraseCallerData file header: the cleartext
  // phone survives in contacts.phone_e164 and call_attempts.to_number on
  // purpose -- not changed by this wave; reported to the owner, not fixed).
  const ALLOWED = Object.freeze({
    contacts: new Set(["id", "business_id", "phone_e164", "created_at", "updated_at"]),
    outreach: new Set([
      "id", "business_id", "campaign_id", "campaign_version", "contact_id", "state",
      "attempts_made", "next_attempt_at", "last_attempt_at", "hold_until", "outcome",
      "close_reason", "idempotency_key", "created_at", "updated_at", "closed_at",
    ]),
    calls: new Set([
      "id", "business_id", "twilio_call_sid", "twilio_number", "status", "started_at",
      "ended_at", "duration_seconds", "sentiment", "outcome", "avg_turn_latency_ms",
      "p95_turn_latency_ms", "direction", "campaign_id", "campaign_version", "outreach_id",
      "attempt_id", "contact_id", "answered_by", "outcome_code",
    ]),
    call_attempts: new Set([
      "id", "business_id", "outreach_id", "attempt_no", "twilio_call_sid", "from_number",
      "to_number", "dialed_at", "answered_at", "ended_at", "twilio_status", "answered_by",
      "amd_duration_ms", "first_audio_ms", "silent", "result", "call_id",
      "status_completed_at", "session_finished_at", "post_call_started_at", "created_at",
    ]),
  });

  // A per-column exception to "must be fully empty": outreach.trigger is
  // reduced to `{source}`, not wiped to `{}` -- `source` (e.g. "webhook") is
  // not personal, and losing it would thin an already-thin audit trail
  // (spec §13.5) for no privacy gain. Any OTHER key surviving here (in
  // particular `data`, the whole posted lead-form payload) is still a leak.
  function isEmptyEnough(table, column, value) {
    if (value === null) return true;
    if (table === "outreach" && column === "trigger") {
      return typeof value === "object" && Object.keys(value).every((k) => k === "source");
    }
    if (typeof value === "object") return Object.keys(value).length === 0; // '{}'::jsonb
    return false;
  }

  async function textAndJsonColumns(table) {
    const { rows } = await admin.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
          AND data_type IN ('text', 'character varying', 'jsonb', 'json')`,
      [table]
    );
    return rows.map((r) => r.column_name);
  }

  it("no personal text/jsonb column outside the documented allowlist survives an erasure", async () => {
    await db.withTenant(BUSINESS, () => db.eraseCallerData(BUSINESS, SUBJECT));

    const rowsByTable = {
      contacts: (await admin.query(`SELECT * FROM contacts WHERE id = $1`, [subject.contactId])).rows,
      outreach: (await admin.query(`SELECT * FROM outreach WHERE contact_id = $1`, [subject.contactId])).rows,
      calls: (await admin.query(`SELECT * FROM calls WHERE twilio_call_sid = $1`, ["CA-erasure-Jane"])).rows,
      call_attempts: (await admin.query(`SELECT * FROM call_attempts WHERE outreach_id = $1`, [subject.openOutreachId])).rows,
    };

    const findings = [];
    for (const [table, allowed] of Object.entries(ALLOWED)) {
      const columns = await textAndJsonColumns(table);
      const rows = rowsByTable[table];
      expect(rows.length, `expected at least one seeded ${table} row for this subject`).toBeGreaterThan(0);
      for (const column of columns) {
        if (allowed.has(column)) continue;
        for (const row of rows) {
          if (!isEmptyEnough(table, column, row[column])) {
            findings.push(`${table}.${column} still holds content after erasure: ${JSON.stringify(row[column])}`);
          }
        }
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  it("the allowlist itself does not silently grow -- a column neither this test's own list nor a real table column is a typo, not a pass", async () => {
    // Guards the guard: if a column gets renamed/removed, ALLOWED above
    // would otherwise just silently stop matching anything and this test
    // would still pass (nothing to check is not the same as nothing found).
    for (const [table, allowed] of Object.entries(ALLOWED)) {
      const { rows } = await admin.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        [table]
      );
      const realColumns = new Set(rows.map((r) => r.column_name));
      for (const column of allowed) {
        expect(realColumns.has(column), `${table}.${column} (in ALLOWED) does not exist in the real schema`).toBe(true);
      }
    }
  });
});
