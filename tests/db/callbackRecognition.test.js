// tests/db/callbackRecognition.test.js
/**
 * Stage 4, S4-1 (spec §12.3, §6.3, amendment C2): an inbound caller whose
 * number we called recently is recognised. Real Postgres, as vetra_app
 * (NOBYPASSRLS), BOTH ENDS REAL: a real outreach row -> the real
 * openOutreachForPhone -> the real shared start helper
 * (lib/outbound/callbackRecognition.js) -> the real prompt builder and tool
 * declarations (services/gemini.js) -> the real record_answer execute
 * writing calls.answers through the real mergeCallAnswers.
 *
 * Covers: tenant scoping (another tenant's outreach is invisible), suppressed
 * (plain and hash-only) and erased numbers are not recognised, the 14-day
 * bound (13d yes / 15d no -- sabotaged in the report), mid-dial states are not
 * recognised, answered keys are the union over every call of the outreach,
 * the recognition closes the outreach `called_back` (a retry cannot dial the
 * lead mid-callback), the inbound calls row carries outreach_id/contact_id,
 * and an inbound call with no outreach is byte-identical.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import pg from "pg";
import { createHmac } from "node:crypto";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const HASH_KEY = "vitest-db-suite-fixed-suppression-hash-key-32chars-min";

const BIZ = "0f0f5100-0000-4000-8000-000000000001";
const OTHER_BIZ = "0f0f5100-0000-4000-8000-000000000002";
const BIZ_PHONE = "+441372605100";
const LEAD = "+447700905101";
const LEAD_B = "+447700905102";

const CAMPAIGN_CONFIG = {
  persona_name: "Ava",
  caller_id: BIZ_PHONE,
  opener: "Hi, is that {first_name}? It's {persona_name}, an AI assistant from {business_name}.",
  topic: "your clinic software enquiry",
  objective: "Qualify.",
  capabilities: ["qualification"],
  questions: [
    { key: "clinic_name", ask: "What is the name of your clinic?", required: true },
    { key: "team_size", ask: "How many people work there?", required: false },
    { key: "start_date", ask: "When would you like to start?", required: false },
  ],
  retries: { schedule: ["+0m"], voicemail_on: [1] },
};

let admin, db, recognize, gemini, qualification;
let campaignId;
let seq = 0;

/** Seed one contact + outreach (state, last_attempt_at N days ago) for `business`. */
async function seed({ business = BIZ, phone = LEAD, state = "waiting", daysAgo = 1, lastAttempt = true } = {}) {
  seq += 1;
  const camp = business === BIZ ? campaignId : (await admin.query(
    `INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
     VALUES ($1,'other','speed_to_lead','solicited','business','active',1) RETURNING id`, [business])).rows[0].id;
  if (business !== BIZ) {
    await admin.query(`INSERT INTO campaign_versions (campaign_id, business_id, version, config) VALUES ($1,$2,1,$3)`,
      [camp, business, JSON.stringify(CAMPAIGN_CONFIG)]);
  }
  const con = await admin.query(
    `INSERT INTO contacts (business_id, phone_e164, first_name, timezone) VALUES ($1,$2,'Sam','Europe/London')
     ON CONFLICT (business_id, phone_e164) DO UPDATE SET first_name = 'Sam' RETURNING id`,
    [business, phone]
  );
  const contactId = con.rows[0].id;
  const out = await admin.query(
    `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,last_attempt_at,trigger,idempotency_key)
     VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::boolean THEN now() - ($7::int * interval '1 day') ELSE NULL END,'{}'::jsonb,$8) RETURNING id`,
    [business, camp, business === BIZ ? 2 : 1, contactId, state, lastAttempt, daysAgo, `cb-${seq}-${Date.now()}`]
  );
  return { outreachId: out.rows[0].id, contactId };
}

const asBiz = (id, fn) => db.withTenant(id, fn);

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);
  await admin.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [[BIZ, OTHER_BIZ]]);
  await admin.query(
    `INSERT INTO businesses (id, name, phone_number, timezone, live_voice, allowed_tasks)
     VALUES ($1, 'Callback Co', $2, 'Europe/London', 'Aoede', '["general_question","take_message"]'::jsonb)`,
    [BIZ, BIZ_PHONE]
  );
  await admin.query(`INSERT INTO businesses (id, name, timezone) VALUES ($1, 'Someone Else Co', 'Europe/London')`, [OTHER_BIZ]);
  const camp = await admin.query(
    `INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
     VALUES ($1,'c','speed_to_lead','solicited','business','active',2) RETURNING id`, [BIZ]);
  campaignId = camp.rows[0].id;
  // v1 differs from v2: the outreach is pinned to v2, so v1 must never be read.
  await admin.query(`INSERT INTO campaign_versions (campaign_id, business_id, version, config) VALUES ($1,$2,1,$3)`,
    [campaignId, BIZ, JSON.stringify({ ...CAMPAIGN_CONFIG, topic: "STALE V1 TOPIC" })]);
  await admin.query(`INSERT INTO campaign_versions (campaign_id, business_id, version, config) VALUES ($1,$2,2,$3)`,
    [campaignId, BIZ, JSON.stringify(CAMPAIGN_CONFIG)]);

  process.env.DATABASE_URL = APP_URL;
  process.env.SUPPRESSION_HASH_KEY = HASH_KEY;
  db = await import("../../services/db.js");
  ({ recognizeCallback: recognize } = await import("../../lib/outbound/callbackRecognition.js"));
  gemini = await import("../../services/gemini.js");
  qualification = (await import("../../capabilities/qualification.js")).default;
});

beforeEach(async () => {
  if (!admin) return;
  process.env.SUPPRESSION_HASH_KEY = HASH_KEY;
  await admin.query(`DELETE FROM calls WHERE business_id = ANY($1::uuid[])`, [[BIZ, OTHER_BIZ]]);
  await admin.query(`DELETE FROM outreach WHERE business_id = ANY($1::uuid[])`, [[BIZ, OTHER_BIZ]]);
  await admin.query(`DELETE FROM suppressions WHERE business_id = ANY($1::uuid[])`, [[BIZ, OTHER_BIZ]]);
});

afterAll(async () => {
  if (!admin) return;
  process.env.DATABASE_URL = url;
  await admin.query(`DELETE FROM calls WHERE business_id = ANY($1::uuid[])`, [[BIZ, OTHER_BIZ]]);
  await admin.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [[BIZ, OTHER_BIZ]]);
  await admin.end();
  await db?.close?.();
});

d("openOutreachForPhone", () => {
  it("returns the pinned topic + questions, last_attempt_at and the answered keys", async () => {
    const { outreachId, contactId } = await seed({ daysAgo: 2 });
    await admin.query(
      `INSERT INTO calls (business_id, twilio_call_sid, caller_number, outreach_id, answers)
       VALUES ($1,'CAcb-a1',$2,$3,$4), ($1,'CAcb-a2',$2,$3,$5), ($1,'CAcb-a3',$2,NULL,$6)`,
      [BIZ, LEAD, outreachId,
       JSON.stringify({ clinic_name: "Riverside", _outcome_note: "x" }),
       JSON.stringify({ team_size: "4" }),
       JSON.stringify({ start_date: "not this outreach" })]
    );
    const hit = await asBiz(BIZ, () => db.openOutreachForPhone(LEAD));
    expect(hit).toMatchObject({ outreachId, campaignId, contactId, topic: "your clinic software enquiry" });
    expect(hit.questions.map((q) => q.key)).toEqual(["clinic_name", "team_size", "start_date"]);
    expect([...hit.answeredKeys].sort()).toEqual(["clinic_name", "team_size"]);
    expect(new Date(hit.lastAttemptAt).getTime()).toBeGreaterThan(Date.now() - 3 * 86400_000);
  });

  it("is tenant scoped: another business's outreach for the same number is invisible", async () => {
    await seed({ business: OTHER_BIZ, phone: LEAD });
    expect(await asBiz(BIZ, () => db.openOutreachForPhone(LEAD))).toBeNull();
    expect(await asBiz(OTHER_BIZ, () => db.openOutreachForPhone(LEAD))).not.toBeNull();
  });

  it("refuses to run outside withTenant", async () => {
    await expect(db.openOutreachForPhone(LEAD)).rejects.toThrow(/withTenant/);
  });

  it("14-day bound: 13 days ago yes, 15 days ago no", async () => {
    await seed({ daysAgo: 13 });
    expect(await asBiz(BIZ, () => db.openOutreachForPhone(LEAD))).not.toBeNull();
    await admin.query(`DELETE FROM outreach WHERE business_id = $1`, [BIZ]);
    await seed({ daysAgo: 15 });
    expect(await asBiz(BIZ, () => db.openOutreachForPhone(LEAD))).toBeNull();
  });

  it("an outreach never dialled (last_attempt_at NULL) is not recognised", async () => {
    await seed({ lastAttempt: false });
    expect(await asBiz(BIZ, () => db.openOutreachForPhone(LEAD))).toBeNull();
  });

  it.each(["dialing", "in_call", "closed"])("state %s is not recognised (only waiting)", async (state) => {
    await seed({ state });
    expect(await asBiz(BIZ, () => db.openOutreachForPhone(LEAD))).toBeNull();
  });

  it("takes the most recent waiting outreach", async () => {
    await seed({ daysAgo: 9 });
    const newer = await seed({ daysAgo: 2 });
    const hit = await asBiz(BIZ, () => db.openOutreachForPhone(LEAD));
    expect(hit.outreachId).toBe(newer.outreachId);
  });

  it("a suppressed number (plain row) is not recognised", async () => {
    await seed();
    await admin.query(`INSERT INTO suppressions (business_id, phone_e164, reason, created_by) VALUES ($1,$2,'opted_out','tool')`, [BIZ, LEAD]);
    expect(await asBiz(BIZ, () => db.openOutreachForPhone(LEAD))).toBeNull();
  });

  it("an erased number (suppression kept by hash alone) is not recognised", async () => {
    await seed();
    await admin.query(`INSERT INTO suppressions (business_id, phone_e164, reason, created_by) VALUES ($1,$2,'opted_out','tool')`, [BIZ, LEAD]);
    await asBiz(BIZ, () => db.eraseCallerData(BIZ, LEAD));
    const sup = (await admin.query(`SELECT phone_e164, phone_hash FROM suppressions WHERE business_id = $1`, [BIZ])).rows[0];
    expect(sup.phone_e164).toBeNull();
    expect(sup.phone_hash).toBeTruthy();
    expect(await asBiz(BIZ, () => db.openOutreachForPhone(LEAD))).toBeNull();
  });

  it("a hash-only suppression (the erased shape) refuses even while the contact row still has the phone", async () => {
    await seed();
    const hash = createHmac("sha256", HASH_KEY).update(LEAD).digest("hex");
    await admin.query(`INSERT INTO suppressions (business_id, phone_hash, reason, created_by) VALUES ($1,$2,'opted_out','tool')`, [BIZ, hash]);
    expect(await asBiz(BIZ, () => db.openOutreachForPhone(LEAD))).toBeNull();
  });

  it("a missing SUPPRESSION_HASH_KEY throws (the caller treats a throw as not recognised)", async () => {
    await seed();
    delete process.env.SUPPRESSION_HASH_KEY;
    await expect(asBiz(BIZ, () => db.openOutreachForPhone(LEAD))).rejects.toThrow(/SUPPRESSION_HASH_KEY/);
  });

  it("a number with no outreach is null, and a non-E.164 string is null", async () => {
    expect(await asBiz(BIZ, () => db.openOutreachForPhone(LEAD_B))).toBeNull();
    expect(await asBiz(BIZ, () => db.openOutreachForPhone("anonymous"))).toBeNull();
  });
});

d("closeOutreachCalledBack", () => {
  it("closes the outreach with close_reason called_back", async () => {
    const { outreachId } = await seed();
    await asBiz(BIZ, () => db.closeOutreachCalledBack(outreachId));
    const row = (await admin.query(`SELECT state, close_reason FROM outreach WHERE id = $1`, [outreachId])).rows[0];
    expect(row).toEqual({ state: "closed", close_reason: "called_back" });
  });
});

d("the real start path: recognizeCallback -> createCall link -> prompt -> record_answer", () => {
  it("recognises, closes called_back, links the inbound row, builds tail + declarations, and record_answer lands in calls.answers", async () => {
    const { outreachId, contactId } = await seed({ daysAgo: 3 });
    await admin.query(
      `INSERT INTO calls (business_id, twilio_call_sid, caller_number, outreach_id, answers) VALUES ($1,'CAcb-prior',$2,$3,$4)`,
      [BIZ, LEAD, outreachId, JSON.stringify({ clinic_name: "Riverside" })]
    );

    let cb = null;
    let callId = null;
    await db.withTenant(BIZ, async () => {
      // Exactly the start path's order: the plain 4-argument createCall first,
      // the lookup LAST, the link only on a hit.
      callId = await db.createCall(BIZ, "CAcb-inbound", LEAD, BIZ_PHONE);
      cb = await recognize({ database: db, businessId: BIZ, callerPhone: LEAD, callSid: "CAcb-inbound", callId });
    });
    expect(cb).toMatchObject({ outreachId, contactId, campaignId });
    expect(cb.remainingQuestions.map((q) => q.key)).toEqual(["team_size", "start_date"]);

    const call = (await admin.query(`SELECT direction, outreach_id, contact_id FROM calls WHERE id = $1`, [callId])).rows[0];
    expect(call).toEqual({ direction: "inbound", outreach_id: outreachId, contact_id: contactId });
    const o = (await admin.query(`SELECT state, close_reason FROM outreach WHERE id = $1`, [outreachId])).rows[0];
    expect(o).toEqual({ state: "closed", close_reason: "called_back" });

    // Prompt: the tail names the topic and ONLY the unanswered questions.
    const config = { businessName: "Callback Co", timezone: "Europe/London", allowedTasks: ["general_question"] };
    const tail = gemini.buildDynamicTail("greeting", "general_question", config, { callbackOutreach: cb, callerPhone: LEAD });
    expect(tail).toMatch(/We called this person on \w+ \d{1,2} \w+ about your clinic software enquiry\./);
    expect(tail).toContain("How many people work there?");
    expect(tail).toContain("When would you like to start?");
    expect(tail).toMatch(/ask these naturally, one at a time, and record each answer with record_answer/);
    expect(tail).not.toContain("What is the name of your clinic?");

    // Declarations: record_answer with only the remaining keys.
    const decls = gemini.buildAllDeclarations(config, { callbackOutreach: cb });
    const ra = decls.find((x) => x.name === "record_answer");
    expect(ra.parameters.properties.key.enum).toEqual(["team_size", "start_date"]);

    // The tool, through the real mergeCallAnswers, lands on the inbound row.
    await db.withTenant(BIZ, async () => {
      const res = await qualification.execute(
        { id: "1", name: "record_answer", args: { key: "team_size", value: "4" } },
        { callSid: "CAcb-inbound", callbackOutreach: cb, deps: { mergeCallAnswers: db.mergeCallAnswers } }
      );
      expect(res.functionResponse.response.success).toBe(true);
    });
    const ans = (await admin.query(`SELECT answers FROM calls WHERE id = $1`, [callId])).rows[0].answers;
    expect(ans).toEqual({ team_size: "4" });
  });

  it("no outreach: not recognised, createCall stays the 4-argument inbound form", async () => {
    let cb = "unset";
    await db.withTenant(BIZ, async () => {
      const callId = await db.createCall(BIZ, "CAcb-none", LEAD_B, BIZ_PHONE);
      cb = await recognize({ database: db, businessId: BIZ, callerPhone: LEAD_B, callSid: "CAcb-none", callId });
    });
    expect(cb).toBeNull();
    const row = (await admin.query(`SELECT outreach_id, contact_id FROM calls WHERE twilio_call_sid = 'CAcb-none'`)).rows[0];
    expect(row).toEqual({ outreach_id: null, contact_id: null });
  });

  it("I1: a SQL error inside the lookup leaves createCall and every other context fetch intact, prompt byte-identical", async () => {
    const { outreachId } = await seed();
    await admin.query("ALTER TABLE campaign_versions RENAME TO campaign_versions_cbx");
    let settled;
    let cb = "unset";
    let afterFetch;
    try {
      await db.withTenant(BIZ, async () => {
        settled = await Promise.allSettled([
          db.createCall(BIZ, "CAcb-sqlerr", LEAD, BIZ_PHONE),
          db.fetchBusinessKnowledge(BIZ),
          db.listIntegrationsForBusiness(BIZ, { enabledOnly: true }),
          db.fetchCallerContext(BIZ, LEAD),
        ]);
        cb = await recognize({ database: db, businessId: BIZ, callerPhone: LEAD, callSid: "CAcb-sqlerr", callId: settled[0].value });
        // The transaction is still usable after the failed lookup.
        afterFetch = await Promise.allSettled([db.fetchBusinessKnowledge(BIZ)]);
      });
    } finally {
      await admin.query("ALTER TABLE campaign_versions_cbx RENAME TO campaign_versions");
    }
    expect(settled.map((x) => x.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    expect(settled[0].value).toBeTruthy();
    expect(afterFetch[0].status).toBe("fulfilled");
    expect(cb).toBeNull();
    // The whole transaction COMMITTED: the call row exists, unlinked, and the outreach was not touched.
    const row = (await admin.query(`SELECT outreach_id FROM calls WHERE twilio_call_sid = 'CAcb-sqlerr'`)).rows[0];
    expect(row).toEqual({ outreach_id: null });
    expect((await admin.query(`SELECT state FROM outreach WHERE id = $1`, [outreachId])).rows[0].state).toBe("waiting");
    const config = { businessName: "Callback Co", timezone: "Europe/London", allowedTasks: ["general_question"] };
    const base = gemini.buildSystemInstruction("greeting", "general_question", config, { callerPhone: LEAD });
    const extras = { callerPhone: LEAD, ...(cb ? { callbackOutreach: cb } : {}) };
    expect(gemini.buildSystemInstruction("greeting", "general_question", config, extras)).toBe(base);
  });

  it("m2: the close is guarded to 'waiting': an outreach that moved to dialing is left alone", async () => {
    const { outreachId } = await seed();
    await admin.query(`UPDATE outreach SET state = 'dialing' WHERE id = $1`, [outreachId]);
    const closed = await asBiz(BIZ, () => db.closeOutreachCalledBack(outreachId));
    expect(closed).toBe(false);
    expect((await admin.query(`SELECT state, close_reason FROM outreach WHERE id = $1`, [outreachId])).rows[0]).toEqual({ state: "dialing", close_reason: null });
  });

  it("m1: a failed link means NOT recognised and the outreach is not closed", async () => {
    const { outreachId } = await seed();
    let cb = "unset";
    await db.withTenant(BIZ, async () => {
      // callId claims a row exists but no calls row carries this sid.
      cb = await recognize({ database: db, businessId: BIZ, callerPhone: LEAD, callSid: "CAcb-nolink", callId: "fake-call-id" });
    });
    expect(cb).toBeNull();
    expect((await admin.query(`SELECT state FROM outreach WHERE id = $1`, [outreachId])).rows[0].state).toBe("waiting");
  });

  it("no calls row (createCall failed) -> never recognised", async () => {
    await seed();
    await db.withTenant(BIZ, async () => {
      expect(await recognize({ database: db, businessId: BIZ, callerPhone: LEAD, callSid: "x", callId: null })).toBeNull();
    });
  });

  it("a lookup slower than the bound yields null (its result is not used) but is awaited to settlement", async () => {
    let settledAt = 0;
    const link = vi.fn();
    const slow = {
      openOutreachForPhone: async () => {
        await new Promise((r) => setTimeout(r, 150));
        settledAt = Date.now();
        return { outreachId: "o", campaignId: "c", contactId: "k", lastAttemptAt: new Date(), topic: null, questions: [], answeredKeys: [] };
      },
      closeOutreachCalledBack: async () => true,
      linkCallToOutreach: link,
    };
    const cb = await recognize({ database: slow, businessId: BIZ, callerPhone: LEAD, callSid: "x", callId: "c1", timeoutMs: 60 });
    const returnedAt = Date.now();
    expect(cb).toBeNull();
    expect(link).not.toHaveBeenCalled();
    expect(settledAt).toBeGreaterThan(0); // the lookup had settled before recognize returned
    expect(returnedAt).toBeGreaterThanOrEqual(settledAt);
  });

  it("I1 residual: a statement that outlives the race and THEN errors is rolled back to its savepoint before the scope commits", async () => {
    await seed();
    // The shape of the real lookup (SAVEPOINT ... ROLLBACK TO on error) with a
    // statement that sleeps past the 100 ms race and then fails. `client` is
    // the tenant transaction's own connection.
    const slowThenFail = (client) => ({
      openOutreachForPhone: async () => {
        await client.query("SAVEPOINT cb_slow");
        try {
          await client.query("SELECT 1 / length(pg_sleep(0.5)::text)");
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT cb_slow");
          throw err;
        }
      },
    });
    let settled;
    let cb = "unset";
    let afterFetch;
    const t0 = Date.now();
    await db.withTenant(BIZ, async (client) => {
      settled = await Promise.allSettled([
        db.createCall(BIZ, "CAcb-slowfail", LEAD, BIZ_PHONE),
        db.fetchBusinessKnowledge(BIZ),
        db.listIntegrationsForBusiness(BIZ, { enabledOnly: true }),
        db.fetchCallerContext(BIZ, LEAD),
      ]);
      cb = await recognize({ database: slowThenFail(client), businessId: BIZ, callerPhone: LEAD, callSid: "CAcb-slowfail", callId: settled[0].value, timeoutMs: 100 });
      afterFetch = await Promise.allSettled([db.fetchBusinessKnowledge(BIZ)]);
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450); // it waited for the slow statement to settle
    expect(settled.map((x) => x.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "fulfilled"]);
    expect(afterFetch[0].status).toBe("fulfilled");
    expect(cb).toBeNull();
    // The scope COMMITTED: the call row exists.
    const row = (await admin.query(`SELECT outreach_id FROM calls WHERE twilio_call_sid = 'CAcb-slowfail'`)).rows[0];
    expect(row).toEqual({ outreach_id: null });
    const config = { businessName: "Callback Co", timezone: "Europe/London", allowedTasks: ["general_question"] };
    const base = gemini.buildSystemInstruction("greeting", "general_question", config, { callerPhone: LEAD });
    const extras = { callerPhone: LEAD, ...(cb ? { callbackOutreach: cb } : {}) };
    expect(gemini.buildSystemInstruction("greeting", "general_question", config, extras)).toBe(base);
  });
});
