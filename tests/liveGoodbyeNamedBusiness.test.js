/**
 * Caller-experience Task 6: the goodbye counters. Every goodbye armed by
 * signOffRe bumps intake.goodbye_turns; one that says the business's own name
 * also bumps intake.goodbye_named_business and logs a closed-field event.
 * Inbound only. Every line and name is invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";
import { bootOutboundCall } from "./helpers/outboundBoot.js";

const CONFIG = {
  businessName: "Brightwork Plumbing",
  greeting: "Thanks for calling.",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  locale: "en-US",
  allowedTasks: ["general_question", "take_message"],
  capabilities: {},
};

beforeEach(() => clearStats());

async function record(run) {
  const lines = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    if (typeof chunk === "string") lines.push(...chunk.split("\n"));
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  const parse = (ev) => lines.filter((l) => l.includes(`"event":"${ev}"`)).map((l) => JSON.parse(l));
  const summaries = parse("live_call_summary");
  expect(summaries).toHaveLength(1);
  return { intake: summaries[0].intake, named: parse("live_goodbye_named_business"), raw: lines.join("\n") };
}

async function goodbye(config, text, opts = {}) {
  return record(async () => {
    const s = await bootLive({ config, callSid: "CA_bye", ...opts });
    await s.assistantTurn("Thanks for calling.");
    await s.callerSays("No, that's all thanks.");
    await s.assistantTurn(text);
    await s.hangUp();
  });
}

describe("goodbye counters", () => {
  it("a goodbye that says the business name bumps both counters and logs a closed event", async () => {
    const text = "Thanks for calling Brightwork Plumbing, have a great day!";
    const { intake, named, raw } = await goodbye(CONFIG, text);
    expect(intake.goodbye_turns).toBe(1);
    expect(intake.goodbye_named_business).toBe(1);
    expect(named).toHaveLength(1);
    expect(named[0].callSid).toBe("CA_bye");
    expect(JSON.stringify(named[0])).not.toMatch(/brightwork|thanks|great day/i);
    // The caller-audible words are never logged.
    expect(raw).not.toContain(text);
  });

  it("the name check ignores case and extra spaces", async () => {
    const { intake } = await goodbye(CONFIG, "Thank you for calling   BRIGHTWORK   plumbing, have a great day!");
    expect(intake.goodbye_named_business).toBe(1);
  });

  it("a plain goodbye bumps only goodbye_turns", async () => {
    const { intake, named } = await goodbye(CONFIG, "Thanks for calling, have a wonderful day");
    expect(intake.goodbye_turns).toBe(1);
    expect(intake.goodbye_named_business).toBe(0);
    expect(named).toHaveLength(0);
  });

  it("a Spanish goodbye without the name bumps only goodbye_turns", async () => {
    const es = { ...CONFIG, languagesSpoken: ["es"] };
    const { intake } = await goodbye(es, "Gracias por llamar. ¡Que tenga un buen día!");
    expect(intake.goodbye_turns).toBe(1);
    expect(intake.goodbye_named_business).toBe(0);
  });

  it("a name under three letters is never matched", async () => {
    const short = { ...CONFIG, businessName: "Jo" };
    const { intake } = await goodbye(short, "Thanks for calling Jo, have a great day!");
    expect(intake.goodbye_turns).toBe(1);
    expect(intake.goodbye_named_business).toBe(0);
  });

  it("a turn that is not a goodbye counts nothing, even with the name in it", async () => {
    const { intake } = await goodbye(CONFIG, "Brightwork Plumbing is open until six today.");
    expect(intake.goodbye_turns).toBe(0);
    expect(intake.goodbye_named_business).toBe(0);
  });
});

describe("outbound is unchanged", () => {
  it("a goodbye that says the business name counts nothing and logs nothing", async () => {
    const { intake, named } = await record(async () => {
      const x = await bootOutboundCall(CONFIG);
      await x.s.callerSays("No, that's all thanks.");
      await x.s.assistantTurn("Thanks for calling Brightwork Plumbing, have a great day!");
      await x.s.hangUp();
    });
    expect(intake.goodbye_turns).toBe(0);
    expect(intake.goodbye_named_business).toBe(0);
    expect(named).toHaveLength(0);
  });
});
