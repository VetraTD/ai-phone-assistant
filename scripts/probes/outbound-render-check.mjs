#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Y2 -- go-live pre-deploy code, group Y. Local, paid, ~$0.003 per --run.
//
// Renders ONE backstop (opener) clip exactly as the dispatcher would, through
// Gemini Live, before any real dial. Never dials. Never touches a database.
//
// TEXT: lib/outbound/campaignSchema.js's renderCampaignLine -- the SAME
// function dispatch.js (the opener/voicemail clip) and callContext.js (the
// Live session's own seed) both call, so the text this probe renders cannot
// disagree with what a real call would speak. Never re-implemented here.
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
// dispatcher's own budget (CAMPAIGN_LIMITS.rendered_opener), and an estimated
// worst-case spend. Never opens a Live session.
//
// --run actually renders and spends. Reserves against the Part 1 cap first
// (scripts/probes/lib/spendLive.js:249 reserveP1("P1-DEPLOY", 0.01)) and
// commits after, win or lose (scripts/spikes/spike-a-opener.mjs's pattern:
// every paid call reserves before, commits in a `finally`, including a
// failed render).
//
// Usage (Norton on this machine intercepts TLS; vendor scripts need the CA bundle):
//   node scripts/probes/outbound-render-check.mjs --persona Ava \
//     --business-name "Digile Media" --first-name Nithin
//                                                       # DRY RUN, spends nothing
//   NODE_EXTRA_CA_CERTS=C:\Users\nithi\.gcloud-vetra2\ca-bundle.pem \
//     LIVE_MODEL=gemini-3.8-live \
//     node scripts/probes/outbound-render-check.mjs --persona Ava \
//       --business-name "Digile Media" --first-name Nithin --run
//                                                       # PAID, ~$0.003
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
import { reserveP1, commit, priceTokens } from "./lib/spendLive.js";

const PROBE = "P1-DEPLOY";
const DEFAULT_VOICE = "Kore";
const DEFAULT_LANGUAGE = "en-GB";
// Spike A measured ~$0.002-0.004 per render (liveRender.js's header); this is
// the worst-case figure reserved against the Part 1 cap before spending.
export const WORST_CASE_USD = 0.01;

/**
 * Parses argv (already sliced past `node script.js`) the way scripts/outbound-admin.js does.
 * @returns {{ok: true, value: {persona: string, businessName: string, firstName: string,
 *   voiceName: string, languageCode: string, run: boolean}} | {ok: false, errors: Array<{path: string, message: string}>}}
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
  const voiceName = argOf("voice") || DEFAULT_VOICE;
  const languageCode = argOf("language") || DEFAULT_LANGUAGE;
  const run = all.includes("--run");

  if (!persona) push("persona", "is required (--persona)");
  if (!businessName) push("business-name", "is required (--business-name)");
  if (!firstName) push("first-name", "is required (--first-name)");
  if (errors.length) return { ok: false, errors };

  return { ok: true, value: { persona, businessName, firstName, voiceName, languageCode, run } };
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
  print = console.log,
  printErr = console.error,
} = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    for (const e of parsed.errors) printErr(`Refusing: ${e.path}: ${e.message}`);
    return { ok: false, ran: false };
  }
  const { persona, businessName, firstName, voiceName, languageCode, run } = parsed.value;

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

  print(`text: ${JSON.stringify(text)}`);
  print(`chars: ${text.length}/${CAMPAIGN_LIMITS.rendered_opener}`);

  if (!run) {
    print(`DRY RUN -- no Live session opened. Re-run with --run to render for real (worst-case ~$${WORST_CASE_USD.toFixed(2)}).`);
    return { ok: true, ran: false, text };
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

  let usd = 0;
  let byteCount = 0;
  try {
    const audio = await renderLinesFn({ lines: { opener: text }, voiceName, languageCode, model, env, log });
    byteCount = audio?.opener?.length || 0;
    const priced = captured.usage ? priceTokensFn(model || "gemini-3.8-live", captured.usage) : { usd: 0, error: "no usage captured -- outbound_render_usage was not logged" };
    usd = priced.usd || 0;

    print(`verdict: ${captured.outcome ?? "unknown"}${captured.refusal ? ` refusal=${JSON.stringify(captured.refusal)}` : ""}`);
    print(`audio bytes: ${byteCount}`);
    print(`usage: ${JSON.stringify(captured.usage)}`);
    print(`cost: $${usd.toFixed(5)}${priced.error ? ` (${priced.error})` : ""}`);

    return { ok: captured.outcome === "accepted", ran: true, text, byteCount, verdict: captured.outcome, refusal: captured.refusal, usage: captured.usage, usd };
  } finally {
    commitFn({ probe: PROBE, usd });
    print(`committed $${usd.toFixed(5)} under ${PROBE}`);
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
