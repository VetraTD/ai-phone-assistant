// tests/outboundPromptSnapshot.test.js
/**
 * OUTBOUND PROMPT — spec §9.5. Snapshots in this file's `outbound/` directory
 * are committed PENDING OWNER REVIEW (session 2b, "Snapshots" note): the first
 * run writes them, a human reviews the wording once, and only after that are
 * they frozen the way the 110 inbound goldens are. Unlike the inbound
 * snapshots, later 2b tasks (18 adds `confirm_identity`) may still regenerate
 * files under `tests/__snapshots__/prompts/outbound/` — the inbound files
 * never move (G9).
 *
 * This suite is the outbound analogue of tests/promptSnapshot.test.js, which
 * stays completely unmodified and untouched by anything here: it iterates
 * FIXTURES (tests/fixtures/businessConfigs.js); this iterates the separate
 * OUTBOUND_FIXTURES export from the same file, and writes into a separate
 * snapshot directory.
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

describe("outbound prompt snapshots (pending owner review)", () => {
  for (const [name, { config, extras }] of Object.entries(OUTBOUND_FIXTURES)) {
    describe(name, () => {
      it("static system prefix", async () => {
        const prefix = buildStaticSystemPrefix(config, extras);
        await expect(prefix).toMatchFileSnapshot(`${SNAP_DIR}/${name}.static.txt`);
      });

      it("dynamic tail (identify_intent)", async () => {
        const tail = buildDynamicTail("identify_intent", null, config, extras);
        await expect(tail).toMatchFileSnapshot(`${SNAP_DIR}/${name}.tail.txt`);
      });

      it("tool declarations", async () => {
        const declarations = buildAllDeclarations(config, extras);
        await expect(JSON.stringify(declarations, null, 2)).toMatchFileSnapshot(`${SNAP_DIR}/${name}.tools.json`);
      });
    });
  }
});

describe("SITUATIONS section (spec §19, S3-D1) — one guidance line per row, integration check via buildDynamicTail", () => {
  // The authoritative, table-driven coverage of all 13 rows lives in
  // tests/outboundPrompt.test.js (direct unit test of outboundCallBlock).
  // This describe block is the lighter INTEGRATION check: the same content
  // still reaches a real assembled prompt through buildDynamicTail.
  const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
  const block = buildDynamicTail("identify_intent", null, config, extras);

  it("contains the SITUATIONS heading (replaces the old spec §9.5 table wholesale, per §19)", () => {
    expect(block).toContain("=== OUTBOUND CALL ===");
    expect(block).toContain("=== SITUATIONS ===");
  });

  const rows = [
    ["the person themselves", /the person themselves/i],
    ["a gatekeeper (S3-D1a) gets the vague reason only, never the topic", /A gatekeeper.*never the topic/is],
    ["a household member or possible child (S3-D1b): one availability question only", /one availability question only/i],
    ["never ask a child anything else", /never ask a child anything else/i],
    ["a wrong number: apologise", /A wrong number.*apologise/is],
    ["a call screener: name and reason once, then wait", /call-screening assistant/i],
    ["a bad time or driving gets a specific callback offer", /A bad time or driving.*callback/is],
    ['"email me instead" -> someone will email, ends kindly', /Email me instead.*follow up by email/is],
    ['"is this a sales call?" -> honest follow-up reason', /Is this a sales call\?.*follow-up/is],
    ['"already booked" \/ "already a customer" -> apologise and end', /Already booked.*already a customer.*apologise/is],
    ["hostile -> apologise once, offer to stop calling, end", /Hostile.*offer to stop calling/is],
    ["a bad line or unusable reply -> ask once, then offer a callback", /A bad line or an unusable reply.*callback/is],
    ['"stop calling" is honoured immediately', /Stop calling.*take me off your list/i],
    ['"are you a robot" gets "yes, an AI assistant"', /Are you a robot.*an AI assistant/is],
  ];
  for (const [label, re] of rows) {
    it(`covers: ${label}`, () => {
      expect(block).toMatch(re);
    });
  }

  it("the voicemail row is ABSENT — AMD (spec §9.4) handles it, not the prompt", () => {
    expect(block).not.toMatch(/voicemail/i);
  });

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
      const full = buildSystemInstruction("identify_intent", null, config, extras);
      expect(claimsRecording(full), name).toBe(false);
    }
  });

  it("states the first-turn rule: persona name, 'AI assistant', business name", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const full = buildSystemInstruction("identify_intent", null, config, extras);
    expect(full).toContain(extras.outboundCall.config.persona_name);
    expect(full).toContain("AI assistant");
    expect(full).toContain(config.businessName);
    expect(full).toMatch(/first reply must include your name/i);
    expect(full).toMatch(/never claim to be human/i);
  });

  it("O-2 flag ON: the first reply must also carry the transcription notice, deferred to the next reply if the opener was already seeded", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead-disclosure-on"];
    const tail = buildDynamicTail("identify_intent", null, config, extras);
    expect(tail).toContain(TRANSCRIPTION_DISCLOSURE);
    expect(tail).toMatch(/give this notice instead in your very next reply/i);
  });

  it("O-2 flag OFF: the notice is given on request only", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    expect(config.recordingDisclosureEnabled).toBeFalsy();
    const tail = buildDynamicTail("identify_intent", null, config, extras);
    expect(tail).toMatch(/if they ask about recording or being transcribed/i);
    expect(tail).toContain(TRANSCRIPTION_DISCLOSURE);
  });
});

describe("O-9: no first name on file", () => {
  it("tells Ava she does not know the person's name and must ask before sharing the reason", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead-no-first-name"];
    const tail = buildDynamicTail("identify_intent", null, config, extras);
    expect(tail).toMatch(/do not know this person's name/i);
    expect(tail).toMatch(/ask who you are speaking to/i);
  });
});

describe("O-10 / O-11 (fix round 1): inbound-only framing suppressed on outbound", () => {
  it("O-10: IDENTIFY_INTENT drops 'Your task: Figure out why the caller is calling' on outbound, but still calls set_call_intent", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const tail = buildDynamicTail("identify_intent", null, config, extras);
    expect(tail).not.toMatch(/Your task: Figure out why the caller is calling/i);
    expect(tail).toMatch(/As soon as you understand, call set_call_intent with the appropriate intent/);
  });

  it("O-10 control: the SAME step keeps the line on inbound (extras.outboundCall absent)", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const { outboundCall, ...inboundLikeExtras } = extras;
    const tail = buildDynamicTail("identify_intent", null, config, inboundLikeExtras);
    expect(tail).toMatch(/Your task: Figure out why the caller is calling/i);
  });

  it("O-10: a later step (booking) keeps its normal guidance on outbound, unaffected", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const tail = buildDynamicTail("gather_details", "book_appointment", config, extras);
    expect(tail).toMatch(/=== CURRENT TASK AND STATE ===/);
    // Booking's own step guidance still renders (not suppressed) — a
    // non-trivial body of scheduling instruction, not just the bare step line.
    expect(tail.length).toBeGreaterThan(400);
  });

  it("O-11: AFTER-HOURS BEHAVIOR is suppressed on outbound even when the tenant's own office is closed right now", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const closedConfig = { ...config, businessHours: { ...WEEKLY_HOURS, mon: { open: null, close: null, closed: true } } };
    const tail = buildDynamicTail("identify_intent", null, closedConfig, extras);
    expect(tail).not.toMatch(/AFTER-HOURS BEHAVIOR/);
    expect(tail).not.toMatch(/office is currently CLOSED/i);
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

describe("D-b regression guard (fix round 1, item 5): THIS CALLER'S NUMBER stays absent even when extras.callerPhone IS populated", () => {
  // D-b relied on extras.callerPhone staying "" on outbound (P-3). The
  // explicit `!outbound` guard added in buildDynamicTail must hold even if
  // some future wiring bug (or Task 18's ctx.party work) puts a real number
  // on extras.callerPhone for an outbound call.
  it("no THIS CALLER'S NUMBER block, and the number itself never appears, when callerPhone is populated on an outbound extras bag", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const withCallerPhone = { ...extras, callerPhone: "+15559876543" };
    const tail = buildDynamicTail("identify_intent", null, config, withCallerPhone);
    expect(tail).not.toMatch(/THIS CALLER'S NUMBER/);
    expect(tail).not.toContain("+15559876543");
    expect(tail).not.toContain("555 987 6543");
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
      const prefix = buildStaticSystemPrefix(config, extras);
      expect(prefix, name).not.toContain("MESSAGE PROTOCOL");
      expect(prefix, name).not.toContain("record_customer_request");
    }
  });

  it("ESCALATION and the request_transfer TOOL CONTRACT bullet are present when the campaign lists transfer", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const prefix = buildStaticSystemPrefix(config, extras);
    expect(prefix).toContain("=== ESCALATION ===");
    expect(prefix).toContain("request_transfer");
  });

  it("ESCALATION and the request_transfer mention are ABSENT when the campaign does not list transfer", () => {
    const { config, extras } = OUTBOUND_FIXTURES["missed-call-callback"];
    const prefix = buildStaticSystemPrefix(config, extras);
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

describe("c3 (checkpoint 2b review, partial FIX) — NON-NEGOTIABLE RULE 4's referent is outbound-only", () => {
  it("outbound: refers to the person whose identity has been confirmed, not the caller ID", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const prefix = buildStaticSystemPrefix(config, extras);
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
    const prefix = buildStaticSystemPrefix(config, extras);
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
  // instruction, unconditional on both directions) must NOT count as an ask,
  // because \bphone number\b requires a boundary right after "number" and
  // "numbers" has a word character ("s") there instead.
  const ASK_RE = /\b(best|contact|phone)\s+number\b/i;

  // Scoped to buildDynamicTail (CURRENT TASK AND STATE + OUTBOUND CALL +
  // SITUATIONS + step guidance) rather than the full assembled
  // buildSystemInstruction: the STATIC prefix's own universal, direction-
  // agnostic guardrail -- "a phone number digit by digit" (services/
  // gemini.js's write-order read-back rule, shared byte-for-byte with
  // inbound) -- is a READ-BACK instruction for digits the caller already
  // volunteered, not an ask, and would otherwise read as a false positive
  // no outbound-only fix could ever remove.
  it("the assembled outbound DYNAMIC TAIL (identify_intent, R1 speed_to_lead) asks for a phone number NOWHERE outside the new number rule -- D3 is a model habit, not a prompt leak", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const tail = buildDynamicTail("identify_intent", null, config, extras);
    const numberRuleLine = tail.split("\n").find((l) => l.includes("Never ask for a phone number."));
    expect(numberRuleLine).toBeTruthy();
    const withoutRule = tail.split("\n").filter((l) => l !== numberRuleLine).join("\n");
    expect(withoutRule).not.toMatch(ASK_RE);
  });

  it("control: the phrase IS present, confirming the scan can see it at all", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const tail = buildDynamicTail("identify_intent", null, config, extras);
    expect(tail).toMatch(ASK_RE);
  });

  it("the STATIC prefix's universal read-back guardrail is untouched and out of scope for this rule -- it is confirming digits already given, not asking for any", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const prefix = buildStaticSystemPrefix(config, extras);
    expect(prefix).toMatch(/a phone number digit by digit/i);
  });
});

describe("S3-1 contract item 5 — gather_details/confirm ask-gate fallback replaced by the closing rule on outbound", () => {
  it("gather_details: an intent no capability pack owns falls back to the closing rule on outbound, not 'ask if anything else'", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const tail = buildDynamicTail("gather_details", "general_question", config, extras);
    expect(tail).not.toMatch(/ask if there's anything else you can help with/i);
    expect(tail).toMatch(
      /confirm the next step in one sentence, thank them by name, say goodbye, then end the call/i
    );
    expect(tail).toMatch(/never ask whether there is anything else you can help with/i);
  });

  it("gather_details control: the SAME unowned intent keeps the ask-gate fallback on inbound", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const { outboundCall, ...inboundLikeExtras } = extras;
    const tail = buildDynamicTail("gather_details", "general_question", config, inboundLikeExtras);
    expect(tail).toMatch(/ask if there's anything else you can help with/i);
  });

  it("confirm: reads back details, then the closing rule instead of 'ask if anything else', on outbound", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const tail = buildDynamicTail("confirm", "book_appointment", config, extras);
    expect(tail).toMatch(/read back key information/i);
    expect(tail).not.toMatch(/explicitly ask if there's anything else they need help with/i);
    expect(tail).toMatch(
      /confirm the next step in one sentence, thank them by name, say goodbye, then end the call/i
    );
    expect(tail).toMatch(/never ask whether there is anything else you can help with/i);
  });

  it("confirm control: inbound keeps the ask-gate fallback, byte-identical wording", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const { outboundCall, ...inboundLikeExtras } = extras;
    const tail = buildDynamicTail("confirm", "book_appointment", config, inboundLikeExtras);
    expect(tail).toMatch(/explicitly ask if there's anything else they need help with/i);
  });

  it("confirm: the mid-call intent-switch instruction survives on outbound too (a caller can still ask for something else)", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const tail = buildDynamicTail("confirm", "book_appointment", config, extras);
    expect(tail).toMatch(/call set_call_intent for the new request instead of ending the call/i);
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
