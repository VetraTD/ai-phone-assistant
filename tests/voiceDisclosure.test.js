import { describe, it, expect } from "vitest";
import { TRANSCRIPTION_DISCLOSURE, claimsRecording } from "../lib/voice/disclosure.js";
import { greetingTextFor } from "../lib/voice/greeting.js";

// D4 (docs/superpowers/specs/2026-09-24-outbound-calling-design.md): no call is
// recorded -- the Live path hands off with <Connect><Stream> and never issues a
// <Record> (tests/recordingPathLint.test.js) -- so nothing this system says to a
// caller may claim that it is. What IS kept is the transcript (LVX83), and that
// is what the disclosure now says.
//
// The production change that would turn these red: putting a recording claim
// back into the code default in lib/voice/greeting.js, or loosening
// claimsRecording() until it misses one of the real sentences below.

describe("TRANSCRIPTION_DISCLOSURE", () => {
  it("is the D4 sentence, word for word", () => {
    expect(TRANSCRIPTION_DISCLOSURE).toBe("This call may be transcribed to help us assist you.");
  });

  it("does not itself claim a recording", () => {
    expect(claimsRecording(TRANSCRIPTION_DISCLOSURE)).toBe(false);
  });
});

describe("claimsRecording", () => {
  // The first block are sentences this system has actually said to callers,
  // offered operators as a default, or pushed into a live model in a probe.
  // The second block are the common UK/US phrasings an operator might type
  // into a greeting -- the production audit (db-inspect --recording-claims)
  // closes LVX88 on reading clean, so a phrasing it misses is a tenant it
  // wrongly clears. Added after review found the first regex missed all of them.
  const CLAIMS = [
    "Thanks for calling Digile Media. You're through to our AI receptionist — calls are recorded for quality. How can I help you today?",
    "This call may be recorded for quality and training purposes.",
    "This call is being recorded for quality and training purposes.",
    "Just so you know, this call is recorded for quality and training purposes.",
    "Please be aware that this call may be recorded for quality assurance and staff training purposes.",
    "This call is recorded for training purposes.",
    "Tell callers the call may be recorded",
    "whether callers are told the call is recorded.",
    "Calls may be monitored or recorded.",
    "calls may be monitored and recorded for training",
    // common phrasings, not from this codebase
    "Your call will be recorded.",
    "We record all calls.",
    "Calls to this number may be recorded.",
    "Calls may be recorded for monitoring purposes.",
    "Call recording is in operation on this line.",
    "This conversation may be recorded.",
    "Your call may also be recorded.",
    "Calls are also recorded.",
    "Calls are sometimes recorded.",
    "Calls may be monitored, recorded and transcribed.",
    "We record calls for training.",
    "We may record calls.",
    "We monitor and record calls.",
    "we're recording this call",
  ];

  // Every negative is phrasing that already exists in this codebase or that the
  // model says legitimately. "recorded" alone is not a claim: the claim
  // detector in lib/voice/strings.js treats "I have your message recorded" as a
  // WRITE confirmation, and flagging it here would teach operators that the
  // word itself is forbidden.
  const NOT_CLAIMS = [
    "This call may be transcribed to help us assist you.",
    "I have your message recorded for the team.",
    "I've recorded your details.",
    "that is a recorded finding, not a suspicion",
    "the calendar had confirmed it was open, and no booking was recorded during the call.",
    "this can only ever run on a call that recorded nothing.",
    "attempt was refused, so that change was never recorded.",
    "Tool traffic for this call, recorded by the system:",
    "Recording announcement",
    // negations are the TRUTH here, and must never be flagged
    "Calls are not being recorded.",
    "Your call is never recorded.",
    "This call is not recorded.",
  ];

  for (const s of CLAIMS) {
    it(`flags: ${s.slice(0, 60)}`, () => {
      expect(claimsRecording(s)).toBe(true);
    });
  }

  for (const s of NOT_CLAIMS) {
    it(`passes: ${s.slice(0, 60)}`, () => {
      expect(claimsRecording(s)).toBe(false);
    });
  }

  it("treats empty and missing text as no claim", () => {
    expect(claimsRecording("")).toBe(false);
    expect(claimsRecording(null)).toBe(false);
    expect(claimsRecording(undefined)).toBe(false);
  });
});

describe("greetingTextFor: the disclosure", () => {
  const base = { businessName: "Brightwork Studio", greeting: "Thanks for calling Brightwork Studio.", _hasCustomGreeting: true };

  it("leads with the transcription notice when the tenant enabled the disclosure and wrote no text of its own", () => {
    const text = greetingTextFor({ ...base, recordingDisclosureEnabled: true, recordingDisclosureText: null });
    expect(text.startsWith(TRANSCRIPTION_DISCLOSURE + " ")).toBe(true);
    expect(text).toBe(`${TRANSCRIPTION_DISCLOSURE} Thanks for calling Brightwork Studio.`);
  });

  it("never claims a recording from the code default", () => {
    const text = greetingTextFor({ ...base, recordingDisclosureEnabled: true, recordingDisclosureText: null });
    expect(claimsRecording(text)).toBe(false);
  });

  it("still uses the tenant's own disclosure text when there is one", () => {
    const text = greetingTextFor({ ...base, recordingDisclosureEnabled: true, recordingDisclosureText: "Custom notice." });
    expect(text).toBe("Custom notice. Thanks for calling Brightwork Studio.");
  });

  it("says nothing extra when the disclosure is off, exactly as before", () => {
    const text = greetingTextFor({ ...base, recordingDisclosureEnabled: false });
    expect(text).toBe("Thanks for calling Brightwork Studio.");
  });
});
