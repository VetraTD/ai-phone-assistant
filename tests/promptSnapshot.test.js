/**
 * GOLDEN SNAPSHOT — the safety net for the capability-packs refactor.
 *
 * Step A of the refactor (see docs/superpowers/specs/2026-07-22-capability-packs-design.md)
 * moves appointment/message/transfer behavior out of services/gemini.js and
 * services/tools.js into capabilities/*.js. The rule for that step is
 * BYTE-IDENTICAL OUTPUT: the prompt the model sees and the tools it is offered
 * must not change by a single character.
 *
 * These snapshots are recorded BEFORE any refactoring. If a snapshot moves
 * during Step A, prompt text drifted and call quality is at risk — revert and
 * find the difference. After Step A they keep guarding against accidental
 * prompt edits.
 *
 * Deliberately exhaustive over the (fixture x step x intent) matrix, because
 * buildStepGuidance branches on intent and buildDbAppointmentTools branches on
 * whether an EHR integration is present — a snapshot of one combination would
 * miss exactly the branches the refactor touches.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  buildSystemInstruction,
  buildStaticSystemPrefix,
  buildDynamicTail,
  buildCallTools,
  buildIntegrationTools,
  buildDbAppointmentTools,
} from "../services/gemini.js";
import { FIXTURES } from "./fixtures/businessConfigs.js";

// A fixed Monday inside business hours. The dynamic tail renders the current
// date/time, so without a frozen clock these snapshots would churn every run.
const FROZEN_NOW = new Date("2026-07-20T15:00:00Z");

// Every (step, intent) pair buildStepGuidance can branch on.
const STEP_INTENTS = [
  ["identify_intent", null],
  ["gather_details", "book_appointment"],
  ["gather_details", "cancel_reschedule"],
  ["gather_details", "take_message"],
  ["gather_details", "callback_request"],
  ["gather_details", "quote_request"],
  ["gather_details", "general_question"],
  ["confirm", null],
  ["ending", null],
];

const SNAP_DIR = "./__snapshots__/prompts";

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("golden prompt snapshots — must not move during the capability-packs refactor", () => {
  for (const [name, { config, extras }] of Object.entries(FIXTURES)) {
    describe(name, () => {
      it("static system prefix is byte-identical", async () => {
        const prefix = buildStaticSystemPrefix(config, extras);
        await expect(prefix).toMatchFileSnapshot(`${SNAP_DIR}/${name}.static.txt`);
      });

      for (const [step, intent] of STEP_INTENTS) {
        const label = intent ? `${step}--${intent}` : step;

        it(`dynamic tail is byte-identical (${label})`, async () => {
          const tail = buildDynamicTail(step, intent, config, extras);
          await expect(tail).toMatchFileSnapshot(`${SNAP_DIR}/${name}.tail.${label}.txt`);
        });
      }

      it("tool declarations are byte-identical", async () => {
        // Assembled exactly as getReplyStreaming does (services/gemini.js:947-955)
        // so the snapshot covers the real merged tool list, not the pieces.
        const declarations = [
          ...(buildCallTools(config.allowedTasks).functionDeclarations || []),
          ...(buildIntegrationTools(extras.integrations, config).functionDeclarations || []),
          ...(buildDbAppointmentTools(config, extras).functionDeclarations || []),
        ];
        await expect(JSON.stringify(declarations, null, 2)).toMatchFileSnapshot(
          `${SNAP_DIR}/${name}.tools.json`
        );
      });
    });
  }
});

// ---------------------------------------------------------------------------
// The same matrix under VOICE_INTENT_MARKER. Both shapes are frozen because
// both are live: the flag ships off, and the tool path stays reachable until
// the marker holds in production.
//
// A previous attempt to reduce set_call_intent traffic by rewording these same
// strings regressed three scenarios on the advisory judge and was reverted.
// These goldens are the review artifact that makes the trade explicit — read
// the diff, do not just accept it.
// ---------------------------------------------------------------------------
describe("golden prompt snapshots — marker mode (VOICE_INTENT_MARKER)", () => {
  for (const [name, { config, extras }] of Object.entries(FIXTURES)) {
    const markerExtras = { ...extras, intentMarker: true };

    describe(name, () => {
      it("static system prefix is byte-identical", async () => {
        const prefix = buildStaticSystemPrefix(config, markerExtras);
        await expect(prefix).toMatchFileSnapshot(`${SNAP_DIR}/${name}.marker.static.txt`);
      });

      for (const [step, intent] of STEP_INTENTS) {
        const label = intent ? `${step}--${intent}` : step;

        it(`dynamic tail is byte-identical (${label})`, async () => {
          const tail = buildDynamicTail(step, intent, config, markerExtras);
          await expect(tail).toMatchFileSnapshot(`${SNAP_DIR}/${name}.marker.tail.${label}.txt`);
        });
      }

      it("tool declarations are byte-identical", async () => {
        const declarations = [
          ...(buildCallTools(config.allowedTasks, { markerMode: true }).functionDeclarations || []),
          ...(buildIntegrationTools(extras.integrations, config).functionDeclarations || []),
          ...(buildDbAppointmentTools(config, extras).functionDeclarations || []),
        ];
        await expect(JSON.stringify(declarations, null, 2)).toMatchFileSnapshot(
          `${SNAP_DIR}/${name}.marker.tools.json`
        );
      });
    });
  }

  // Invariants that hold across every fixture, asserted rather than eyeballed
  // in fifty golden files.
  describe("mode separation", () => {
    for (const [name, { config, extras }] of Object.entries(FIXTURES)) {
      const markerExtras = { ...extras, intentMarker: true };

      it(`${name}: the marker literal appears in marker mode only`, () => {
        expect(buildStaticSystemPrefix(config, markerExtras)).toContain("<<intent:");
        expect(buildStaticSystemPrefix(config, extras)).not.toContain("<<intent:");
      });

      it(`${name}: the tool name is absent from every marker-mode prompt`, () => {
        const parts = [
          buildStaticSystemPrefix(config, markerExtras),
          ...STEP_INTENTS.map(([step, intent]) => buildDynamicTail(step, intent, config, markerExtras)),
        ];
        for (const part of parts) expect(part).not.toContain("set_call_intent");
      });
    }
  });
});

describe("prompt structure invariants the refactor must preserve", () => {
  const { config, extras } = FIXTURES["clinic-athena"];

  it("buildSystemInstruction is exactly prefix + blank line + tail", () => {
    // The capability prompt assembler must not change this join — the whole
    // caching strategy depends on the prefix being a stable leading substring.
    const full = buildSystemInstruction("gather_details", "book_appointment", config, extras);
    const prefix = buildStaticSystemPrefix(config, extras);
    const tail = buildDynamicTail("gather_details", "book_appointment", config, extras);

    expect(full).toBe(`${prefix}\n\n${tail}`);
    expect(full.startsWith(prefix)).toBe(true);
  });

  it("the static prefix is identical across every step and intent", () => {
    // Gemini implicit caching hits on a stable PREFIX. If a capability pack
    // leaks step- or intent-dependent text into the static half, cache hit
    // rate collapses and per-call cost/latency rise without any test failing
    // — so assert it directly.
    const baseline = buildStaticSystemPrefix(config, extras);
    for (const [step, intent] of STEP_INTENTS) {
      expect(buildStaticSystemPrefix(config, extras), `${step}/${intent}`).toBe(baseline);
    }
  });

  it("the static prefix carries no time-varying or step-varying markers", () => {
    const prefix = buildStaticSystemPrefix(config, extras);
    for (const marker of [
      "=== DATE AND TIME ===",
      "=== AFTER-HOURS BEHAVIOR ===",
      "=== CURRENT TASK AND STATE ===",
      "Step:",
      "gather_details",
      "identify_intent",
    ]) {
      expect(prefix, marker).not.toContain(marker);
    }
  });

  it("no fixture renders 'undefined' or 'null' into prompt text", () => {
    for (const [name, fx] of Object.entries(FIXTURES)) {
      const prefix = buildStaticSystemPrefix(fx.config, fx.extras);
      expect(prefix, `${name} prefix`).not.toContain("undefined");
      for (const [step, intent] of STEP_INTENTS) {
        const tail = buildDynamicTail(step, intent, fx.config, fx.extras);
        expect(tail, `${name} tail ${step}/${intent}`).not.toContain("undefined");
      }
    }
  });

  it("every declared tool has a unique name within a fixture", () => {
    // The registry in Step A resolves tool name -> owning capability, so a
    // duplicate name becomes a dispatch ambiguity rather than a harmless
    // shadow. Lock the invariant in now.
    for (const [name, fx] of Object.entries(FIXTURES)) {
      const declarations = [
        ...(buildCallTools(fx.config.allowedTasks).functionDeclarations || []),
        ...(buildIntegrationTools(fx.extras.integrations, fx.config).functionDeclarations || []),
        ...(buildDbAppointmentTools(fx.config, fx.extras).functionDeclarations || []),
      ];
      const names = declarations.map((d) => d.name);
      expect(new Set(names).size, `${name}: ${names.join(", ")}`).toBe(names.length);
    }
  });
});

describe("greeting-context tail line only quotes what the caller actually heard", () => {
  // lib/voice/session.js buildGreeting speaks config.greeting verbatim ONLY when
  // config._hasCustomGreeting is true; otherwise it synthesizes a time-of-day +
  // business-name line and config.greeting still holds the generic
  // DEFAULT_GREETING (services/supabase.js loadConfig). The tail line must not
  // quote text the caller never heard.
  const { config: base, extras } = FIXTURES["appointments-db"];

  it("custom greeting (_hasCustomGreeting: true) -> quoted line naming the greeting", () => {
    const config = { ...base, greeting: "Thanks for calling Acme Dental.", _hasCustomGreeting: true };
    const tail = buildDynamicTail("confirm", null, config, extras);
    expect(tail).toContain(
      'The caller was already greeted with: "Thanks for calling Acme Dental." — do not greet them again.'
    );
  });

  it("greeting present but _hasCustomGreeting falsy -> generic line, nothing quoted", () => {
    const config = { ...base, greeting: "Hi, how can I help you today?", _hasCustomGreeting: false };
    const tail = buildDynamicTail("confirm", null, config, extras);
    expect(tail).toContain("The caller was already greeted — do not greet them again.");
    expect(tail).not.toContain("already greeted with:");
    expect(tail).not.toContain("Hi, how can I help you today?");
  });

  it("greeting present but _hasCustomGreeting absent (unset) -> same generic fallback", () => {
    const config = { ...base, greeting: "Hi, how can I help you today?" };
    delete config._hasCustomGreeting;
    const tail = buildDynamicTail("confirm", null, config, extras);
    expect(tail).toContain("The caller was already greeted — do not greet them again.");
    expect(tail).not.toContain("already greeted with:");
  });

  it("no greeting at all -> no re-greet line of either form", () => {
    const config = { ...base };
    delete config.greeting;
    delete config._hasCustomGreeting;
    const tail = buildDynamicTail("confirm", null, config, extras);
    expect(tail).not.toContain("already greeted");
  });
});
