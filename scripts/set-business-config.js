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
const FIELDS = ["name", "greeting", "general_info", "custom_instructions", "timezone"];

const TO = argOf("to");
const FROM = argOf("from");
const COPY = (argOf("copy") || "").split(",").map((s) => s.trim()).filter(Boolean);
const CONFIRM = has("confirm");

const E164 = /^\+[1-9]\d{6,14}$/;
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
  SETS[field] = decoded;
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
      changes[f] = source[f] === null || source[f] === undefined ? null : String(source[f]);
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

  const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
  const values = fields.map((f) => changes[f]);
  const res = await pool.query(
    `UPDATE businesses SET ${sets} WHERE id = $1`,
    [target.id, ...values]
  );
  say("rows updated", res.rowCount);
  if (res.rowCount !== 1) {
    console.error(`FAIL: expected to update exactly 1 row, updated ${res.rowCount}.`);
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
  await pool.end().catch(() => {});
  if (typeof close === "function") await close().catch(() => {});
}
