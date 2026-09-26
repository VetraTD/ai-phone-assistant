#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Y2 -- go-live pre-deploy code, group Y. Local, paid, ~$0.003 per --run.
// Fix round 1 (review Minors 6-7): the spend ledger no longer records $0 for
// a failed/unpriced paid run, and voice/language are resolved through the
// production resolvers instead of being hard-coded.
//
// Renders ONE backstop (opener) clip exactly as the dispatcher would, through
// Gemini Live, before any real dial. Never dials. Never touches a database.
//
// TEXT: lib/outbound/campaignSchema.js's renderCampaignLine -- the SAME
// function dispatch.js (the opener/voicemail clip) and callContext.js (the
// Live session's own seed) both call, so the text this probe renders cannot
// disagree with what a real call would speak. Never re-implemented here.
//
// VOICE + LANGUAGE: resolved exactly as createLiveRenderAudio does
// (lib/outbound/liveRender.js:445-447), through the SAME two production
// functions, `resolveLiveLanguage(config, callerId, env)` and
// `resolveLiveVoice(config, languageCode, env)` (lib/voice/live/index.js),
// lazily imported the same way createLiveRenderAudio imports them (that
// module must not load at boot). `config` here is shaped like the tenant's
// own row: `--locale`/`--live-voice` stand in for `businesses.locale` /
// `.liveVoice`, and `--caller-id` stands in for the campaign's `caller_id` --
// production always resolves against the BUSINESS number, never the
// contact's. Neither resolver is re-implemented; an empty `--locale`/
// `--live-voice` gets exactly the fallback the dispatcher gets for a tenant
// with no locale/liveVoice set (the caller-ID's country, then the per-
// language default voice).
//
// AUDIO + VERIFICATION: lib/outbound/liveRender.js's renderLines -- the SAME
// function dispatch's renderAudio wraps for a real call (spike A: ~140 ms
// warm, first audio 0.54-0.85 s, ~$0.002-0.004/render). Its verdict
// (accepted/refused, overlap, word ratio) and its token usage are only ever
// LOGGED (`outbound_render_usage`, `outbound_backstop_render_refused`), never
// returned -- so this probe injects a `log` to CAPTURE them rather than
// re-deriving overlap/ratio itself (which would be a second implementation of
// the very thing being checked).
//
// DRY RUN BY DEFAULT: builds and prints the text, its length against the
// dispatcher's own budget (CAMPAIGN_LIMITS.rendered_opener), and the resolved
// language/voice/source and an estimated worst-case spend. Never opens a
// Live session.
//
// --run actually renders and spends. Reserves against the Part 1 cap first
// (scripts/probes/lib/spendLive.js:249 reserveP1("P1-DEPLOY", 0.01)) and
// commits after, win or lose -- and NEVER commits $0 once the reserve has
// run: a throw commits the reserved worst case, and unpriced usage (no
// usageMetadata captured, or a LIVE_MODEL with no rate card) falls back to
// priceGeminiByMinutes on the audio actually measured, or to the worst case
// if there is nothing to measure at all -- the same shape
// scripts/spikes/spike-a-opener.mjs:~290-295 uses (that file, not
// scripts/probes/spike-a-opener.mjs, which does not exist in this repo).
//
// Usage (Norton on this machine intercepts TLS; vendor scripts need the CA bundle):
//   node scripts/probes/outbound-render-check.mjs --persona Ava \
//     --business-name "Digile Media" --first-name Nithin --caller-id +441372656055
//                                                       # DRY RUN, spends nothing
//   NODE_EXTRA_CA_CERTS=C:\Users\nithi\.gcloud-vetra2\ca-bundle.pem \
//     LIVE_MODEL=gemini-3.8-live \
//     node scripts/probes/outbound-render-check.mjs --persona Ava \
//       --business-name "Digile Media" --first-name Nithin \
//       --caller-id +441372656055 --run
//                                                       # PAID, ~$0.003
//   --caller-id is REQUIRED with --run (no default caller-ID exists in
//   production either); optional otherwise. --locale/--live-voice are the
//   tenant's own config values -- pass what `db-inspect --business <phone>`
//   reports, or leave them empty to see the SAME fallback a tenant with no
//   locale/liveVoice set gets in production.
//
// Model from LIVE_MODEL (the production model, e.g. gemini-3.8-live).
// Needs GEMINI_API_KEY in the environment or .env, read the way every other
// probe in this directory reads it.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { renderCampaignLine, CAMPAIGN_LIMITS } from "../../lib/outbound/campaignSchema.js";
import { TEMPLATES } from "../../lib/outbound/templates.js";
import { renderLines } from "../../lib/outbound/liveRender.js";
import { reserveP1, commit, priceTokens, priceGeminiByMinutes } from "./lib/spendLive.js";

const PROBE = "P1-DEPLOY";
const E164 = /^\+[1-9]\d{6,14}$/;
// Spike A measured ~$0.002-0.004 per render (liveRender.js's header); this is
// both the worst-case figure reserved against the Part 1 cap before spending
// AND the last-resort commit when nothing else can be priced (Minor 6).
export const WORST_CASE_USD = 0.01;
// The clip renderLines hands back is already downsampled to the 8 kHz mu-law
// Twilio plays (lib/voice/resample.js's createDownsampler) -- one byte per
// sample -- so byte count over 8000 is real seconds of audio actually heard,
// not an estimate of an estimate.
const RENDER_SAMPLE_RATE_HZ = 8000;

/**
 * Parses argv (already sliced past `node script.js`) the way scripts/outbound-admin.js does.
 * @returns {{ok: true, value: {persona: string, businessName: string, firstName: string,
 *   callerId: string|null, locale: string, liveVoice: string, run: boolean}} |
 *   {ok: false, errors: Array<{path: string, message: string}>}}
 */
export function parseArgs(argv) {
  const all = Array.isArray(argv) ? argv : [];
  const errors = [];
  const push = (path, message) => errors.push({ path, message });
  const argOf = (name) => {
    const i = all.indexOf(`--${name}`);
    return i >= 0 && all[i + 1] !== undefined && !String(all[i + 1]).startsWith("--") ? all[i + 1] : null;
  };

  const persona = argOf("persona");
  const businessName = argOf("business-name");
  const firstName = argOf("first-name");
  const callerId = argOf("caller-id");
  const locale = argOf("locale") || "";
  const liveVoice = argOf("live-voice") || "";
  const run = all.includes("--run");

  if (!persona) push("persona", "is required (--persona)");
  if (!businessName) push("business-name", "is required (--business-name)");
  if (!firstName) push("first-name", "is required (--first-name)");
  if (callerId !== null && !E164.test(callerId)) push("caller-id", "must be an E.164 number (--caller-id)");
  // Minor 7: production always resolves voice/language against a real
  // business number (the campaign's caller_id). --run without one would
  // render in whatever this function falls back to for no number at all,
  // which is not a check of any real tenant's render.
  if (run && !callerId) push("caller-id", "is required with --run (--caller-id <e164>) -- production always resolves against the campaign's caller_id");

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { persona, businessName, firstName, callerId, locale, liveVoice, run } };
}

/**
 * The opener TEXT, via the production builder -- the speed_to_lead template
 * (Part 1's only shipped template) with `persona_name` overridden from the
 * CLI, exactly as a saved campaign's config would carry it.
 * @returns {{text: string|null, config: object}}
 */
export function buildOpenerText({ persona, businessName, firstName }) {
  const config = { ...TEMPLATES.speed_to_lead, persona_name: persona };
  const text = renderCampaignLine(config.opener, { firstName, businessName, config });
  return { text, config };
}

/**
 * @param {object} [deps] - injectable for testing; production defaults otherwise.
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  renderLines: renderLinesFn = renderLines,
  reserveP1: reserveP1Fn = reserveP1,
  commit: commitFn = commit,
  priceTokens: priceTokensFn = priceTokens,
  priceGeminiByMinutes: priceGeminiByMinutesFn = priceGeminiByMinutes,
  // Injectable so a test can check the resolution without a network call --
  // both functions are pure (string/table lookups), so production defaults
  // are safe to exercise in a dry run with no network and no spend.
  resolveLiveLanguage: resolveLiveLanguageFn,
  resolveLiveVoice: resolveLiveVoiceFn,
  print = console.log,
  printErr = console.error,
} = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    for (const e of parsed.errors) printErr(`Refusing: ${e.path}: ${e.message}`);
    return { ok: false, ran: false };
  }
  const { persona, businessName, firstName, callerId, locale, liveVoice, run } = parsed.value;

  const { text } = buildOpenerText({ persona, businessName, firstName });
  if (text === null) {
    printErr(
      "Refusing: renderCampaignLine produced no usable opener for these inputs " +
        "(unusable_line -- the same refusal dispatch.js logs)."
    );
    return { ok: false, ran: false, text: null };
  }
  if (text.length > CAMPAIGN_LIMITS.rendered_opener) {
    printErr(
      `Refusing: rendered opener is ${text.length} chars, over the ${CAMPAIGN_LIMITS.rendered_opener}-char ` +
        "budget dispatch.js enforces (outbound_backstop_render_refused)."
    );
    return { ok: false, ran: false, text };
  }

  // Minor 7: resolved exactly the way createLiveRenderAudio resolves them
  // (liveRender.js:445-447) -- a tenant-shaped config, the campaign's
  // caller_id, and the SAME production functions. Lazily imported for the
  // same reason createLiveRenderAudio imports them lazily: this module must
  // not load at boot.
  let resolveLiveLanguage = resolveLiveLanguageFn;
  let resolveLiveVoice = resolveLiveVoiceFn;
  if (!resolveLiveLanguage || !resolveLiveVoice) {
    ({ resolveLiveLanguage, resolveLiveVoice } = await import("../../lib/voice/live/index.js"));
  }
  const tenantConfig = { locale: locale || undefined, liveVoice: liveVoice || undefined };
  const language = resolveLiveLanguage(tenantConfig, callerId || null, env);
  const voice = resolveLiveVoice(tenantConfig, language.code, env);

  print(`text: ${JSON.stringify(text)}`);
  print(`chars: ${text.length}/${CAMPAIGN_LIMITS.rendered_opener}`);
  print(`language: ${language.code} (source: ${language.source})`);
  print(`voice: ${voice.name} (source: ${voice.source})`);

  if (!run) {
    print(`DRY RUN -- no Live session opened. Re-run with --run to render for real (worst-case ~$${WORST_CASE_USD.toFixed(2)}).`);
    return { ok: true, ran: false, text, language, voice };
  }

  const budget = reserveP1Fn(PROBE, WORST_CASE_USD);
  print(`reserved: Part 1 remaining $${budget.p1Remaining.toFixed(4)}, ledger remaining $${budget.ledgerRemaining.toFixed(4)}`);

  const model = env.LIVE_MODEL || undefined;
  const captured = { usage: null, outcome: null, refusal: null };
  const log = {
    info(event, fields) {
      if (event === "outbound_render_usage" && fields?.kind === "opener") {
        const { kind, outcome, ...usage } = fields || {};
        captured.outcome = outcome;
        captured.usage = usage;
      }
    },
    error(event, fields) {
      if (event === "outbound_backstop_render_refused") captured.refusal = fields;
    },
  };

  // Minor 6. The reserve above already committed the Part 1 ledger to
  // treating this as a real spend, so nothing past this point may report
  // $0: a throw, missing usage, or an unpriced model must all fall back to a
  // real (or worst-case) figure, never silently under-record.
  let usd = 0;
  let estimated = false;
  let byteCount = 0;
  try {
    const audio = await renderLinesFn({ lines: { opener: text }, voiceName: voice.name, languageCode: language.code, model, env, log });
    byteCount = audio?.opener?.length || 0;

    const priced = captured.usage
      ? priceTokensFn(model || "gemini-3.8-live", captured.usage)
      : { usd: 0, error: "no usage captured -- outbound_render_usage was not logged" };

    if (priced.usd) {
      usd = priced.usd;
    } else {
      // Unpriced usage (never captured, or LIVE_MODEL has no rate card):
      // fall back to the audio actually measured -- spike-a-opener.mjs's
      // pattern -- or the worst case if there is nothing to measure (a
      // refusal with no audio and no usable usage at all).
      const byMinutes = priceGeminiByMinutesFn({ inSeconds: 0, outSeconds: byteCount / RENDER_SAMPLE_RATE_HZ });
      usd = byMinutes.usd || WORST_CASE_USD;
      estimated = true;
    }

    print(`verdict: ${captured.outcome ?? "unknown"}${captured.refusal ? ` refusal=${JSON.stringify(captured.refusal)}` : ""}`);
    print(`audio bytes: ${byteCount}`);
    print(`usage: ${JSON.stringify(captured.usage)}`);
    print(`cost: $${usd.toFixed(5)}${estimated ? " (estimated)" : ""}${priced.error ? ` (${priced.error})` : ""}`);

    return { ok: captured.outcome === "accepted", ran: true, text, language, voice, byteCount, verdict: captured.outcome, refusal: captured.refusal, usage: captured.usage, usd, estimated };
  } catch (err) {
    // The session was reserved and (as far as this function can tell) opened;
    // nothing usable came back at all, so the worst case is what gets billed
    // rather than nothing.
    usd = WORST_CASE_USD;
    estimated = true;
    printErr(`render failed: ${err?.message || err}`);
    throw err;
  } finally {
    commitFn({ probe: PROBE, usd, estimated });
    print(`committed $${usd.toFixed(5)} under ${PROBE}${estimated ? " (estimated)" : ""}`);
  }
}

// Guarded exactly as scripts/outbound-admin.js is: importing this module
// resolves the tree (production builder, renderLines, the spend meter)
// without opening a connection or a Live session.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((e) => {
      console.error(`outbound-render-check failed: ${e.message}`);
      process.exit(1);
    });
}
