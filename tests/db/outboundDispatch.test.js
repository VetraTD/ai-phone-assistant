// tests/db/outboundDispatch.test.js
/**
 * G6: duplicate dispatch of the same task produces exactly ONE Twilio call.
 * Real Postgres, real services/db.js, as vetra_app (the smsConsent.test.js
 * idiom: vetra_app LOGIN for the run, DATABASE_URL set before import).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const BIZ = "0e0e0000-0000-4000-8000-000000000001";
let admin, db, createDispatcher, TEMPLATES, outreachId;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]);
  await admin.query(`INSERT INTO businesses (id, name, timezone, outbound_enabled) VALUES ($1,'Race','Europe/London',true)`, [BIZ]);
  ({ TEMPLATES } = await import("../../lib/outbound/templates.js"));
  const cfg = { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055",
    calling_window: { mon_fri: "08:00-21:00", sat: "08:00-21:00", sun: "08:00-21:00", outside_window: "queue" } };
  const c = await admin.query(`INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
                               VALUES ($1,'r','speed_to_lead','solicited','business','active',1) RETURNING id`, [BIZ]);
  await admin.query(`INSERT INTO campaign_versions (campaign_id,business_id,version,config) VALUES ($1,$2,1,$3)`, [c.rows[0].id, BIZ, cfg]);
  const k = await admin.query(`INSERT INTO contacts (business_id, phone_e164, first_name) VALUES ($1,'+447700900321','Sam') RETURNING id`, [BIZ]);
  await admin.query(`INSERT INTO consents (business_id,contact_id,purpose,channels,covers_automated,source,captured_at)
                     VALUES ($1,$2,'enquiry_followup','{call}',true,'manual',now())`, [BIZ, k.rows[0].id]);
  // next_attempt_at on the dispatcher's FIXED clock, not now(): dispatch skips
  // a row not yet due (fix C), and a real-clock now() is after 13:00:05Z on
  // 2026-09-28 from that day on -- every dispatch would be not_due.
  outreachId = (await admin.query(`INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,idempotency_key,next_attempt_at)
                                  VALUES ($1,$2,1,$3,'waiting','{}','race-1','2026-09-28T12:59:00Z') RETURNING id`, [BIZ, c.rows[0].id, k.rows[0].id])).rows[0].id;
  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
  ({ createDispatcher } = await import("../../lib/outbound/dispatch.js"));
});

afterAll(async () => {
  if (!admin) return;
  process.env.DATABASE_URL = url;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
});

d("G6: the double-dial lock under real concurrency", () => {
  it("ten concurrent dispatches of one outreach place exactly one call and write exactly one attempt", async () => {
    const create = vi.fn(async () => { await new Promise((r) => setTimeout(r, 50)); return { sid: `CArace${create.mock.calls.length}` }; });
    const dispatch = createDispatcher({
      db, twilio: { calls: { create } }, enqueue: async () => ({ created: true }),
      env: { enabled: false, allowlist: new Set(["+447700900321"]), maxConcurrent: 8, inboundReserve: 2, baseUrl: "https://svc.example" },
      // FIXED clock inside the 08:00-21:00 window. With `new Date()` this test
      // goes red every evening London time (outside_window -> zero dials).
      now: () => new Date("2026-09-28T13:00:00Z"), rand: () => 0,
      callerIdValid: async () => true, renderAudio: async () => null, log: { info() {}, error() {} },
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => dispatch({ businessId: BIZ, outreachId })));
    expect(create).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === "dialed")).toHaveLength(1);
    const attempts = await admin.query(`SELECT count(*)::int AS n FROM call_attempts WHERE outreach_id = $1`, [outreachId]);
    expect(attempts.rows[0].n).toBe(1);                           // the row actually landed (RLS-safe write)
    const o = await admin.query(`SELECT state, attempts_made FROM outreach WHERE id = $1`, [outreachId]);
    expect(o.rows[0]).toEqual({ state: "dialing", attempts_made: 1 });
  });
});

// The race above runs only the claim-and-dial half of the data layer. These
// run every other dispatcher write, and the read helpers, as vetra_app under
// FORCE RLS, and each one reads the row back through the admin client: a
// tenantless write matches zero rows and reports success, so "it did not
// throw" proves nothing on its own. Runs after G6, on the same business, with
// one contact per path so the paths cannot trip each other's daily cap.
d("the dispatcher's other paths land in real rows, as vetra_app", () => {
  const PHONES = {
    never: "+447700900401", paused: "+447700900402", failed: "+447700900403",
    busy: "+447700900404", placed: "+447700900405", due: "+447700900406",
    closedMid: "+447700900407", closedMid429: "+447700900408",
  };
  const FIXED = new Date("2026-09-28T13:00:00Z");
  const DUE = new Date("2026-09-28T12:59:00Z"); // due on the FIXED clock, whatever the real date
  let cfg;

  beforeAll(async () => {
    // Room for every path to reach the dial: G6 leaves one live attempt.
    await admin.query(`UPDATE businesses SET outbound_max_concurrent = 50 WHERE id = $1`, [BIZ]);
    cfg = { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055",
      calling_window: { mon_fri: "08:00-21:00", sat: "08:00-21:00", sun: "08:00-21:00", outside_window: "queue" } };
  });

  async function seed(key, phone, { campaignStatus = "active", nextAttemptAt = DUE } = {}) {
    const c = await admin.query(`INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
                                 VALUES ($1,$2,'speed_to_lead','solicited','business',$3,1) RETURNING id`, [BIZ, key, campaignStatus]);
    await admin.query(`INSERT INTO campaign_versions (campaign_id,business_id,version,config) VALUES ($1,$2,1,$3)`, [c.rows[0].id, BIZ, cfg]);
    const k = await admin.query(`INSERT INTO contacts (business_id, phone_e164, first_name) VALUES ($1,$2,'Sam') RETURNING id`, [BIZ, phone]);
    await admin.query(`INSERT INTO consents (business_id,contact_id,purpose,channels,covers_automated,source,captured_at)
                       VALUES ($1,$2,'enquiry_followup','{call}',true,'manual',now())`, [BIZ, k.rows[0].id]);
    const o = await admin.query(`INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,idempotency_key,next_attempt_at)
                                 VALUES ($1,$2,1,$3,'waiting','{}',$4,$5) RETURNING id`, [BIZ, c.rows[0].id, k.rows[0].id, key, nextAttemptAt]);
    return { outreachId: o.rows[0].id, contactId: k.rows[0].id };
  }
  const dispatcher = (create, extra = {}) => createDispatcher({
    db, twilio: { calls: { create } }, enqueue: async () => ({ created: true }),
    env: { enabled: false, allowlist: new Set(Object.values(PHONES)), maxConcurrent: 100, inboundReserve: 2, baseUrl: "https://svc.example" },
    now: () => FIXED, rand: () => 0,
    callerIdValid: async () => true, renderAudio: async () => null, log: { info() {}, error() {} }, ...extra,
  });
  const outreachRow = async (id) => (await admin.query(
    `SELECT state, attempts_made, next_attempt_at, close_reason, closed_at FROM outreach WHERE id = $1`, [id])).rows[0];
  const attemptRows = async (id) => (await admin.query(
    `SELECT id, result, twilio_status, ended_at, twilio_call_sid, opener_audio, voicemail_audio FROM call_attempts WHERE outreach_id = $1`, [id])).rows;
  const twilioError = (status) => vi.fn(async () => { throw Object.assign(new Error(`twilio ${status}`), { status }); });

  it("a 'never' verdict (do-not-call) closes the outreach and dials nothing", async () => {
    const { outreachId: id } = await seed("never-1", PHONES.never);
    await admin.query(`INSERT INTO suppressions (business_id, phone_e164, reason, created_by) VALUES ($1,$2,'manual','dashboard')`, [BIZ, PHONES.never]);
    const create = vi.fn();
    expect(await dispatcher(create)({ businessId: BIZ, outreachId: id })).toEqual({ status: "closed", reason: "suppressed" });
    expect(create).not.toHaveBeenCalled();
    const o = await outreachRow(id);
    expect(o).toMatchObject({ state: "closed", close_reason: "suppressed", attempts_made: 0 });
    expect(o.closed_at).toBeInstanceOf(Date);
    expect(await attemptRows(id)).toEqual([]);
  });

  it("a paused campaign parks the outreach: still waiting, next_attempt_at NULL", async () => {
    const { outreachId: id } = await seed("paused-1", PHONES.paused, { campaignStatus: "paused" });
    expect(await dispatcher(vi.fn())({ businessId: BIZ, outreachId: id })).toMatchObject({ status: "later", reason: "campaign_paused" });
    expect(await outreachRow(id)).toMatchObject({ state: "waiting", next_attempt_at: null, attempts_made: 0 });
  });

  it("a failed calls.create fails the attempt, releases its capacity, and reschedules the next entry", async () => {
    const { outreachId: id } = await seed("failed-1", PHONES.failed);
    expect((await dispatcher(twilioError(400))({ businessId: BIZ, outreachId: id })).status).toBe("dial_failed");
    const [a, ...more] = await attemptRows(id);
    expect(more).toEqual([]);
    expect(a).toMatchObject({ result: "failed", twilio_status: "failed", twilio_call_sid: null });
    expect(a.ended_at).toBeInstanceOf(Date);
    const reg = await admin.query(`SELECT count(*)::int AS n FROM dial_registry WHERE attempt_id = $1`, [a.id]);
    expect(reg.rows[0].n).toBe(0); // capacity released: the 044 trigger dropped it on result/ended_at
    const o = await outreachRow(id);
    expect(o).toMatchObject({ state: "waiting", attempts_made: 1 });
    expect(o.next_attempt_at.toISOString()).toBe("2026-09-28T13:10:00.000Z"); // schedule[1] = "+10m"
  });

  it("Twilio's 429 gives the attempt back (C16): no row, no attempt used, +30 s", async () => {
    const { outreachId: id } = await seed("busy-1", PHONES.busy);
    expect((await dispatcher(twilioError(429))({ businessId: BIZ, outreachId: id })).status).toBe("dial_failed");
    expect(await attemptRows(id)).toEqual([]);
    const o = await outreachRow(id);
    expect(o).toMatchObject({ state: "waiting", attempts_made: 0 });
    expect(o.next_attempt_at.toISOString()).toBe("2026-09-28T13:00:30.000Z");
  });

  it("a placed call stores its CallSid (routable through the directory) and the rendered clips", async () => {
    const { outreachId: id } = await seed("placed-1", PHONES.placed);
    const renderAudio = async () => ({ opener: Buffer.from([1, 2, 3]), voicemail: Buffer.from([9]) });
    const r = await dispatcher(vi.fn(async () => ({ sid: "CAplaced0001" })), { renderAudio })({ businessId: BIZ, outreachId: id });
    expect(r).toMatchObject({ status: "dialed", callSid: "CAplaced0001" });
    const [a] = await attemptRows(id);
    expect(a.twilio_call_sid).toBe("CAplaced0001");
    expect([...a.opener_audio]).toEqual([1, 2, 3]);
    expect([...a.voicemail_audio]).toEqual([9]);
    const dir = await admin.query(`SELECT attempt_id FROM call_attempt_directory WHERE twilio_call_sid = 'CAplaced0001'`);
    expect(dir.rows[0]?.attempt_id).toBe(a.id);
    expect(await outreachRow(id)).toMatchObject({ state: "dialing", attempts_made: 1 });
  });

  it("fix A: the SID write is idempotent for the SAME sid (it is retried) and still never overwrites a different one", async () => {
    const dir = await admin.query(`SELECT attempt_id FROM call_attempt_directory WHERE twilio_call_sid = 'CAplaced0001'`);
    const attemptId = dir.rows[0].attempt_id;
    await expect(db.withTenant(BIZ, () => db.setAttemptCallSid(attemptId, "CAplaced0001"))).resolves.toBeUndefined();
    await expect(db.withTenant(BIZ, () => db.setAttemptCallSid(attemptId, "CAother00001"))).rejects.toThrow(/expected 1 row/);
    const a = await admin.query(`SELECT twilio_call_sid FROM call_attempts WHERE id = $1`, [attemptId]);
    expect(a.rows[0].twilio_call_sid).toBe("CAplaced0001");
  });

  it("fix B: an outreach closed while Twilio was asked still gets its failed attempt recorded, and stays closed", async () => {
    const { outreachId: id } = await seed("closed-mid-1", PHONES.closedMid);
    const create = vi.fn(async () => {
      // Another path (an opt-out, the dashboard) closes it between dispatch's commit and Twilio's answer.
      await admin.query(`UPDATE outreach SET state = 'closed', close_reason = 'suppressed', closed_at = now() WHERE id = $1`, [id]);
      throw Object.assign(new Error("twilio 400"), { status: 400 });
    });
    expect((await dispatcher(create)({ businessId: BIZ, outreachId: id })).status).toBe("dial_failed");
    const [a, ...more] = await attemptRows(id);
    expect(more).toEqual([]);
    expect(a).toMatchObject({ result: "failed", twilio_status: "failed" });
    expect(a.ended_at).toBeInstanceOf(Date);
    const reg = await admin.query(`SELECT count(*)::int AS n FROM dial_registry WHERE attempt_id = $1`, [a.id]);
    expect(reg.rows[0].n).toBe(0); // not left holding capacity
    expect(await outreachRow(id)).toMatchObject({ state: "closed", close_reason: "suppressed" });
    // Only the post-create failure path tolerates a closed row: a plain
    // reschedule (the gate's "later") still refuses to reopen one.
    await expect(db.withTenant(BIZ, () => db.rescheduleOutreach(id, new Date()))).rejects.toThrow(/expected 1 row/);
  });

  it("fix B: the same for a 429 -- the attempt is given back and the closed outreach stays closed", async () => {
    const { outreachId: id } = await seed("closed-mid-2", PHONES.closedMid429);
    const create = vi.fn(async () => {
      await admin.query(`UPDATE outreach SET state = 'closed', close_reason = 'suppressed', closed_at = now() WHERE id = $1`, [id]);
      throw Object.assign(new Error("twilio 429"), { status: 429 });
    });
    expect((await dispatcher(create)({ businessId: BIZ, outreachId: id })).status).toBe("dial_failed");
    expect(await attemptRows(id)).toEqual([]);
    expect(await outreachRow(id)).toMatchObject({ state: "closed", close_reason: "suppressed", attempts_made: 0 });
  });

  it("the read helpers return exactly the types the gate demands, and the scoped ones refuse to run unscoped", async () => {
    const { outreachId: dueId, contactId } = await seed("due-1", PHONES.due, { nextAttemptAt: new Date(Date.now() - 3_600_000) });
    // Stored through the 026 trigger, which normalises it to +447700900406.
    await admin.query(`INSERT INTO appointments (business_id, client_name, client_phone, scheduled_at) VALUES ($1,'Sam',' +44 7700 900406 ',now())`, [BIZ]);
    const facts = await db.withTenant(BIZ, async () => ({
      suppressed: await db.isSuppressed(PHONES.never),
      notSuppressed: await db.isSuppressed(PHONES.due),
      dialsPlaced: await db.countDialsSince(PHONES.placed, new Date(0)),
      dialsFailed: await db.countDialsSince(PHONES.failed, new Date(0)),   // a failed attempt still counts toward the cap
      dialsGivenBack: await db.countDialsSince(PHONES.busy, new Date(0)),  // C16: a 429 does not
      relationship: await db.hasServiceRelationship("0044 7700 900406"),  // same number, other spelling
      noRelationship: await db.hasServiceRelationship(PHONES.paused),
      consents: await db.listConsents(contactId),
      active: await db.activeDialCounts(BIZ),
    }));
    expect(facts).toMatchObject({
      suppressed: true, notSuppressed: false, dialsPlaced: 1, dialsFailed: 1, dialsGivenBack: 0,
      relationship: true, noRelationship: false,
    });
    expect(facts.consents).toHaveLength(1);
    expect(facts.consents[0]).toMatchObject({ purpose: "enquiry_followup", channels: ["call"], covers_automated: true, expires_at: null, revoked_at: null });
    expect(facts.consents[0].captured_at).toBeInstanceOf(Date);
    expect(Number.isInteger(facts.active.globalOutbound)).toBe(true);
    expect(facts.active.businessOutbound).toBe(2); // G6's call and the placed call are live; failed and 429 are not

    // The sweep has no tenant: outboundDue reads the 044 directory through a definer.
    expect(await db.outboundDue(500, 0)).toContainEqual({ business_id: BIZ, outreach_id: dueId });

    await expect(db.isSuppressed(PHONES.never)).rejects.toThrow(/withTenant/);
    await expect(db.countDialsSince(PHONES.placed, new Date(0))).rejects.toThrow(/withTenant/);
    await expect(db.lockCapacity()).rejects.toThrow(/withTenant/);
  });

  // F4: the gate drops an "operator-test" consent unless the number is on the
  // service allow-list. That rule reads wording_version -- if listConsents did
  // not select it, every consent would arrive without one and the rule would
  // never fire (fail open). So the column must be real, read through RLS.
  it("listConsents returns source and wording_version, so the gate's operator-test rule has a real fact", async () => {
    const { contactId } = await seed("optest-1", "+447700900409");
    await admin.query(`INSERT INTO consents (business_id,contact_id,purpose,channels,covers_automated,source,captured_at,wording_version)
                       VALUES ($1,$2,'enquiry_followup','{call}',true,'manual',now() - interval '1 day','operator-test')`, [BIZ, contactId]);
    const consents = await db.withTenant(BIZ, () => db.listConsents(contactId));
    expect(consents.map((c) => ({ source: c.source, wording_version: c.wording_version }))).toEqual([
      { source: "manual", wording_version: null },            // seed()'s, captured now (newest first)
      { source: "manual", wording_version: "operator-test" },
    ]);
  });
});
