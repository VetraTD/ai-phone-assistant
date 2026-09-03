#!/usr/bin/env node
/**
 * LVX17 -- what is the 2.2 seconds actually made of?
 *
 * ---------------------------------------------------------------------------
 * The question
 * ---------------------------------------------------------------------------
 *
 * Every Live call opens with roughly two seconds of silence before the caller
 * hears anything, and on one call a caller hung up during it. Staged timings
 * on 2026-09-02 located it exactly:
 *
 *     | call | lookup | context |  connect | total   |
 *     |------|--------|---------|----------|---------|
 *     | 1    |  17 ms |   61 ms | 2,243 ms | 2,400 ms|
 *     | 2    |   3 ms |   14 ms | 2,158 ms | 2,177 ms|
 *
 * The database is nothing and warming the module graph was nothing.
 * `live.connect()` costs ~2.2 s on EVERY call, warm or cold, and on this path
 * the model is the only voice, so it sits in front of the greeting.
 *
 * Two hypotheses have never been separated, and the choice of fix depends
 * entirely on which is true:
 *
 *   NETWORK -- TLS plus WebSocket upgrade to AI Studio. Not ours. If this
 *              dominates, the greeting has to come from somewhere else, and
 *              that means a second voice on the call.
 *
 *   PAYLOAD -- session setup carrying a ~17,000-character system instruction
 *              and ten tool declarations, prefilled server-side before the
 *              socket is usable. If THIS dominates, the fix is the prefix
 *              shrink already wanted for cost (backlog C2), and the model's
 *              OWN voice arrives sooner with no second voice and nothing
 *              spoken over.
 *
 * Already eliminated, so nobody re-derives it: the languageCode retry in
 * lib/voice/live/client.js is NOT the cause. It runs only when the first
 * connect throws; a clean connect returns languagePinned:true on attempt one.
 * 2.2 s is one handshake, not two.
 *
 * ---------------------------------------------------------------------------
 * The arms
 * ---------------------------------------------------------------------------
 *
 *   full      production prompt + ten tools     -- the control, what callers get
 *   minimal   minimal prompt   + ten tools      -- isolates the instruction
 *   no_tools  production prompt + no tools      -- isolates the declarations
 *   floor     minimal prompt   + no tools       -- the smallest setup possible
 *
 * `floor` is the closest thing available to a pure network measurement. The
 * gap between `floor` and `full` is the part that is ours to fix.
 *
 * THREE RUNS PER ARM, INTERLEAVED. This repository has already had an N=1
 * probe return opposite verdicts on consecutive runs, and interleaving is what
 * stops drift across the sitting -- network weather, API-side load -- landing
 * entirely on whichever arm ran last.
 *
 * Every run is printed, with a median. Never a bare mean over a signal that
 * may be bursty: that mistake was made in the echo round and a design
 * conclusion was drawn from it before a nonzero count disproved it.
 *
 * ---------------------------------------------------------------------------
 * What it costs
 * ---------------------------------------------------------------------------
 *
 * Twelve connects, ZERO turns. No audio is sent, no reply is generated, the
 * socket is closed as soon as it opens.
 *
 * Whether a connect with no turns is billed at all has never been measured
 * here, so this does not assert that it is free -- it prints whatever
 * usageMetadata arrives, and prints "none reported" when nothing does, rather
 * than printing a 0 that would read as a measurement. Expected to be pennies
 * at most.
 *
 * Usage:
 *   node scripts/probes/live-connect-cost.mjs             # plan only, spends nothing
 *   node scripts/probes/live-connect-cost.mjs --confirm
 *   node scripts/probes/live-connect-cost.mjs --confirm --runs 5
 */
import "dotenv/config";
import { Modality } from "@google/genai";

import * as db from "../../services/db.js";
import { buildSystemInstruction } from "../../services/gemini.js";
import { STEPS } from "../../lib/callState.js";
import { connectLive, liveSurface, LIVE_MODEL_DEFAULT } from "../../lib/voice/live/client.js";
import { buildLiveTools } from "../../lib/voice/live/tools.js";
import { buildMinimalInstruction } from "../../lib/voice/live/minimalPrompt.js";

const argv = process.argv.slice(2);
const CONFIRMED = argv.includes("--confirm");
const RUNS = Number(valueOf("--runs") || 3);
const BUSINESS_PHONE = valueOf("--business") || process.env.LIVE_BUSINESS_PHONE || "+441372656055";

function valueOf(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

const ARMS = [
  { key: "full", prompt: "full", tools: true },
  { key: "minimal", prompt: "minimal", tools: true },
  { key: "no_tools", prompt: "full", tools: false },
  { key: "floor", prompt: "minimal", tools: false },
];

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

async function main() {
  console.log("");
  console.log("  LVX17 -- what is the 2.2 s made of?");
  console.log("  -----------------------------------");
  console.log(`  model     ${process.env.LIVE_MODEL || LIVE_MODEL_DEFAULT}`);
  console.log(`  surface   ${liveSurface()}`);
  console.log(`  business  ${BUSINESS_PHONE}`);
  console.log(`  arms      ${ARMS.map((a) => a.key).join(", ")}`);
  console.log(`  runs      ${RUNS} per arm, interleaved  (${RUNS * ARMS.length} connects total)`);
  console.log("");
  console.log("  Sends no audio, takes no turns, closes as soon as the socket opens.");
  console.log("  Billed tokens are PRINTED, not assumed -- see the header.");
  console.log("");

  if (!CONFIRMED) {
    console.log("  Not run. Re-run with --confirm.\n");
    return;
  }

  const business = db.isEnabled() ? await db.lookupBusinessByPhone(BUSINESS_PHONE) : null;
  if (!business) {
    console.error(`  No business found for ${BUSINESS_PHONE}. Refusing to measure a prompt`);
    console.error("  no caller will ever hear -- the whole point is the production payload.\n");
    process.exitCode = 1;
    return;
  }

  const config = db.loadConfig(business);
  const integrations = await db.withTenantSafe(
    business.id,
    () => db.listIntegrationsForBusiness(business.id, { enabledOnly: true }),
    { operation: "liveConnectProbe", fallback: [] }
  );
  const extras = {
    integrations: integrations || [],
    businessId: business.id,
    callerPhone: "+447700900123",
    callId: null,
    greetingSpoken: false,
  };

  const fullInstruction = buildSystemInstruction(STEPS.IDENTIFY_INTENT, null, config, extras);
  const minimalInstruction = buildMinimalInstruction(config);
  const allTools = buildLiveTools(config, extras);
  const toolCount = allTools?.[0]?.functionDeclarations?.length ?? 0;

  console.log(`  instruction  full ${fullInstruction.length} chars / minimal ${minimalInstruction.length} chars`);
  console.log(`  tools        ${toolCount} declared`);
  console.log("");
  if (toolCount !== 10) {
    console.log(`  WARNING: ${toolCount} tools, not ten. Rounds 1-2 of the vendor analysis were`);
    console.log("  invalidated by exactly this. Check the tenant config before trusting a number.\n");
  }

  const results = Object.fromEntries(ARMS.map((a) => [a.key, []]));
  const usageSeen = [];

  for (let run = 1; run <= RUNS; run += 1) {
    for (const arm of ARMS) {
      const cfg = {
        responseModalities: [Modality.AUDIO],
        systemInstruction: {
          parts: [{ text: arm.prompt === "minimal" ? minimalInstruction : fullInstruction }],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: arm.tools ? allTools : [],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.LIVE_VOICE || "Kore" } },
          languageCode: process.env.LIVE_LANGUAGE_CODE || "en-GB",
        },
      };

      const t0 = Date.now();
      let session = null;
      let error = null;
      try {
        const out = await connectLive({
          config: cfg,
          callbacks: {
            onmessage: (msg) => {
              if (msg?.usageMetadata) usageSeen.push({ arm: arm.key, usage: msg.usageMetadata });
            },
            onerror: () => {},
            onclose: () => {},
          },
        });
        session = out.session;
      } catch (err) {
        error = err?.message || String(err);
      }
      const ms = Date.now() - t0;

      if (error) {
        console.log(`  run ${run}  ${arm.key.padEnd(9)} FAILED after ${ms} ms -- ${error.slice(0, 120)}`);
      } else {
        results[arm.key].push(ms);
        console.log(`  run ${run}  ${arm.key.padEnd(9)} ${String(ms).padStart(5)} ms`);
      }
      try {
        session?.close();
      } catch {
        /* already gone */
      }
      // A breath between connects, so twelve handshakes in a row are not
      // themselves the thing being measured.
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  console.log("");
  console.log("  arm        runs                     median");
  console.log("  ---------  -----------------------  ------");
  for (const arm of ARMS) {
    const xs = results[arm.key];
    console.log(
      `  ${arm.key.padEnd(9)}  ${xs.join(", ").padEnd(23)}  ${xs.length ? `${median(xs)} ms` : "n/a"}`
    );
  }

  const full = median(results.full);
  const floor = median(results.floor);
  console.log("");
  if (full != null && floor != null) {
    const ours = full - floor;
    const pct = Math.round((ours / full) * 100);
    console.log(`  full - floor = ${ours} ms  (${pct}% of the wait is the payload, and ours to fix)`);
    console.log(`  floor        = ${floor} ms  (network and session init, not ours)`);
    console.log("");
    console.log("  This is a measurement, NOT a verdict. Read it with the arms above:");
    console.log("  if `minimal` and `no_tools` do not straddle `full` and `floor` sensibly,");
    console.log("  the two variables interact and neither single fix is the answer.");
  }

  console.log("");
  if (usageSeen.length) {
    console.log(`  BILLED: ${usageSeen.length} usageMetadata message(s) arrived on connects with no turns.`);
    console.log(`  ${JSON.stringify(usageSeen.slice(0, 4))}`);
  } else {
    console.log("  BILLED: no usageMetadata reported. A connect with no turn appears not to bill,");
    console.log("  which is what was expected and is now observed rather than assumed.");
  }
  console.log("");
}

main()
  .catch((err) => {
    console.error("probe failed:", err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => {
    // The pool keeps the process alive otherwise.
    db.close?.();
  });
