/**
 * scripts/probes/outbound-render-check.mjs (go-live pre-deploy, Y2; fix
 * round 1 for review Minors 6-7).
 *
 * NO NETWORK. This exercises the dry-run text and voice/language resolution
 * (the production renderCampaignLine / resolveLiveLanguage / resolveLiveVoice,
 * never re-implemented -- the resolvers are pure lookups, so calling the real
 * ones in a dry run costs nothing and opens no socket) and the --run gate
 * with an INJECTED FAKE renderLines/reserveP1/commit -- never the real Gemini
 * Live client, never a paid session. The controller runs the actual paid
 * --run leg separately.
 */
import { describe, it, expect, vi } from "vitest";
import { parseArgs, buildOpenerText, main, WORST_CASE_USD } from "../scripts/probes/outbound-render-check.mjs";
import { renderCampaignLine } from "../lib/outbound/campaignSchema.js";
import { TEMPLATES } from "../lib/outbound/templates.js";
import { resolveLiveLanguage, resolveLiveVoice } from "../lib/voice/live/index.js";

const PERSONA = "Ava";
const BUSINESS_NAME = "Digile Media";
const FIRST_NAME = "Nithin";
// The US tenant named in the go-live commands doc -- a +1 number, so the
// production fallback (no locale/liveVoice on the row) resolves en-US/Kore,
// never Digile's en-GB.
const US_CALLER_ID = "+18176011171";
const BASE_ARGV = ["--persona", PERSONA, "--business-name", BUSINESS_NAME, "--first-name", FIRST_NAME];
const CLEAN_ENV = {}; // no LIVE_LANGUAGE_CODE / LIVE_VOICE / LIVE_MODEL override

describe("outbound-render-check: parseArgs", () => {
  it("parses persona/business-name/first-name/caller-id and defaults locale/live-voice/run", () => {
    const r = parseArgs([...BASE_ARGV, "--caller-id", US_CALLER_ID]);
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ persona: PERSONA, businessName: BUSINESS_NAME, firstName: FIRST_NAME, callerId: US_CALLER_ID, locale: "", liveVoice: "", run: false });
  });

  it("--run is a flag, not a value", () => {
    expect(parseArgs([...BASE_ARGV, "--caller-id", US_CALLER_ID, "--run"]).value.run).toBe(true);
  });

  it("--locale and --live-voice are the tenant's own config values, parsed verbatim", () => {
    const r = parseArgs([...BASE_ARGV, "--caller-id", US_CALLER_ID, "--locale", "en-GB", "--live-voice", "Aoede"]);
    expect(r.value).toMatchObject({ locale: "en-GB", liveVoice: "Aoede" });
  });

  it("caller-id is optional without --run", () => {
    const r = parseArgs(BASE_ARGV);
    expect(r.ok).toBe(true);
    expect(r.value.callerId).toBeNull();
  });

  it("caller-id is REQUIRED with --run (production always resolves against a real business number)", () => {
    const r = parseArgs([...BASE_ARGV, "--run"]);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.path)).toContain("caller-id");
  });

  it("rejects a non-E.164 --caller-id", () => {
    const r = parseArgs([...BASE_ARGV, "--caller-id", "0117"]);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.path)).toContain("caller-id");
  });

  it("refuses when --business-name or --first-name is missing", () => {
    const r = parseArgs(["--persona", PERSONA]);
    expect(r.ok).toBe(false);
    const paths = r.errors.map((e) => e.path);
    expect(paths).toContain("business-name");
    expect(paths).toContain("first-name");
  });
});

describe("outbound-render-check: buildOpenerText builds the SAME text the dispatcher would", () => {
  it("matches renderCampaignLine called directly against the speed_to_lead template", () => {
    const { text } = buildOpenerText({ persona: PERSONA, businessName: BUSINESS_NAME, firstName: FIRST_NAME });
    const expectedConfig = { ...TEMPLATES.speed_to_lead, persona_name: PERSONA };
    const expected = renderCampaignLine(expectedConfig.opener, { firstName: FIRST_NAME, businessName: BUSINESS_NAME, config: expectedConfig });
    expect(text).toBe(expected);
    expect(text).toContain(BUSINESS_NAME);
    expect(text).toContain(FIRST_NAME);
    expect(text).toMatch(/AI assistant/i);
  });

  it("carries the persona override through to the rendered text", () => {
    const { text } = buildOpenerText({ persona: "Sam", businessName: BUSINESS_NAME, firstName: FIRST_NAME });
    expect(text).toContain("Sam");
  });
});

// Minor 7. Pure functions -- no network, no spend -- so these run in a dry
// run against the REAL production resolvers, never a fake.
describe("outbound-render-check: voice/language resolved through the production resolvers (Minor 7)", () => {
  it("--caller-id with no --locale/--live-voice resolves to exactly what the production resolvers return for that input", async () => {
    const expectedLanguage = resolveLiveLanguage({}, US_CALLER_ID, CLEAN_ENV);
    const expectedVoice = resolveLiveVoice({}, expectedLanguage.code, CLEAN_ENV);

    const lines = [];
    const result = await main({
      argv: [...BASE_ARGV, "--caller-id", US_CALLER_ID],
      env: CLEAN_ENV,
      print: (s) => lines.push(s),
      printErr: (s) => lines.push(s),
    });

    expect(result.language).toEqual(expectedLanguage);
    expect(result.voice).toEqual(expectedVoice);
    // US number, no locale on the row: production falls back to en-US, not
    // Digile's en-GB -- the exact gap Minor 7 named.
    expect(expectedLanguage).toMatchObject({ code: "en-US", source: "from_number" });
    expect(expectedVoice).toMatchObject({ name: "Kore", source: "default" });
    expect(lines.some((l) => l.includes("language: en-US") && l.includes("from_number"))).toBe(true);
    expect(lines.some((l) => l.includes("voice: Kore") && l.includes("default"))).toBe(true);
  });

  it("explicit --locale/--live-voice win over the caller-ID-derived fallback", async () => {
    const result = await main({
      argv: [...BASE_ARGV, "--caller-id", US_CALLER_ID, "--locale", "en-GB", "--live-voice", "Aoede"],
      env: CLEAN_ENV,
      print: () => {},
      printErr: () => {},
    });

    expect(result.language).toMatchObject({ code: "en-GB", source: "tenant" });
    expect(result.voice).toMatchObject({ name: "Aoede", source: "tenant" });
  });

  it("a GB caller-id with no locale resolves en-GB/Kore, matching the production resolvers directly", async () => {
    const gbCallerId = "+441372656055";
    const expectedLanguage = resolveLiveLanguage({}, gbCallerId, CLEAN_ENV);
    const expectedVoice = resolveLiveVoice({}, expectedLanguage.code, CLEAN_ENV);

    const result = await main({ argv: [...BASE_ARGV, "--caller-id", gbCallerId], env: CLEAN_ENV, print: () => {}, printErr: () => {} });
    expect(result.language).toEqual(expectedLanguage);
    expect(result.voice).toEqual(expectedVoice);
  });
});

describe("outbound-render-check: main() dry run never opens a session", () => {
  it("prints the text, resolved language/voice, and an estimated worst-case spend, and never calls renderLines", async () => {
    const renderLinesFn = vi.fn();
    const reserveP1Fn = vi.fn();
    const commitFn = vi.fn();
    const lines = [];
    const result = await main({
      argv: [...BASE_ARGV, "--caller-id", US_CALLER_ID],
      env: CLEAN_ENV,
      renderLines: renderLinesFn,
      reserveP1: reserveP1Fn,
      commit: commitFn,
      print: (s) => lines.push(s),
      printErr: (s) => lines.push(s),
    });

    expect(renderLinesFn).not.toHaveBeenCalled();
    expect(reserveP1Fn).not.toHaveBeenCalled();
    expect(commitFn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, ran: false });
    expect(result.text).toContain(BUSINESS_NAME);
    expect(lines.some((l) => l.includes("DRY RUN"))).toBe(true);
    expect(lines.some((l) => l.includes(String(WORST_CASE_USD.toFixed(2))))).toBe(true);
    expect(lines.some((l) => l.startsWith("language:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("voice:"))).toBe(true);
  });

  it("refuses before building anything when a required flag is missing, and never calls renderLines", async () => {
    const renderLinesFn = vi.fn();
    const result = await main({ argv: ["--persona", PERSONA], renderLines: renderLinesFn, print: () => {}, printErr: () => {} });
    expect(renderLinesFn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, ran: false });
  });

  it("refuses --run with no --caller-id before building anything", async () => {
    const renderLinesFn = vi.fn();
    const reserveP1Fn = vi.fn();
    const result = await main({ argv: [...BASE_ARGV, "--run"], renderLines: renderLinesFn, reserveP1: reserveP1Fn, print: () => {}, printErr: () => {} });
    expect(renderLinesFn).not.toHaveBeenCalled();
    expect(reserveP1Fn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, ran: false });
  });
});

describe("outbound-render-check: main() --run requires --run to open a session", () => {
  it("with --run: reserves against P1-DEPLOY, resolves voice/language, calls the injected renderLines with the built text, and commits the priced usage after", async () => {
    const fakeAudio = Buffer.from([1, 2, 3, 4, 5]);
    const renderLinesFn = vi.fn(async ({ lines: l, log }) => {
      // Simulate liveRender.js's own logging contract, so main() has a real
      // outbound_render_usage line to capture and price -- without opening
      // any socket.
      log.info("outbound_render_usage", { kind: "opener", outcome: "accepted", text_in: 10, audio_out: 100, audio_in: 0, text_out: 0, cached_in: 0 });
      return { opener: fakeAudio };
    });
    const reserveP1Fn = vi.fn(() => ({ p1Spent: 0.5, p1Remaining: 9.5, ledgerRemaining: 31.23 }));
    const commitFn = vi.fn();
    const priceTokensFn = vi.fn(() => ({ usd: 0.0021 }));
    const lines = [];

    const expectedLanguage = resolveLiveLanguage({}, US_CALLER_ID, { LIVE_MODEL: "gemini-3.8-live" });
    const expectedVoice = resolveLiveVoice({}, expectedLanguage.code, { LIVE_MODEL: "gemini-3.8-live" });

    const result = await main({
      argv: [...BASE_ARGV, "--caller-id", US_CALLER_ID, "--run"],
      env: { LIVE_MODEL: "gemini-3.8-live" },
      renderLines: renderLinesFn,
      reserveP1: reserveP1Fn,
      commit: commitFn,
      priceTokens: priceTokensFn,
      print: (s) => lines.push(s),
      printErr: (s) => lines.push(s),
    });

    expect(reserveP1Fn).toHaveBeenCalledTimes(1);
    expect(reserveP1Fn).toHaveBeenCalledWith("P1-DEPLOY", WORST_CASE_USD);

    expect(renderLinesFn).toHaveBeenCalledTimes(1);
    const call = renderLinesFn.mock.calls[0][0];
    expect(call.lines).toEqual({ opener: result.text });
    expect(call.model).toBe("gemini-3.8-live");
    expect(call.voiceName).toBe(expectedVoice.name);
    expect(call.languageCode).toBe(expectedLanguage.code);
    expect(typeof call.log.info).toBe("function");

    expect(commitFn).toHaveBeenCalledTimes(1);
    expect(commitFn).toHaveBeenCalledWith({ probe: "P1-DEPLOY", usd: 0.0021, estimated: false });

    expect(result).toMatchObject({ ok: true, ran: true, byteCount: fakeAudio.length, verdict: "accepted", usd: 0.0021, estimated: false });
  });

  // -------------------------------------------------------------------
  // Minor 6: the spend ledger must never record $0 once a session opened.
  // -------------------------------------------------------------------

  it("a throw after the session opens still commits the reserved worst case, not $0", async () => {
    const renderLinesFn = vi.fn(async () => {
      throw new Error("boom");
    });
    const reserveP1Fn = vi.fn(() => ({ p1Spent: 0, p1Remaining: 10, ledgerRemaining: 31.73 }));
    const commitFn = vi.fn();

    await expect(
      main({
        argv: [...BASE_ARGV, "--caller-id", US_CALLER_ID, "--run"],
        env: CLEAN_ENV,
        renderLines: renderLinesFn,
        reserveP1: reserveP1Fn,
        commit: commitFn,
        print: () => {},
        printErr: () => {},
      })
    ).rejects.toThrow("boom");

    expect(commitFn).toHaveBeenCalledTimes(1);
    expect(commitFn).toHaveBeenCalledWith({ probe: "P1-DEPLOY", usd: WORST_CASE_USD, estimated: true });
    expect(commitFn.mock.calls[0][0].usd).toBeGreaterThan(0);
  });

  it("unpriced usage (outbound_render_usage never captured) falls back to priceGeminiByMinutes on the measured audio, not $0", async () => {
    const fakeAudio = Buffer.alloc(8000); // 1.0s of 8kHz mu-law
    const renderLinesFn = vi.fn(async () => ({ opener: fakeAudio })); // never calls log.info
    const reserveP1Fn = vi.fn(() => ({ p1Spent: 0, p1Remaining: 10, ledgerRemaining: 31.73 }));
    const commitFn = vi.fn();
    const priceGeminiByMinutesFn = vi.fn(() => ({ usd: 0.0003, estimated: true }));

    const result = await main({
      argv: [...BASE_ARGV, "--caller-id", US_CALLER_ID, "--run"],
      env: CLEAN_ENV,
      renderLines: renderLinesFn,
      reserveP1: reserveP1Fn,
      commit: commitFn,
      priceGeminiByMinutes: priceGeminiByMinutesFn,
      print: () => {},
      printErr: () => {},
    });

    expect(priceGeminiByMinutesFn).toHaveBeenCalledWith({ inSeconds: 0, outSeconds: 1 });
    expect(commitFn).toHaveBeenCalledTimes(1);
    expect(commitFn).toHaveBeenCalledWith({ probe: "P1-DEPLOY", usd: 0.0003, estimated: true });
    expect(result).toMatchObject({ usd: 0.0003, estimated: true });
  });

  it("an unpriced MODEL (priceTokens returns usd:0) also falls back rather than committing $0", async () => {
    const fakeAudio = Buffer.alloc(4000); // 0.5s
    const renderLinesFn = vi.fn(async ({ log }) => {
      log.info("outbound_render_usage", { kind: "opener", outcome: "accepted", text_in: 5, audio_out: 50 });
      return { opener: fakeAudio };
    });
    const reserveP1Fn = vi.fn(() => ({ p1Spent: 0, p1Remaining: 10, ledgerRemaining: 31.73 }));
    const commitFn = vi.fn();
    const priceTokensFn = vi.fn(() => ({ usd: 0, error: "no rate card for models/unknown-preview" }));
    const priceGeminiByMinutesFn = vi.fn(() => ({ usd: 0.0002, estimated: true }));

    const result = await main({
      argv: [...BASE_ARGV, "--caller-id", US_CALLER_ID, "--run"],
      env: { LIVE_MODEL: "models/unknown-preview" },
      renderLines: renderLinesFn,
      reserveP1: reserveP1Fn,
      commit: commitFn,
      priceTokens: priceTokensFn,
      priceGeminiByMinutes: priceGeminiByMinutesFn,
      print: () => {},
      printErr: () => {},
    });

    expect(commitFn).toHaveBeenCalledWith({ probe: "P1-DEPLOY", usd: 0.0002, estimated: true });
    expect(result.usd).toBe(0.0002);
  });

  it("falls back to the worst case when even priceGeminiByMinutes has nothing to measure (a refusal with no audio)", async () => {
    const renderLinesFn = vi.fn(async () => ({ opener: null })); // refused, no clip, no usage logged
    const reserveP1Fn = vi.fn(() => ({ p1Spent: 0, p1Remaining: 10, ledgerRemaining: 31.73 }));
    const commitFn = vi.fn();

    const result = await main({
      argv: [...BASE_ARGV, "--caller-id", US_CALLER_ID, "--run"],
      env: CLEAN_ENV,
      renderLines: renderLinesFn,
      reserveP1: reserveP1Fn,
      commit: commitFn,
      print: () => {},
      printErr: () => {},
    });

    expect(commitFn).toHaveBeenCalledWith({ probe: "P1-DEPLOY", usd: WORST_CASE_USD, estimated: true });
    expect(result.usd).toBe(WORST_CASE_USD);
  });
});
