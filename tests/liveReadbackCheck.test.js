/**
 * Caller-experience Task 6: a message read-back should end in a check, and a
 * spelled read-back spoken in the same turn as the message save is counted.
 *
 * Scope of the read-back counters: the turn that carries a MESSAGE save and the
 * first assistant turn after it; inbound only. A turn in scope that reads back
 * contact details or spelled letters bumps intake.readbacks, and
 * intake.readbacks_without_check when none of its question sentences (the
 * closing question aside) checks the read-back.
 *
 * S4-B5 (prod call, 2026-11-13): the spelled letters were spoken in the same
 * turn that carried the record_customer_request save, and confirm.readbacks
 * read 0 / readback_spelled_missing 1 with the spelling flag set. Names and
 * numbers here are invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/notifications.js", () => ({
  notifyAppointmentBooked: vi.fn(async () => {}),
  notifyCustomerRequest: vi.fn(async () => true),
  notifyUnconfirmedClaim: vi.fn(async () => {}),
  sendCallerSms: vi.fn(async () => {}),
  MESSAGE_SLA_TEXT: "as soon as possible",
}));

import { bootLive, fakeDb } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";
import { getStrings, READBACK_CHECK_RE } from "../lib/voice/strings.js";
import { readbackHasCheck } from "../lib/voice/askLedger.js";

const EN = getStrings("en");
const ES = getStrings({ languagesSpoken: ["es"] });

const CONFIG = {
  businessName: "Brightwork Plumbing",
  greeting: "Thanks for calling.",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  locale: "en-US",
  allowedTasks: ["general_question", "take_message", "callback_request"],
  capabilities: {},
};
const MESSAGE = {
  request_type: "message",
  caller_name: "Jon Doe",
  callback_number: "214 555 0123",
  message: "about the invoice",
};
const READ_BACK = "So that's Jon, J-O-N, Doe, D-O-E, on 2 1 4, 5 5 5, 0 1 2 3, about the invoice.";
const CLOSING = "Is there anything else I can help you with?";

describe("READBACK_CHECK_RE", () => {
  it("is exported per language and on each strings table", () => {
    expect(READBACK_CHECK_RE.en).toBe(EN.readbackCheckRe);
    expect(READBACK_CHECK_RE.es).toBe(ES.readbackCheckRe);
  });
  it.each([
    "Is that right?",
    "Did I get that right?",
    "Have I got that correct?",
    "Is that all correct?",
    "Does that sound right?",
    "So that's R-A-M-A-N, right?",
    "Is everything correct?",
  ])("EN checks: %s", (s) => expect(EN.readbackCheckRe.test(s)).toBe(true));
  it("ES checks", () => expect(ES.readbackCheckRe.test("¿Es correcto?")).toBe(true));
  it.each([
    "Is there anything else I can help you with?",
    "Is there anything else?",
    "Right, let me take that down.",
    "That's right, they'll call you back.",
  ])("EN does not: %s", (s) => expect(EN.readbackCheckRe.test(s)).toBe(false));
  it("ES does not", () => expect(ES.readbackCheckRe.test("¿Algo más en que le pueda ayudar?")).toBe(false));
});

describe("readbackHasCheck: question sentences only, closing question excluded", () => {
  const has = (t) => readbackHasCheck(t, EN.readbackCheckRe);
  it("a statement that says 'have it right' is not a check", () => {
    expect(has("Just so I have it right, I'll pass that on. That way I can make sure I have it right.")).toBe(false);
  });
  it("the closing question is not a check", () => {
    expect(has(`${READ_BACK} ${CLOSING}`)).toBe(false);
  });
  it("a question sentence that checks is", () => {
    expect(has(`${READ_BACK} Is that right?`)).toBe(true);
  });
  it("a question sentence that itself carries the read-back is", () => {
    expect(has("So, just to confirm, that's four six nine, nine three three, eight eight eight seven?")).toBe(true);
  });
});

let prior;
beforeEach(() => {
  clearStats();
  prior = process.env.VOICE_SPELL_POLICY;
  process.env.VOICE_SPELL_POLICY = "off";
});
afterEach(() => {
  if (prior === undefined) delete process.env.VOICE_SPELL_POLICY;
  else process.env.VOICE_SPELL_POLICY = prior;
});

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
  const summaries = lines.filter((l) => l.includes('"event":"live_call_summary"')).map((l) => JSON.parse(l));
  expect(summaries).toHaveLength(1);
  return summaries[0];
}

function storeDb() {
  const rows = [];
  let tenant = null;
  return {
    ...fakeDb(CONFIG, "biz-1"),
    withTenantSafe: async (id, fn) => {
      const previous = tenant;
      tenant = id;
      try {
        return await fn();
      } finally {
        tenant = previous;
      }
    },
    createCustomerRequest: vi.fn(async (r) => {
      if (tenant !== r.businessId) return null;
      rows.push({ id: `req-${rows.length + 1}`, ...r });
      return `req-${rows.length}`;
    }),
    listCallCustomerRequests: vi.fn(async () => []),
    updateCustomerRequest: vi.fn(async () => null),
  };
}

/** The caller has given their details, spelled; the next turn's words are the read-back. */
async function boot(callSid) {
  const s = await bootLive({ config: CONFIG, database: storeDb(), callSid });
  await s.callerSays("It's Jon Doe, J O N, D O E, 214 555 0123, it's about the invoice.");
  await s.assistantTurn("Thanks, one moment.");
  await s.callerSays("Yes, that's right.");
  return s;
}

async function save(s) {
  const [res] = await s.callTool("record_customer_request", MESSAGE);
  expect(res?.response?.success).toBe(true);
}

describe("the read-back check counter", () => {
  it("S4 shape: letters then straight into the closing question bumps both counters", async () => {
    const summary = await record(async () => {
      const s = await boot("CA_rb_1");
      await s.assistantSays(READ_BACK);
      await save(s);
      await s.assistantSays(CLOSING);
      await s.turnEnds();
      await s.hangUp();
    });
    expect(summary.intake.readbacks).toBe(1);
    expect(summary.intake.readbacks_without_check).toBe(1);
  });

  it("a read-back that ends in a check bumps only readbacks", async () => {
    const summary = await record(async () => {
      const s = await boot("CA_rb_2");
      await s.assistantSays(`${READ_BACK} Is that right?`);
      await save(s);
      await s.turnEnds();
      await s.hangUp();
    });
    expect(summary.intake.readbacks).toBe(1);
    expect(summary.intake.readbacks_without_check).toBe(0);
  });

  it("the first assistant turn AFTER the save is in scope; the one after that is not", async () => {
    const summary = await record(async () => {
      const s = await boot("CA_rb_3");
      await s.assistantSays("Passing that on now.");
      await save(s);
      await s.turnEnds();
      await s.callerSays("Thanks.");
      await s.assistantTurn(`${READ_BACK} ${CLOSING}`);
      await s.callerSays("Thanks.");
      await s.assistantTurn(`${READ_BACK} ${CLOSING}`);
      await s.hangUp();
    });
    expect(summary.intake.readbacks).toBe(1);
    expect(summary.intake.readbacks_without_check).toBe(1);
  });

  it("a contact read-back with no message save counts nothing", async () => {
    const summary = await record(async () => {
      const s = await boot("CA_rb_4");
      await s.assistantTurn(`${READ_BACK} ${CLOSING}`);
      await s.hangUp();
    });
    expect(summary.intake.readbacks).toBe(0);
    expect(summary.intake.readbacks_without_check).toBe(0);
  });

  it("a save turn with no read-back counts nothing", async () => {
    const summary = await record(async () => {
      const s = await boot("CA_rb_5");
      await s.assistantSays("Passing that on now.");
      await save(s);
      await s.assistantSays(CLOSING);
      await s.turnEnds();
      await s.hangUp();
    });
    expect(summary.intake.readbacks).toBe(0);
    expect(summary.intake.readbacks_without_check).toBe(0);
  });
});

describe("S4-B5: a spelled read-back in the same turn as the message save", () => {
  it("is counted as spelled, not missing", async () => {
    const summary = await record(async () => {
      const s = await boot("CA_rb_spell");
      await s.assistantSays(READ_BACK);
      await save(s);
      await s.assistantSays(CLOSING);
      await s.turnEnds();
      await s.hangUp();
    });
    expect(summary.confirm.readback_spelled).toBe(1);
    expect(summary.confirm.readback_spelled_missing).toBe(0);
  });

  it("with a real caller ID there is no number in the read-back: the saved name's letters are enough", async () => {
    const summary = await record(async () => {
      const s = await boot("CA_rb_nonum");
      await s.assistantSays(
        "So that's Jon, J-O-N, Doe, D-O-E, about the invoice, and they'll call you back on the number you're calling from."
      );
      await save(s);
      await s.assistantSays(CLOSING);
      await s.turnEnds();
      await s.hangUp();
    });
    expect(summary.confirm.readback_spelled).toBe(1);
    expect(summary.confirm.readback_spelled_missing).toBe(0);
  });

  it("letters spoken in an earlier turn since the last save count, tested against the saved name", async () => {
    const summary = await record(async () => {
      const s = await boot("CA_rb_earlier");
      await s.assistantTurn("So that's Jon, J-O-N, Doe, D-O-E, about the invoice, is that right?");
      await s.callerSays("Yes.");
      await s.assistantSays("Passing that on now.");
      await save(s);
      await s.turnEnds();
      await s.hangUp();
    });
    expect(summary.confirm.readback_spelled).toBe(1);
    expect(summary.confirm.readback_spelled_missing).toBe(0);
  });

  it("the business spelling its own name in the save turn does not count", async () => {
    const summary = await record(async () => {
      const s = await boot("CA_rb_own");
      await s.assistantSays("We are Brightwork, B-R-I-G-H-T-W-O-R-K, by the way.");
      await save(s);
      await s.turnEnds();
      await s.hangUp();
    });
    expect(summary.confirm.readback_spelled).toBe(0);
    expect(summary.confirm.readback_spelled_missing).toBe(1);
  });

  it("a message read-back with no letters is still missing", async () => {
    const summary = await record(async () => {
      const s = await boot("CA_rb_nospell");
      await s.assistantSays("So that's Jon Doe on 2 1 4, 5 5 5, 0 1 2 3 about the invoice.");
      await save(s);
      await s.turnEnds();
      await s.hangUp();
    });
    expect(summary.confirm.readback_spelled).toBe(0);
    expect(summary.confirm.readback_spelled_missing).toBe(1);
  });
});
