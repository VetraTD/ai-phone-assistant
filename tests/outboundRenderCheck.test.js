/**
 * scripts/probes/outbound-render-check.mjs (go-live pre-deploy, Y2).
 *
 * NO NETWORK. This exercises the dry-run text builder (the production
 * renderCampaignLine, never re-implemented) and the --run gate with an
 * INJECTED FAKE renderLines/reserveP1/commit -- never the real Gemini Live
 * client, never a paid session. The controller runs the actual paid --run
 * leg separately.
 */
import { describe, it, expect, vi } from "vitest";
import { parseArgs, buildOpenerText, main, WORST_CASE_USD } from "../scripts/probes/outbound-render-check.mjs";
import { renderCampaignLine } from "../lib/outbound/campaignSchema.js";
import { TEMPLATES } from "../lib/outbound/templates.js";

const PERSONA = "Ava";
const BUSINESS_NAME = "Digile Media";
const FIRST_NAME = "Nithin";
const BASE_ARGV = ["--persona", PERSONA, "--business-name", BUSINESS_NAME, "--first-name", FIRST_NAME];

describe("outbound-render-check: parseArgs", () => {
  it("parses persona/business-name/first-name and defaults voice/language/run", () => {
    const r = parseArgs(BASE_ARGV);
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ persona: PERSONA, businessName: BUSINESS_NAME, firstName: FIRST_NAME, run: false });
    expect(r.value.voiceName).toBeTruthy();
    expect(r.value.languageCode).toBeTruthy();
  });

  it("--run is a flag, not a value", () => {
    expect(parseArgs([...BASE_ARGV, "--run"]).value.run).toBe(true);
  });

  it("--voice and --language override the defaults", () => {
    const r = parseArgs([...BASE_ARGV, "--voice", "Aoede", "--language", "en-US"]);
    expect(r.value).toMatchObject({ voiceName: "Aoede", languageCode: "en-US" });
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

describe("outbound-render-check: main() dry run never opens a session", () => {
  it("prints the text and an estimated worst-case spend, and never calls renderLines", async () => {
    const renderLinesFn = vi.fn();
    const reserveP1Fn = vi.fn();
    const commitFn = vi.fn();
    const lines = [];
    const result = await main({
      argv: BASE_ARGV,
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
  });

  it("refuses before building anything when a required flag is missing, and never calls renderLines", async () => {
    const renderLinesFn = vi.fn();
    const result = await main({ argv: ["--persona", PERSONA], renderLines: renderLinesFn, print: () => {}, printErr: () => {} });
    expect(renderLinesFn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, ran: false });
  });
});

describe("outbound-render-check: main() --run requires --run to open a session", () => {
  it("with --run: reserves against P1-DEPLOY, calls the injected renderLines with the built text, and commits the priced usage after", async () => {
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

    const result = await main({
      argv: [...BASE_ARGV, "--run"],
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
    expect(typeof call.log.info).toBe("function");

    expect(commitFn).toHaveBeenCalledTimes(1);
    expect(commitFn).toHaveBeenCalledWith({ probe: "P1-DEPLOY", usd: 0.0021 });

    expect(result).toMatchObject({ ok: true, ran: true, byteCount: fakeAudio.length, verdict: "accepted", usd: 0.0021 });
  });

  it("still commits (win or lose) when renderLines throws", async () => {
    const renderLinesFn = vi.fn(async () => {
      throw new Error("boom");
    });
    const reserveP1Fn = vi.fn(() => ({ p1Spent: 0, p1Remaining: 10, ledgerRemaining: 31.73 }));
    const commitFn = vi.fn();

    await expect(
      main({
        argv: [...BASE_ARGV, "--run"],
        renderLines: renderLinesFn,
        reserveP1: reserveP1Fn,
        commit: commitFn,
        print: () => {},
        printErr: () => {},
      })
    ).rejects.toThrow("boom");

    expect(commitFn).toHaveBeenCalledTimes(1);
    expect(commitFn).toHaveBeenCalledWith({ probe: "P1-DEPLOY", usd: 0 });
  });
});
