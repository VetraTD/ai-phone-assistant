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

describe("situations table (spec §9.5) — one guidance line per row", () => {
  const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
  const block = buildDynamicTail("identify_intent", null, config, extras);

  it("contains the OUTBOUND CALL heading", () => {
    expect(block).toContain("=== OUTBOUND CALL ===");
  });

  const rows = [
    ["a gatekeeper gets the vague reason only", /gatekeeper/i],
    ["Ava waits if put through", /wait patiently/i],
    ["a child or anyone else: share nothing", /share nothing about why you/i],
    ["never ask a child anything", /never ask a child/i],
    ["offer a callback", /offer to call back/i],
    ["a wrong number: apologise", /wrong number.*apologise/is],
    ["a call screener: name and reason once, then wait", /call-screening assistant/i],
    ['"bad time" gets a specific callback offer', /isn't a good time.*offer a specific/is],
    ['"how did you get my number" gets the form explanation plus the offer to stop', /how did you get my number/i],
    ['"stop calling" is honoured immediately', /stop calling.*take me off your list/i],
    ['"are you a robot" gets "yes, an AI assistant"', /are you a robot.*an ai assistant/is],
  ];
  for (const [label, re] of rows) {
    it(`covers: ${label}`, () => {
      expect(block).toMatch(re);
    });
  }

  it("the voicemail row is ABSENT — AMD (spec §9.4) handles it, not the prompt", () => {
    expect(block).not.toMatch(/voicemail/i);
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

  it("confirm_identity is absent — Task 18 adds it, not this one", () => {
    const { config, extras } = OUTBOUND_FIXTURES["speed-to-lead"];
    const names = buildAllDeclarations(config, extras).map((d) => d.name);
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

  it("a campaign that lists no implemented capability (missed-call-callback shape) keeps exactly the two engine tools", () => {
    const { config, extras } = OUTBOUND_FIXTURES["missed-call-callback"];
    const names = buildAllDeclarations(config, extras).map((d) => d.name);
    expect(names).toEqual(["set_call_intent", "end_call"]);
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

describe("no fixture renders 'undefined' or 'null' into prompt text", () => {
  for (const [name, { config, extras }] of Object.entries(OUTBOUND_FIXTURES)) {
    it(name, () => {
      const full = buildSystemInstruction("identify_intent", null, config, extras);
      expect(full).not.toContain("undefined");
      expect(full).not.toMatch(/\bnull\b/);
    });
  }
});
