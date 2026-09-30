#!/usr/bin/env node
/**
 * Generates lib/outbound/euHolidays.json: the nationwide public holidays of
 * the 27 EU member states, used by lib/outbound/legalFloor.js (S4-5).
 *
 * date-holidays is NOT a dependency of this repo (no package.json change, no
 * runtime import). Install it into a scratch directory, then point this
 * script at that directory:
 *
 *   npm i date-holidays@3.37.0 --prefix <scratch>/dh
 *   node scripts/outbound/gen-eu-holidays.mjs <scratch>/dh [firstYear] [lastYear]
 *
 * (the directory can also come from the DATE_HOLIDAYS_DIR env var).
 *
 * Only `type === "public"` entries are kept, and the library is instantiated
 * WITHOUT a state/region, so regional days (DE Laender, ES communities, FR
 * Alsace-Moselle, ...) are meant to be absent. That "no state means nationwide
 * only" behaviour could not be confirmed from documentation, so this script
 * self-checks it (SELF_CHECKS below) and exits non-zero if any check fails.
 *
 * Data licence: date-holidays code ISC, holiday data CC-BY-3.0 (attribution is
 * carried in the JSON `source` block and in docs/outbound-eu-calling-floor.md).
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EU = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
];

const dir = process.argv[2] || process.env.DATE_HOLIDAYS_DIR;
const firstYear = Number(process.argv[3] || 2026);
const lastYear = Number(process.argv[4] || 2030);
if (!dir) {
  console.error("usage: gen-eu-holidays.mjs <dir containing node_modules/date-holidays> [firstYear] [lastYear]");
  process.exit(2);
}
const req = createRequire(path.resolve(dir) + path.sep);
const Holidays = req("date-holidays");
const PINNED_VERSION = "3.37.0";
const version = req("date-holidays/package.json").version;
if (version !== PINNED_VERSION) {
  console.error(`date-holidays version mismatch: installed ${version}, pinned ${PINNED_VERSION}. Install the pinned version into the scratch dir.`);
  process.exit(1);
}

const holidays = {};
for (const cc of EU) {
  const hd = new Holidays(cc);
  const dates = new Set();
  for (let y = firstYear; y <= lastYear; y++) {
    for (const h of hd.getHolidays(y)) {
      if (h.type === "public") dates.add(String(h.date).slice(0, 10));
    }
  }
  holidays[cc] = [...dates].sort();
}

// Known-answer checks: a day that must be present, and regional-only /
// non-holiday days that must be absent (proves "public, no state" = nationwide).
const SELF_CHECKS = [
  ["ES", "2026-10-12", true], // Fiesta Nacional
  ["DE", "2026-10-03", true], // Unity Day
  ["DE", "2026-01-06", false], // Epiphany: BW/BY/ST only
  ["DE", "2026-06-04", false], // Corpus Christi: regional
  ["DE", "2026-11-01", false], // All Saints: BW/BY/NW/RP/SL only
  ["FR", "2026-04-03", false], // Good Friday: Alsace-Moselle only
  ["FR", "2026-07-14", true],
  ["IE", "2026-03-17", true],
  ["IT", "2026-06-02", true],
  ["NL", "2026-04-27", true],
  ["BE", "2026-07-21", true],
  ["PT", "2026-06-10", true],
];
let failed = 0;
for (const [cc, date, want] of SELF_CHECKS) {
  const got = holidays[cc].includes(date);
  if (got !== want) { console.error(`SELF-CHECK FAILED: ${cc} ${date} expected ${want} got ${got}`); failed++; }
}
if (failed) process.exit(1);

const out = {
  source: {
    library: "date-holidays",
    version,
    licence: "ISC AND CC-BY-3.0",
    attribution: "Holiday data (c) date-holidays contributors, https://github.com/commenthol/date-holidays, licensed CC-BY-3.0 (code ISC).",
    filter: "type === 'public', no state/region (nationwide only)",
    generated_by: "scripts/outbound/gen-eu-holidays.mjs",
  },
  years: [firstYear, lastYear],
  holidays,
};
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "lib", "outbound", "euHolidays.json");
writeFileSync(target, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${target}: ${EU.length} countries, ${firstYear}-${lastYear}, date-holidays@${version}`);
