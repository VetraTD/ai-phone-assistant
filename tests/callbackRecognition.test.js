// tests/callbackRecognition.test.js
/**
 * S4-1 (spec §12.3), no database: the prompt tail, the declarations, the
 * qualification pack's inbound widening, and the start helper's failure modes.
 * The database half is tests/db/callbackRecognition.test.js; the Live wiring is
 * tests/liveCallbackRecognition.test.js.
 *
 * INBOUND BYTE-IDENTITY. Without `callbackOutreach` nothing changes: for every
 * golden fixture the prompt and the declarations built with
 * `callbackOutreach: null` equal the ones built without the key (the existing
 * tests/__snapshots__/prompts files pin the latter). WITH a callback, the
 * static prefix (the cache unit) is still identical -- only the dynamic tail
 * grows a RETURNED CALL section. The callback snapshots live in their own
 * directory, tests/__snapshots__/prompts/callback/.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  buildSystemInstruction,
  buildStaticSystemPrefix,
  buildDynamicTail,
  buildAllDeclarations,
  buildCallbackSection,
} from "../services/gemini.js";
import { recognizeCallback, remainingQuestionsOf } from "../lib/outbound/callbackRecognition.js";
import qualification from "../capabilities/qualification.js";
import { FIXTURES } from "./fixtures/businessConfigs.js";

const FROZEN_NOW = new Date("2026-09-29T15:00:00Z");
beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
});
afterAll(() => vi.useRealTimers());

const CB = {
  outreachId: "out-1",
  campaignId: "camp-1",
  contactId: "con-1",
  lastAttemptAt: "2026-09-28T09:30:00.000Z",
  topic: "your clinic software enquiry",
  remainingQuestions: [
    { key: "team_size", ask: "How many people work there?", required: false },
    { key: "start_date", ask: "When would you like to start?", required: false },
  ],
};

describe("inbound byte-identity", () => {
  for (const [name, { config, extras }] of Object.entries(FIXTURES)) {
    it(`${name}: callbackOutreach null is the same prompt and declarations as no key`, () => {
      const withNull = { ...extras, callbackOutreach: null };
      expect(buildSystemInstruction("identify_intent", null, config, withNull)).toBe(
        buildSystemInstruction("identify_intent", null, config, extras)
      );
      expect(JSON.stringify(buildAllDeclarations(config, withNull))).toBe(JSON.stringify(buildAllDeclarations(config, extras)));
    });

    it(`${name}: with a callback the static prefix is unchanged and the tail only grows the section`, () => {
      const withCb = { ...extras, callbackOutreach: CB };
      expect(buildStaticSystemPrefix(config, withCb)).toBe(buildStaticSystemPrefix(config, extras));
      const plain = buildDynamicTail("identify_intent", null, config, extras);
      const tail = buildDynamicTail("identify_intent", null, config, withCb);
      const section = buildCallbackSection(CB, config.timezone);
      expect(section).toContain("=== RETURNED CALL ===");
      // Sections are joined by a blank line: remove the section and one join.
      const stripped = tail.includes(section + "\n\n") ? tail.replace(section + "\n\n", "") : tail.replace("\n\n" + section, "");
      expect(stripped).toBe(plain);
    });
  }

  it("callback snapshots (own directory)", async () => {
    const { config, extras } = FIXTURES["messages-only"];
    const withCb = { ...extras, callbackOutreach: CB };
    await expect(buildDynamicTail("identify_intent", null, config, withCb)).toMatchFileSnapshot(
      "./__snapshots__/prompts/callback/messages-only.tail.identify_intent.txt"
    );
    await expect(JSON.stringify(buildAllDeclarations(config, withCb), null, 2)).toMatchFileSnapshot(
      "./__snapshots__/prompts/callback/messages-only.tools.json"
    );
  });

  it("with a callback, record_answer is the ONLY addition; schedule_callback and the platform packs stay undeclared", () => {
    const { config, extras } = FIXTURES["messages-only"];
    const base = buildAllDeclarations(config, extras).map((d) => d.name);
    const cb = buildAllDeclarations(config, { ...extras, callbackOutreach: CB }).map((d) => d.name);
    expect(cb.filter((n) => !base.includes(n))).toEqual(["record_answer"]);
    for (const n of ["schedule_callback", "record_outcome", "opt_out"]) expect(cb).not.toContain(n);
  });

  it("nothing left to ask: no record_answer", () => {
    const { config, extras } = FIXTURES["messages-only"];
    const names = buildAllDeclarations(config, { ...extras, callbackOutreach: { ...CB, remainingQuestions: [] } }).map((d) => d.name);
    expect(names).not.toContain("record_answer");
  });
});

describe("buildCallbackSection", () => {
  it("renders the date in the BUSINESS timezone (weekday day month)", () => {
    const late = { ...CB, lastAttemptAt: "2026-09-28T23:30:00.000Z" };
    expect(buildCallbackSection(late, "Europe/London")).toContain("on Tuesday 29 September about");
    expect(buildCallbackSection(late, "America/Chicago")).toContain("on Monday 28 September about");
  });
  it("omits 'about' with no topic, and the questions sentence with none remaining", () => {
    const s = buildCallbackSection({ ...CB, topic: null, remainingQuestions: [] }, "Europe/London");
    expect(s).toMatch(/We called this person on Monday 28 September\.$/);
    expect(s).not.toContain("about");
    expect(s).not.toContain("Questions still unanswered");
  });
  it("lists the questions in the model-facing words, not the keys", () => {
    const s = buildCallbackSection(CB, "Europe/London");
    expect(s).toContain("Questions still unanswered: How many people work there? / When would you like to start?.");
    expect(s).not.toContain("team_size");
  });
  it("returns '' with no callback", () => {
    expect(buildCallbackSection(null, "Europe/London")).toBe("");
    expect(buildCallbackSection(undefined, "Europe/London")).toBe("");
  });
});

describe("qualification pack on inbound", () => {
  const fc = (args) => ({ id: "1", name: "record_answer", args });
  it("declares only with a callback that has questions left; the static prompt stays empty", () => {
    expect(qualification.tools({}, {})).toEqual([]);
    expect(qualification.tools({}, { callbackOutreach: { ...CB, remainingQuestions: [] } })).toEqual([]);
    const [d] = qualification.tools({}, { callbackOutreach: CB });
    expect(d.parameters.properties.key.enum).toEqual(["team_size", "start_date"]);
    expect(d.parameters.properties.key.description).toContain('team_size = "How many people work there?"');
    expect(qualification.prompt({}, { callbackOutreach: CB })).toEqual({ static: { capabilities: [] } });
  });
  it("execute accepts a remaining key and refuses an answered one; writes via mergeCallAnswers", async () => {
    const merge = vi.fn(async () => {});
    const ok = await qualification.execute(fc({ key: "team_size", value: "4" }), {
      callSid: "CA1",
      callbackOutreach: CB,
      deps: { mergeCallAnswers: merge },
    });
    expect(ok.functionResponse.response.success).toBe(true);
    expect(merge).toHaveBeenCalledWith("CA1", { team_size: "4" });
    const no = await qualification.execute(fc({ key: "clinic_name", value: "x" }), { callSid: "CA1", callbackOutreach: CB, deps: { mergeCallAnswers: merge } });
    expect(no.functionResponse.response.success).toBe(false);
    expect(merge).toHaveBeenCalledTimes(1);
  });
  it("an ordinary inbound call refuses every key", async () => {
    const merge = vi.fn();
    const r = await qualification.execute(fc({ key: "team_size", value: "4" }), { callSid: "CA1", deps: { mergeCallAnswers: merge } });
    expect(r.functionResponse.response.success).toBe(false);
    expect(merge).not.toHaveBeenCalled();
  });
});

describe("remainingQuestionsOf", () => {
  it("drops answered keys and questions without a key or ask; never returns keys starting with _", () => {
    const out = remainingQuestionsOf(
      [{ key: "a", ask: "A?" }, { key: "b", ask: " " }, { key: "c" }, { ask: "?" }, { key: "d", ask: "D?", required: true }],
      ["a"]
    );
    expect(out).toEqual([{ key: "d", ask: "D?", required: true }]);
    expect(remainingQuestionsOf(undefined, undefined)).toEqual([]);
  });
});

describe("recognizeCallback failure modes", () => {
  const log = () => ({ info: vi.fn(), error: vi.fn() });
  const HIT = { outreachId: "o", campaignId: "c", contactId: "k", lastAttemptAt: new Date(), topic: "t", questions: [], answeredKeys: [] };

  it("no caller number (withheld) -> null without touching the database", async () => {
    const database = { openOutreachForPhone: vi.fn() };
    expect(await recognizeCallback({ database, businessId: "b", callerPhone: "" })).toBeNull();
    expect(database.openOutreachForPhone).not.toHaveBeenCalled();
  });
  it("a database object without the lookup (a missing wire) -> null WITH a warn log, not silence", async () => {
    const l = log();
    expect(await recognizeCallback({ database: {}, businessId: "b", callerPhone: "+447700900001", callSid: "CA1", log: l })).toBeNull();
    expect(l.error).toHaveBeenCalledWith("outbound_callback_lookup_failed", expect.objectContaining({ severity: "warn" }));
  });
  it("logs carry no phone number", async () => {
    const l = log();
    const database = { openOutreachForPhone: async () => { throw new Error("boom"); } };
    await recognizeCallback({ database, businessId: "b", callerPhone: "+447700900001", callSid: "CA1", log: l });
    expect(JSON.stringify(l.error.mock.calls)).not.toContain("447700900001");
  });
  it("a hit closes called_back once and returns ISO date + remaining questions", async () => {
    const l = log();
    const database = { openOutreachForPhone: async () => HIT, closeOutreachCalledBack: vi.fn(async () => {}) };
    const r = await recognizeCallback({ database, businessId: "b", callerPhone: "+447700900001", log: l });
    expect(database.closeOutreachCalledBack).toHaveBeenCalledWith("o");
    expect(r).toMatchObject({ outreachId: "o", campaignId: "c", contactId: "k", topic: "t", remainingQuestions: [] });
    expect(typeof r.lastAttemptAt).toBe("string");
  });
});
