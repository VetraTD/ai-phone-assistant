import { describe, it, expect } from "vitest";
import {
  CALL_LINES,
  voicemailCallbackUrl,
  messageDoneUrl,
  buildTransferTwiml,
  buildMessageTwiml,
  buildHangupLineTwiml,
  buildDegradedVoicemailTwiml,
  buildUnroutedVoicemailTwiml,
  buildUnroutedTransferTwiml,
} from "../lib/twiml.js";

describe("CALL_LINES", () => {
  it("holds the exact spoken lines", () => {
    expect(CALL_LINES).toEqual({
      noAnswer: "Sorry, nobody could get to the phone. Please leave your name, number and a short message after the tone.",
      cantTransfer: "Sorry, I can't put you through right now. Please leave your name, number and a short message after the tone.",
      technical: "I'm sorry, we're having a technical problem. Please leave your name, number and a short message after the tone, and the team will get back to you.",
      technicalOutbound: "I'm sorry, we're having a technical problem. We'll be in touch. Goodbye.",
      timeUp: "I'm sorry, we've reached the time limit for this call. Thank you for calling. Goodbye.",
    });
    expect(Object.isFrozen(CALL_LINES)).toBe(true);
  });
});

describe("url helpers", () => {
  it("voicemailCallbackUrl encodes the number", () => {
    expect(voicemailCallbackUrl("https://b", "+441372656055")).toBe("https://b/twilio/voicemail?to=%2B441372656055");
    expect(voicemailCallbackUrl("https://b", undefined)).toBe("https://b/twilio/voicemail?to=");
  });
  it("messageDoneUrl", () => {
    expect(messageDoneUrl("https://b")).toBe("https://b/twilio/message-done");
  });
});

describe("buildTransferTwiml", () => {
  it("exact string with callerId", () => {
    expect(
      buildTransferTwiml({ number: "+441372656055", callerId: "+15550001111", ringTone: "gb", actionUrl: "https://b/twilio/transfer-result" })
    ).toBe(
      '<Response><Dial ringTone="gb" timeout="20" timeLimit="3600" action="https://b/twilio/transfer-result" method="POST" callerId="+15550001111">+441372656055</Dial></Response>'
    );
  });
  it("omits callerId entirely when falsy; honours overrides", () => {
    const x = buildTransferTwiml({ number: "+1555", callerId: "", ringTone: "us", timeoutSec: 45, timeLimitSec: 600, actionUrl: "https://b/a" });
    expect(x).toBe('<Response><Dial ringTone="us" timeout="45" timeLimit="600" action="https://b/a" method="POST">+1555</Dial></Response>');
    expect(x).not.toContain("callerId");
  });
  it("escapes number, url, callerId", () => {
    const x = buildTransferTwiml({ number: 'a"<&', callerId: 'c"<&', ringTone: "us", actionUrl: 'https://b/a?x=1&y="2"' });
    expect(x).toContain(">a&quot;&lt;&amp;</Dial>");
    expect(x).toContain('action="https://b/a?x=1&amp;y=&quot;2&quot;"');
    expect(x).toContain('callerId="c&quot;&lt;&amp;"');
  });
});

describe("buildMessageTwiml", () => {
  it("exact string", () => {
    expect(
      buildMessageTwiml({ line: "Hello there", sayVoice: "Polly.Amy", callbackUrl: "https://b/twilio/voicemail?to=%2B1", actionUrl: "https://b/twilio/message-done" })
    ).toBe(
      '<Response><Say voice="Polly.Amy">Hello there</Say><Record maxLength="120" playBeep="true" action="https://b/twilio/message-done" recordingStatusCallback="https://b/twilio/voicemail?to=%2B1"/><Hangup/></Response>'
    );
  });
  it("defaults the voice and maxLength override", () => {
    const x = buildMessageTwiml({ line: "Hi", callbackUrl: "https://b/c", actionUrl: "https://b/a", maxLengthSec: 60 });
    expect(x).toContain('<Say voice="Polly.Joanna">');
    expect(x).toContain('maxLength="60"');
  });
  it("escapes voice, line and urls", () => {
    const x = buildMessageTwiml({ line: 'a < b & "c"', sayVoice: 'v"<', callbackUrl: "https://b/c?x=1&y=2", actionUrl: "https://b/a?x=1&y=2" });
    expect(x).toContain('voice="v&quot;&lt;"');
    expect(x).toContain("a &lt; b &amp; &quot;c&quot;");
    expect(x).toContain('action="https://b/a?x=1&amp;y=2"');
    expect(x).toContain('recordingStatusCallback="https://b/c?x=1&amp;y=2"');
  });
  it("throws without actionUrl or callbackUrl", () => {
    expect(() => buildMessageTwiml({ line: "x", callbackUrl: "https://b/c" })).toThrow(TypeError);
    expect(() => buildMessageTwiml({ line: "x", callbackUrl: "https://b/c", actionUrl: "" })).toThrow(TypeError);
    expect(() => buildMessageTwiml({ line: "x", actionUrl: "https://b/a" })).toThrow(TypeError);
    expect(() => buildMessageTwiml({ line: "x", actionUrl: "https://b/a", callbackUrl: "" })).toThrow(TypeError);
  });
});

describe("buildHangupLineTwiml", () => {
  it("exact string, default voice", () => {
    expect(buildHangupLineTwiml({ line: "Bye" })).toBe('<Response><Say voice="Polly.Joanna">Bye</Say><Hangup/></Response>');
  });
  it("escapes", () => {
    expect(buildHangupLineTwiml({ line: "a & b", sayVoice: 'v"' })).toBe('<Response><Say voice="v&quot;">a &amp; b</Say><Hangup/></Response>');
  });
});

describe("legacy wrappers", () => {
  it("degraded keeps its wording and gains action + beep", () => {
    const x = buildDegradedVoicemailTwiml("https://b/voicemail?to=%2B1", "https://b/twilio/message-done");
    expect(x).toContain("We&apos;re sorry");
    expect(x).toContain("leave your name, number, and a brief message after the tone.");
    expect(x).toContain('action="https://b/twilio/message-done"');
    expect(x).toContain('recordingStatusCallback="https://b/voicemail?to=%2B1"');
    expect(x).toContain('playBeep="true"');
    expect(x).toContain('voice="Polly.Joanna"');
  });
  it("unrouted keeps its wording and gains action + beep", () => {
    const x = buildUnroutedVoicemailTwiml("https://b/cb", "Polly.Amy", "https://b/twilio/message-done");
    expect(x).toContain("can&apos;t connect you to this office right now.");
    expect(x).toContain("and someone will get back to you.");
    expect(x).toContain('voice="Polly.Amy"');
    expect(x).toContain('action="https://b/twilio/message-done"');
    expect(x).toContain('recordingStatusCallback="https://b/cb"');
  });
  it("wrappers refuse a missing action URL", () => {
    expect(() => buildDegradedVoicemailTwiml("https://b/cb")).toThrow(TypeError);
    expect(() => buildUnroutedVoicemailTwiml("https://b/cb", "Polly.Amy")).toThrow(TypeError);
  });
});

describe("buildUnroutedTransferTwiml", () => {
  it("carries timeLimit right after ringTone", () => {
    const x = buildUnroutedTransferTwiml("+1555", "+1666", "us");
    expect(x).toContain('<Dial ringTone="us" timeLimit="3600" callerId="+1666">+1555</Dial>');
  });
});
