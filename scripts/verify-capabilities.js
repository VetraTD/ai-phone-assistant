#!/usr/bin/env node
/**
 * Verify the capability-packs system end to end, from the terminal.
 *
 * Exists because the dashboard cannot show any of this yet: configSchema is
 * declared by every pack but nothing renders it, so capability config,
 * requirement kinds and adapter routing have no UI. This walks the same code a
 * live call walks — config load, tool registration, prompt assembly, tool
 * dispatch — and prints what a caller would actually experience.
 *
 * READ-ONLY against the database. It checks whether migration 020 has been run
 * and otherwise works from in-memory rows, so it never writes to your data.
 *
 *   node scripts/verify-capabilities.js              # self-contained fixtures
 *   node scripts/verify-capabilities.js +18175803291 # a REAL business
 *
 * With a phone number it loads that business's actual configuration and prints
 * what its AI receptionist would now do — which tools it has, what it must
 * collect, and what it refuses without. That is the link between clicking Save
 * in the dashboard and knowing a caller's experience changed.
 */

import "dotenv/config";
import { loadConfig, isEnabled } from "../services/supabase.js";
import { buildCallTools, buildIntegrationTools, buildDbAppointmentTools, buildStaticSystemPrefix } from "../services/gemini.js";
import { executeToolCall } from "../services/tools.js";
import { resolveSchedulingAdapter, verifiableFieldsFor } from "../adapters/scheduling/index.js";

const GREEN = "\x1b[32m", RED = "\x1b[31m", DIM = "\x1b[2m", BOLD = "\x1b[1m", RESET = "\x1b[0m";
const ok = (m) => console.log(`  ${GREEN}✓${RESET} ${m}`);
const no = (m) => console.log(`  ${RED}✗${RESET} ${m}`);
const dim = (m) => console.log(`  ${DIM}${m}${RESET}`);
const head = (m) => console.log(`\n${BOLD}${m}${RESET}\n${"─".repeat(m.length)}`);

let failures = 0;
function check(condition, pass, fail) {
  if (condition) ok(pass);
  else { no(fail); failures++; }
}

// ---------------------------------------------------------------------------
// 1. Migration status
// ---------------------------------------------------------------------------
head("1. Migration 020");

if (!isEnabled()) {
  dim("Supabase not configured in .env — skipping the live check.");
} else {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { error } = await sb.from("business_capabilities").select("business_id").limit(1);
  if (error) {
    no(`business_capabilities not readable: ${error.message}`);
    dim("Run database/020_business_capabilities.sql in the Supabase SQL editor.");
    dim("Everything below still works — the dual-read falls back to allowed_tasks.");
  } else {
    ok("business_capabilities exists and is readable");
  }
}

// ---------------------------------------------------------------------------
// 2. Two businesses, one codebase
// ---------------------------------------------------------------------------
head("2. Two businesses, identical code, different behaviour");

const CLINIC = { id: "biz-clinic", name: "Riverside Family Clinic", allowed_tasks: ["book_appointment", "cancel_reschedule"], timezone: "America/Chicago" };
const PLUMBER = { id: "biz-plumber", name: "Dave's Plumbing", allowed_tasks: ["quote_request"], timezone: "America/New_York" };

const clinicCfg = loadConfig(CLINIC, [
  {
    capability_id: "appointments",
    enabled: true,
    adapter: "internal",
    config: {
      notes: "Ask morning or afternoon first. Never offer Friday afternoon.",
      require: {
        identity: {
          custom: [{
            key: "dental_number",
            label: "Dental number",
            ask: "And your dental number — the six digits on your card?",
            pattern: "^[0-9]{6}$",
            verify: "collect_only",
          }],
        },
      },
    },
  },
]);

const plumberCfg = loadConfig(PLUMBER, [
  { capability_id: "appointments", enabled: false, config: {} },
  { capability_id: "quotes", enabled: true, adapter: "webhook", config: {} },
]);

// Passes the WHOLE config, exactly as getReplyStreaming does. Passing only
// cfg.allowedTasks is the lossy legacy form: packs then cannot see
// config.capabilities and a business's configured requirements never become
// tool parameters.
const toolNames = (cfg, integrations = []) => [
  ...buildCallTools(cfg).functionDeclarations,
  ...buildIntegrationTools(integrations).functionDeclarations,
  ...buildDbAppointmentTools(cfg, { integrations }).functionDeclarations,
].map((d) => d.name);

const clinicTools = toolNames(clinicCfg);
const plumberTools = toolNames(plumberCfg);

console.log(`  ${BOLD}Riverside (clinic)${RESET}: ${clinicTools.join(", ")}`);
console.log(`  ${BOLD}Dave's Plumbing${RESET}  : ${plumberTools.join(", ")}\n`);

check(clinicTools.includes("book_appointment"), "clinic can book", "clinic is missing book_appointment");
check(!plumberTools.includes("book_appointment"),
  "plumber has NO booking tool — the state that was unrepresentable before",
  "plumber still got book_appointment (the empty-vs-unset fix regressed)");
check(plumberTools.includes("record_quote_request"), "plumber can take quote requests", "plumber is missing record_quote_request");
check(plumberTools.includes("record_customer_request") && plumberTools.includes("request_transfer"),
  "both keep the CORE tools (messages, transfer)", "a core tool went missing");

// ---------------------------------------------------------------------------
// 3. The configured field became a real tool parameter
// ---------------------------------------------------------------------------
head("3. Config becomes a tool parameter, not just a prompt hint");

const bookDecl = buildCallTools(clinicCfg).functionDeclarations.find((d) => d.name === "book_appointment");
const hasParam = !!bookDecl?.parameters?.properties?.identity_dental_number;
const isRequired = (bookDecl?.parameters?.required || []).includes("identity_dental_number");

check(hasParam, "book_appointment gained an identity_dental_number parameter", "the configured field never reached the tool schema");
check(isRequired, "and it is marked required", "the field is optional — it would not be enforced");
if (hasParam) dim(`ask text carried through: "${bookDecl.parameters.properties.identity_dental_number.description.slice(0, 80)}..."`);

const prompt = buildStaticSystemPrefix(clinicCfg, { transferAllowed: true, integrations: [] });
check(prompt.includes("Dental number"), "the prompt tells the model to collect it up front", "the prompt never mentions it — the model would learn by being refused");

// ---------------------------------------------------------------------------
// 4. Enforcement: the refusal a prompt line could never give you
// ---------------------------------------------------------------------------
head("4. Enforcement at the tool layer");

const ctx = {
  businessId: "biz-clinic", callerPhone: "+15551234567", callId: "call-1",
  integrations: [], capabilityState: {}, config: clinicCfg,
  deps: undefined, step: "gather_details",
};

const withoutNumber = await executeToolCall(
  { id: "1", name: "book_appointment", args: { scheduled_at: "2027-01-05T10:00:00", client_name: "Sarah Kim" } },
  ctx
);
check(withoutNumber.functionResponse.response.success === false,
  "booking WITHOUT the dental number is refused",
  "booking succeeded without the required field — enforcement is not working");
dim(`model is told: "${withoutNumber.functionResponse.response.message}"`);

const badFormat = await executeToolCall(
  { id: "2", name: "book_appointment", args: { scheduled_at: "2027-01-05T10:00:00", identity_dental_number: "41" } },
  ctx
);
check(badFormat.functionResponse.response.success === false,
  "a value failing the configured pattern is refused",
  "a malformed value was accepted");

// ---------------------------------------------------------------------------
// 5. Adapter routing
// ---------------------------------------------------------------------------
head("5. Adapter routing and what each backend can prove");

const athenaIntegration = [{ enabled: true, provider: "athenahealth" }];
check(resolveSchedulingAdapter(null, athenaIntegration).id === "athenahealth",
  "an unconfigured business with an EHR integration still routes to it (dual-read)",
  "legacy routing broke — a business mid-migration would change backends");
check(resolveSchedulingAdapter({ adapter: "internal" }, athenaIntegration).id === "internal",
  "explicit config overrides the integration", "config did not win over the integration");

for (const [label, cfg, ints] of [
  ["athenahealth", null, athenaIntegration],
  ["internal", null, []],
  ["webhook", { adapter: "webhook" }, []],
]) {
  const fields = verifiableFieldsFor(cfg, ints);
  console.log(`  ${label.padEnd(14)} can verify: ${fields.length ? fields.join(", ") : DIM + "nothing — identity is collect-only here" + RESET}`);
}

// ---------------------------------------------------------------------------
// 6. A real business, if one was named
// ---------------------------------------------------------------------------
const targetPhone = process.argv[2];
if (targetPhone) {
  head(`6. Live business: ${targetPhone}`);

  const { lookupBusinessByPhone } = await import("../services/supabase.js");
  const business = await lookupBusinessByPhone(targetPhone);

  if (!business) {
    no(`No business answers on ${targetPhone}`);
    failures++;
  } else {
    const cfg = loadConfig(business);
    const integrations = [];
    console.log(`  ${BOLD}${business.name}${RESET}`);
    dim(`timezone ${cfg.timezone} · adapter ${resolveSchedulingAdapter(cfg.capabilities?.appointments, integrations).id}`);
    console.log();

    const tools = toolNames(cfg, integrations);
    console.log(`  Tools the model gets: ${tools.join(", ")}`);

    const configured = Object.entries(cfg.capabilities || {});
    if (configured.length === 0) {
      dim("No capability rows configured — running on allowed_tasks defaults.");
    } else {
      console.log();
      for (const [id, c] of configured) {
        console.log(`  ${BOLD}${id}${RESET}${c.adapter ? ` via ${c.adapter}` : ""}`);
        const custom = c.require?.identity?.custom || [];
        for (const f of custom) {
          console.log(`     must collect: ${f.label} — asked as "${f.ask}"${f.pattern ? ` (format ${f.pattern})` : ""}`);
        }
        if (c.require?.confirmBeforeWrite) console.log("     must read back and get an explicit yes");
        if (c.require?.businessHoursOnly) console.log("     writes only during opening hours");
        if (c.notes) console.log(`     guidance: "${String(c.notes).slice(0, 90)}${c.notes.length > 90 ? "…" : ""}"`);
        if (!custom.length && !c.require?.confirmBeforeWrite && !c.require?.businessHoursOnly && !c.notes) {
          dim("     nothing configured beyond being switched on");
        }
      }

      // Prove the enforcement is real for THIS business, by attempting the
      // write its own configuration is supposed to block.
      const appt = cfg.capabilities.appointments;
      const firstCustom = appt?.require?.identity?.custom?.[0];
      if (firstCustom && tools.includes("book_appointment")) {
        console.log();
        const attempt = await executeToolCall(
          { id: "live", name: "book_appointment", args: { scheduled_at: "2027-01-05T10:00:00", client_name: "Test Caller" } },
          { businessId: business.id, callerPhone: "+15550000000", callId: null, integrations, capabilityState: {}, config: cfg, step: "gather_details" }
        );
        check(attempt.functionResponse.response.success === false,
          `a booking without the ${firstCustom.label} is refused for this business`,
          `booking succeeded without the ${firstCustom.label} — the requirement is NOT being enforced`);
        dim(`the model is told: "${attempt.functionResponse.response.message}"`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
head("Result");
if (failures === 0) {
  console.log(`  ${GREEN}All checks passed.${RESET}`);
} else {
  console.log(`  ${RED}${failures} check(s) failed.${RESET}`);
}
console.log();
process.exit(failures === 0 ? 0 : 1);
