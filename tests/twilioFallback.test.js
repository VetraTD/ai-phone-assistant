import { createRequire } from "node:module";
import { describe, it, expect, afterEach } from "vitest";
import { CALL_LINES } from "../lib/twiml.js";

const require = createRequire(import.meta.url);
const { buildFallbackTwiml, handler, LINES } = require("../twilio/fallback/fallback.js");
const { VoiceResponse } = require("twilio").twiml;

const OURS = "+442071234567";
const CALLER = "+447700900555";
const BIZ = "+447700900123";
const CTX = { DOMAIN_NAME: "vetra-fallback-1234.twil.io", VOICEMAIL_URL: "https://prod.example.com/twilio/voicemail" };

function build(event, context = CTX) {
  return buildFallbackTwiml({ From: CALLER, To: OURS, n: BIZ, t: "20", v: "Polly.Amy", ...event }, context, VoiceResponse).toString();
}
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}\\b[^>]*?/?>`, "g"))].map((m) => m[0]);
const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
const unesc = (s) => s.replace(/&amp;/g, "&");

describe("branches", () => {
  it("step=done hangs up and nothing else", () => {
    const xml = build({ step: "done" });
    expect(xml).toMatch(/<Response><Hangup\/><\/Response>/);
    expect(xml).not.toContain("<Say");
  });

  it("step=after with a completed dial hangs up (no leave-a-message)", () => {
    const xml = build({ step: "after", DialCallStatus: "completed" });
    expect(xml).toMatch(/<Response><Hangup\/><\/Response>/);
  });

  it.each(["busy", "no-answer", "failed", "canceled", undefined])("step=after with %s takes a message with the noAnswer line", (st) => {
    const xml = build({ step: "after", DialCallStatus: st });
    expect(xml).toContain("Sorry, nobody could get to the phone.");
    expect(tags(xml, "Record")).toHaveLength(1);
  });

  it("step requests are not bounce-checked", () => {
    const xml = build({ step: "after", DialCallStatus: "no-answer", From: OURS, To: OURS });
    expect(xml).not.toContain("<Reject");
    expect(tags(xml, "Record")).toHaveLength(1);
  });

  it("rejects a call from our number to itself", () => {
    expect(build({ From: OURS, To: OURS })).toContain('<Reject reason="busy"/>');
  });

  it("rejects From===To even when n is missing", () => {
    const xml = build({ From: OURS, To: OURS, n: undefined });
    expect(xml).toContain('<Reject reason="busy"/>');
    expect(xml).not.toContain("<Record");
  });

  it("rejects a call coming from the number we would dial", () => {
    const xml = build({ From: BIZ });
    expect(xml).toContain('<Reject reason="busy"/>');
    expect(xml).not.toContain("<Dial");
  });

  it("takes a message with the technical line when n is missing", () => {
    const xml = build({ n: undefined });
    expect(xml).toContain(CALL_LINES.technical);
    expect(xml).not.toContain("<Dial");
    expect(tags(xml, "Record")).toHaveLength(1);
  });

  it.each(["abc", "447700900123", "+0123456789", "+12", "+4477009001231234567", "", ["+447700900123", "+1"], 5])(
    "treats n=%j as missing",
    (bad) => {
      const xml = build({ n: bad });
      expect(xml).not.toContain("<Dial");
      expect(xml).toContain("technical problem");
    },
  );

  it("dials the transfer number with no Say before it", () => {
    const xml = build({});
    expect(xml).toMatch(/^<\?xml[^>]*\?><Response><Dial /);
    expect(xml).toContain(`<Number>${BIZ}</Number>`);
    expect(xml).not.toContain("<Say");
  });

  it("dials a leading-space n as +n", () => {
    const xml = build({ n: " 447700900123" });
    expect(xml).toContain("<Number>+447700900123</Number>");
  });
});

describe("the Dial", () => {
  it("shows OUR number as caller ID, never the caller's", () => {
    const dial = tags(build({}), "Dial")[0];
    expect(attr(dial, "callerId")).toBe(OURS);
    expect(dial).not.toContain(CALLER);
  });

  it("has timeout, timeLimit 3600, action and POST", () => {
    const dial = tags(build({}), "Dial")[0];
    expect(attr(dial, "timeout")).toBe("20");
    expect(attr(dial, "timeLimit")).toBe("3600");
    expect(attr(dial, "method")).toBe("POST");
    expect(attr(dial, "action")).toBeTruthy();
  });

  it.each([["45", "45"], ["20", "20"], ["30", "20"], ["junk", "20"], [undefined, "20"]])("t=%s rings %s seconds", (t, want) => {
    expect(attr(tags(build({ t }), "Dial")[0], "timeout")).toBe(want);
  });

  it("action carries n, t, v with + encoded, and & is XML-escaped", () => {
    const xml = build({ t: "45" });
    const dial = tags(xml, "Dial")[0];
    const raw = attr(dial, "action");
    expect(raw).toContain("&amp;");
    const url = new URL(unesc(raw));
    expect(url.origin + url.pathname).toBe("https://vetra-fallback-1234.twil.io/fallback");
    expect(url.search).toContain("n=%2B447700900123");
    expect(url.searchParams.get("step")).toBe("after");
    expect(url.searchParams.get("n")).toBe(BIZ);
    expect(url.searchParams.get("t")).toBe("45");
    expect(url.searchParams.get("v")).toBe("Polly.Amy");
  });

  it("action is relative without DOMAIN_NAME", () => {
    const raw = attr(tags(build({}, {}), "Dial")[0], "action");
    expect(raw.startsWith("fallback?step=after")).toBe(true);
  });

  it("never puts the caller's number or CallSid in the XML", () => {
    for (const ev of [{ CallSid: "CA123456789" }, { n: undefined, CallSid: "CA123456789" }, { step: "after", DialCallStatus: "busy", CallSid: "CA123456789" }]) {
      const xml = build(ev);
      expect(xml).not.toContain(CALLER);
      expect(xml).not.toContain(CALLER.slice(1));
      expect(xml).not.toContain("CA123456789");
    }
  });
});

describe("voice", () => {
  const sayTags = (xml) => tags(xml, "Say");

  it("a valid voice is on every Say", () => {
    for (const xml of [build({ n: undefined }), build({ step: "after", DialCallStatus: "busy" })]) {
      expect(sayTags(xml).length).toBeGreaterThan(0);
      for (const s of sayTags(xml)) expect(attr(s, "voice")).toBe("Polly.Amy");
    }
  });

  it("accepts Neural voices", () => {
    expect(attr(sayTags(build({ n: undefined, v: "Polly.Amy-Neural" }))[0], "voice")).toBe("Polly.Amy-Neural");
  });

  it.each(['Polly.Amy"><Hangup/>', "Alice", "", undefined])("omits the voice attribute for v=%j", (v) => {
    const xml = build({ n: undefined, v });
    expect(sayTags(xml).length).toBeGreaterThan(0);
    for (const s of sayTags(xml)) expect(s).not.toContain("voice");
    expect(xml.match(/<Hangup\/>/g)).toHaveLength(1);
  });

  it("drops an invalid v from the after URL too", () => {
    const raw = attr(tags(build({ v: "Alice" }), "Dial")[0], "action");
    expect(raw).not.toContain("v=");
  });
});

describe("Record", () => {
  const events = [
    { n: undefined },
    { step: "after", DialCallStatus: "busy" },
    { step: "after", DialCallStatus: "no-answer" },
    { step: "after" },
    { n: "bad" },
  ];

  it("every Record in every branch has a non-empty action, with or without VOICEMAIL_URL", () => {
    for (const ctx of [CTX, {}, { DOMAIN_NAME: CTX.DOMAIN_NAME }, { VOICEMAIL_URL: "" }]) {
      for (const ev of events) {
        const records = tags(build(ev, ctx), "Record");
        expect(records).toHaveLength(1);
        for (const r of records) {
          expect(attr(r, "action")).toBeTruthy();
          expect(attr(r, "method")).toBe("POST");
          expect(attr(r, "maxLength")).toBe("120");
          expect(attr(r, "playBeep")).toBe("true");
        }
      }
    }
  });

  it("action is the done step", () => {
    expect(attr(tags(build({ n: undefined }), "Record")[0], "action")).toBe("https://vetra-fallback-1234.twil.io/fallback?step=done");
    expect(attr(tags(build({ n: undefined }, {}), "Record")[0], "action")).toBe("fallback?step=done");
  });

  it("callback carries only to=<our number> when VOICEMAIL_URL is set", () => {
    const r = tags(build({ n: undefined }), "Record")[0];
    expect(attr(r, "recordingStatusCallback")).toBe(`https://prod.example.com/twilio/voicemail?to=${encodeURIComponent(OURS)}`);
    expect(attr(r, "recordingStatusCallback")).toContain("to=%2B442071234567");
  });

  it("has no callback when VOICEMAIL_URL is unset or empty, but keeps the action", () => {
    for (const ctx of [{ DOMAIN_NAME: CTX.DOMAIN_NAME }, { DOMAIN_NAME: CTX.DOMAIN_NAME, VOICEMAIL_URL: "" }]) {
      const r = tags(build({ n: undefined }, ctx), "Record")[0];
      expect(r).not.toContain("recordingStatusCallback");
      expect(attr(r, "action")).toBeTruthy();
    }
  });

  it("is followed by a Hangup", () => {
    expect(build({ n: undefined })).toMatch(/<Record [^>]*\/><Hangup\/><\/Response>$/);
  });
});

describe("lines", () => {
  it("match CALL_LINES in lib/twiml.js", () => {
    expect(LINES.noAnswer).toBe(CALL_LINES.noAnswer);
    expect(LINES.technical).toBe(CALL_LINES.technical);
  });
});

describe("handler", () => {
  afterEach(() => {
    delete globalThis.Twilio;
  });

  it("answers with (null, twiml) from the builder", () => {
    globalThis.Twilio = { twiml: { VoiceResponse } };
    const calls = [];
    handler(CTX, { From: CALLER, To: OURS, n: BIZ, t: "20", v: "Polly.Amy" }, (...a) => calls.push(a));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBeNull();
    expect(calls[0][1].toString()).toContain("<Dial ");
  });

  it("still answers valid TwiML with a Say and Hangup when the builder throws", () => {
    globalThis.Twilio = { twiml: { VoiceResponse } };
    const event = {
      get From() {
        throw new Error("boom");
      },
    };
    const calls = [];
    handler(CTX, event, (...a) => calls.push(a));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBeNull();
    const xml = String(calls[0][1]);
    expect(xml).toContain("<Response>");
    expect(xml).toContain("<Say");
    expect(xml).toContain("<Hangup/>");
  });

  it("still answers when the Twilio global is missing", () => {
    const calls = [];
    handler(CTX, { From: CALLER, To: OURS }, (...a) => calls.push(a));
    expect(calls[0][0]).toBeNull();
    expect(String(calls[0][1])).toContain("<Hangup/>");
  });
});
