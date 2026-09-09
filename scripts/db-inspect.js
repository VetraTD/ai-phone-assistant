#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Read-only database facts, for questions that cannot be answered from a
// workstation.
//
//   gcloud run jobs execute vetra-migrate-us-staging --args=scripts/db-inspect.js
//
// The Cloud SQL instances are private-IP only, so there is no psql from here.
// Every question about what the REAL database allows — as opposed to what the
// local dev container allows — has to be asked from inside the VPC.
//
// It exists because a whole class of defect in this codebase comes from the
// local database being MORE permissive than Cloud SQL: local `vetra` is a
// superuser with BYPASSRLS and owns every function, so SECURITY DEFINER sails
// past row-level security that would stop it in production. Two bootstrap
// functions were broken that way and nothing caught it.
//
// STRICTLY READ-ONLY. No DDL, no writes. It answers questions; changing things
// is a migration's job.
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

// ---------------------------------------------------------------------------
// THREE MODES, because "is this staging?" was the wrong question to ask once.
//
// This file used to refuse outright anywhere but staging, and that refusal was
// right for what it did: the transcript dump prints what a caller SAID, which
// in production is patient speech, and Cloud Logging is not where that belongs.
//
// But it made the file useless for the questions actually being asked of
// production -- "what hours does this tenant allow", "are transcripts being
// written at all" -- neither of which needs a single word of caller speech.
// Refusing those pushed every investigation into a code-change-and-deploy loop,
// and an investigation tool nobody can afford to run is not a control, it is a
// blind spot with a good excuse.
//
// So the gate moves from the FILE to the SECTIONS that print content:
//
//   --business <e164>   tenant CONFIG only. Name, timezone, hours, policy,
//                       allowed_tasks, and whether general_info holds anything.
//                       No caller speech, no PHI. Safe anywhere.
//   --counts            row counts per table, plus the knowledge and capability
//                       breakdowns. Numbers, never content. Safe anywhere, and
//                       the honest answer to "does the database actually work".
//   --appointments      status breakdown and scheduled times. No names, no
//                       phone numbers, no notes text. Tells `cancelled` from
//                       `scheduled`, which a count of the table cannot.
//   --calls             one line of metadata per call: status, ended_at,
//                       duration, whether a summary exists, how many
//                       transcript rows. NO message text. Safe anywhere, and
//                       the answer to "which rows are not being updated",
//                       which a count cannot give. --limit N, default 25.
//   (no arguments)      the full audit, including the transcript dump.
//                       STAGING ONLY, unchanged.
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const BUSINESS = argOf("business");
const WANT_COUNTS = argv.includes("--counts");
const WANT_CALLS = argv.includes("--calls");
// --appointments: the status breakdown and the times.
//
// Four blind spots, closed together, and each one cost a call to discover:
// a rescheduled TIME could not be verified, `cancelled` could not be told from
// `scheduled`, `--counts` gave one number for a table holding both, and the
// only way to check a booking existed was to ask the assistant -- which is the
// thing under test.
const WANT_APPTS = argv.includes("--appointments");
// Bounded so a tenant with a long history cannot turn one question into a
// thousand log lines. Cloud Logging drops what it cannot ship, and a truncated
// answer that looks complete is the failure mode this file already knows about.
const CALLS_LIMIT = Math.min(Math.max(parseInt(argOf("limit") || "25", 10) || 25, 1), 200);
// EVERY new flag belongs in this OR. A flag that is not here leaves AD_HOC
// false, and the script falls through to the staging-only full audit and exits
// 1 -- with a message about staging that says nothing about the flag you passed.
const AD_HOC = Boolean(BUSINESS) || WANT_COUNTS || WANT_CALLS || WANT_APPTS;

const looksLikeStaging = /staging/i.test(cfg.database) && /staging/i.test(cfg.instance);

if (!AD_HOC && !looksLikeStaging) {
  console.error(
    `Refusing the full audit: this does not look like staging.
` +
      `  CLOUD_SQL_DATABASE = ${JSON.stringify(cfg.database)}
` +
      `  CLOUD_SQL_INSTANCE = ${JSON.stringify(cfg.instance)}
` +
      `The full audit prints transcript text, which in production is patient speech.
` +
      "For production, ask a narrower question that carries no caller speech:\n" +
      "  --args=scripts/db-inspect.js,--counts\n" +
      "  --args=scripts/db-inspect.js,--business,+441372656055\n" +
      "  --args=scripts/db-inspect.js,--business,+441372656055,--calls\n" +
      "  --args=scripts/db-inspect.js,--business,+441372656055,--counts,--appointments"
  );
  process.exit(1);
}

// A phone number reaches a SQL function argument, so it is checked rather than
// trusted. E.164 only -- nothing else can be a business phone, and a value that
// is not one is a mistake worth failing on rather than passing through.
if (BUSINESS && !/^\+[1-9]\d{6,14}$/.test(BUSINESS)) {
  console.error(`Refusing: --business ${JSON.stringify(BUSINESS)} is not an E.164 number.`);
  process.exit(1);
}

const { poolConfig, close } = await cloudSqlPoolConfig(cfg, { connectionTimeoutMillis: 10_000 });
const pool = new pg.Pool(poolConfig);

// One line per fact, no leading newline and no leading whitespace.
//
// Cloud Logging dropped every indented continuation line of the first version:
// the seven section headers arrived and not one row did, which reads as "every
// query returned nothing" rather than "the log shipper ate the answers". The
// seed script's unindented output had always come through fine.
//
// A diagnostic whose failure mode is silently losing its results is worse than
// no diagnostic at all.
const show = (label, rows) => {
  if (!rows.length) {
    console.log(`[inspect] ${label}: (none)`);
    return;
  }
  for (const r of rows) console.log(`[inspect] ${label}: ${JSON.stringify(r)}`);
};

try {
  show("connected as", (await pool.query("SELECT current_user, current_database()")).rows);

  // ---------------------------------------------------------------------
  // AD-HOC MODE. Config and counts, never content.
  //
  // The question that produced this: the assistant offered "11:30pm" on the
  // first deployed Live calls (LVX80). The fix so far treats that as an offer
  // made before anything checked, which the log order establishes. What it does
  // NOT establish is whether 23:30 was ever a legitimate slot -- openTimesForDay
  // derives its whole window from business_hours, so a tenant whose hours run
  // late would have the availability tool return 23:30 as genuinely open, and
  // the model would have been EARLY rather than WRONG. Different defect,
  // different fix.
  //
  // The local dev row says 09:00-17:00 Europe/London. That is not this database,
  // which is the entire reason this file exists.
  // ---------------------------------------------------------------------
  let scopedBusinessId = null;

  if (BUSINESS) {
    // app_lookup_business_by_phone RETURNS SETOF businesses, so every column of
    // the table is already selectable here -- allowed_tasks and general_info
    // cost no second query and no scope, because the function is SECURITY
    // DEFINER and sets app.business_id itself when it is unset.
    //
    // allowed_tasks is the one that could never be read back after being
    // written: import-tenant sets it and nothing could confirm it landed. The
    // default for an unconfigured tenant is book_appointment ONLY, which is why
    // cancelling was impossible on Brightwork Studio until 2026-09-09.
    //
    // general_info is printed as a LENGTH, not as text. It is tenant copy
    // rather than caller speech, but this file's line is "config and numbers",
    // and "is there a price configured" is answered by a number.
    const row = await pool.query(
      `SELECT id, phone_number, name, timezone, after_hours_policy, business_hours,
              allowed_tasks,
              (general_info IS NOT NULL AND general_info <> '') AS has_general_info,
              coalesce(length(general_info), 0) AS general_info_chars,
              -- IS THERE A PRICE IN THE PROMPT? LVX66, and the $3,000 question.
              --
              -- On two consecutive calls on 2026-09-09 the assistant said
              -- "our branding and web design projects typically start around
              -- three thousand dollars", once contradicting itself inside a
              -- single turn ("...I can't quote a figure directly here"). A
              -- price is the worst thing on the list to invent, and nothing
              -- outside the VPC could say whether it was configured.
              --
              -- A BOOLEAN, not the text. general_info and custom_instructions
              -- are the tenant's own copy rather than caller speech, so they
              -- are on the safe side of this file's line -- but they are free
              -- text of arbitrary length, and "does a price appear in it" is
              -- the whole question. A fact answers it; a dump would answer it
              -- and a great deal else.
              --
              -- Both fields, because both reach the model: general_info is
              -- knowledge and custom_instructions is instruction, and a figure
              -- in either one is a figure the assistant may repeat.
              -- NOTE the doubled backslashes. This is a JS template literal, so
              -- a single \s reaches Postgres as a bare "s" and the pattern
              -- silently stops matching a currency symbol followed by a space.
              -- Same family as the heredoc trap already recorded for this repo.
              (general_info ~* '[$£€]\\s*[0-9]|[0-9][0-9,. ]*\\s*(dollars|pounds|usd|gbp)|thousand') AS general_info_mentions_price,
              coalesce(length(custom_instructions), 0) AS custom_instructions_chars,
              (custom_instructions ~* '[$£€]\\s*[0-9]|[0-9][0-9,. ]*\\s*(dollars|pounds|usd|gbp)|thousand') AS custom_instructions_mentions_price
         FROM app_lookup_business_by_phone($1)`,
      [BUSINESS]
    );
    show(`tenant config ${BUSINESS}`, row.rows);
    scopedBusinessId = row.rows[0]?.id ?? null;
    if (!scopedBusinessId) {
      show(`tenant config ${BUSINESS}`, [
        { error: "no business routes to this number on THIS database" },
      ]);
    }
  }

  if (WANT_COUNTS) {
    // Counts only. A count is not content, so this is safe where the transcript
    // dump is not -- and it is the honest answer to "does the database actually
    // work", which no amount of reading the code settles.
    //
    // SCOPED, or the numbers lie. Every table here is under FORCE row-level
    // security, so an unscoped count returns 0 and reads as "nothing is being
    // written" when it means "you did not say who you are". That distinction is
    // exactly the one this file was written to stop people getting wrong.
    //
    // customer_requests: the take-message and after-hours path had no row-level
    // instrument at all, so "did it save the message" was unanswerable from
    // outside the VPC.
    //
    // business_knowledge and business_capabilities: the $3,000 question. The
    // assistant quoted a price confidently on two consecutive calls. If the
    // knowledge table is empty and general_info is null, the figure was
    // invented -- and a price is the worst thing on the list to invent.
    const TABLES = [
      "calls",
      "call_transcripts",
      "appointments",
      "sms_consents",
      "customer_requests",
      "business_knowledge",
      "business_capabilities",
    ];
    if (!scopedBusinessId) {
      show("counts", [
        {
          skipped: "counts need a tenant to scope to",
          hint: "pass --business <e164> as well; RLS makes an unscoped count read 0",
        },
      ]);
    } else {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.business_id', $1, true)`, [scopedBusinessId]);
        for (const t of TABLES) {
          try {
            // Table names come from the constant above and never from argv, so
            // this interpolation cannot be reached by an argument.
            const c = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
            show("counts", [{ table: t, rows: c.rows[0].n }]);
          } catch (err) {
            // A missing table is a MIGRATION fact, not a crash.
            show("counts", [{ table: t, error: err?.message }]);
          }
        }

        // A count of business_knowledge does not answer the question. A row
        // with enabled=false is not served to the model, so "3 rows" and "3
        // rows, none enabled" are the same number and opposite facts.
        try {
          const k = await client.query(
            `SELECT count(*)::int AS rows,
                    count(*) FILTER (WHERE enabled)::int AS enabled_rows,
                    count(DISTINCT category)::int AS categories,
                    -- Same question as the tenant config's price probe, for the
                    -- other place an answer can come from. A count of rows says
                    -- the table is populated; it does not say whether a figure
                    -- the assistant quoted is in one of them.
                    count(*) FILTER (
                      WHERE enabled AND answer ~* '[$£€]\\s*[0-9]|[0-9][0-9,. ]*\\s*(dollars|pounds|usd|gbp)|thousand'
                    )::int AS enabled_rows_mentioning_price
               FROM business_knowledge`
          );
          show("knowledge", k.rows);
        } catch (err) {
          show("knowledge", [{ error: err?.message }]);
        }

        // Which capabilities this tenant actually has a row for, and how they
        // are configured. adapter_config is DELIBERATELY not selected -- it can
        // hold credentials, and this file prints to Cloud Logging.
        try {
          const caps = await client.query(
            `SELECT capability_id, enabled, adapter, config
               FROM business_capabilities
              ORDER BY capability_id`
          );
          show("capabilities", caps.rows);
          if (!caps.rows.length) {
            show("capabilities", [
              {
                note:
                  "no business_capabilities row: every capability runs on its declared DEFAULTS. " +
                  "confirmBeforeWrite defaults to false, so a tenant with no row has no " +
                  "read-back requirement configured.",
              },
            ]);
          }
        } catch (err) {
          show("capabilities", [{ error: err?.message }]);
        }

        await client.query("COMMIT");
      } finally {
        client.release();
      }
    }
  }

  // ---------------------------------------------------------------------
  // --appointments: status breakdown and scheduled times. No names, no phones.
  //
  // `status` carries NO check constraint (schema.sql:143-156) and
  // updateAppointmentStatus writes whatever it is given, so this GROUPS rather
  // than assuming an enum. A value nobody expected showing up here is itself
  // the finding.
  //
  // client_name, client_phone and notes are never selected. They are the
  // caller's own data and this file's whole line is that config and numbers
  // travel where content does not.
  // ---------------------------------------------------------------------
  if (WANT_APPTS) {
    if (!scopedBusinessId) {
      show("appointments", [
        {
          skipped: "appointments need a tenant to scope to",
          hint: "pass --business <e164> as well; RLS makes an unscoped select read 0",
        },
      ]);
    } else {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.business_id', $1, true)`, [scopedBusinessId]);
        const breakdown = await client.query(
          `SELECT status,
                  count(*)::int AS n,
                  min(scheduled_at) AS earliest,
                  max(scheduled_at) AS latest
             FROM appointments
            GROUP BY status
            ORDER BY n DESC`
        );
        show("appointments by status", breakdown.rows);
        const rows = await client.query(
          `SELECT right(id::text, 6) AS id_tail,
                  scheduled_at,
                  status,
                  created_at,
                  call_id IS NOT NULL AS from_call,
                  (notes IS NOT NULL AND notes <> '') AS has_notes
             FROM appointments
            ORDER BY scheduled_at DESC
            LIMIT $1`,
          [CALLS_LIMIT]
        );
        show("appointments", rows.rows);
        await client.query("COMMIT");
      } catch (err) {
        show("appointments", [{ error: err?.message }]);
      } finally {
        client.release();
      }
    }
  }

  // ---------------------------------------------------------------------
  // --calls: one line of METADATA per call. No message text, ever.
  //
  // `--counts` answers "is anything being written". It cannot answer the
  // question that actually came up: nine production calls logged
  // call_ended_status_callback reading "completed", and the dashboard showed
  // them still in-progress with no duration. A count of `calls` is the same
  // number either way.
  //
  // What discriminates is per-row: status, ended_at, duration_seconds, and
  // whether a summary was ever written. None of that is content -- it is the
  // shape of the row, not a word anyone said -- so it sits on the safe side of
  // the line this file draws at the top, alongside --counts and --business.
  //
  // The SID is truncated to its last six characters. That is enough to join a
  // row to a log line and not enough to be a handle on the call elsewhere.
  // ---------------------------------------------------------------------
  if (WANT_CALLS) {
    if (!scopedBusinessId) {
      show("calls", [
        {
          skipped: "calls need a tenant to scope to",
          hint: "pass --business <e164> as well; RLS makes an unscoped select read 0",
        },
      ]);
    } else {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.business_id', $1, true)`, [scopedBusinessId]);
        const rows = await client.query(
          `SELECT right(twilio_call_sid, 6) AS sid_tail,
                  status,
                  started_at,
                  ended_at,
                  duration_seconds,
                  (summary IS NOT NULL AND summary <> '') AS has_summary,
                  sentiment IS NOT NULL AS has_sentiment,
                  (SELECT count(*)::int FROM call_transcripts t WHERE t.call_id = c.id) AS transcript_rows
             FROM calls c
            ORDER BY started_at DESC
            LIMIT $1`,
          [CALLS_LIMIT]
        );
        show("calls", rows.rows);
        // The single number the whole investigation turned on, said plainly so
        // it does not have to be counted by eye across twenty log lines.
        const stuck = rows.rows.filter((r) => r.ended_at === null).length;
        show("calls summary", [
          {
            listed: rows.rows.length,
            never_completed: stuck,
            note:
              "never_completed counts rows with a null ended_at. A local harness run leaves one " +
              "legitimately -- it is not Twilio and sends no status callback.",
          },
        ]);
        await client.query("COMMIT");
      } catch (err) {
        show("calls", [{ error: err?.message }]);
      } finally {
        client.release();
      }
    }
  }

  // The full audit prints caller speech and is staging-only. Everything above
  // this line is config and numbers, and runs anywhere.
  if (!AD_HOC) {

  // THE QUESTION THIS WAS BUILT FOR. Postgres requires you to HAVE bypassrls
  // (or be superuser) in order to CREATE a role that has it. If the connecting
  // role has neither, a "give the bootstrap functions a BYPASSRLS owner" fix is
  // simply unavailable on Cloud SQL and the design has to avoid bypassing at all.
  show(
    "role attributes of the connecting user",
    (
      await pool.query(
        `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole
           FROM pg_roles WHERE rolname = current_user`
      )
    ).rows
  );

  show(
    "roles that CAN bypass row-level security",
    (await pool.query(`SELECT rolname FROM pg_roles WHERE rolbypassrls OR rolsuper ORDER BY rolname`)).rows
  );

  show(
    "owners of the bootstrap functions, and whether they bypass RLS",
    (
      await pool.query(
        `SELECT p.proname, r.rolname AS owner, r.rolsuper, r.rolbypassrls, p.prosecdef AS security_definer
           FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.proname IN ('app_lookup_business_by_phone','app_create_business_for_user','app_business_capabilities','app_lookup_user_by_auth_uid')
          ORDER BY p.proname`
      )
    ).rows
  );

  show(
    "tables with FORCE row level security",
    (
      await pool.query(
        `SELECT relname FROM pg_class
          WHERE relforcerowsecurity AND relkind = 'r' ORDER BY relname`
      )
    ).rows
  );

  // Proof of the live symptom, not an argument about it: does the read
  // bootstrap actually return the seeded business?
  show(
    "app_lookup_business_by_phone('+18176326969') with no tenant scope",
    (await pool.query(`SELECT count(*)::int AS rows_returned FROM app_lookup_business_by_phone('+18176326969')`)).rows
  );

  // And is the row really there, seen from a scope that can see it?
  const id = await pool.query(
    `SELECT id FROM businesses WHERE phone_number = '+18176326969'`
  );
  show("direct select on businesses (also RLS-bound, so 0 is expected)", [{ rows: id.rows.length }]);

  // ---------------------------------------------------------------------
  // What the receptionist actually HEARD.
  //
  // The question this exists to answer: a caller says "Nithin" and the bot
  // says "Nathan". Did speech-to-text mishear it, or did it hear correctly and
  // text-to-speech pronounce it wrong? Those are different subsystems with
  // different fixes, and no amount of listening distinguishes them — only the
  // stored transcript does.
  //
  // Scoped, because call_transcripts is under FORCE row-level security like
  // everything else. Unscoped this returns zero rows and looks like "no
  // transcripts exist".
  // ---------------------------------------------------------------------
  const biz = await pool.query(
    `SELECT id FROM app_lookup_business_by_phone('+18176326969')`
  );
  if (!biz.rows.length) {
    show("recent transcripts", []);
  } else {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.business_id', $1, true)`, [biz.rows[0].id]);
      const rows = await client.query(
        `SELECT c.started_at, t.speaker, t.message
           FROM call_transcripts t JOIN calls c ON c.id = t.call_id
          ORDER BY c.started_at DESC, t.sequence ASC
          LIMIT 40`
      );
      await client.query("COMMIT");
      show(
        "recent transcripts (newest call first)",
        rows.rows.map((r) => ({ speaker: r.speaker, message: r.message }))
      );
    } finally {
      client.release();
    }

    // ---------------------------------------------------------------------
    // O25 checkpoint 1: did the consent gate actually WRITE a row?
    //
    // Added 2026-08-23 after a pre-flight found this script could not answer
    // it. O25's four checkpoints are: a row in `sms_consents` carrying the
    // number, the call id, the script and its version; the log showing the
    // gate OPENED rather than `sms_followup_blocked_no_consent`; an ATTEMPTED
    // message in Twilio; and finally a text that arrives. Two and three are
    // readable from Cloud Logging and the Twilio console after the call — this
    // one was not readable at all, because nothing in the image queried the
    // table. Discovering that AFTER the test call would have wasted it, since
    // fixing it needs a rebuild, a tag bump and an apply.
    //
    // Scoped, like the transcripts above: `sms_consents` is under row-level
    // security, so an unscoped read returns zero rows and reads as "nobody ever
    // consented" rather than "you did not set a tenant".
    //
    // THE NUMBER IS MASKED TO ITS LAST FOUR. Enough to confirm the row is bound
    // to the caller who actually rang — which is the whole evidentiary point —
    // without putting a full phone number into Cloud Logging, where the rest of
    // this design deliberately keeps caller identifiers out of.
    const consentClient = await pool.connect();
    try {
      await consentClient.query("BEGIN");
      await consentClient.query(`SELECT set_config('app.business_id', $1, true)`, [biz.rows[0].id]);
      const consents = await consentClient.query(
        `SELECT created_at, right(phone_number, 4) AS number_last4, call_id,
                granted, script_version, source, left(script, 60) AS script_head
           FROM sms_consents
          ORDER BY created_at DESC
          LIMIT 10`
      );
      await consentClient.query("COMMIT");
      show("sms_consents (newest first) — O25 checkpoint 1", consents.rows);
    } catch (err) {
      // A missing table is a MIGRATION fact, not a crash. If 037 has not run on
      // this database, say so in the words that name the actual problem.
      await consentClient.query("ROLLBACK").catch(() => {});
      show("sms_consents", [
        {
          error: err?.message,
          hint: "42P01 here means migration 037 has not run on THIS database — check with --args=scripts/migrate.js,--status",
        },
      ]);
    } finally {
      consentClient.release();
    }
  }
  } // end: full audit, staging only
} catch (err) {
  console.error("inspect failed:", err?.message || err);
  process.exitCode = 1;
} finally {
  await pool.end();
  await close?.();
}
