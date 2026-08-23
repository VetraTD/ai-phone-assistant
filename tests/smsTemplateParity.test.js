import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { DEFAULT_SMS_TEMPLATES } from "../services/notifications.js";
import {
  SMS_TEMPLATE_PLACEHOLDERS,
  SMS_TEMPLATE_KINDS,
  SMS_TEMPLATE_MAX_LENGTH,
  templatePlaceholders,
  smsTemplateProblem,
} from "../lib/smsConsent.js";

const require = createRequire(import.meta.url);
const dashboard = require("../AI-phone-dashboard/backend/src/constants.js");

// The dashboard backend is CommonJS and cannot import the ESM registry, so the
// SMS template vocabulary exists twice. Duplicates drift — the reserved
// tool-name list already proved that by going stale while packs grew past it —
// so the drift is what this file fails on.

describe("SMS template vocabulary — the two copies agree", () => {
  it("the same kinds on both sides, and they are exactly what sendCallerSms can send", () => {
    expect([...SMS_TEMPLATE_KINDS].sort()).toEqual([...dashboard.SMS_TEMPLATE_KINDS].sort());
    expect([...SMS_TEMPLATE_KINDS].sort()).toEqual(Object.keys(DEFAULT_SMS_TEMPLATES).sort());
  });

  it("the same placeholder allowlist on both sides", () => {
    for (const kind of SMS_TEMPLATE_KINDS) {
      expect([...SMS_TEMPLATE_PLACEHOLDERS[kind]].sort(), kind).toEqual(
        [...dashboard.SMS_TEMPLATE_PLACEHOLDERS[kind]].sort()
      );
    }
  });

  it("the same length cap on both sides", () => {
    expect(SMS_TEMPLATE_MAX_LENGTH).toBe(dashboard.SMS_TEMPLATE_MAX_LENGTH);
  });

  // The allowlist would be worthless if it did not describe the defaults: a
  // built-in template using a placeholder the allowlist forbids would make
  // sendCallerSms reject its own fallback.
  it("every default template only uses placeholders its own kind allows", () => {
    for (const [kind, template] of Object.entries(DEFAULT_SMS_TEMPLATES)) {
      expect(smsTemplateProblem(kind, template), `${kind}: ${template}`).toBeNull();
    }
  });
});

describe("smsTemplateProblem", () => {
  it("accepts an override that stays inside the vocabulary", () => {
    expect(smsTemplateProblem("missed_call", "We missed you at {business}.")).toBeNull();
  });

  it("names the placeholders that are not available", () => {
    const problem = smsTemplateProblem("missed_call", "Hi {name} at {business}, see {datetime}");
    const [offending, available] = problem.split("Available:");
    expect(offending).toMatch(/\{name\}/);
    expect(offending).toMatch(/\{datetime\}/);
    // {business} IS carried by this kind, so it must not be listed as a
    // problem — only offered as one of the available fields.
    expect(offending).not.toMatch(/\{business\}/);
    expect(available).toMatch(/\{business\}/);
  });

  it("rejects an unknown kind rather than waving it through", () => {
    expect(smsTemplateProblem("not_a_kind", "anything")).toMatch(/unknown template kind/);
  });

  it("rejects a template past the two-segment cap", () => {
    expect(smsTemplateProblem("missed_call", "x".repeat(SMS_TEMPLATE_MAX_LENGTH + 1))).toMatch(
      /characters or fewer/
    );
    expect(smsTemplateProblem("missed_call", "x".repeat(SMS_TEMPLATE_MAX_LENGTH))).toBeNull();
  });

  it("rejects a non-string", () => {
    expect(smsTemplateProblem("missed_call", 42)).toMatch(/must be a string/);
  });
});

describe("templatePlaceholders", () => {
  it("finds each placeholder once, in order", () => {
    expect(templatePlaceholders("{a} then {b} then {a}")).toEqual(["a", "b"]);
  });

  it("returns nothing for a template with no placeholders", () => {
    expect(templatePlaceholders("plain text")).toEqual([]);
    expect(templatePlaceholders(null)).toEqual([]);
  });
});
