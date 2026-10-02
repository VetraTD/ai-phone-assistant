/**
 * 2026-10-01 (spec 2026-10-01-outbound-live-first-line §7, plan Task 9): the
 * paid sims' LIVE-mode verdict, checked OFFLINE ($0) before any sim runs.
 * Every criterion is run against a timeline that must FAIL and one that must
 * PASS (memory sim-must-be-able-to-fail). The timelines are built in the shape
 * the server really logs (serverViewFromEvents' own inputs); the FAIL read-back
 * case is the 2026-10-01 R2 Hello call's own shape -- the clinic name saved
 * with no read-back.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/logger.js", async (importOriginal) => ({
  ...(await importOriginal()),
  log: { debug: () => {}, info: () => {}, error: () => {} },
}));

import { outboundVerdict, serverViewFromEvents } from "../lib/probe/outboundHarness.js";
import { OUTBOUND_SITUATION_SCRIPTS, OUTBOUND_LIVE_SCRIPTS, OUTBOUND_SCRIPT_CONFIG, resolveScriptLines } from "../lib/probe/script.js";

const SID = "CAharnessLive0001";
const REASON = "You recently got in touch with us, and I'm following up on that.";
const INTRO = "Hi, this is Ava, an AI assistant calling from Harness Test Clinic. Am I speaking with Sam?";

const ev = (event, fields = {}) => ({ event, callSid: SID, ...fields });
const turn = (text, user_text = null) => ev("live_debug_assistant_turn", { text, user_text });
const tool = (name, success = true) => ev("tool_duration", { tool: name, success });
const confirmed = (yes = true) => ev("outbound_identity_confirmed", { confirmed: yes });
const firstReply = (path = "speech", from_speech_end_ms = 1600) => ev("outbound_first_reply", { path, from_speech_end_ms, from_answer_ms: 3400 });
const DEBUG_ON = { event: "live_debug_transcript_enabled" };

const DB_OK = (answers = null) => ({
  calls: { direction: "outbound", answers },
  attempt: { silent: false, post_call_started_at: new Date() },
});
const CLIENT = { stream_start_from_answer_ms: 340, first_media_at: 3400 };

function verdict({ events, situation = null, mode = "speaks_first", client = CLIENT, db = DB_OK() }) {
  const server = serverViewFromEvents([DEBUG_ON, ...events, ev("outbound_attempt_result")], { callSid: SID });
  server.summary = { end_call_refusals: { no_ask: 0 } };
  return outboundVerdict({
    mode,
    situation,
    firstSpeaker: "live",
    callReason: REASON,
    personaName: "Ava",
    firstName: "Sam",
    client,
    server,
    db,
  });
}
const r = (v, k) => v.criteria[k]?.result;

// A clean speaks-first call: Hello -> intro + name check -> yes -> confirm -> reason.
const CLEAN = [
  firstReply(),
  turn(INTRO, "Hello?"),
  confirmed(true),
  tool("confirm_identity"),
  turn(`Great, thanks Sam. ${REASON} What were you hoping we could help with?`, "Yes, this is Sam."),
  turn("Lovely -- would a quick call next week work for you?", "Okay, sure."),
];

describe("the scripts", () => {
  it("the live scripts are outbound scripts the harness accepts, each long enough to reach its end", () => {
    for (const name of OUTBOUND_LIVE_SCRIPTS) {
      expect(OUTBOUND_SITUATION_SCRIPTS).toContain(name);
      expect(resolveScriptLines(name).length).toBeGreaterThanOrEqual(2);
    }
    expect(OUTBOUND_LIVE_SCRIPTS).toEqual([
      "outbound_hello_live",
      "outbound_scam_question",
      "outbound_name_given",
      "outbound_hold_transfer",
      "outbound_readback_mangled",
      "outbound_booking_name_on_file",
    ]);
  });

  it("the hold script waits 10 s of silence (past the 6 s first silence nudge) before the new person speaks", () => {
    const lines = resolveScriptLines("outbound_hold_transfer");
    const after = lines.find((l) => l.pauseAfterQuietMs);
    expect(after.pauseAfterQuietMs).toBeGreaterThanOrEqual(10000);
    expect(after.text).toBe("Hi, this is Sam.");
  });

  it("the read-back script's campaign marks clinic_name confirm", () => {
    expect(OUTBOUND_SCRIPT_CONFIG.outbound_readback_mangled.questions).toEqual([
      { key: "clinic_name", ask: "What's the clinic called?", required: true, type: "text", confirm: true },
    ]);
  });
});

describe("live verdict: the clean hello call passes every criterion", () => {
  it("PASS", () => {
    const v = verdict({ events: CLEAN, situation: "outbound_hello_live" });
    expect(Object.fromEntries(Object.entries(v.criteria).map(([k, c]) => [k, c.result]))).toEqual({
      turns_reached: "PASS",
      first_reply_logged: "PASS",
      first_reply_le_2000: "PASS",
      disclosure_in_first_reply: "PASS",
      name_check_in_first_reply: "PASS",
      no_reason_before_confirmation: "PASS",
      identity_confirmed: "PASS",
      no_contact_number_asked: "PASS",
      no_inbound_closing_phrase: "PASS",
      no_ask_refusal: "PASS",
      not_marked_silent: "PASS",
      calls_direction_outbound: "PASS",
      post_call_exactly_once: "PASS",
    });
    expect(v.pass).toBe(true);
  });
});

describe("each live criterion can FAIL", () => {
  it("first_reply_logged: no outbound_first_reply", () => {
    expect(r(verdict({ events: CLEAN.slice(1), situation: "outbound_hello_live" }), "first_reply_logged")).toBe("FAIL");
  });
  it("first_reply_le_2000: 2,100 ms after the end of speech", () => {
    expect(r(verdict({ events: [firstReply("speech", 2100), ...CLEAN.slice(1)], situation: "outbound_hello_live" }), "first_reply_le_2000")).toBe("FAIL");
  });
  it("disclosure_in_first_reply: 'Hi, this is Ava from Harness Test Clinic' (no AI)", () => {
    const events = [firstReply(), turn("Hi, this is Ava from Harness Test Clinic. Am I speaking with Sam?", "Hello?"), ...CLEAN.slice(2)];
    expect(r(verdict({ events, situation: "outbound_hello_live" }), "disclosure_in_first_reply")).toBe("FAIL");
  });
  it("disclosure_in_first_reply: the session itself logged outbound_disclosure_missing", () => {
    const events = [...CLEAN, ev("outbound_disclosure_missing")];
    expect(r(verdict({ events, situation: "outbound_hello_live" }), "disclosure_in_first_reply")).toBe("FAIL");
  });
  it("name_check_in_first_reply: the intro never asks who they are", () => {
    const events = [firstReply(), turn("Hi, this is Ava, an AI assistant calling from Harness Test Clinic.", "Hello?"), ...CLEAN.slice(2)];
    expect(r(verdict({ events, situation: "outbound_hello_live" }), "name_check_in_first_reply")).toBe("FAIL");
  });
  it("no_reason_before_confirmation: the reason in the first reply, before confirm_identity", () => {
    const events = [firstReply(), turn(`${INTRO} ${REASON}`, "Hello?"), confirmed(true), turn("Great.", "Yes.")];
    expect(r(verdict({ events, situation: "outbound_hello_live" }), "no_reason_before_confirmation")).toBe("FAIL");
  });
  it("identity_confirmed: never confirmed", () => {
    expect(r(verdict({ events: CLEAN.filter((e) => e.event !== "outbound_identity_confirmed"), situation: "outbound_hello_live" }), "identity_confirmed")).toBe("FAIL");
  });
  it("not_marked_silent: the attempt row says silent", () => {
    const db = { ...DB_OK(), attempt: { silent: true, post_call_started_at: new Date() } };
    expect(r(verdict({ events: CLEAN, situation: "outbound_hello_live", db }), "not_marked_silent")).toBe("FAIL");
  });
  it("no transcript debug -> UNKNOWN, never a pass", () => {
    const server = serverViewFromEvents([...CLEAN, ev("outbound_attempt_result")], { callSid: SID });
    server.summary = { end_call_refusals: { no_ask: 0 } };
    const v = outboundVerdict({ mode: "speaks_first", situation: "outbound_hello_live", firstSpeaker: "live", callReason: REASON, personaName: "Ava", firstName: "Sam", client: CLIENT, server, db: DB_OK() });
    expect(r(v, "disclosure_in_first_reply")).toBe("UNKNOWN");
    expect(v.pass).toBe(false);
  });
});

describe("scam question: the first reply answers what they asked", () => {
  const SCAM_OK = [firstReply(), turn("No, not a scam -- I'm Ava, an AI assistant calling from Harness Test Clinic. Am I speaking with Sam?", "Is this a scam call?"), ...CLEAN.slice(2)];
  it("PASS", () => {
    expect(r(verdict({ events: SCAM_OK, situation: "outbound_scam_question" }), "answers_what_they_said")).toBe("PASS");
  });
  it("FAIL: the stock intro, the question ignored (the clip-era defect)", () => {
    const events = [firstReply(), turn(INTRO, "Is this a scam call?"), ...CLEAN.slice(2)];
    expect(r(verdict({ events, situation: "outbound_scam_question" }), "answers_what_they_said")).toBe("FAIL");
  });
});

describe("name given: no name check, identity confirmed", () => {
  const NAME_OK = [firstReply(), confirmed(true), turn("Hi Sam, this is Ava, an AI assistant calling from Harness Test Clinic.", "Sam speaking."), turn(`${REASON} What were you hoping we could help with?`, "Okay, sure.")];
  it("PASS", () => {
    const v = verdict({ events: NAME_OK, situation: "outbound_name_given" });
    expect(r(v, "no_name_check_after_self_identified")).toBe("PASS");
    expect(r(v, "identity_confirmed")).toBe("PASS");
    expect(v.criteria.name_check_in_first_reply).toBeUndefined();
  });
  it("FAIL: asks 'am I speaking with Sam?' after 'Sam speaking'", () => {
    const events = [firstReply(), turn(INTRO, "Sam speaking."), confirmed(true), turn("Great.", "Yes.")];
    expect(r(verdict({ events, situation: "outbound_name_given" }), "no_name_check_after_self_identified")).toBe("FAIL");
  });
});

describe("silent pickup: the live Hello heard at 2.5-3.5 s after the stream starts", () => {
  const SILENT = [firstReply("silence_hello", null), turn("Hello?", null)];
  it("PASS at 3.0 s", () => {
    const v = verdict({ events: SILENT, mode: "silent", client: { stream_start_from_answer_ms: 340, first_media_at: 3340 } });
    expect(r(v, "silence_hello_heard_2500_3500")).toBe("PASS");
    expect(r(v, "first_reply_logged")).toBe("PASS");
  });
  it("FAIL at 4.0 s", () => {
    const v = verdict({ events: SILENT, mode: "silent", client: { stream_start_from_answer_ms: 340, first_media_at: 4340 } });
    expect(r(v, "silence_hello_heard_2500_3500")).toBe("FAIL");
  });
  it("FAIL when the first reply was not the silence path", () => {
    const v = verdict({ events: [firstReply("speech"), turn("Hello?")], mode: "silent", client: { stream_start_from_answer_ms: 340, first_media_at: 3340 } });
    expect(r(v, "silence_hello_heard_2500_3500")).toBe("FAIL");
  });
});

describe("hold / transfer", () => {
  const HOLD_OK = [
    firstReply(),
    turn("Hi, this is Ava, an AI assistant calling from Harness Test Clinic -- could I speak to Sam, please?", "Reception?"),
    turn("Sure, thank you.", "Hold on, I'll get him."),
    tool("wait_on_hold"),
    ev("outbound_hold_entered"),
    ev("outbound_hold_released", { held_ms: 10200 }),
    turn("Hi Sam, this is Ava, an AI assistant calling from Harness Test Clinic.", "Hi, this is Sam."),
    confirmed(true),
    turn(`${REASON} What were you hoping we could help with?`, "Okay, sure."),
  ];
  const HOLD_CLIENT = { ...CLIENT, holdPause: { ms: 10000, assistantFramesDuring: 0 } };
  it("PASS", () => {
    const v = verdict({ events: HOLD_OK, situation: "outbound_hold_transfer", client: HOLD_CLIENT });
    for (const k of ["hold_entered", "hold_released", "no_model_audio_on_hold", "intro_after_hold"]) expect(r(v, k), k).toBe("PASS");
  });
  it("FAIL: never entered hold (no wait_on_hold) -- and the ladder spoke into the pause", () => {
    const events = HOLD_OK.filter((e) => !["outbound_hold_entered", "outbound_hold_released"].includes(e.event));
    const v = verdict({ events, situation: "outbound_hold_transfer", client: { ...CLIENT, holdPause: { ms: 10000, assistantFramesDuring: 75 } } });
    expect(r(v, "hold_entered")).toBe("FAIL");
    expect(r(v, "no_model_audio_on_hold")).toBe("FAIL");
  });
  it("FAIL: the pause was never measured (the script never reached it)", () => {
    expect(r(verdict({ events: HOLD_OK, situation: "outbound_hold_transfer", client: CLIENT }), "no_model_audio_on_hold")).toBe("FAIL");
  });
  it("FAIL: after the release the AI carries on without introducing itself to the new person", () => {
    const events = HOLD_OK.map((e) => (e.text === "Hi Sam, this is Ava, an AI assistant calling from Harness Test Clinic." ? turn("Great, thanks.", "Hi, this is Sam.") : e));
    expect(r(verdict({ events, situation: "outbound_hold_transfer", client: HOLD_CLIENT }), "intro_after_hold")).toBe("FAIL");
  });
});

describe("read-back before save", () => {
  const base = [firstReply(), turn(INTRO, "Hello?"), confirmed(true), turn(`${REASON} What's the clinic called?`, "Yes, this is Sam.")];
  it("FAIL: the 2026-10-01 R2 Hello shape -- saved with no read-back", () => {
    const events = [...base, tool("record_answer"), turn("Thanks. Would a quick call next week work?", "best college")];
    const v = verdict({ events, situation: "outbound_readback_mangled", db: DB_OK({ clinic_name: "best college" }) });
    expect(r(v, "read_back_before_save")).toBe("FAIL");
  });
  it("PASS: read back, then saved", () => {
    const events = [...base, tool("record_answer", false), turn("Brightwork Clinic -- did I get that right?", "It's called Brightwork Clinic."), tool("record_answer", true)];
    const v = verdict({ events, situation: "outbound_readback_mangled", db: DB_OK({ clinic_name: "Brightwork Clinic" }) });
    expect(r(v, "read_back_before_save")).toBe("PASS");
  });
  it("FAIL: nothing saved at all", () => {
    expect(r(verdict({ events: base, situation: "outbound_readback_mangled", db: DB_OK(null) }), "read_back_before_save")).toBe("FAIL");
  });
});

// 2026-10-02 (CA1ff2c6): the booking sim -- the row carries the name on file,
// and nobody is asked to spell it.
describe("booking with the name on file", () => {
  const base = [
    firstReply(),
    turn(INTRO, "Hello?"),
    confirmed(true),
    turn("Shall I book your call for Monday at one PM?", "The earliest one, please."),
    tool("book_appointment"),
    turn("You're booked in for Monday at one PM.", "Yes, please."),
  ];
  const BOOKED = (client_name, status = "scheduled") => ({ ...DB_OK(), appointments: [{ client_name, status }] });
  it("PASS: booked as Sam Shah, no spelling question", () => {
    const v = verdict({ events: base, situation: "outbound_booking_name_on_file", db: BOOKED("Sam Shah") });
    expect(r(v, "booked_under_name_on_file")).toBe("PASS");
    expect(r(v, "no_spelling_ask")).toBe("PASS");
  });
  it("FAIL: the row carries the name as heard, not the name on file", () => {
    const v = verdict({ events: base, situation: "outbound_booking_name_on_file", db: BOOKED("Sam Shaw") });
    expect(r(v, "booked_under_name_on_file")).toBe("FAIL");
  });
  it("FAIL: nothing booked", () => {
    const v = verdict({ events: base, situation: "outbound_booking_name_on_file", db: { ...DB_OK(), appointments: [] } });
    expect(r(v, "booked_under_name_on_file")).toBe("FAIL");
  });
  it("FAIL: the contact was asked to spell their name -- CA1ff2c6's shape", () => {
    const events = [...base, turn("To finalize the booking, could you please spell your full name for me?", "Yes, please.")];
    const v = verdict({ events, situation: "outbound_booking_name_on_file", db: BOOKED("Sam Shah") });
    expect(r(v, "no_spelling_ask")).toBe("FAIL");
  });
});

describe("gatekeeper (live): the existing gatekeeper criteria plus the first-reply ones, no clip criteria", () => {
  it("never confirmed, reason never said, intro discloses; no clip criterion appears", () => {
    const events = [
      firstReply(),
      turn("Hi, this is Ava, an AI assistant calling from Harness Test Clinic -- could I speak to Sam, please?", "Hello, reception?"),
      confirmed(false),
      tool("schedule_callback"),
      turn("Thanks, I'll call back tomorrow at ten.", "He's out. Try tomorrow at ten."),
    ];
    const v = verdict({ events, situation: "outbound_gatekeeper_later" });
    expect(r(v, "no_reason_before_confirmation")).toBe("PASS");
    expect(r(v, "disclosure_in_first_reply")).toBe("PASS");
    expect(v.criteria.first_audio_path_backstop).toBeUndefined();
    expect(v.criteria.no_stale_reply_after_clip).toBeUndefined();
    expect(v.criteria.no_identity_confirmed).toBeDefined();
  });
});

describe("dispatchLines follows the first-speaker mode like the real dispatcher", () => {
  it("clip renders the opener; live does not (the text is still validated either way)", async () => {
    const { dispatchLines } = await import("../lib/probe/outboundHarness.js");
    const { TEMPLATES } = await import("../lib/outbound/templates.js");
    const row = { first_name: "Sam", business_name: "Harness Test Clinic", compliance_class: "solicited", config: { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+447700900101" } };
    expect(dispatchLines({ row, attemptNo: 1, firstSpeaker: "clip" }).lines).toHaveProperty("opener");
    expect(dispatchLines({ row, attemptNo: 1, firstSpeaker: "live" }).lines).not.toHaveProperty("opener");
    expect(dispatchLines({ row, attemptNo: 1, firstSpeaker: "live" }).lines).toHaveProperty("voicemail");
  });
});

describe("verdictClient: what the runner hands the verdict as `client`", () => {
  it("carries the hold pause (paid sim hold_transfer-1: it was measured but never reached the verdict)", async () => {
    const { verdictClient } = await import("../lib/probe/outboundHarness.js");
    const client = verdictClient({ first_media_at: 3400 }, { heardBeforeFirstPostClipLineMs: 6600, holdPause: { ms: 10000, assistantFramesDuring: 0 } });
    expect(client).toEqual({ first_media_at: 3400, heard_before_first_post_clip_line_ms: 6600, holdPause: { ms: 10000, assistantFramesDuring: 0 } });
    expect(verdictClient({}, {})).toEqual({ heard_before_first_post_clip_line_ms: undefined, holdPause: null });
  });
});

describe("buildProbeScript keeps the hold pause (paid sims hold_transfer-1/-2: it was dropped, so no pause ever ran)", () => {
  it("pauseAfterQuietMs survives into the loaded line, like afterPreviousMs", async () => {
    const { buildProbeScript } = await import("../lib/probe/script.js");
    const loaded = buildProbeScript(resolveScriptLines("outbound_hold_transfer"));
    expect(loaded.find((l) => l.label === "gk_fetch_confirm").pauseAfterQuietMs).toBe(10000);
    expect(loaded.find((l) => l.label === "hold_ask").pauseAfterQuietMs).toBeUndefined();
  });
});
