// tests/outboundPromptSnapshot.test.js
/**
 * OUTBOUND PROMPT. Since 2026-09-30 (owner decision, "two binders, one
 * rulebook") the outbound prompt is its OWN build -- services/gemini.js
 * buildOutboundSystemInstruction, reached through the one switch
 * buildSystemInstruction -- not the receptionist prompt with a block
 * appended. So each outbound fixture is pinned as ONE full prompt
 * (`<name>.prompt.txt`, read in full before it was accepted) plus its tool
 * declarations (`<name>.tools.json`, unchanged by the split: the tool set did
 * not move).
 *
 * tests/promptSnapshot.test.js (the inbound goldens) stays untouched: it
 * iterates FIXTURES; this iterates OUTBOUND_FIXTURES, into its own directory.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  buildSystemInstruction,
  buildStaticSystemPrefix,
  buildDynamicTail,
  buildAllDeclarations,
} from "../services/gemini.js";
import { OUTBOUND_FIXTURES, WEEKLY_HOURS } from "./fixtures/businessConfigs.js";
import { claimsRecording, TRANSCRIPTION_DISCLOSURE } from "../lib/voice/disclosure.js";

const FROZEN_NOW = new Date("2026-07-20T15:00:00Z"); // a Monday, inside business hours
const SNAP_DIR = "./__snapshots__/prompts/outbound";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

/** The prompt an outbound Live session is actually given (lib/voice/live/index.js). */
const promptFor = (config, extras) => buildSystemInstruction("identify_intent", null, config, extras);

describe("outbound prompt snapshots", () => {
  for (const [name, { config, extras }] of Object.entries(OUTBOUND_FIXTURES)) {
    describe(name, () => {
      it("full outbound prompt", async () => {
        await expect(promptFor(config, extras)).toMatchFileSnapshot(`${SNAP_DIR}/${name}.prompt.txt`);
      });

      it("tool declarations", async () => {
        const declarations = buildAllDeclarations(config, extras);
        await expect(JSON.stringify(declarations, null, 2)).toMatchFileSnapshot(`${SNAP_DIR}/${name}.tools.json`);
      });
    });
  }
});

describe("the switch (owner decision 2026-09-30): one decision by direction picks the builder", () => {
  const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];

  it("the prompt is step-independent on outbound (Live freezes it at connect; the plan is in the job prompt)", () => {
    expect(buildSystemInstruction("gather_details", "book_appointment", config, extras)).toBe(promptFor(config, extras));
  });

  it("the inbound halves refuse an outbound call context -- they never quietly build a receptionist prompt for one", () => {
    expect(() => buildStaticSystemPrefix(config, extras)).toThrow(/outbound/);
    expect(() => buildDynamicTail("identify_intent", null, config, extras)).toThrow(/outbound/);
  });

  it("inbound control: the same config without outboundCall still builds the receptionist prompt", () => {
    const { outboundCall, ...inboundLikeExtras } = extras;
    expect(buildSystemInstruction("identify_intent", null, config, inboundLikeExtras)).toMatch(/You are a warm, professional receptionist/);
  });
});

describe("SITUATIONS section (spec §19, S3-D1) — integration check through the full outbound prompt", () => {
  // The table-driven coverage of every row lives in tests/outboundPrompt.test.js
  // (direct unit test of outboundCallBlock); this checks the rows reach the
  // assembled prompt.
  const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
  const block = promptFor(config, extras);

  it("contains the job prompt's three headings, in order", () => {
    const a = block.indexOf("=== THIS CALL ===");
    const b = block.indexOf("=== CALL PLAN ===");
    const c = block.indexOf("=== SITUATIONS ===");
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  const rows = [
    ["the person themselves", /the person themselves/i],
    ["a gatekeeper (S3-D1a) gets the vague reason only, never the topic", /A gatekeeper.*never the topic/is],
    ["a household member or possible child (S3-D1b): one availability question only", /one availability question only/i],
    ["never ask a child anything else", /never ask a child anything else/i],
    ["a wrong number: apologise", /A wrong number.*apologise/is],
    ["a call screener: name and the enquiry once, then wait", /call-screening assistant/i],
    ["a bad time or driving gets a specific callback offer", /A bad time or driving.*callback/is],
    ['"email me instead" -> someone will email, ends kindly', /Email me instead.*follow up by email/is],
    ['"is this a sales call?" -> honest follow-up reason', /Is this a sales call\?.*follow-up/is],
    ['"already booked" \/ "already a customer" -> apologise and end', /Already booked.*already a customer.*apologise/is],
    ["hostile -> apologise once, offer to stop calling, end", /Hostile.*offer to stop calling/is],
    ["a bad line or unusable reply -> ask once, then offer a callback", /A bad line or an unusable reply.*callback/is],
    ['"stop calling" is honoured immediately', /Stop calling.*take me off your list/i],
    ['"are you a robot" gets "yes, an AI assistant"', /Are you a robot.*an AI assistant/is],
    ["a voicemail greeting that got past AMD: no message, nothing about why", /voicemail greeting.*leave no message/is],
  ];
  for (const [label, re] of rows) {
    it(`covers: ${label}`, () => {
      expect(block).toMatch(re);
    });
  }

  it("no inbound ask-gate phrasing ('anything else I can help/assist')", () => {
    expect(block).not.toMatch(/anything else (?:that )?(?:I|we) can (?:help|assist)/i);
  });

  it("D3: the number rule is present", () => {
    expect(block).toMatch(/never ask for a phone number/i);
  });

  it("D7: the closing rule is present, verbatim", () => {
    expect(block).toContain(
      "To end the call: confirm the next step in one sentence, thank them by name, say goodbye, then end the call. " +
        "You placed this call, so never ask whether there is anything else you can help with."
    );
  });
});

describe("first-turn rule and disclosure (spec §9.3/§9.5, O-2)", () => {
  it("no claimsRecording match anywhere in any outbound prompt", () => {
    for (const [name, { config, extras }] of Object.entries(OUTBOUND_FIXTURES)) {
      expect(claimsRecording(promptFor(config, extras)), name).toBe(false);
    }
  });

  it("states the first-turn rule: persona name, 'AI assistant', business name", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const full = promptFor(config, extras);
    expect(full).toContain(extras.outboundCall.config.persona_name);
    expect(full).toContain("AI assistant");
    expect(full).toContain(config.businessName);
    // 2026-10-01: live mode (the default) states it as FIRST REPLY rule 2;
    // the clip rollback keeps its own sentence.
    expect(full).toMatch(/2\. Say who you are -- your name \(Ava\), that you are an AI assistant/);
    expect(full).toMatch(/never claim to be human/i);
    const clip = OUTBOUND_FIXTURES["speed-to-lead-clip"];
    expect(promptFor(clip.config, clip.extras)).toMatch(/first reply must include your name/i);
  });

  it("O-2 flag ON: the first reply must also carry the transcription notice, deferred to the next reply if the opener was already seeded", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead-disclosure-on"];
    const full = promptFor(config, extras);
    expect(full).toContain(TRANSCRIPTION_DISCLOSURE);
    // 2026-10-01: live mode has no seeded opener, so no deferral clause; the
    // clip rollback keeps it.
    expect(full).toMatch(/Your first reply must also give this notice, word for word/);
    expect(full).not.toMatch(/give this notice instead in your very next reply/i);
    const clipExtras = { ...extras, outboundCall: { ...extras.outboundCall, firstSpeaker: "clip" } };
    expect(promptFor(config, clipExtras)).toMatch(/give this notice instead in your very next reply/i);
  });

  it("O-2 flag OFF: the notice is given on request only", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    expect(config.recordingDisclosureEnabled).toBeFalsy();
    const full = promptFor(config, extras);
    expect(full).toMatch(/if they ask about recording or being transcribed/i);
    expect(full).toContain(TRANSCRIPTION_DISCLOSURE);
  });
});

describe("O-9: no first name on file", () => {
  it("tells Ava she does not know the person's name, and the reason waits until they have confirmed who they are", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead-no-first-name"];
    const full = promptFor(config, extras);
    expect(full).toMatch(/do not know this person's name/i);
    expect(full).toMatch(/once they have confirmed who they are/i);
    expect(full).toMatch(/Once they confirm who they are and that they made the enquiry, call confirm_identity/);
  });
});

describe("inbound-only framing never reaches the outbound prompt (O-10 / O-11, now structural)", () => {
  it("no intent step guidance and no set_call_intent instruction", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const full = promptFor(config, extras);
    expect(full).not.toMatch(/Your task: Figure out why the caller is calling/i);
    expect(full).not.toMatch(/CURRENT TASK AND STATE/);
    expect(full).not.toContain("set_call_intent");
  });

  it("O-11: AFTER-HOURS BEHAVIOR is absent even when the tenant's own office is closed right now", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const closedConfig = { ...config, businessHours: { ...WEEKLY_HOURS, mon: { open: null, close: null, closed: true } } };
    const full = promptFor(closedConfig, extras);
    expect(full).not.toMatch(/AFTER-HOURS BEHAVIOR/);
    expect(full).not.toMatch(/office is currently CLOSED/i);
  });

  it("O-11 control: the SAME closed config renders AFTER-HOURS BEHAVIOR on inbound (extras.outboundCall absent)", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const { outboundCall, ...inboundLikeExtras } = extras;
    const closedConfig = { ...config, businessHours: { ...WEEKLY_HOURS, mon: { open: null, close: null, closed: true } } };
    const tail = buildDynamicTail("identify_intent", null, closedConfig, inboundLikeExtras);
    expect(tail).toMatch(/=== AFTER-HOURS BEHAVIOR ===/);
    expect(tail).toMatch(/office is currently CLOSED/i);
  });
});

describe("D-b regression guard: THIS CALLER'S NUMBER stays absent even when extras.callerPhone IS populated", () => {
  it("no THIS CALLER'S NUMBER block, and the number itself never appears, when callerPhone is populated on an outbound extras bag", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const withCallerPhone = { ...extras, callerPhone: "+15559876543" };
    const full = promptFor(config, withCallerPhone);
    expect(full).not.toMatch(/THIS CALLER'S NUMBER/);
    expect(full).not.toContain("+15559876543");
    expect(full).not.toContain("555 987 6543");
  });
});

describe("D-c + O-1: outbound tool set = campaign capabilities ∩ tenant packs, plus end_call and set_call_intent", () => {
  it("book_appointment and request_transfer survive (tenant has them, the campaign lists appointments+transfer)", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const names = buildAllDeclarations(config, extras).map((d) => d.name);
    expect(names).toContain("set_call_intent");
    expect(names).toContain("end_call");
    expect(names).toContain("book_appointment");
    expect(names).toContain("request_transfer");
  });

  it("record_customer_request does NOT survive: the tenant has it (CORE, take_message), but the campaign never lists messages", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const names = buildAllDeclarations(config, extras).map((d) => d.name);
    expect(names).not.toContain("record_customer_request");
  });

  it("confirm_identity is present — Task 18 has landed", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const names = buildAllDeclarations(config, extras).map((d) => d.name);
    expect(names).toContain("confirm_identity");
  });

  it("confirm_identity is absent on inbound (extras.outboundCall missing)", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const { outboundCall, ...inboundLikeExtras } = extras;
    const names = buildAllDeclarations(config, inboundLikeExtras).map((d) => d.name);
    expect(names).not.toContain("confirm_identity");
  });

  it("Ruling P-4: webhook integration tools are excluded on outbound even when extras.integrations carries one", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const withWebhook = {
      ...extras,
      integrations: [
        {
          enabled: true,
          provider: "webhook",
          name: "open_case_file",
          config: { params_schema: { type: "object" } },
        },
      ],
    };
    const inboundNames = buildAllDeclarations(config, extras).map((d) => d.name);
    const outboundNames = buildAllDeclarations(config, withWebhook).map((d) => d.name);
    expect(outboundNames).toEqual(inboundNames);
    expect(outboundNames).not.toContain("open_case_file");
  });

  // S3-3 supersedes this item's old name and assertion; S3-10 supersedes it
  // again now that `qualification` has a real pack too. `callback`/
  // `opt_out`/`outcome` shipped in S3-3, `qualification` in S3-10, and this
  // fixture's own campaign config lists all four (see
  // tests/fixtures/businessConfigs.js) -- so "keeps exactly the engine
  // tools" is no longer true even without the PLATFORM_PACKS union, since
  // the campaign names them itself.
  it("a campaign that lists only qualification plus the S3-3 platform capabilities gets the engine tools plus record_answer and the three platform tools, nothing else", () => {
    const { config, extras } = OUTBOUND_FIXTURES["missed-call-callback"];
    const names = buildAllDeclarations(config, extras).map((d) => d.name);
    // confirm_identity (Task 18) is unconditional on outbound, like end_call
    // and set_call_intent — it never passes through the campaign-capability
    // filter because it is not a capability pack's tool. record_answer
    // (S3-10) is a CAMPAIGN pack: declared because this fixture's own
    // campaign capabilities list names "qualification" (unlike the three
    // below, it is NOT unioned in when the campaign omits it — see the next
    // test). set_call_outcome/schedule_callback/opt_out (S3-3) are
    // PLATFORM_PACKS -- declared regardless of what the campaign's own
    // capabilities list says, and this fixture's config also lists them
    // explicitly (a harmless, idempotent union either way). Order is
    // registry order (capabilities/index.js): qualification, outcome,
    // callback, opt_out.
    expect(names).toEqual([
      "set_call_intent",
      "end_call",
      "confirm_identity",
      // 2026-10-01: the engine's hold tool, live mode (this fixture's default).
      "wait_on_hold",
      "record_answer",
      "set_call_outcome",
      "schedule_callback",
      "opt_out",
    ]);
  });

  // S3-10, named risk 3/companion to the test above: unlike the three
  // PLATFORM_PACKS, qualification is never unioned in when the campaign
  // omits it -- its own tools() gates on config.capabilities directly (see
  // capabilities/qualification.js), so leaving "qualification" off the list
  // must leave record_answer off the declarations too.
  it("record_answer is absent when the campaign's own capabilities list omits qualification", () => {
    const { config, extras } = OUTBOUND_FIXTURES["missed-call-callback"];
    const withoutQualification = {
      ...extras,
      outboundCall: {
        ...extras.outboundCall,
        config: {
          ...extras.outboundCall.config,
          capabilities: extras.outboundCall.config.capabilities.filter((c) => c !== "qualification"),
        },
      },
    };
    const names = buildAllDeclarations(config, withoutQualification).map((d) => d.name);
    expect(names).not.toContain("record_answer");
  });

  it("PLATFORM_PACKS survive even when a campaign's own capabilities list omits them entirely", () => {
    const { config, extras } = OUTBOUND_FIXTURES["missed-call-callback"];
    const withoutPlatformCaps = {
      ...extras,
      outboundCall: { ...extras.outboundCall, config: { ...extras.outboundCall.config, capabilities: ["qualification"] } },
    };
    const names = buildAllDeclarations(config, withoutPlatformCaps).map((d) => d.name);
    expect(names).toContain("set_call_outcome");
    expect(names).toContain("schedule_callback");
    expect(names).toContain("opt_out");
  });

  it("without extras.outboundCall, the tool builders are unaffected (inbound-shape control; promptSnapshot.test.js has the byte-identical proof)", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const { outboundCall, ...inboundLikeExtras } = extras;
    const names = buildAllDeclarations(config, inboundLikeExtras).map((d) => d.name);
    // record_customer_request and request_transfer are CORE on inbound: both
    // present the moment outboundCall is gone, unlike on the outbound branch
    // above.
    expect(names).toContain("record_customer_request");
    expect(names).toContain("request_transfer");
  });
});

describe("Ruling 16-b (carried from Task 16, fulfilled by Task 18): get_caller_appointments_from_db's description", () => {
  it("does not claim it uses 'the number the caller is calling from' on outbound — that field is deliberately empty (P-3)", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const decl = buildAllDeclarations(config, extras).find((d) => d.name === "get_caller_appointments_from_db");
    expect(decl).toBeTruthy();
    expect(decl.description).not.toMatch(/the caller is calling from/i);
    expect(decl.description).toMatch(/confirm_identity/);
  });

  it("keeps the stock wording on inbound, byte-identical", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const { outboundCall, ...inboundLikeExtras } = extras;
    const decl = buildAllDeclarations(config, inboundLikeExtras).find(
      (d) => d.name === "get_caller_appointments_from_db"
    );
    expect(decl.description).toMatch(/the number the caller is calling from/i);
  });
});

describe("D-c extends to prompt TEXT, not only tool declarations", () => {
  // messages/transfer are `core: true` (capabilities/messages.js,
  // capabilities/transfer.js) and used to contribute their static prompt
  // fragments UNCONDITIONALLY, regardless of what the campaign lists --
  // "messages" is not even a legal outbound campaign capability
  // (lib/outbound/campaignSchema.js CAMPAIGN_ENUMS.capabilities), so the
  // MESSAGE PROTOCOL section (naming record_customer_request) would
  // otherwise appear on every single outbound call. See
  // lib/capabilities/promptAssembler.js `outboundAllowsPack`.
  it("the MESSAGE PROTOCOL section never reaches an outbound prompt (messages is not a legal campaign capability)", () => {
    for (const [name, { config, extras }] of Object.entries(OUTBOUND_FIXTURES)) {
      const prefix = promptFor(config, extras);
      expect(prefix, name).not.toContain("MESSAGE PROTOCOL");
      expect(prefix, name).not.toContain("record_customer_request");
    }
  });

  it("ESCALATION and the request_transfer TOOL CONTRACT bullet are present when the campaign lists transfer", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const prefix = promptFor(config, extras);
    expect(prefix).toContain("=== ESCALATION ===");
    expect(prefix).toContain("request_transfer");
  });

  it("ESCALATION and the request_transfer mention are ABSENT when the campaign does not list transfer", () => {
    const { config, extras } = OUTBOUND_FIXTURES["missed-call-callback"];
    const prefix = promptFor(config, extras);
    expect(prefix).not.toContain("=== ESCALATION ===");
    expect(prefix).not.toContain("request_transfer");
    expect(prefix).not.toContain("check_appointment_availability");
  });

  it("inbound is unaffected: the same tenant config still gets MESSAGE PROTOCOL and ESCALATION without outboundCall", () => {
    const { config, extras } = OUTBOUND_FIXTURES["missed-call-callback"];
    const { outboundCall, ...inboundLikeExtras } = extras;
    const prefix = buildStaticSystemPrefix(config, inboundLikeExtras);
    expect(prefix).toContain("MESSAGE PROTOCOL");
    expect(prefix).toContain("=== ESCALATION ===");
  });
});

// S3-10 fix round 1 (controller Ruling R-S3-10-prompt): the full Task 24
// contract binds -- capabilities/qualification.js's prompt() must put the
// campaign's questions into the CAPABILITIES line, marked required/optional.
// Both existing OUTBOUND_FIXTURES campaigns list "qualification" and carry
// the shipped speed_to_lead template's one question (clinic_name, required),
// so "speed-to-lead" alone is enough for the positive case; the negative case
// builds a variant with "qualification" filtered out of the campaign's own
// capabilities list, the same technique the D-c intersection tests above use.
describe("S3-10 (moved 2026-09-30 into the CALL PLAN): the prompt lists the campaign's qualification questions", () => {
  it("a qualify_then_book-shaped campaign's prompt contains every question's ask text, key and required/optional mark", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const prefix = promptFor(config, extras);
    expect(prefix).toContain("What's the clinic called?");
    expect(prefix).toContain("clinic_name");
    expect(prefix).toMatch(/clinic_name \(required\)/);
  });

  it("a campaign without the qualification capability gets none of it", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const withoutQualification = {
      ...extras,
      outboundCall: {
        ...extras.outboundCall,
        config: {
          ...extras.outboundCall.config,
          capabilities: extras.outboundCall.config.capabilities.filter((c) => c !== "qualification"),
        },
      },
    };
    const prefix = promptFor(config, withoutQualification);
    expect(prefix).not.toContain("What's the clinic called?");
    expect(prefix).not.toContain("clinic_name");
  });

  it("the opener text and the voicemail template never contain the question text", () => {
    const { extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    expect(extras.outboundCall.openerText).not.toContain("What's the clinic called?");
    expect(extras.outboundCall.config.voicemail).not.toContain("What's the clinic called?");
    expect(extras.outboundCall.config.voicemail).not.toContain("clinic_name");
  });

  it("inbound is unaffected: no question text reaches the prompt without ctx.outboundCall", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const { outboundCall, ...inboundLikeExtras } = extras;
    const prefix = buildStaticSystemPrefix(config, inboundLikeExtras);
    expect(prefix).not.toContain("What's the clinic called?");
    expect(prefix).not.toContain("clinic_name");
  });
});

describe("c3 (checkpoint 2b review, partial FIX) — NON-NEGOTIABLE RULE 4's referent is outbound-only", () => {
  it("outbound: refers to the person whose identity has been confirmed, not the caller ID", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const prefix = promptFor(config, extras);
    expect(prefix).toContain("Only discuss records belonging to the person whose identity you have confirmed");
    expect(prefix).not.toContain("the person calling from this number");
  });

  it("inbound is unaffected, byte-identical wording", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const { outboundCall, ...inboundLikeExtras } = extras;
    const prefix = buildStaticSystemPrefix(config, inboundLikeExtras);
    expect(prefix).toContain("Only discuss records belonging to the person calling from this number");
    expect(prefix).not.toContain("the person whose identity you have confirmed");
  });
});

describe("M5 (checkpoint 2b review, Controller Ruling OVERNIGHT) — no phantom 'take a message' on outbound", () => {
  it("outbound: NNR 1 and the guardrails offer a callback, never a message, as the POSITIVE instruction", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const prefix = promptFor(config, extras);
    expect(prefix).not.toContain("offer to take a message so someone can follow up");
    expect(prefix).not.toContain('take their details for follow-up"');
    expect(prefix).not.toContain("offer to take their details so someone can follow up");
    expect(prefix).toContain("offer to call them back another time with the right answer");
    expect(prefix).toContain("offer to call them back another time");
  });

  it("inbound is unaffected: NNR 1 and the guardrails still offer to take a message / take their details", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const { outboundCall, ...inboundLikeExtras } = extras;
    const prefix = buildStaticSystemPrefix(config, inboundLikeExtras);
    expect(prefix).toContain("offer to take a message so someone can follow up");
    expect(prefix).not.toContain("call them back another time");
  });
});

describe("no fixture renders 'undefined' or 'null' into prompt text", () => {
  for (const [name, { config, extras }] of Object.entries(OUTBOUND_FIXTURES)) {
    it(name, () => {
      const full = buildSystemInstruction("identify_intent", null, config, extras);
      expect(full).not.toContain("undefined");
      expect(full).not.toMatch(/\bnull\b/);
    });
  }
});

describe("S3-1 contract item 6 — D3's real source", () => {
  // A word-bounded scan: "phone numbers digit by digit" (the read-back
  // instruction, shared with inbound) must NOT count as an ask, because
  // \bphone number\b requires a boundary right after "number".
  const ASK_RE = /\b(best|contact|phone)\s+number\b/i;
  /** The outbound JOB prompt (THIS CALL onward): the part that says what to do on this call. */
  const jobPrompt = (config, extras) => {
    const full = promptFor(config, extras);
    return full.slice(full.indexOf("=== THIS CALL ==="));
  };

  it("the outbound job prompt asks for a phone number NOWHERE outside the number rule", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const job = jobPrompt(config, extras);
    const numberRuleLine = job.split("\n").find((l) => l.includes("Never ask for a phone number."));
    expect(numberRuleLine).toBeTruthy();
    const withoutRule = job.split("\n").filter((l) => l !== numberRuleLine).join("\n");
    expect(withoutRule).not.toMatch(ASK_RE);
  });

  it("control: the phrase IS present, confirming the scan can see it at all", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    expect(jobPrompt(config, extras)).toMatch(ASK_RE);
  });

  it("the shared read-back rule is untouched -- it confirms digits already given, it asks for none", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    expect(promptFor(config, extras)).toMatch(/a phone number digit by digit/i);
  });
});

describe("S3-1 contract item 5 — the ask-gate never reaches outbound; the closing rule does", () => {
  it("outbound: no 'ask if there's anything else' in any form, and the closing rule is the plan's last step", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const full = promptFor(config, extras);
    expect(full).not.toMatch(/ask if there's anything else/i);
    expect(full).not.toMatch(/explicitly ask if there's anything else/i);
    expect(full).toMatch(/\d\. To end the call: confirm the next step in one sentence, thank them by name, say goodbye, then end the call/);
    expect(full).toMatch(/never ask whether there is anything else you can help with/i);
  });

  it("inbound control: gather_details and confirm keep the ask-gate wording, byte-identical", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const { outboundCall, ...inboundLikeExtras } = extras;
    expect(buildDynamicTail("gather_details", "general_question", config, inboundLikeExtras)).toMatch(
      /ask if there's anything else you can help with/i
    );
    expect(buildDynamicTail("confirm", "book_appointment", config, inboundLikeExtras)).toMatch(
      /explicitly ask if there's anything else they need help with/i
    );
  });
});

describe("S3-1 contract item 4 — confirm_identity's gatekeeper wording agrees with prompt.js's one source (S3-D1a)", () => {
  it("confirm_identity's description never mentions the topic, matching the SITUATIONS gatekeeper line", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const decl = buildAllDeclarations(config, extras).find((d) => d.name === "confirm_identity");
    expect(decl).toBeTruthy();
    expect(decl.description.toLowerCase()).not.toContain(extras.outboundCall.config.topic.toLowerCase());
  });

  it("confirm_identity's false-branch agrees with the gatekeeper move: share nothing further, offer a callback -- never the caller's own word standing in", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const decl = buildAllDeclarations(config, extras).find((d) => d.name === "confirm_identity");
    expect(decl.description).toMatch(/share nothing further/i);
    expect(decl.description).toMatch(/callback/i);
  });
});

// 2026-10-01 (spec 2026-10-01-outbound-live-first-line §4): wait_on_hold is an
// engine tool like confirm_identity, declared on an OUTBOUND call in LIVE
// first-speaker mode only -- never inbound, never in the clip rollback.
describe("wait_on_hold declaration", () => {
  const names = (config, extras) => buildAllDeclarations(config, extras).map((d) => d.name);
  it("declared on a live-mode outbound call (the default)", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    expect(names(config, extras)).toContain("wait_on_hold");
  });
  it("not declared in clip mode", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead-clip"];
    expect(names(config, extras)).not.toContain("wait_on_hold");
  });
  it("not declared on inbound", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const { outboundCall: _o, ...inboundExtras } = extras;
    expect(names(config, inboundExtras)).not.toContain("wait_on_hold");
    expect(names(config, inboundExtras)).not.toContain("confirm_identity");
  });
});
