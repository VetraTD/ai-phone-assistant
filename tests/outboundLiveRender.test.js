// tests/outboundLiveRender.test.js
/**
 * Spec §9.3 step 1 / D6 (revised): the backstop and voicemail clips are
 * rendered by a short Gemini Live session IN THE TENANT'S LIVE VOICE, then
 * verified against the line and stored as 8 kHz mu-law.
 *
 * Every Live interaction here is a FAKE `connect` that emits canned 24 kHz
 * PCM and an output transcript. No real Gemini call is made (Task 15 owns the
 * paid run).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  renderLines,
  createLiveRenderAudio,
  RENDER_TIMEOUT_MS,
  RENDER_SYSTEM_PROMPT,
  wordOverlap,
} from "../lib/outbound/liveRender.js";
import { loadConfig } from "../services/db.js";

const OPENER = "Hi, is that Sam? It's Ava, an AI assistant from Digile Media.";
const VOICEMAIL =
  "Hi Sam, it's Ava, an AI assistant from Digile Media, about your enquiry. We'll try you again soon. This call may be transcribed to help us assist you.";

/** `ms` of a loud 24 kHz PCM16 tone, base64, as Live sends it. */
function pcm24k(ms) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 6000 : -6000, i * 2);
  return buf.toString("base64");
}

/**
 * A fake connectLive. Once the user turn arrives it emits two audio chunks
 * (500 ms each), the transcript `say(line)`, then turnComplete -- the shape
 * a real render produced in spike A.
 */
function fakeConnect({ say = (line) => line, hang = false, failConnect = false, closeEarly = false } = {}) {
  const sessions = [];
  const connect = vi.fn(async ({ config, callbacks }) => {
    if (failConnect) throw new Error("connect refused");
    const session = {
      config,
      sent: [],
      closed: false,
      sendClientContent(msg) {
        this.sent.push(msg);
        if (hang) return;
        const line = msg.turns[0].parts[0].text.replace(/^Say exactly: "/, "").replace(/"$/, "");
        setImmediate(() => {
          if (closeEarly) {
            callbacks.onclose?.({ code: 1011, reason: "internal" });
            return;
          }
          callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm24k(500) } }] } } });
          callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm24k(500) } }] } } });
          callbacks.onmessage({ serverContent: { outputTranscription: { text: say(line) } } });
          callbacks.onmessage({ serverContent: { turnComplete: true } });
        });
      },
      close() {
        this.closed = true;
      },
    };
    sessions.push(session);
    return { session, languagePinned: true, surface: "aistudio", model: "m" };
  });
  return { connect, sessions };
}

const quietLog = () => ({ info: vi.fn(), error: vi.fn() });

afterEach(() => {
  vi.useRealTimers();
});

describe("renderLines", () => {
  it("returns an 8 kHz mu-law buffer of the right length: one second of 24 kHz PCM16 -> 8,000 bytes", async () => {
    const { connect } = fakeConnect();
    const out = await renderLines({ lines: { opener: OPENER }, voiceName: "Aoede", languageCode: "en-GB", connect, log: quietLog() });
    expect(Buffer.isBuffer(out.opener)).toBe(true);
    expect(out.opener.length).toBe(8000);
    expect(out).not.toHaveProperty("voicemail");
  });

  it("asks Live, in the given voice and language, to speak the line verbatim -- then closes the session", async () => {
    const { connect, sessions } = fakeConnect();
    await renderLines({ lines: { opener: OPENER }, voiceName: "Aoede", languageCode: "en-GB", connect, log: quietLog() });

    expect(connect).toHaveBeenCalledTimes(1);
    const { config } = connect.mock.calls[0][0];
    expect(config.responseModalities).toEqual(["AUDIO"]);
    expect(config.systemInstruction).toEqual({ parts: [{ text: RENDER_SYSTEM_PROMPT }] });
    expect(RENDER_SYSTEM_PROMPT).toBe("Speak the user's text exactly, nothing else.");
    expect(config.outputAudioTranscription).toEqual({});
    expect(config.speechConfig).toEqual({ voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }, languageCode: "en-GB" });
    expect(sessions[0].sent).toEqual([
      { turns: [{ role: "user", parts: [{ text: `Say exactly: "${OPENER}"` }] }], turnComplete: true },
    ]);
    expect(sessions[0].closed).toBe(true);
  });

  it("renders the opener and the voicemail, one short session each", async () => {
    const { connect } = fakeConnect();
    const out = await renderLines({ lines: { opener: OPENER, voicemail: VOICEMAIL }, voiceName: "Kore", languageCode: "en-GB", connect, log: quietLog() });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(out.opener.length).toBe(8000);
    expect(out.voicemail.length).toBe(8000);
  });

  it("REFUSES a clip whose transcript drops 'AI assistant' -- the backstop must say the disclosure verbatim", async () => {
    const { connect } = fakeConnect({ say: (line) => line.replace("an AI assistant ", "") });
    const log = quietLog();
    const out = await renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect, log, logFields: { outreachId: "out-1" } });
    expect(out.opener).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "outbound_backstop_render_refused",
      expect.objectContaining({ outreachId: "out-1", reason: "transcript_mismatch" })
    );
  });

  it("refuses a clip that drops ONLY the word 'AI' even though the word overlap stays above 0.9", async () => {
    const say = (line) => line.replace("an AI assistant", "an assistant");
    expect(wordOverlap(OPENER, say(OPENER))).toBeGreaterThanOrEqual(0.9);
    const { connect } = fakeConnect({ say });
    const out = await renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect, log: quietLog() });
    expect(out.opener).toBeNull();
  });

  it("accepts a transcript that differs only in case, punctuation and 'A.I.' spelling", async () => {
    const say = () => "hi is that sam its ava an A.I. assistant from digile media";
    const { connect } = fakeConnect({ say });
    const out = await renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect, log: quietLog() });
    expect(out.opener).not.toBeNull();
  });

  it("a refused voicemail is logged under its own name and does not take the opener with it", async () => {
    const { connect } = fakeConnect({ say: (line) => (line === VOICEMAIL ? "Hello." : line) });
    const log = quietLog();
    const out = await renderLines({ lines: { opener: OPENER, voicemail: VOICEMAIL }, voiceName: "Kore", languageCode: "en-GB", connect, log });
    expect(out.opener.length).toBe(8000);
    expect(out.voicemail).toBeNull();
    expect(log.error).toHaveBeenCalledWith("outbound_voicemail_render_refused", expect.objectContaining({ reason: "transcript_mismatch" }));
  });

  it("a connect failure or an early close gives null for that line, never a throw", async () => {
    const failed = await renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect: fakeConnect({ failConnect: true }).connect, log: quietLog() });
    expect(failed.opener).toBeNull();
    const closed = await renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect: fakeConnect({ closeEarly: true }).connect, log: quietLog() });
    expect(closed.opener).toBeNull();
  });

  it("a hung Live session is bounded: after RENDER_TIMEOUT_MS the line is null and the session is closed", async () => {
    vi.useFakeTimers();
    const { connect, sessions } = fakeConnect({ hang: true });
    const log = quietLog();
    let settled = null;
    const p = renderLines({ lines: { opener: OPENER }, voiceName: "Kore", languageCode: "en-GB", connect, log }).then((v) => (settled = v));

    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS - 1);
    expect(settled).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled.opener).toBeNull();
    expect(sessions[0].closed).toBe(true);
    expect(log.error).toHaveBeenCalledWith("outbound_backstop_render_refused", expect.objectContaining({ reason: "timeout" }));
  });

  it("the timeout is the ruled value", () => {
    expect(RENDER_TIMEOUT_MS).toBe(20_000);
  });
});

describe("createLiveRenderAudio (dispatch's renderAudio)", () => {
  const BIZ = "biz-digile";
  function fakeDb(business) {
    return {
      withTenant: vi.fn(async (_id, fn) => fn()),
      fetchBusinessById: vi.fn(async () => business),
      fetchBusinessCapabilities: vi.fn(async () => []),
      // The real one: the voice comes from config.liveVoice, which only
      // loadConfig maps from the row's live_voice column.
      loadConfig,
    };
  }

  it("renders in the voice and language resolved from the BUSINESS (its number and its config), never the contact's", async () => {
    // No locale on the row, so the language derives from a NUMBER -- and the
    // business number (+44) and the contact's (+1) disagree on purpose.
    const db = fakeDb({ id: BIZ, name: "Digile Media", live_voice: "Aoede", locale: null });
    const { connect } = fakeConnect();
    const renderAudio = createLiveRenderAudio({ db, env: {}, connect, log: quietLog() });

    const row = {
      id: "out-1",
      business_id: BIZ,
      phone_e164: "+15551230000",
      config: { caller_id: "+441372656055" },
    };
    const audio = await renderAudio({ row, attemptNo: 1, lines: { opener: OPENER } });

    expect(db.withTenant.mock.calls[0][0]).toBe(BIZ);
    expect(db.fetchBusinessById).toHaveBeenCalledWith(BIZ);
    const { config } = connect.mock.calls[0][0];
    expect(config.speechConfig).toEqual({ voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } }, languageCode: "en-GB" });
    expect(audio.opener.length).toBe(8000);
    expect(audio.voicemail).toBeNull();
  });

  it("a refused line comes back as null for that key", async () => {
    const db = fakeDb({ id: BIZ, name: "Digile Media", live_voice: null, locale: "en-GB" });
    const { connect } = fakeConnect({ say: (line) => (line === VOICEMAIL ? "nope" : line) });
    const renderAudio = createLiveRenderAudio({ db, env: {}, connect, log: quietLog() });
    const audio = await renderAudio({
      row: { id: "out-1", business_id: BIZ, config: { caller_id: "+441372656055" } },
      attemptNo: 1,
      lines: { opener: OPENER, voicemail: VOICEMAIL },
    });
    expect(audio.opener.length).toBe(8000);
    expect(audio.voicemail).toBeNull();
    // No live_voice on the row: the per-language default, as the call uses.
    expect(connect.mock.calls[0][0].config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
  });

  it("a business that cannot be loaded throws (dispatch logs outbound_backstop_render_failed) rather than rendering in a default voice", async () => {
    const db = fakeDb(null);
    const { connect } = fakeConnect();
    const renderAudio = createLiveRenderAudio({ db, env: {}, connect, log: quietLog() });
    await expect(
      renderAudio({ row: { id: "out-1", business_id: BIZ, config: { caller_id: "+441372656055" } }, attemptNo: 1, lines: { opener: OPENER } })
    ).rejects.toThrow(/business/);
    expect(connect).not.toHaveBeenCalled();
  });
});
