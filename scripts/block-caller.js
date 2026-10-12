#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The operator path for the inbound block list (batch-3 S4, Task 4.3).
// ---------------------------------------------------------------------------
//
// blocked_callers is a PLATFORM table: no row-level security and no grant to
// vetra_app, so the voice service can only ask app_caller_blocked(number,
// business) and cannot write the list. Cloud SQL is private-IP only, so, like
// set-business-config.js and outbound-admin.js, this runs through the migrate
// job and ships in the image.
//
// USAGE
//   node scripts/block-caller.js --add <e164> --reason "<text>" [--business <twilio e164>] [--days N] [--confirm]
//   node scripts/block-caller.js --remove <e164> [--confirm]
//   node scripts/block-caller.js --list
//
//   --add     blocks the number for every business, or only for the business
//             that owns --business (a Twilio number). It is an upsert: adding
//             a number that is already listed replaces its scope, reason and
//             expiry. --days N (1-365) makes the block lapse after N days;
//             without it the block lasts until removed.
//   --remove  deletes the number's row.
//   --list    prints every row, masked to the last four digits.
//   Twilio's withheld-caller placeholders (+266696687 and the like) ARE valid
//   here: blocking every withheld caller during an attack is a legitimate use.
//
// DRY RUN BY DEFAULT. Without --confirm, --add and --remove say what they WOULD
// do and write nothing (no write transaction is opened). Nothing prints a
// caller number whole: only its last four digits. The reason is stored as the
// operator typed it but printed with any number-like span of 5+ digits masked to its last four.
//
// The migrate job connects as Cloud SQL `postgres`, which owns these tables
// and has no BYPASSRLS; business_directory is a platform table, so the
// --business lookup needs no tenant scope.
// ---------------------------------------------------------------------------

import { pathToFileURL } from "node:url";
import { connect } from "./migrate.js";
import { last4 } from "../lib/phone.js";

const E164 = /^\+[1-9]\d{6,14}$/;
const MAX_REASON = 200;
const MAX_DAYS = 365;
const KNOWN_FLAGS = new Set(["add", "remove", "list", "reason", "business", "days", "confirm"]);
const VALUE_FLAGS = new Set(["add", "remove", "reason", "business", "days"]);

const say = (...parts) => console.log("[block]", ...parts);

/**
 * Parses argv (already sliced past `node script.js`). Pure: no I/O, so a bad
 * invocation is refused before any database connection exists.
 * @returns {{ok:true,value:object}|{ok:false,errors:string[]}}
 */
export function parseArgs(argv) {
  const all = Array.isArray(argv) ? argv : [];
  const errors = [];
  const flags = new Map();

  for (let i = 0; i < all.length; i += 1) {
    const tok = String(all[i]);
    if (!tok.startsWith("--")) {
      // Not echoed: a stray token is often a number typed without its flag.
      errors.push("unexpected argument (a value with no flag in front of it)");
      continue;
    }
    const name = tok.slice(2);
    if (!KNOWN_FLAGS.has(name)) {
      errors.push(`unknown flag --${name.slice(0, 20).replace(/\d/g, "#")}`);
      continue;
    }
    let value = true;
    if (VALUE_FLAGS.has(name)) {
      const next = all[i + 1];
      if (next === undefined || String(next).startsWith("--")) {
        value = null;
        errors.push(`--${name} needs a value`);
      } else {
        value = String(next);
        i += 1;
      }
    }
    if (flags.has(name)) {
      errors.push(`--${name} given twice`);
      continue;
    }
    flags.set(name, value);
  }

  const modes = ["add", "remove", "list"].filter((m) => flags.has(m));
  if (modes.length !== 1) {
    errors.push("give exactly one of --add <e164>, --remove <e164>, --list");
  }
  const mode = modes.length === 1 ? modes[0] : null;
  const confirm = flags.get("confirm") === true;

  const phone = mode === "add" || mode === "remove" ? flags.get(mode) : null;
  if ((mode === "add" || mode === "remove") && flags.get(mode) !== null && !E164.test(phone || "")) {
    errors.push(
      `--${mode} must be an E.164 number: + then 7-15 digits, no spaces or formatting (got a value ending ${last4(phone) || "(none)"})`
    );
  }

  let reason = null;
  let days = null;
  let businessPhone = null;
  if (mode === "add") {
    reason = flags.get("reason") ?? null;
    if (!flags.has("reason")) errors.push("--reason is required with --add");
    else if (reason !== null && (reason.trim().length < 1 || reason.length > MAX_REASON)) {
      errors.push(`--reason must be 1-${MAX_REASON} characters`);
    }
    if (flags.has("days")) {
      const raw = flags.get("days");
      if (raw !== null && !(/^[1-9]\d{0,3}$/.test(raw) && Number(raw) <= MAX_DAYS)) {
        errors.push(`--days must be a whole number from 1 to ${MAX_DAYS} (absent = until removed)`);
      } else if (raw !== null) {
        days = Number(raw);
      }
    }
    if (flags.has("business")) {
      businessPhone = flags.get("business");
      if (businessPhone !== null && !E164.test(businessPhone)) {
        errors.push(`--business must be an E.164 number (got a value ending ${last4(businessPhone) || "(none)"})`);
      }
    }
  } else {
    for (const f of ["reason", "business", "days"]) {
      if (flags.has(f)) errors.push(`--${f} only applies to --add`);
    }
  }
  if (mode === "list" && confirm) errors.push("--confirm does not apply to --list");

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { mode, confirm, phone, reason: reason && reason.trim(), days, businessPhone } };
}

function expiryText(row) {
  if (!row.expires_at) return "until removed";
  const when = new Date(row.expires_at);
  const iso = Number.isNaN(when.getTime()) ? String(row.expires_at) : when.toISOString();
  return when.getTime() <= Date.now() ? `${iso} (expired)` : iso;
}

/**
 * A reason is stored as typed but printed masked: any number-like span with 5+
 * digits (a number typed into it, with any short non-letter separators, any
 * Unicode digits) becomes an ellipsis and its last four digits.
 */
export function maskReason(reason) {
  return String(reason ?? "").replace(/\+?\p{Nd}(?:[^\p{L}\p{Nd}\n]{0,3}\p{Nd})+/gu, (span) => {
    const digits = span.normalize("NFKC").replace(/\P{Nd}/gu, "");
    return digits.length >= 5 ? `…${digits.slice(-4)}` : span;
  });
}

/** One masked line per row. Never the whole number. */
export function formatRow(row) {
  const scope = row.business_id ? `business ${row.business_id}` : "all";
  return `ending ${last4(row.phone)}  scope: ${scope}  expires: ${expiryText(row)}  reason: ${maskReason(row.reason)}`;
}

async function resolveBusiness(client, businessPhone) {
  const r = await client.query("SELECT business_id FROM business_directory WHERE phone_number = $1", [businessPhone]);
  return r.rowCount === 1 ? r.rows[0].business_id : null;
}

/**
 * Upsert one block. Dry run (no `confirm`) reads only and opens no transaction.
 * @returns {Promise<{ok:boolean,dryRun?:boolean,error?:string,businessId?:string|null,
 *   existing?:boolean,rows?:number,inserted?:boolean}>}
 */
export async function addBlock(client, { phone, reason, businessPhone = null, days = null, confirm = false }) {
  if (!E164.test(phone || "")) return { ok: false, error: "phone must be an E.164 number" };
  if (typeof reason !== "string" || reason.trim().length < 1 || reason.length > MAX_REASON) {
    return { ok: false, error: `reason must be 1-${MAX_REASON} characters` };
  }
  if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= MAX_DAYS)) {
    return { ok: false, error: `days must be a whole number from 1 to ${MAX_DAYS}` };
  }

  let businessId = null;
  if (businessPhone) {
    businessId = await resolveBusiness(client, businessPhone);
    if (!businessId) {
      return { ok: false, error: `no business has the number ending ${last4(businessPhone)}; nothing written` };
    }
  }

  const existing = (await client.query("SELECT 1 FROM blocked_callers WHERE phone = $1", [phone])).rowCount === 1;
  if (!confirm) return { ok: true, dryRun: true, businessId, existing };

  await client.query("BEGIN");
  try {
    const r = await client.query(
      `INSERT INTO blocked_callers (phone, business_id, reason, expires_at)
       VALUES ($1, $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE now() + make_interval(days => $4::int) END)
       ON CONFLICT (phone) DO UPDATE
         SET business_id = EXCLUDED.business_id,
             reason      = EXCLUDED.reason,
             expires_at  = EXCLUDED.expires_at,
             created_at  = now()
       RETURNING (xmax = 0) AS inserted`,
      [phone, businessId, reason.trim(), days]
    );
    await client.query("COMMIT");
    return { ok: true, businessId, rows: r.rowCount, inserted: r.rows[0].inserted };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/** Delete one block. Dry run counts and opens no transaction. */
export async function removeBlock(client, { phone, confirm = false }) {
  if (!E164.test(phone || "")) return { ok: false, error: "phone must be an E.164 number" };
  if (!confirm) {
    const n = (await client.query("SELECT count(*)::int AS n FROM blocked_callers WHERE phone = $1", [phone])).rows[0].n;
    return { ok: true, dryRun: true, rows: n };
  }
  await client.query("BEGIN");
  try {
    const r = await client.query("DELETE FROM blocked_callers WHERE phone = $1", [phone]);
    await client.query("COMMIT");
    return { ok: true, rows: r.rowCount };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

/** Every row, newest first, as raw rows. Print them through formatRow. */
export async function listBlocks(client) {
  const r = await client.query(
    "SELECT phone, business_id, reason, created_at, expires_at FROM blocked_callers ORDER BY created_at DESC, phone"
  );
  return r.rows;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    for (const e of parsed.errors) console.error(`Refusing: ${e}`);
    process.exit(1);
  }
  const v = parsed.value;
  const { client, close } = await connect();
  try {
    if (v.mode === "list") {
      const rows = await listBlocks(client);
      say(`${rows.length} blocked number(s)`);
      for (const row of rows) say(formatRow(row));
      return;
    }
    const result =
      v.mode === "add"
        ? await addBlock(client, { ...v })
        : await removeBlock(client, { phone: v.phone, confirm: v.confirm });
    if (!result.ok) {
      console.error(`Refusing: ${result.error}`);
      process.exit(1);
    }
    if (result.dryRun) {
      if (v.mode === "add") {
        const scope = result.businessId ? `business ${result.businessId}` : "every business";
        const until = v.days ? `for ${v.days} day(s)` : "until removed";
        say(`would ${result.existing ? "replace the block on" : "block"} the number ending ${last4(v.phone)} for ${scope}, ${until}`);
      } else {
        say(`would remove ${result.rows} row(s) for the number ending ${last4(v.phone)}`);
      }
      say("DRY RUN — nothing written. Re-run with --confirm to apply.");
      return;
    }
    if (v.mode === "add") {
      say(`${result.inserted ? "added" : "updated"} ${result.rows} row(s) for the number ending ${last4(v.phone)}`);
    } else {
      say(`removed ${result.rows} row(s) for the number ending ${last4(v.phone)}`);
    }
  } finally {
    await close?.();
  }
}

// Guarded as outbound-admin.js is: importing this module (the build's
// smoke-verifiers step does) opens no connection.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(`block-caller failed: ${e.message}`);
    process.exit(1);
  });
}
