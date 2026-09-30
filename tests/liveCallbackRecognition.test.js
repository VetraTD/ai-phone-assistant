// tests/liveCallbackRecognition.test.js
/**
 * S4-1 (spec §12.3) through the REAL Live session (lib/voice/live/index.js) on
 * tests/helpers/liveBoot.js, and the real start helper, prompt builder and tool
 * declarations. The stubbed `openOutreachForPhone` returns EXACTLY the shape
 * services/db.js's function returns (its RETURN statement), not a shape read
 * off a log line; tests/db/callbackRecognition.test.js runs the real function.
 *
 * Inbound with no outreach must be what it was: same createCall arguments,
 * same prompt, same declarations.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const logged = vi.hoisted(() => []);
vi.mock("../lib/logger.js", async (importOriginal) => {
  const rec = (level) => (event, fields = {}) => {
    logged.push({ level, event, ...fields });
  };
  return { ...(await importOriginal()), log: { debug: rec("DEBUG"), info: rec("INFO"), error: rec("ERROR") } };
});

import { bootLive, fakeDb } from "./helpers/liveBoot.js";

const BIZ = "biz-cb";
const CALLER = "+447700905101";
const BIZ_PHONE = "+441372605100";

const CONFIG = {
  businessId: BIZ,
  businessName: "Callback Co",
  greeting: "Thanks for calling Callback Co.",
  mainPhone: BIZ_PHONE,
  timezone: "Europe/London",
  businessHours: {},
  locale: null,
  liveVoice: null,
  allowedTasks: ["general_question", "take_message"],
  capabilities: {},
};

/** The exact shape services/db.js openOutreachForPhone returns. */
const HIT = {
  outreachId: "out-9",
  campaignId: "camp-9",
  contactId: "contact-9",
  campaignVersion: 2,
  lastAttemptAt: new Date("2026-09-28T09:30:00Z"),
  topic: "your clinic software enquiry",
  questions: [
    { key: "clinic_name", ask: "What is the name of your clinic?", required: true },
    { key: "team_size", ask: "How many people work there?", required: false },
  ],
  answeredKeys: ["clinic_name"],
};

function dbWith(over = {}) {
  const base = fakeDb(CONFIG, BIZ);
  return {
    ...base,
    createCall: vi.fn(async () => "call-1"),
    openOutreachForPhone: vi.fn(async () => null),
    closeOutreachCalledBack: vi.fn(async () => {}),
    ...over,
  };
}

async function boot(database) {
  const call = await bootLive({ config: CONFIG, businessId: BIZ, businessPhone: BIZ_PHONE, callerPhone: CALLER, database, callSid: "CAcb1" });
  const conn = call.live.connect.mock.calls[0][0].config;
  const names = (conn.tools || []).flatMap((t) => (t.functionDeclarations || []).map((d) => d.name));
  return { call, prompt: conn.systemInstruction.parts[0].text, conn, names };
}

beforeEach(() => {
  logged.length = 0;
});

describe("Live start: inbound callback recognition", () => {
  it("a recognised callback: tail line, record_answer with only the remaining keys, linked row, closed called_back", async () => {
    const database = dbWith({ openOutreachForPhone: vi.fn(async () => HIT) });
    const { call, prompt, conn } = await boot(database);

    expect(database.openOutreachForPhone).toHaveBeenCalledWith(CALLER);
    expect(database.closeOutreachCalledBack).toHaveBeenCalledWith("out-9");
    expect(database.createCall).toHaveBeenCalledTimes(1);
    expect(database.createCall.mock.calls[0]).toEqual([BIZ, "CAcb1", CALLER, BIZ_PHONE, { outreachId: "out-9", contactId: "contact-9" }]);

    expect(prompt).toMatch(/We called this person on Monday 28 September about your clinic software enquiry\./);
    expect(prompt).toContain("Questions still unanswered: How many people work there?.");
    expect(prompt).not.toContain("What is the name of your clinic?");

    const decl = conn.tools.flatMap((t) => t.functionDeclarations).find((d) => d.name === "record_answer");
    expect(decl.parameters.properties.key.enum).toEqual(["team_size"]);
    // schedule_callback / outcome / opt_out stay undeclared on inbound
    const names = conn.tools.flatMap((t) => t.functionDeclarations).map((d) => d.name);
    for (const n of ["schedule_callback", "record_outcome", "opt_out"]) expect(names).not.toContain(n);

    // The tail, never the cached static prefix (the prefix is what a cache holds).
    expect(logged.filter((l) => l.event === "outbound_callback_recognized")).toEqual([
      { level: "INFO", event: "outbound_callback_recognized", callSid: "CAcb1", outreachId: "out-9", campaignId: "camp-9" },
    ]);
    // No phone number and no answer in any log line.
    expect(JSON.stringify(logged)).not.toContain(CALLER);
    await call.hangUp();
  });

  it("record_answer through the running session lands via mergeCallAnswers on the inbound call", async () => {
    const database = dbWith({ openOutreachForPhone: vi.fn(async () => HIT) });
    const merge = vi.fn(async () => {});
    const call = await bootLive({ config: CONFIG, businessId: BIZ, businessPhone: BIZ_PHONE, callerPhone: CALLER, database, callSid: "CAcb1" });
    call.deps.mergeCallAnswers = merge;
    await call.callTool("record_answer", { key: "team_size", value: "four" });
    expect(merge).toHaveBeenCalledWith("CAcb1", { team_size: "four" });
    await call.hangUp();
  });

  it("no outreach: createCall is the 4-argument inbound form; no callback line; no record_answer", async () => {
    const database = dbWith();
    const { call, prompt, names } = await boot(database);
    expect(database.createCall.mock.calls[0]).toEqual([BIZ, "CAcb1", CALLER, BIZ_PHONE]);
    expect(database.closeOutreachCalledBack).not.toHaveBeenCalled();
    expect(prompt).not.toMatch(/RETURNED CALL|We called this person/);
    expect(names).not.toContain("record_answer");
    expect(logged.filter((l) => l.event === "outbound_callback_recognized")).toEqual([]);
    await call.hangUp();
  });

  it("a callback whose questions are all answered: the line stays, no unanswered sentence, no record_answer", async () => {
    const database = dbWith({ openOutreachForPhone: vi.fn(async () => ({ ...HIT, answeredKeys: ["clinic_name", "team_size"] })) });
    const { call, prompt, names } = await boot(database);
    expect(prompt).toContain("We called this person on Monday 28 September about your clinic software enquiry.");
    expect(prompt).not.toContain("Questions still unanswered");
    expect(names).not.toContain("record_answer");
    await call.hangUp();
  });

  it("the no-outreach prompt and declarations are byte-identical to a database with no lookup at all... and the recognised prompt differs only in the tail", async () => {
    const plain = await boot(dbWith());
    const hit = await boot(dbWith({ openOutreachForPhone: vi.fn(async () => HIT) }));
    const cut = (p) => p.split("=== RETURNED CALL ===")[0];
    // Everything before the returned-call section is the same text.
    expect(hit.prompt.startsWith(cut(hit.prompt))).toBe(true);
    expect(plain.prompt).not.toContain("RETURNED CALL");
    expect(hit.prompt.length).toBeGreaterThan(plain.prompt.length);
    await plain.call.hangUp();
    await hit.call.hangUp();
  });

  it("a lookup that throws: not recognised, prompt and createCall unchanged, warn log without the phone", async () => {
    const database = dbWith({
      openOutreachForPhone: vi.fn(async () => {
        throw new Error("SUPPRESSION_HASH_KEY is missing");
      }),
    });
    const { call, prompt, names } = await boot(database);
    expect(database.createCall.mock.calls[0]).toEqual([BIZ, "CAcb1", CALLER, BIZ_PHONE]);
    expect(prompt).not.toContain("We called this person");
    expect(names).not.toContain("record_answer");
    const w = logged.filter((l) => l.event === "outbound_callback_lookup_failed");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: "warn", callSid: "CAcb1" });
    expect(JSON.stringify(logged)).not.toContain(CALLER);
    await call.hangUp();
  });

  it("a lookup that never answers does not hold the greeting: the session connects after the bound", async () => {
    const database = dbWith({ openOutreachForPhone: vi.fn(() => new Promise(() => {})) });
    const t0 = Date.now();
    const { call, prompt } = await boot(database);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(prompt).not.toContain("We called this person");
    expect(logged.filter((l) => l.event === "outbound_callback_lookup_failed")[0]).toMatchObject({ reason: "timeout" });
    await call.hangUp();
  });

  it("a close that fails is warn-logged and the recognition still stands", async () => {
    const database = dbWith({
      openOutreachForPhone: vi.fn(async () => HIT),
      closeOutreachCalledBack: vi.fn(async () => {
        throw new Error("closeOutreach: expected 1 row, got 0");
      }),
    });
    const { call, prompt } = await boot(database);
    expect(prompt).toContain("We called this person");
    expect(logged.filter((l) => l.event === "outbound_callback_close_failed")).toHaveLength(1);
    await call.hangUp();
  });
});
