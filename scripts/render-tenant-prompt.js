#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Prompt check: render the prompt a tenant payload would give the live agent,
// BEFORE importing it.
//
//   node scripts/render-tenant-prompt.js <payload.json>
//
// The payload is scripts/import-tenant.js's JSON shape. Offline: no database,
// no network, no API key. It builds the same greeting-step prompt the live
// front-end renders, from the same loadConfig the call path uses.
//
// WARNINGS CHECK THE RAW VALUES. The prompt builder cuts custom_instructions
// and general_info at 2000 characters and the capability schema cuts `notes` at
// 2000, both silently, so the rendered prompt looks fine while the tail of what
// the client wrote is gone. Only the payload still shows the real length.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../services/db.js";
import { buildSystemInstruction } from "../services/gemini.js";

const LIMIT = 2000;

/** The capability rows a payload would write, adapted the way importTenant does. */
function payloadRows(payload) {
  const capabilities = Array.isArray(payload.capabilities) ? payload.capabilities : [];
  // Same adapting importTenant does: the id may be spelled three ways.
  const rows = [];
  for (const cap of capabilities) {
    const capId = cap.capability_id ?? cap.capability ?? cap.id;
    if (!capId) continue;
    rows.push({
      capability_id: capId,
      enabled: cap.enabled !== false,
      config: cap.config ?? {},
      ...(cap.adapter ? { adapter: cap.adapter } : {}),
      ...(cap.adapter_config ? { adapter_config: cap.adapter_config } : {}),
    });
  }
  return rows;
}

/**
 * The config the call path would build from this payload once imported: the
 * same loadConfig, fed the same rows. Exported so the eval runner can test a
 * tenant before it is imported (a scenario's `config`).
 */
export function payloadToConfig(payload) {
  const business = payload?.business;
  if (!business || typeof business !== "object") {
    throw new Error('Payload needs a "business" object.');
  }
  return loadConfig({ id: "payload-check", ...business }, payloadRows(payload));
}

export function renderTenantPrompt(payload) {
  const config = payloadToConfig(payload);
  const business = payload.business;
  const rows = payloadRows(payload);
  const prompt = buildSystemInstruction("greeting", null, config, { greetingSpoken: false });

  const warnings = [];
  for (const field of ["custom_instructions", "general_info"]) {
    const v = business[field];
    if (typeof v === "string" && v.length > LIMIT) {
      warnings.push(
        `${field} is ${v.length} characters; the prompt keeps only the first ${LIMIT}, so the last ${v.length - LIMIT} are never heard.`
      );
    }
  }
  for (const r of rows) {
    const notes = r.config?.notes;
    if (typeof notes === "string" && notes.length > LIMIT) {
      warnings.push(
        `capability ${r.capability_id} notes is ${notes.length} characters; the limit is ${LIMIT} and the rest is cut.`
      );
    }
  }

  return { prompt, chars: prompt.length, warnings };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/render-tenant-prompt.js <payload.json>");
    process.exit(2);
  }
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const { prompt, chars, warnings } = renderTenantPrompt(payload);
  console.log(prompt);
  console.log("");
  console.log(`PROMPT CHARS  ${chars}`);
  if (warnings.length) {
    for (const w of warnings) console.log(`WARNING  ${w}`);
    process.exit(1);
  }
  console.log("WARNINGS  none");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (e) {
    console.error(`render-tenant-prompt failed: ${e.message}`);
    process.exit(2);
  }
}
