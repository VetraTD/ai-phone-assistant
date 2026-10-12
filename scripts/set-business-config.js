#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Copy operator-config fields from one business to another, and set fields
// outright — with a backup that can actually be restored and a read-back that
// the machine checks.
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
//
// There is no write path to a business row from a workstation. Cloud SQL is
// private-IP only, the voice service exposes no settings endpoint (only
// /phone-numbers/buy), and the dashboard writes through a different backend. So
// a config change that has to be made from here goes through the migrate job,
// and the job only runs what is baked into the image.
//
// The immediate need: point the American test line's tenant at another tenant's
// prompt so a UK demo can be dialled from a US handset, without touching
// `businesses.phone_number` — which carries a UNIQUE index, so re-pointing a
// number is a swap that leaves the other line routing to nothing.
//
// ---------------------------------------------------------------------------
// The two things that make this safe to run
// ---------------------------------------------------------------------------
//
// BACKUP AS BASE64, one line per field. `custom_instructions` is multi-line
// operator prose, and db-inspect's own header records what Cloud Logging does
// to multi-line output: indented continuation lines are dropped outright, so a
// backup printed as prose is a backup that cannot be restored. Base64 has no
// whitespace and survives the shipper intact.
//
// READ-BACK COMPARED BY THE MACHINE. docs/live-frontend-RESTORE.md carries a
// correction against itself: a restore was recorded as verified "field-for-
// field" and was not, because a human compared values by eye at the end of a
// long session. A mismatch here is a non-zero exit, not a line to scan past.
//
// Dry run by default. Nothing is written without --confirm.
//
//   node scripts/set-business-config.js --to +1... --show
//   node scripts/set-business-config.js --to +1... --from +44... --copy name,greeting
//   node scripts/set-business-config.js --to +1... --set custom_instructions=<base64> --confirm
// ---------------------------------------------------------------------------

import pg from "pg";
import { cloudSqlPoolConfig } from "../lib/db/cloudSqlPool.js";
import { checkDial, REFUSAL_MESSAGES } from "../lib/dialCost.js";

const cfg = {
  instance: process.env.CLOUD_SQL_INSTANCE,
  database: process.env.CLOUD_SQL_DATABASE,
  user: process.env.CLOUD_SQL_IAM_USER,
  password: process.env.CLOUD_SQL_PASSWORD,
  authType: process.env.CLOUD_SQL_PASSWORD ? "PASSWORD" : "IAM",
};

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const has = (name) => argv.includes(`--${name}`);

/**
 * The only columns this script may touch.
 *
 * A whitelist rather than a check, because the column name is interpolated into
 * SQL — there is no parameter form for an identifier. Nothing outside this list
 * can reach the statement, whatever is passed.
 */
// after_hours_policy is here because it decides BEHAVIOUR, not just prose: a
// tenant whose rules say "this line is answered around the clock, only
// bookings are limited to 9-5" needs `book_later`, and with `take_message`
// the model is told to offer a message instead of booking the moment the
// office is shut — the prompt and the policy then say opposite things.
const FIELDS = [
  "name",
  "greeting",
  "general_info",
  "custom_instructions",
  "timezone",
  "after_hours_policy",
  // WHETHER THIS TENANT TEXTS CALLERS AT ALL. Off by default, and
  // services/notifications.js returns on it with no log and no counter, so
  // POSTCALL_VERIFY=send on a tenant with it false drops every caller message in
  // silence. There was no write path to it from here: the dashboard has one, and
  // this script is the only route from a workstation.
  //
  // A boolean through a text field works because the parameter reaches Postgres
  // untyped and is cast to the column, and the read-back compares String() on both
  // sides, so a stored `true` matches a written "true".
  "sms_followup_enabled",
  // What happens when nobody picks up a transfer: take_message (default, ring 20 s)
  // or own_voicemail (ring 45 s, message as the fallback). Migration 052.
  "transfer_no_answer",
  // The ONE number used for transfers (and later overflow / server-down fallback).
  // Must reach a person directly; the dial-time price check is a later session.
  // dump() prints this in full (base64) in BEFORE/AFTER ON PURPOSE: the backup
  // must be restorable, and it is business configuration, like the
  // `phone_number b64` line above. Not a caller number.
  "transfer_phone_number",
  // The per-client switch-on for numbers costing 10-60 cents/min (migration 053).
  // WE set it; there is no dashboard screen. Off by default: only numbers at or
  // under 10 cents/min are dialled automatically. Exactly "true" or "false".
  "allow_pricier_numbers",
];

/**
 * Per-field value checks, run BEFORE any write. field -> (value) => error | null.
 * Messages name the field and the allowed shape and never echo a whole number.
 */
const E164 = /^\+[1-9]\d{6,14}$/;
const last4 = (v) => {
  const d = String(v).replace(/\D/g, "");
  return d.length >= 4 ? `...${d.slice(-4)}` : "(too short)";
};
const VALIDATORS = {
  transfer_no_answer: (v) =>
    v === "take_message" || v === "own_voicemail" ? null : "must be exactly take_message or own_voicemail",
  transfer_phone_number: (v) =>
    E164.test(v) ? null : `must be E.164, + then 7-15 digits, no spaces or formatting (got a value ending ${last4(v)})`,
  allow_pricier_numbers: (v) => (v === "true" || v === "false" ? null : "must be exactly true or false"),
};
function refusal(field, value, flag) {
  const err = VALIDATORS[field]?.(value);
  return err ? `Refusing: ${flag} ${field} ${err}.` : null;
}

/**
 * The number block for transfer_phone_number: the dial-time price check, run
 * BEFORE the number is stored. needs_switch_on is refused unless the same
 * command also writes allow_pricier_numbers = true. Never echoes the number.
 */
function transferPriceRefusal(value, allowPricier, flag) {
  const v = checkDial(value, { allowPricier });
  if (v.ok) return null;
  return `Refusing: ${flag} transfer_phone_number (ending ${last4(value)}) ${v.reason}. ${REFUSAL_MESSAGES[v.reason]}`;
}

const TO = argOf("to");
const FROM = argOf("from");
const COPY = (argOf("copy") || "").split(",").map((s) => s.trim()).filter(Boolean);
const CONFIRM = has("confirm");

if (!TO || !E164.test(TO)) {
  console.error("Refusing: --to must be an E.164 business phone number.");
  process.exit(1);
}
if (FROM && !E164.test(FROM)) {
  console.error("Refusing: --from must be an E.164 business phone number.");
  process.exit(1);
}
for (const f of COPY) {
  if (!FIELDS.includes(f)) {
    console.error(`Refusing: --copy ${JSON.stringify(f)} is not one of ${FIELDS.join(", ")}.`);
    process.exit(1);
  }
}

// --set field=<base64>. Base64 because the value travels as a Cloud Run job
// argument: --args is comma-separated and these values contain commas and
// newlines. Base64's alphabet has neither.
const SETS = {};
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] !== "--set") continue;
  const raw = argv[i + 1] || "";
  const eq = raw.indexOf("=");
  const field = raw.slice(0, eq);
  const b64 = raw.slice(eq + 1);
  if (!FIELDS.includes(field)) {
    console.error(`Refusing: --set ${JSON.stringify(field)} is not one of ${FIELDS.join(", ")}.`);
    process.exit(1);
  }
  let decoded;
  try {
    decoded = Buffer.from(b64, "base64").toString("utf8");
  } catch {
    console.error(`Refusing: --set ${field} value is not valid base64.`);
    process.exit(1);
  }
  if (!decoded) {
    console.error(`Refusing: --set ${field} decoded to an empty string.`);
    process.exit(1);
  }
  const bad = refusal(field, decoded, "--set");
  if (bad) {
    console.error(bad);
    process.exit(1);
  }
  SETS[field] = decoded;
}
// --set args come in any order, so the cross-field check waits until all are
// parsed. If allow_pricier_numbers is going to be --copy'd, the answer is not
// known yet: the check after the copy decides.
if (SETS.transfer_phone_number !== undefined && (SETS.allow_pricier_numbers !== undefined || !COPY.includes("allow_pricier_numbers"))) {
  const bad = transferPriceRefusal(SETS.transfer_phone_number, SETS.allow_pricier_numbers === "true", "--set");
  if (bad) {
    console.error(bad);
    process.exit(1);
  }
}

const { poolConfig, close } = await cloudSqlPoolConfig(cfg, { connectionTimeoutMillis: 10_000 });
const pool = new pg.Pool(poolConfig);

/** One fact per line, flush left. Cloud Logging drops indented continuations. */
const say = (...parts) => console.log("[cfg]", ...parts);

const cols = FIELDS.join(", ");

/**
 * Resolve through app_lookup_business_by_phone, NOT a direct column match.
 *
 * `WHERE phone_number = $1` found nothing for a number db-inspect resolves
 * fine. That function is what the voice service itself routes through, so it is
 * also the only lookup that guarantees this script edits the row a caller would
 * actually reach — and a stored value can carry whitespace that makes an exact
 * match fail while routing still works. The raw cell is dumped as base64 below
 * for exactly that reason.
 */
async function readRow(phone) {
  // EVERY COLUMN FROM THE FUNCTION, never a direct `FROM businesses`.
  //
  // The first version resolved the id here and then re-read the row straight
  // from the table, and the table read came back empty for a number the
  // function resolves fine — so the two do not see the same rows. db-inspect
  // has always taken all of it from the function (that is how it computes
  // custom_instructions_chars), and it is the lookup the voice service itself
  // routes through, so it is the one that defines which row a caller reaches.
  const res = await pool.query(
    `SELECT id, phone_number, ${cols} FROM app_lookup_business_by_phone($1)`,
    [phone]
  );
  say("lookup", phone, "rows", res.rowCount);
  return res.rows[0] || null;
}

/** Base64, so a multi-line value survives the log shipper and can be restored. */
function dump(label, row) {
  say(`${label} id`, row.id);
  // Base64 so hidden whitespace in the cell is visible. A leading newline in
  // a phone-number cell has previously made every other tenant answer as
  // "our office"; an exact-match lookup failing is the same smell.
  say(`${label} phone_number b64`, Buffer.from(String(row.phone_number || ""), "utf8").toString("base64"));
  for (const f of FIELDS) {
    const v = row[f];
    const s = v === null || v === undefined ? "" : String(v);
    say(`${label} ${f} chars`, s.length);
    say(`${label} ${f} b64`, Buffer.from(s, "utf8").toString("base64"));
  }
}

try {
  const target = await readRow(TO);
  if (!target) {
    console.error(`Refusing: no business has phone_number ${TO}.`);
    process.exit(1);
  }

  // THE BACKUP, PRINTED BEFORE ANYTHING IS DECIDED. These values exist nowhere
  // else that this session can reach — db-inspect reports their lengths and not
  // their contents — so overwriting without this is unrecoverable.
  say("connected as", (await pool.query("SELECT current_user")).rows[0].current_user);
  dump("BEFORE", target);

  const changes = { ...SETS };
  if (FROM && COPY.length > 0) {
    const source = await readRow(FROM);
    if (!source) {
      console.error(`Refusing: no business has phone_number ${FROM}.`);
      process.exit(1);
    }
    say("copying from id", source.id);
    for (const f of COPY) {
      // Copied verbatim from the live row rather than retyped, which is the
      // point: a transcription error in operator prose is invisible until a
      // caller hears it.
      if (f in changes) continue;
      // Copying NULL clears the target's field, and that is allowed on purpose
      // (transfer_no_answer cannot be NULL -- it is a NOT NULL column).
      changes[f] = source[f] === null || source[f] === undefined ? null : String(source[f]);
      const bad = changes[f] === null ? null : refusal(f, changes[f], "--copy");
      if (bad) {
        console.error(bad);
        process.exit(1);
      }
    }
  }

  // Every value written to transfer_phone_number is price-checked before any
  // write, with the allow_pricier_numbers value THIS command writes (if any).
  if (changes.transfer_phone_number !== null && changes.transfer_phone_number !== undefined) {
    const bad = transferPriceRefusal(changes.transfer_phone_number, changes.allow_pricier_numbers === "true", "--copy/--set");
    if (bad) {
      console.error(bad);
      process.exit(1);
    }
  }

  const fields = Object.keys(changes);
  if (fields.length === 0) {
    say("no changes requested; --show only");
    process.exit(0);
  }

  for (const f of fields) {
    const before = target[f] === null || target[f] === undefined ? "" : String(target[f]);
    const after = changes[f] === null ? "" : String(changes[f]);
    say(`PLAN ${f}`, `${before.length} chars -> ${after.length} chars`, before === after ? "(no change)" : "(CHANGES)");
  }

  if (!CONFIRM) {
    say("DRY RUN — nothing written. Re-run with --confirm to apply.");
    process.exit(0);
  }

  // SCOPED, IN A TRANSACTION. The first version updated straight off the pool
  // and matched ZERO rows.
  //
  // Cloud SQL's `postgres` is not BYPASSRLS, whatever `current_user` says, so a
  // direct write to a tenant table with no `app.business_id` set matches
  // nothing. Reads got away with it only because app_lookup_business_by_phone
  // is SECURITY DEFINER. This is the same failure already on file as "a
  // tenantless write matches zero rows and reports success" — it reported
  // failure here only because the row count is checked.
  //
  // Same shape db-inspect uses for its scoped counts.
  const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
  const values = fields.map((f) => changes[f]);
  const client = await pool.connect();
  let updated = 0;
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('app.business_id', $1, true)`, [target.id]);
    const res = await client.query(`UPDATE businesses SET ${sets} WHERE id = $1`, [target.id, ...values]);
    updated = res.rowCount;
    if (updated !== 1) {
      // ROLLBACK, not just an exit: a write that touched the wrong number of
      // rows must leave nothing behind to reason about later.
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }
  } finally {
    client.release();
  }
  say("rows updated", updated);
  if (updated !== 1) {
    console.error(`FAIL: expected to update exactly 1 row, updated ${updated}. Rolled back.`);
    process.exit(1);
  }

  // READ BACK AND COMPARE. Not printed for a human to check — compared here,
  // because the recorded failure of the last restore was a human checking.
  const after = await readRow(TO);
  dump("AFTER", after);
  let bad = 0;
  for (const f of fields) {
    const want = changes[f] === null ? "" : String(changes[f]);
    const got = after[f] === null || after[f] === undefined ? "" : String(after[f]);
    if (want !== got) {
      bad += 1;
      console.error(`MISMATCH ${f}: wanted ${want.length} chars, read back ${got.length}.`);
    }
  }
  if (bad > 0) {
    console.error(`FAIL: ${bad} field(s) did not read back as written.`);
    process.exit(1);
  }
  say("VERIFIED: every field read back exactly as written.");
} finally {
  // Both awaited inside try/catch rather than chained off a returned promise:
  // cloudSqlPoolConfig's close() returns undefined for a direct connection, and
  // `.catch()` on undefined threw AFTER a successful, verified write — turning a
  // clean run into a non-zero exit, which is the one signal this script uses to
  // mean "something went wrong".
  try {
    await pool.end();
  } catch {}
  try {
    if (typeof close === "function") await close();
  } catch {}
}
