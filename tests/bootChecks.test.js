// A1.2 gate: a subsystem disabled by missing config announces itself at boot,
// and a subsystem that CANNOT WORK stops the boot.
//
// The defect this closes: services/notifications.js `sendEmail` returns early
// when there is no mail transport and `sendSms` returns early when there is no
// Twilio client or no from-number. Both are silent. A business row with
// `notification_email` set and `notifications_enabled = true` therefore
// produced exactly the same observable behaviour whether the mail was sent or
// dropped — nothing. Two live features looked working and were not.
//
// The line between fatal and announced is drawn deliberately and is the whole
// design decision here; see lib/bootChecks.js.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { checkNotificationConfig, checkDeploymentMode, checkDatabaseConfig, assertBootConfig, FATAL, ANNOUNCE } from "../lib/bootChecks.js";

const SID = "AC" + "1".repeat(32);
const TOKEN = "authtoken1234567890";
const FROM = "+15551234567";

/** Codes only — the assertions read better than comparing whole objects. */
function codes(findings) {
  return findings.map((f) => f.code).sort();
}

describe("checkNotificationConfig — configuration that cannot be what anyone meant", () => {
  it("half an SMTP credential pair is fatal (user without pass)", () => {
    const { findings } = checkNotificationConfig({ SMTP_USER: "bot@example.com" });
    expect(codes(findings.filter((f) => f.severity === FATAL))).toContain("smtp_half_configured");
  });

  it("half an SMTP credential pair is fatal the other way round (pass without user)", () => {
    const { findings } = checkNotificationConfig({ SMTP_PASS: "secret" });
    expect(codes(findings.filter((f) => f.severity === FATAL))).toContain("smtp_half_configured");
  });

  it("a from-number with no Twilio client behind it is fatal", () => {
    const { findings } = checkNotificationConfig({ TWILIO_SMS_FROM: FROM });
    expect(codes(findings.filter((f) => f.severity === FATAL))).toContain("sms_from_without_client");
  });

  it("a from-number that is not E.164 is fatal — every send would fail and be swallowed", () => {
    const { findings } = checkNotificationConfig({
      TWILIO_ACCOUNT_SID: SID,
      TWILIO_AUTH_TOKEN: TOKEN,
      TWILIO_SMS_FROM: "555-1234",
    });
    expect(codes(findings.filter((f) => f.severity === FATAL))).toContain("sms_from_not_e164");
  });

  it("NOTIFICATIONS_ENABLED asked for explicitly with no channel to deliver on is fatal", () => {
    const { findings } = checkNotificationConfig({ NOTIFICATIONS_ENABLED: "true" });
    expect(codes(findings.filter((f) => f.severity === FATAL))).toContain("notifications_forced_on_with_no_channel");
  });
});

describe("checkNotificationConfig — configuration that might be deliberate", () => {
  // This is the case that must NOT be fatal, and it is the one worth stating
  // out loud: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are also the VOICE
  // credentials. A deployment that uses Twilio for calls and never for texts is
  // a legitimate configuration, and refusing to boot on it would take the
  // receptionist off the air to protect a notification.
  it("Twilio voice creds without a from-number is announced, never fatal", () => {
    const { findings } = checkNotificationConfig({ TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN });
    expect(findings.filter((f) => f.severity === FATAL)).toEqual([]);
    expect(codes(findings.filter((f) => f.severity === ANNOUNCE))).toContain("sms_channel_off");
  });

  it("no channel configured at all is announced, never fatal", () => {
    const { findings } = checkNotificationConfig({});
    expect(findings.filter((f) => f.severity === FATAL)).toEqual([]);
    expect(codes(findings.filter((f) => f.severity === ANNOUNCE))).toContain("notifications_off");
  });

  it('NOTIFICATIONS_ENABLED="false" with working creds is announced, never fatal', () => {
    const { findings } = checkNotificationConfig({
      NOTIFICATIONS_ENABLED: "false",
      SMTP_USER: "bot@example.com",
      SMTP_PASS: "secret",
    });
    expect(findings.filter((f) => f.severity === FATAL)).toEqual([]);
    expect(codes(findings.filter((f) => f.severity === ANNOUNCE))).toContain("notifications_disabled_by_env");
  });

  it("email configured and SMS not: SMS is announced off, email is not mentioned", () => {
    const { findings } = checkNotificationConfig({ SMTP_USER: "bot@example.com", SMTP_PASS: "secret" });
    expect(findings.filter((f) => f.severity === FATAL)).toEqual([]);
    const announced = codes(findings.filter((f) => f.severity === ANNOUNCE));
    expect(announced).toContain("sms_channel_off");
    expect(announced).not.toContain("email_channel_off");
  });

  it("a fully configured pair of channels produces no findings at all", () => {
    const { findings } = checkNotificationConfig({
      SMTP_USER: "bot@example.com",
      SMTP_PASS: "secret",
      TWILIO_ACCOUNT_SID: SID,
      TWILIO_AUTH_TOKEN: TOKEN,
      TWILIO_SMS_FROM: FROM,
      DASHBOARD_URL: "https://dashboard.example/app",
    });
    expect(findings).toEqual([]);
  });

  // A1.3 emptied the notification bodies, so the link IS the message. A working
  // channel with nowhere to point is worth saying out loud.
  it("a working channel with no DASHBOARD_URL is announced, never fatal", () => {
    const { findings } = checkNotificationConfig({ SMTP_USER: "bot@example.com", SMTP_PASS: "secret" });
    expect(findings.filter((f) => f.severity === FATAL)).toEqual([]);
    expect(codes(findings.filter((f) => f.severity === ANNOUNCE))).toContain("dashboard_url_unset");
  });

  it("no channel means no DASHBOARD_URL complaint — there is nothing to link from", () => {
    const { findings } = checkNotificationConfig({});
    expect(codes(findings)).not.toContain("dashboard_url_unset");
  });
});

describe("checkNotificationConfig agrees with the module it describes", () => {
  // bootChecks reads process.env a second time, independently of
  // services/notifications.js. Two readers of the same env is exactly how a
  // check drifts away from the thing it is checking and starts passing while
  // the subsystem is broken. These cases pin them together.
  const cases = [
    ["no creds", {}],
    ["smtp only", { SMTP_USER: "bot@example.com", SMTP_PASS: "secret" }],
    ["sms only", { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_SMS_FROM: FROM }],
    ["twilio without from", { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN }],
    ["explicitly off", { NOTIFICATIONS_ENABLED: "false", SMTP_USER: "bot@example.com", SMTP_PASS: "secret" }],
  ];

  const KEYS = ["NOTIFICATIONS_ENABLED", "SMTP_USER", "SMTP_PASS", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_SMS_FROM"];

  it.each(cases)("%s: enabled + sms-creds match services/notifications.js", async (_label, env) => {
    const saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    Object.assign(process.env, env);
    try {
      const { vi } = await import("vitest");
      vi.resetModules();
      const mod = await import("../services/notifications.js");
      const summary = checkNotificationConfig(process.env);
      expect(summary.notificationsEnabled).toBe(mod.NOTIFICATIONS_ENABLED);
      expect(summary.sms).toBe(mod.HAS_SMS_CREDS);
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      const { vi } = await import("vitest");
      vi.resetModules();
    }
  });
});

describe("assertBootConfig", () => {
  it("throws on a fatal finding, and the message names the code", () => {
    expect(() => assertBootConfig({ SMTP_USER: "bot@example.com" }, { log: () => {} })).toThrow(
      /smtp_half_configured/
    );
  });

  it("does not throw when findings are only announcements", () => {
    expect(() => assertBootConfig({}, { log: () => {} })).not.toThrow();
  });

  it("announces every finding through the logger, fatal and non-fatal alike", () => {
    const lines = [];
    try {
      assertBootConfig({ SMTP_USER: "bot@example.com" }, { log: (...a) => lines.push(a) });
    } catch {
      // the throw is asserted above; here we only care that it spoke first
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).toContain("smtp_half_configured");
  });
});

describe("checkDeploymentMode", () => {
  it("unset defaults to standard and says nothing", () => {
    const { findings, mode } = checkDeploymentMode({});
    expect(mode).toBe("standard");
    expect(findings).toEqual([]);
  });

  it("hipaa is announced, so the boot log states which regime it is in", () => {
    const { findings, mode } = checkDeploymentMode({ DEPLOYMENT_MODE: "hipaa" });
    expect(mode).toBe("hipaa");
    expect(codes(findings.filter((f) => f.severity === ANNOUNCE))).toContain("deployment_mode_hipaa");
  });

  // The direction of the mistake is the whole argument. A typo that defaulted
  // to `standard` would turn every HIPAA protection OFF while reading, at a
  // glance, as though it turned them on — invisible precisely to the person
  // who was trying to be careful.
  it.each(["hippa", "HIPPA", "hipaa-us", "true", "on"])("refuses DEPLOYMENT_MODE=%s", (value) => {
    const { findings } = checkDeploymentMode({ DEPLOYMENT_MODE: value });
    expect(codes(findings.filter((f) => f.severity === FATAL))).toContain("deployment_mode_unrecognised");
  });

  it("is case- and whitespace-insensitive for a value that IS a mode", () => {
    expect(checkDeploymentMode({ DEPLOYMENT_MODE: "  HIPAA " }).mode).toBe("hipaa");
    expect(checkDeploymentMode({ DEPLOYMENT_MODE: "  HIPAA " }).findings.filter((f) => f.severity === FATAL)).toEqual([]);
  });

  it("assertBootConfig refuses to boot on a typo'd mode", () => {
    expect(() =>
      assertBootConfig(
        { DEPLOYMENT_MODE: "hippa", SMTP_USER: "b@e.com", SMTP_PASS: "s", DASHBOARD_URL: "https://d.example" },
        { log: () => {} }
      )
    ).toThrow(/deployment_mode_unrecognised/);
  });
});

describe("checkDatabaseConfig", () => {
  it("says nothing when DATABASE_URL is set", () => {
    expect(checkDatabaseConfig({ DATABASE_URL: "postgres://u:p@h/db" }).findings).toEqual([]);
  });

  // A3 changed which variable decides whether this process has a database. A
  // deployment that carries SUPABASE_URL forward and not DATABASE_URL boots
  // happily and answers every call as "our office" — a working receptionist
  // for the wrong company.
  it("announces a missing DATABASE_URL, and does not make it fatal", () => {
    const { findings } = checkDatabaseConfig({ SUPABASE_URL: "https://old.supabase.co" });
    expect(codes(findings)).toContain("database_not_configured");
    expect(findings.filter((f) => f.severity === FATAL)).toEqual([]);
  });

  // Deliberate, and worth pinning so nobody "tightens" it later: the degraded
  // path exists because a call that gets a human-sounding apology beats a call
  // that rings out. Refusing to boot turns a database outage into a phone
  // outage.
  it("assertBootConfig still boots with no database", () => {
    expect(() =>
      assertBootConfig({ SMTP_USER: "b@e.com", SMTP_PASS: "s", DASHBOARD_URL: "https://d.example" }, { log: () => {} })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Cloud SQL is a second way to be configured, added at B2.
//
// The check knew only about DATABASE_URL, so a correctly configured Cloud Run
// deployment — which has no DATABASE_URL at all — would have announced "every
// call runs on default config" on every boot. An alarm that fires when nothing
// is wrong is an alarm people learn to scroll past, and that costs the real one.
// ---------------------------------------------------------------------------
describe("checkDatabaseConfig — Cloud SQL", () => {
  it("says nothing when CLOUD_SQL_INSTANCE is set and DATABASE_URL is not", () => {
    const { findings } = checkDatabaseConfig({
      CLOUD_SQL_INSTANCE: "p:us-central1:i",
    });
    expect(findings).toEqual([]);
  });

  it("still announces when NEITHER is set", () => {
    const { findings } = checkDatabaseConfig({});
    expect(findings.map((f) => f.code)).toEqual(["database_not_configured"]);
  });

  it("is FATAL when BOTH are set", () => {
    // Ambiguity, not redundancy: two databases named and no way to know which
    // one was meant. services/db.js refuses to start on it too.
    const { findings } = checkDatabaseConfig({
      CLOUD_SQL_INSTANCE: "p:us-central1:i",
      DATABASE_URL: "postgres://localhost/x",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("database_double_configured");
    expect(findings[0].severity).toBe(FATAL);
  });
});

// ---------------------------------------------------------------------------
// server.js's env preflight, which predates both Vertex and this file.
//
// GEMINI_API_KEY was required unconditionally. A8 established that the API-key
// path is the Gemini Developer API, which the Google Cloud BAA does not cover
// and which lib/compliance.js REFUSES in hipaa mode — so a HIPAA deployment
// could not boot without carrying a credential it is forbidden to use. The boot
// check and the compliance guard demanded opposite things.
//
// Asserted against the source because the preflight runs at import and calls
// process.exit, which cannot be exercised in-process.
// ---------------------------------------------------------------------------
describe("server.js env preflight and Vertex", () => {
  const src = readFileSync(new URL("../server.js", import.meta.url), "utf8");

  it("does not require GEMINI_API_KEY when Vertex is enabled", () => {
    expect(src).toMatch(/if \(!GEMINI_API_KEY && !VERTEX_ENABLED\)/);
    expect(src).not.toMatch(/if \(!GEMINI_API_KEY\) \{/);
  });

  it("still requires it when Vertex is NOT enabled", () => {
    // The check must remain a hard exit for the API-key path. A deployment with
    // neither backend configured cannot answer a call, and discovering that on
    // the first caller is the failure this preflight exists to prevent.
    const i = src.indexOf("if (!GEMINI_API_KEY && !VERTEX_ENABLED)");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 400)).toMatch(/process\.exit\(1\)/);
  });

  it("points the operator at Vertex as the covered path", () => {
    expect(src).toMatch(/BAA-covered path/);
  });
});

// ---------------------------------------------------------------------------
// Twilio signature validation, and the malformed case specifically.
//
// Found by POSTing junk at the deployed staging service: a bogus signature
// returned 500, not 403. `twilio.validateRequest` base64-decodes the header and
// compares with crypto.timingSafeEqual, which THROWS on unequal-length buffers
// — so a wrong-length signature raised instead of returning false.
//
// It matters twice over. A 500 and a 403 are distinguishable, so the difference
// tells an attacker which guesses were well-formed. And anyone can generate
// unbounded 500s on a public endpoint with junk, burying real failures.
// ---------------------------------------------------------------------------
describe("twilioValidation handles a malformed signature", () => {
  const src = readFileSync(new URL("../server.js", import.meta.url), "utf8");

  it("wraps validateRequest so a throw becomes a rejection, not a 500", () => {
    const i = src.indexOf("twilio.validateRequest(");
    expect(i).toBeGreaterThan(-1);
    const around = src.slice(Math.max(0, i - 400), i + 200);
    expect(around).toMatch(/try\s*\{/);
    expect(around).toMatch(/catch/);
  });

  it("a caught throw is treated as INVALID, never as valid", () => {
    // The dangerous version of this fix sets `valid = true` in the catch, or
    // calls next(). Both turn a crash into an authentication bypass.
    const i = src.indexOf("twilio.validateRequest(");
    const around = src.slice(i, i + 260);
    expect(around).toMatch(/catch\s*\{[\s\S]*valid\s*=\s*false/);
    expect(around).not.toMatch(/catch\s*\{[\s\S]*next\(\)/);
  });
});
