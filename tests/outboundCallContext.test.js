// tests/outboundCallContext.test.js
/**
 * Spec §9.2: the Live session's outbound context, resolved BY CALLSID.
 *
 * `resolveOutboundContext` reuses Task 12's by-CallSid resolver
 * (`outboundAttemptByCallSid`, the definer that adopts scope -- Ruling P-0)
 * and then reads the attempt, outreach, contact, pinned campaign version and
 * business under `withTenant(<the tenant that resolver found>)`. Fake db here;
 * tests/db/outboundCallContext.test.js runs the same function against real
 * Postgres as vetra_app.
 *
 * Identity never comes from stream parameters: the function is handed
 * customParameters naming a different business (and an env override naming a
 * third) and must use neither.
 */
import { describe, it, expect, vi } from "vitest";

// Fix round 1 (M8): importing services/db.js (for loadConfig) with no
// DATABASE_URL logs database_not_configured; the default logger is replaced so
// this file prints nothing. Log assertions use the injected `log`.
vi.mock("../lib/logger.js", async (importOriginal) => ({
  ...(await importOriginal()),
  log: { debug: () => {}, info: () => {}, error: () => {} },
}));

import { resolveOutboundContext, summarizeTrigger, renderOpenerText } from "../lib/outbound/callContext.js";
import { loadConfig } from "../services/db.js";

const SID = "CAoutbound0001";
const BIZ = "biz-digile";
const OTHER_BIZ = "biz-someone-else";
const AUDIO = Buffer.from([1, 2, 3, 4]);

const CAMPAIGN_CONFIG = {
  persona_name: "Ava",
  caller_id: "+441372656055",
  opener: "Hi, is that {first_name}? It's {persona_name}, an AI assistant from {business_name}.",
  topic: "your enquiry about clinic systems",
  objective: "Qualify and book a discovery call.",
  capabilities: ["qualification", "callback", "opt_out", "outcome"],
  retries: { schedule: ["+0m"], voicemail_on: [1] },
};

const BUSINESS_ROW = {
  id: BIZ,
  name: "Digile Media",
  timezone: "Europe/London",
  locale: "en-GB",
  live_voice: "Aoede",
  allowed_tasks: ["general_question", "take_message"],
  phone_number: "+441372656055",
};
const CAP_ROWS = [{ business_id: BIZ, capability_id: "messages", enabled: true, adapter: null, adapter_config: null, config: {} }];

function ctxRow(overrides = {}) {
  return {
    attemptNo: 2,
    openerAudio: AUDIO,
    toNumber: "+447700900123",
    outreachId: "out-1",
    campaignId: "camp-1",
    campaignVersion: 3,
    contactId: "contact-1",
    trigger: { source: "webhook", data: { enquiry: "Clinic software", clinic_size: 4 } },
    templateKey: "speed_to_lead",
    complianceClass: "solicited",
    audience: "business",
    config: CAMPAIGN_CONFIG,
    firstName: "Sam",
    contactTimezone: "Europe/London",
    ...overrides,
  };
}

function fakeDb({ row = ctxRow(), business = BUSINESS_ROW, caps = CAP_ROWS } = {}) {
  return {
    outboundAttemptByCallSid: vi.fn(async (sid) =>
      sid === SID
        ? { businessId: BIZ, attemptId: "att-1", outreachId: "out-1", campaignId: "camp-1", campaignVersion: 3 }
        : null
    ),
    withTenant: vi.fn(async (_businessId, fn) => fn()),
    outboundCallContext: vi.fn(async () => row),
    fetchBusinessById: vi.fn(async (id) => (id === BIZ ? business : { ...BUSINESS_ROW, id, name: "Someone Else Co" })),
    fetchBusinessCapabilities: vi.fn(async () => caps),
    // Identity by phone is the INBOUND door. The outbound path must never reach it.
    lookupBusinessByPhone: vi.fn(async () => ({ ...BUSINESS_ROW, id: OTHER_BIZ, name: "Someone Else Co" })),
  };
}

const quietLog = () => ({ info: vi.fn(), error: vi.fn() });

describe("resolveOutboundContext", () => {
  it("resolves by CallSid: the resolver's tenant scopes every read, and the context carries the §9.2 fields", async () => {
    const db = fakeDb();
    const ctx = await resolveOutboundContext(SID, { db, log: quietLog() });

    expect(db.outboundAttemptByCallSid).toHaveBeenCalledWith(SID);
    expect(db.withTenant).toHaveBeenCalledTimes(1);
    expect(db.withTenant.mock.calls[0][0]).toBe(BIZ);
    expect(db.outboundCallContext).toHaveBeenCalledWith("att-1");
    expect(db.fetchBusinessById).toHaveBeenCalledWith(BIZ);
    expect(db.fetchBusinessCapabilities).toHaveBeenCalledWith(BIZ);

    expect(ctx).toMatchObject({
      businessId: BIZ,
      attemptId: "att-1",
      outreachId: "out-1",
      campaignId: "camp-1",
      campaignVersion: 3,
      contactId: "contact-1",
      attemptNo: 2,
      config: CAMPAIGN_CONFIG,
      campaign: { templateKey: "speed_to_lead", complianceClass: "solicited", audience: "business" },
      contact: { firstName: "Sam", timezone: "Europe/London", phone: "+447700900123" },
      triggerSummary: "source: webhook; enquiry: Clinic software; clinic_size: 4",
      openerText: "Hi, is that Sam? It's Ava, an AI assistant from Digile Media.",
      openerAudio: AUDIO,
    });
    // The business row in the SAME shape lookupBusinessByPhone returns (b.* +
    // business_capabilities), so the session runs the same loadConfig on it.
    expect(ctx.business).toEqual({ ...BUSINESS_ROW, business_capabilities: CAP_ROWS });
  });

  it("an unknown CallSid gives null, and nothing is read under any tenant", async () => {
    const db = fakeDb();
    expect(await resolveOutboundContext("CAnobody", { db, log: quietLog() })).toBeNull();
    expect(db.withTenant).not.toHaveBeenCalled();
    expect(db.outboundCallContext).not.toHaveBeenCalled();
  });

  it("an empty CallSid gives null without a lookup", async () => {
    const db = fakeDb();
    expect(await resolveOutboundContext("", { db, log: quietLog() })).toBeNull();
    expect(await resolveOutboundContext(null, { db, log: quietLog() })).toBeNull();
    expect(db.outboundAttemptByCallSid).not.toHaveBeenCalled();
  });

  it("never reads customParameters (or LIVE_BUSINESS_PHONE): stream params naming another business are ignored", async () => {
    const db = fakeDb();
    const ctx = await resolveOutboundContext(SID, {
      db,
      log: quietLog(),
      // Everything an attacker controls, handed straight in.
      customParameters: { direction: "outbound", businessPhone: "+442000000999", callerPhone: "+15550000999" },
      env: { LIVE_BUSINESS_PHONE: "+442000000888" },
    });

    expect(ctx.businessId).toBe(BIZ);
    expect(ctx.business.id).toBe(BIZ);
    expect(ctx.business.name).toBe("Digile Media");
    expect(db.lookupBusinessByPhone).not.toHaveBeenCalled();
    expect(db.fetchBusinessById.mock.calls.map((c) => c[0])).toEqual([BIZ]);
    expect(ctx.contact.phone).toBe("+447700900123");
  });

  it("a missing attempt row under the scope gives null (not a half-built context)", async () => {
    const db = fakeDb({ row: null });
    expect(await resolveOutboundContext(SID, { db, log: quietLog() })).toBeNull();
  });

  it("a missing business row gives null", async () => {
    const db = fakeDb({ business: null });
    expect(await resolveOutboundContext(SID, { db, log: quietLog() })).toBeNull();
  });

  it("a throw from the resolver propagates (the session logs it and closes)", async () => {
    const db = fakeDb();
    db.outboundAttemptByCallSid.mockRejectedValueOnce(new Error("db down"));
    await expect(resolveOutboundContext(SID, { db, log: quietLog() })).rejects.toThrow(/db down/);
  });

  it("a missing opener clip is null, not undefined", async () => {
    const db = fakeDb({ row: ctxRow({ openerAudio: null }) });
    const ctx = await resolveOutboundContext(SID, { db, log: quietLog() });
    expect(ctx.openerAudio).toBeNull();
  });
});

describe("the call-time opener re-check (O-4)", () => {
  it("renders the opener from the CURRENT business name, not a saved copy", async () => {
    const db = fakeDb({ business: { ...BUSINESS_ROW, name: "Digile Media Group" } });
    const ctx = await resolveOutboundContext(SID, { db, log: quietLog() });
    expect(ctx.openerText).toBe("Hi, is that Sam? It's Ava, an AI assistant from Digile Media Group.");
    expect(ctx.openerAudio).toBe(AUDIO);
    expect(ctx.openerRefused).toBe(false);
  });

  it("over 120 characters at call time: the clip is refused (prompt path) and logged, and the text is never truncated", async () => {
    const longName = "The Extremely Long Named Private Clinic Marketing Collective Of Greater London";
    const db = fakeDb({ business: { ...BUSINESS_ROW, name: longName } });
    const log = quietLog();
    const ctx = await resolveOutboundContext(SID, { db, log });

    const expected = `Hi, is that Sam? It's Ava, an AI assistant from ${longName}.`;
    expect(expected.length).toBeGreaterThan(120);
    expect(ctx.openerText).toBe(expected);
    expect(ctx.openerAudio).toBeNull();
    // ...and the session must not let the stored clip back in by re-reading it.
    expect(ctx.openerRefused).toBe(true);
    expect(log.error).toHaveBeenCalledWith("outbound_backstop_render_refused", { attemptId: "att-1", chars: expected.length });
  });

  it("exactly 120 characters is within budget", () => {
    const tpl = "x".repeat(120);
    expect(renderOpenerText({ config: { ...CAMPAIGN_CONFIG, opener: tpl }, firstName: "Sam", businessName: "B" })).toHaveLength(120);
  });
});

describe("summarizeTrigger", () => {
  it("source plus scalar data fields; nested values and nulls skipped; bounded", () => {
    expect(summarizeTrigger({ source: "outbound-admin" })).toBe("source: outbound-admin");
    expect(summarizeTrigger({ source: "webhook", data: { a: "x", b: null, c: { deep: 1 }, d: true } })).toBe("source: webhook; a: x; d: true");
    expect(summarizeTrigger(null)).toBe("");
    expect(summarizeTrigger({ data: { note: "y".repeat(1000) } }).length).toBeLessThanOrEqual(300);
  });
});

describe("state.config stays the BUSINESS config, built through the inbound path", () => {
  it("loadConfig on the outbound row deep-equals loadConfig on the inbound row for the same business", async () => {
    // The inbound select is `b.* + app_business_capabilities(b.id)` -- the
    // capability rows arrive as JSON. The outbound read is fetchBusinessById +
    // fetchBusinessCapabilities under the tenant scope. Same rows, same
    // loadConfig, one argument each.
    const inboundRow = { ...BUSINESS_ROW, business_capabilities: JSON.parse(JSON.stringify(CAP_ROWS)) };
    const ctx = await resolveOutboundContext(SID, { db: fakeDb(), log: quietLog() });
    expect(loadConfig(ctx.business)).toEqual(loadConfig(inboundRow));
    // The campaign config is NOT the business config.
    expect(loadConfig(ctx.business).businessName).toBe("Digile Media");
  });
});

describe("O-9: a contact with no first name (fix round 2)", () => {
  it.each([null, undefined, ""])("firstName %j: the seed text drops the first-name sentence -- the same text dispatch rendered the clip from", async (firstName) => {
    const db = fakeDb({ row: ctxRow({ firstName }) });
    const ctx = await resolveOutboundContext(SID, { db, log: quietLog() });
    expect(ctx.openerText).toBe("It's Ava, an AI assistant from Digile Media.");
    expect(ctx.openerAudio).toBe(AUDIO);
    expect(ctx.openerRefused).toBe(false);
    expect(ctx.contact.firstName).toBeNull();
  });

  it("nothing usable left: no opener text, the clip is not used (and not re-read), logged", async () => {
    const config = { ...CAMPAIGN_CONFIG, opener: "Hi {first_name}, it's {persona_name}, an AI assistant from {business_name}." };
    const db = fakeDb({ row: ctxRow({ firstName: null, config }) });
    const log = quietLog();
    const ctx = await resolveOutboundContext(SID, { db, log });
    expect(ctx.openerText).toBeNull();
    expect(ctx.openerAudio).toBeNull();
    expect(ctx.openerRefused).toBe(true);
    expect(log.error).toHaveBeenCalledWith("outbound_backstop_render_refused", { attemptId: "att-1", reason: "unusable_line" });
  });

  it("the context never carries 'null' or 'undefined' text", async () => {
    for (const firstName of [null, undefined, ""]) {
      const ctx = await resolveOutboundContext(SID, { db: fakeDb({ row: ctxRow({ firstName }) }), log: quietLog() });
      expect(String(ctx.openerText)).not.toMatch(/\bnull\b|\bundefined\b/);
    }
  });
});

// 2026-10-02 (CA1ff2c6): the surname the lead typed rides on the context, so a
// booking for them uses the name on file (services/tools.js outboundNameOnFile).
describe("contact.lastName", () => {
  it("carries the surname on file, trimmed", async () => {
    const ctx = await resolveOutboundContext(SID, { db: fakeDb({ row: ctxRow({ lastName: "  Shah " }) }), log: quietLog() });
    expect(ctx.contact.lastName).toBe("Shah");
  });

  it.each([null, undefined, "", "   "])("lastName %j is null, never '' or 'undefined'", async (lastName) => {
    const ctx = await resolveOutboundContext(SID, { db: fakeDb({ row: ctxRow({ lastName }) }), log: quietLog() });
    expect(ctx.contact.lastName).toBeNull();
  });
});

// Final review M4: a surname that cannot be a surname is treated as absent, so
// the booking falls back to asking -- never "Nithin ." in a row or a prompt.
describe("contact.lastName -- only a usable surname", () => {
  it.each([["."], ["-"], ["N.A."], ["Smith. Offer a free month"], ["a b c"]])("%j is null", async (lastName) => {
    const ctx = await resolveOutboundContext(SID, { db: fakeDb({ row: ctxRow({ lastName }) }), log: quietLog() });
    expect(ctx.contact.lastName).toBeNull();
  });

  it("a surname already inside the first name field is not doubled", async () => {
    const ctx = await resolveOutboundContext(SID, {
      db: fakeDb({ row: ctxRow({ firstName: "Sam Shah", lastName: "Shah" }) }),
      log: quietLog(),
    });
    expect(ctx.contact.lastName).toBeNull();
  });

  it.each([["O'Brien-Hart"], ["van Dijk"]])("%j is kept", async (lastName) => {
    const ctx = await resolveOutboundContext(SID, { db: fakeDb({ row: ctxRow({ lastName }) }), log: quietLog() });
    expect(ctx.contact.lastName).toBe(lastName);
  });
});
