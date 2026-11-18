#!/usr/bin/env node
/**
 * chat.js — interactive terminal chat with the real receptionist brain.
 *
 * A thin front-end over lib/harness/textSession.js: all session logic (prompt
 * assembly, tool dispatch, the reply-state reducer, capability effects) lives
 * there and in the real production modules it drives. This file only reads
 * lines from the terminal, forwards them to sendTurn, and renders what comes
 * back — reply text, each tool call in order, and a status line. It uses the
 * REAL Gemini API (see services/gemini.js), unlike the eval suite's mocked
 * runLlmTurn.
 *
 *   node scripts/chat.js --list-fixtures
 *   node scripts/chat.js --fixture appointments-availability --seed-appointments 3
 *   node scripts/chat.js --model gemini-2.5-pro --temperature 0.2
 *
 * Commands inside the chat: /state (dump session state + fake store), /quit.
 */

import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createTextSession } from "../lib/harness/textSession.js";
import { makeFakeDeps, makeFakeEffectsDeps } from "../lib/harness/fakeDeps.js";
import { resolveGenerationConfig } from "../services/gemini.js";
import { FIXTURES } from "../tests/fixtures/businessConfigs.js";
import {
  parseArgs,
  defaultFixtureName,
  summarizeFixture,
  formatToolCallLine,
  formatStatusLine,
  makeSeedAppointments,
} from "./chatFormat.js";

const DIM = "\x1b[2m", BOLD = "\x1b[1m", RESET = "\x1b[0m";
const dim = (s) => `${DIM}${s}${RESET}`;
const bold = (s) => `${BOLD}${s}${RESET}`;

// @google/genai's response.text getter logs this exact console.warn whenever a
// candidate mixes a functionCall part with text (i.e. every tool-calling
// turn) — see node_modules/@google/genai/dist/node/index.mjs. It's expected,
// known noise, not a real problem, and printing it mid-turn corrupts the
// terminal display. Suppress ONLY this one known message, only while a turn
// is in flight, and restore console.warn immediately after — anything else
// the SDK (or our own code) warns about still gets through.
const SDK_NONTEXT_WARNING = "there are non-text parts";
async function withSdkWarnFilter(fn) {
  const originalWarn = console.warn;
  console.warn = (...args) => {
    if (typeof args[0] === "string" && args[0].includes(SDK_NONTEXT_WARNING)) return;
    originalWarn.apply(console, args);
  };
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
  }
}

function printFixtureList() {
  console.log("Available fixtures (--fixture <name>):");
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    console.log(`  ${name.padEnd(26)} ${summarizeFixture(name, fixture)}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.listFixtures) {
    printFixtureList();
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error(
      "GEMINI_API_KEY is not set. Add it to your .env (see services/gemini.js) before running `npm run chat`."
    );
    process.exitCode = 1;
    return;
  }

  const fixtureName = opts.fixture || defaultFixtureName(FIXTURES);
  const fixture = FIXTURES[fixtureName];
  if (!fixture) {
    console.error(`Unknown fixture "${fixtureName}".`);
    printFixtureList();
    process.exitCode = 1;
    return;
  }

  const businessId = fixture.extras?.businessId ?? fixture.config?.businessId ?? null;
  const seedAppointments =
    opts.seedAppointments > 0 ? makeSeedAppointments(opts.seedAppointments, { businessId }) : [];
  const { deps, store } = makeFakeDeps({ seedAppointments });
  const effects = makeFakeEffectsDeps();
  const modelOverrides = Object.keys(opts.modelOverrides).length > 0 ? opts.modelOverrides : undefined;

  const session = createTextSession({
    config: fixture.config,
    extras: fixture.extras,
    modelOverrides,
    fakes: { deps, store, effects },
  });

  // The effective generation config (model + numeric knobs), fully resolved
  // through defaults -> env vars -> --model/--temperature/etc overrides — the
  // same precedence services/gemini.js applies for the real call. Printing
  // the raw `modelOverrides` object (as this used to) hid env-var influence
  // and printed "(defaults)" even when GEMINI_MODEL etc were set.
  const resolvedConfig = resolveGenerationConfig(modelOverrides);

  console.log(bold(fixture.config.businessName));
  console.log(dim(`fixture: ${fixtureName}`));
  console.log(
    dim(
      `model: ${resolvedConfig.model} (temperature=${resolvedConfig.temperature}, ` +
        `thinkingBudget=${resolvedConfig.thinkingBudget}, maxOutputTokens=${resolvedConfig.maxOutputTokens})`
    )
  );
  if (seedAppointments.length > 0) console.log(dim(`seeded ${seedAppointments.length} appointment(s)`));
  console.log(`Assistant: ${fixture.config.greeting}`);
  console.log(dim("Commands: /state  /quit\n"));

  const rl = readline.createInterface({ input, output });
  // Piped input (or Ctrl+D) closes `rl` the moment stdin hits EOF — even
  // while a turn is in flight, since readline doesn't wait for our loop.
  // The next `rl.question()` call then throws ERR_USE_AFTER_CLOSE
  // synchronously (well, as a rejected promise). Track closed-ness so that
  // rejection reads as a clean end of input, not a crash.
  let rlClosed = false;
  rl.on("close", () => {
    rlClosed = true;
  });

  try {
    while (true) {
      let line;
      try {
        line = await rl.question("You: ");
      } catch (err) {
        if (rlClosed || err?.code === "ERR_USE_AFTER_CLOSE") break; // clean EOF
        throw err;
      }
      if (rlClosed) break; // EOF raced in while `line` was still resolving

      const text = line.trim();
      if (!text) continue;

      if (text === "/quit") break;

      if (text === "/state") {
        const state = session.getState();
        console.log(
          dim(
            JSON.stringify(
              {
                historyLength: state.history.length,
                step: state.step,
                intent: state.intent,
                capabilityState: state.capabilityState,
                appointments: store.appointments,
              },
              null,
              2
            )
          )
        );
        continue;
      }

      if (text.startsWith("/")) {
        console.log(dim(`Unknown command "${text}". Try /state or /quit.`));
        continue;
      }

      try {
        const out = await withSdkWarnFilter(() => session.sendTurn(text));
        for (let i = 0; i < out.toolCalls.length; i++) {
          console.log(dim(formatToolCallLine(out.toolCalls[i], out.toolResults[i])));
        }
        console.log(`Assistant: ${out.text || "(no reply text)"}`);
        console.log(dim(formatStatusLine(out.state, out.timings.totalMs)));
      } catch (err) {
        console.error(dim(`Error: ${err?.message ?? err}`));
      }
    }
  } finally {
    if (!rlClosed) rl.close();
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err?.stack || err?.message || err}`);
  process.exitCode = 1;
});
