#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Hammersleys round 4 (item 6): the Deepgram-vs-Live hard-word table for ONE
// call, read from inside the VPC like db-inspect:
//
//   gcloud run jobs execute vetra-migrate-uk-prod \
//     --args=scripts/shadow-compare.js,--business,<uuid>,--call,<CA...>,--words,"Plaistow Street|Lingfield|half eight"
//
// STRICTLY READ-ONLY (one transaction, rolled back). Tenant-scoped (RLS:
// app.business_id), so a wrong --business reads nothing. Prints ONLY, per hard
// word, whether each transcript heard it, its nearest same-length run of words
// and when Deepgram's segment holding it arrived (ms since the shadow stream
// started) -- never the rest of what the caller said. Meant for the owner's own
// test calls; delete the execution afterwards like an import's.
//
// Import-safe (main guard below): the image's smoke-verifiers step imports it.
// ---------------------------------------------------------------------------
import pg from "pg";
import { pathToFileURL } from "node:url";
import { cloudSqlPoolConfig } from "../lib/db/cloudSqlPool.js";
import { hardWordTable } from "../lib/voice/shadowCompare.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(argv) {
  const argOf = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
  };
  const BUSINESS = argOf("business");
  const CALL = argOf("call");
  const WORDS = (argOf("words") || "").split("|").map((w) => w.trim()).filter(Boolean);

  if (!BUSINESS || !UUID.test(BUSINESS) || !CALL || !/^CA[0-9A-Za-z_]{6,40}$/.test(CALL) || WORDS.length === 0) {
    console.error('usage: shadow-compare.js --business <uuid> --call <CA...> --words "word one|word two"');
    return 2;
  }

  const pool = process.env.DATABASE_URL
    ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
    : new pg.Pool(
        (
          await cloudSqlPoolConfig(
            {
              instance: process.env.CLOUD_SQL_INSTANCE,
              database: process.env.CLOUD_SQL_DATABASE,
              user: process.env.CLOUD_SQL_IAM_USER,
              password: process.env.CLOUD_SQL_PASSWORD,
              authType: process.env.CLOUD_SQL_PASSWORD ? "PASSWORD" : "IAM",
            },
            { connectionTimeoutMillis: 10_000 }
          )
        ).poolConfig
      );

  const line = (o) => console.log(JSON.stringify(o));
  let code = 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SELECT set_config('app.business_id', $1, true)`, [BUSINESS]);
    const call = await client.query(
      `SELECT id, answers->'_shadow_stt' AS shadow FROM calls WHERE twilio_call_sid = $1 AND business_id = $2`,
      [CALL, BUSINESS]
    );
    if (!call.rows.length) {
      line({ shadow_compare: "no such call for this business", call: CALL.slice(-6) });
      code = 1;
    } else {
      const { id, shadow } = call.rows[0];
      const rows = await client.query(
        `SELECT speaker, message FROM call_transcripts WHERE call_id = $1 ORDER BY sequence`,
        [id]
      );
      const live = rows.rows.filter((r) => r.speaker !== "ai").map((r) => r.message || "").join(" ");
      const segments = Array.isArray(shadow?.segments) ? shadow.segments : [];
      line({
        shadow_compare: "call",
        call: CALL.slice(-6),
        live_caller_rows: rows.rows.filter((r) => r.speaker !== "ai").length,
        deepgram_segments: segments.length,
        deepgram_frames_sent: shadow?.frames_sent ?? null,
        deepgram_error: shadow?.error ?? null,
      });
      for (const r of hardWordTable({ live, segments, words: WORDS })) line({ shadow_compare: "word", ...r });
    }
    await client.query("ROLLBACK");
  } catch (err) {
    line({ shadow_compare: "error", reason: err?.message });
    code = 1;
    await client.query("ROLLBACK").catch(() => {});
  } finally {
    client.release();
    await pool.end();
  }
  return code;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`shadow-compare failed: ${e.message}`);
      process.exit(1);
    });
}
