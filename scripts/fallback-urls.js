#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Prints the Twilio "Primary handler fails" URL for each of our phone numbers
// (batch-3 S5, Task 5.2).
// ---------------------------------------------------------------------------
//
// Each Twilio account hosts the Function in twilio/fallback/fallback.js. A
// number's fallback URL is that Function's URL plus ?n=<transfer number>&t=<20|45>&v=<voice>.
// This builds the URLs so nobody hand-types a number. Read-only: no writes, no
// --confirm. Cloud SQL is private-IP only, so, like block-caller.js, this runs
// through the migrate job and ships in the image.
//
// USAGE
//   node scripts/fallback-urls.js --base <Function URL>
//   e.g. --base https://vetra-fallback-1234.twil.io/fallback
//
// n is left out (the fallback then takes a message instead of ringing) when the
// business has no transfer number, it is not E.164, or lib/dialCost.js would
// refuse to dial it: the Function dials straight from Twilio and skips our
// dial-time price check, so the check is applied here.
//
// Prints business configuration only (our number, its transfer number inside
// the URL). Never any caller data, secret or the DATABASE_URL.
// ---------------------------------------------------------------------------

import { pathToFileURL } from "node:url";
import { connect } from "./migrate.js";
import { checkDial } from "../lib/dialCost.js";
import { listFallbackRows } from "../lib/db/fallbackUrlRows.js";

const E164 = /^\+[1-9]\d{7,14}$/;

const say = (...parts) => console.log("[fallback]", ...parts);

/** @returns {{ok:true,value:{base:string}}|{ok:false,errors:string[]}} */
export function parseArgs(argv) {
  const all = Array.isArray(argv) ? argv : [];
  const errors = [];
  let base = null;
  let seen = false;
  for (let i = 0; i < all.length; i += 1) {
    const tok = String(all[i]);
    if (!tok.startsWith("--")) {
      errors.push("unexpected argument (a value with no flag in front of it)");
      continue;
    }
    const name = tok.slice(2);
    if (name !== "base") {
      errors.push(`unknown flag --${name.slice(0, 20).replace(/\d/g, "#")}`);
      continue;
    }
    if (seen) {
      errors.push("--base given twice");
      continue;
    }
    seen = true;
    const next = all[i + 1];
    if (next === undefined || String(next).startsWith("--")) {
      errors.push("--base needs a value");
    } else {
      base = String(next);
      i += 1;
    }
  }
  if (!seen) errors.push("--base <Function URL> is required");
  if (base !== null) {
    let u = null;
    try {
      u = new URL(base);
    } catch {
      errors.push("--base is not a valid URL");
    }
    if (u) {
      if (u.protocol !== "https:") errors.push("--base must be an https:// URL");
      else if (u.search || u.hash || base.includes("?") || base.includes("#")) {
        errors.push("--base must not have a query string or a #fragment (the script adds them)");
      } else {
        base = base.replace(/\/$/, "");
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { base } };
}

/**
 * @returns {{url:string, omitted:null|string}} omitted is why `n` is missing
 */
export function buildFallbackUrl({ base, transferNumber, transferNoAnswer, sayVoice, allowPricier }) {
  const params = new URLSearchParams();
  let omitted = null;
  if (typeof transferNumber !== "string" || transferNumber === "") {
    omitted = "no_transfer_number";
  } else if (!E164.test(transferNumber)) {
    omitted = "not_e164";
  } else {
    const check = checkDial(transferNumber, { allowPricier: allowPricier === true });
    if (check.ok === true) params.set("n", transferNumber);
    else omitted = check.reason || "unknown";
  }
  params.set("t", transferNoAnswer === "own_voicemail" ? "45" : "20");
  if (sayVoice) params.set("v", sayVoice);
  return { url: `${base}?${params.toString()}`, omitted };
}

const OMIT_NOTES = {
  no_transfer_number: "no transfer number is set",
  not_e164: "the transfer number is not in +country-code format",
  needs_switch_on: "the transfer number costs more than our standard rate; set allow_pricier_numbers to true to include it",
  over_ceiling: "the transfer number costs more than we allow",
  never: "the transfer number is premium-rate or special-rate, which we never dial",
  unknown: "we have no price for the transfer number",
};

/** The lines for one business. */
export function formatBlock(row, { url, omitted }) {
  const lines = [`[fallback] ${row.phone_number}  ${row.name ?? ""}`.trimEnd(), `[fallback]   ${url}`];
  if (omitted) {
    lines.push(
      `[fallback]   (no transfer number in this URL, so the fallback will take a message: ${OMIT_NOTES[omitted] || omitted})`
    );
  }
  return lines;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    for (const e of parsed.errors) console.error(`Refusing: ${e}`);
    process.exit(1);
  }
  const { base } = parsed.value;
  // Imported here so that importing this module (the build's smoke step) loads
  // nothing heavy and opens no connection.
  const { loadConfig } = await import("../services/db.js");
  const { resolveProfile } = await import("../lib/voice/voiceLocale.js");
  const { client, close } = await connect();
  try {
    const rows = await listFallbackRows(client);
    for (const row of rows) {
      const config = loadConfig(row.business);
      const built = buildFallbackUrl({
        base,
        transferNumber: row.transfer_phone_number,
        transferNoAnswer: config.transferNoAnswer,
        sayVoice: resolveProfile(config).twimlSayVoice,
        allowPricier: config.allowPricierNumbers,
      });
      for (const line of formatBlock(row, built)) console.log(line);
    }
    say(
      `${rows.length} number${rows.length === 1 ? "" : "s"}. Paste each URL into that number's Voice > "Primary handler fails" (Webhook, HTTP POST).`
    );
  } finally {
    await close?.();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`fallback-urls failed: ${e.message}`);
      process.exit(1);
    });
}
