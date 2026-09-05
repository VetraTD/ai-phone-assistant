#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Point +441372656055 at a test rig, and put it back — with the read-back that
// the last restore did not actually do.
//
// ---------------------------------------------------------------------------
// Why this is a script and not two lines of node -e
// ---------------------------------------------------------------------------
//
// docs/live-frontend-RESTORE.md carries a correction against itself. On
// 2026-09-03 the American test number was recorded as restored "field-for-field"
// to a captured voiceUrl of /twilio/voice. Re-reading it a day later returned
// /twilio/live-voice. Nothing was visibly broken — the host was alive — so the
// error survived a week, during which `npm run probe` dialled the Live front-end
// while reporting its numbers as cascade numbers.
//
// The lesson recorded there is exact: "Reading a number back is not enough on
// its own if the read-back is only glanced at." A human comparing four URLs by
// eye, at the end of a long session, having just been told it worked, is the
// step that failed. So the comparison is done by the machine, field by field,
// and a mismatch is a non-zero exit rather than a line of output to scan past.
//
// This is a real line that people ring — Digile Media's, the demo a friend
// dials. The window it is pointed elsewhere should be minutes.
//
//   node scripts/uk-number.js show
//   node scripts/uk-number.js point https://<tunnel>.trycloudflare.com --confirm
//   node scripts/uk-number.js restore --confirm
//
// Credentials come from Twilio ACCOUNT A, which owns this number. They are not
// in .env — they live in GCP Secret Manager, and the two variables below are
// expected to be exported by the caller:
//
//   export CLOUDSDK_CONFIG=~/.gcloud-vetra2
//   export TWA_SID=$(gcloud secrets versions access latest \
//     --secret=twilio-account-sid --project=vetra-uk-edc8ca)
//   export TWA_TOK=$(gcloud secrets versions access latest \
//     --secret=twilio-auth-token --project=vetra-uk-edc8ca)
// ---------------------------------------------------------------------------
import twilio from "twilio";

const NUMBER = "+441372656055";

// The captured state, from docs/live-frontend-RESTORE.md section 3, read live
// from Twilio on 2026-09-05 BEFORE anything was changed. Hard-coded on purpose:
// a restore that reads its target from the same place it might have been
// corrupted is not a restore.
const CAPTURED = {
  sid: "PN143d2a428a1d27c601c0419f83309a2a",
  voiceUrl: "https://voice-uk-prod-462445274080.europe-west2.run.app/twilio/voice",
  voiceMethod: "POST",
  statusCallback: "https://voice-uk-prod-462445274080.europe-west2.run.app/twilio/status",
  statusCallbackMethod: "POST",
};

// Every field compared on the way back. voiceApplicationSid is included because
// a non-empty one silently overrides voiceUrl, so "voiceUrl is correct" is not
// on its own a statement that the number will reach the right place.
const FIELDS = ["voiceUrl", "voiceMethod", "statusCallback", "statusCallbackMethod", "voiceApplicationSid"];

function client() {
  const sid = process.env.TWA_SID;
  const tok = process.env.TWA_TOK;
  if (!sid || !tok) {
    console.error(
      "\n  TWA_SID / TWA_TOK are not set. This number is on Twilio ACCOUNT A, whose\n" +
        "  token is in GCP Secret Manager and deliberately not in .env. See the\n" +
        "  header of this file for the two commands that export them.\n"
    );
    process.exit(1);
  }
  if (!sid.startsWith("AC1828")) {
    // The single most expensive mistake available here. Account B's credentials
    // are in .env and are the ones already loaded in most shells; used against
    // this number they do not fail loudly, they simply do not find it, which
    // reads as "the number does not exist".
    console.error(`\n  Refusing: TWA_SID is ${sid.slice(0, 6)}..., which is not account A (AC1828...).`);
    console.error("  A number on the wrong account 403s every webhook, and reads as a broken endpoint.\n");
    process.exit(1);
  }
  return twilio(sid, tok);
}

async function read(c) {
  const found = await c.incomingPhoneNumbers.list({ phoneNumber: NUMBER });
  if (!found.length) {
    console.error(`\n  ${NUMBER} was not found on this account.\n`);
    process.exit(1);
  }
  return found[0];
}

function print(n, label) {
  console.log(`\n  ${label}`);
  console.log(`    sid                   ${n.sid}`);
  for (const f of FIELDS) console.log(`    ${f.padEnd(22)}${n[f] || "(empty)"}`);
}

/** Compare one field at a time and say which one is wrong. */
function verify(n, expected) {
  let ok = true;
  console.log("\n  Field-by-field check:");
  for (const f of FIELDS) {
    const want = expected[f] ?? "";
    const got = n[f] ?? "";
    const match = want === got;
    if (!match) ok = false;
    console.log(`    ${match ? "OK  " : "BAD "} ${f.padEnd(22)}${match ? got || "(empty)" : `expected ${want || "(empty)"}, got ${got || "(empty)"}`}`);
  }
  return ok;
}

const [action, ...rest] = process.argv.slice(2);
const confirmed = rest.includes("--confirm");
const c = client();

if (action === "show") {
  print(await read(c), `${NUMBER} — live from Twilio`);
  console.log("");
} else if (action === "point") {
  const base = rest.find((a) => a.startsWith("http"));
  if (!base) {
    console.error("\n  Usage: uk-number.js point https://<tunnel>.trycloudflare.com --confirm\n");
    process.exit(1);
  }
  const target = {
    voiceUrl: `${base.replace(/\/$/, "")}/twilio/live-voice`,
    voiceMethod: "POST",
    // DELIBERATELY LEFT AS CAPTURED. /twilio/status is mounted behind the
    // single-token twilioValidation, so an account-A signature fails there and
    // Twilio's end-of-call report gets a 403. That is LVX14's shape, it is
    // accepted for this demo, and it costs nothing a Live call was using: the
    // Live front-end never files a call record anyway (LVX30). Pointing it at
    // the tunnel instead would 403 identically and add a field to restore.
    statusCallback: CAPTURED.statusCallback,
    statusCallbackMethod: CAPTURED.statusCallbackMethod,
  };
  print(await read(c), "BEFORE");
  console.log("\n  Will set:");
  for (const [k, v] of Object.entries(target)) console.log(`    ${k.padEnd(22)}${v}`);
  if (!confirmed) {
    console.log("\n  Not changed. Re-run with --confirm.\n");
    process.exit(0);
  }
  await c.incomingPhoneNumbers(CAPTURED.sid).update(target);
  const after = await read(c);
  print(after, "AFTER");
  const ok = verify(after, { ...target, voiceApplicationSid: "" });
  console.log(
    ok
      ? "\n  Pointed at the rig. RESTORE AS SOON AS THE CALL IS DONE:\n    node scripts/uk-number.js restore --confirm\n"
      : "\n  MISMATCH — the number is not where it should be. Do not call yet.\n"
  );
  process.exitCode = ok ? 0 : 1;
} else if (action === "restore") {
  print(await read(c), "BEFORE");
  console.log("\n  Will restore to the captured GCP values.");
  if (!confirmed) {
    console.log("\n  Not changed. Re-run with --confirm.\n");
    process.exit(0);
  }
  await c.incomingPhoneNumbers(CAPTURED.sid).update({
    voiceUrl: CAPTURED.voiceUrl,
    voiceMethod: CAPTURED.voiceMethod,
    statusCallback: CAPTURED.statusCallback,
    statusCallbackMethod: CAPTURED.statusCallbackMethod,
  });
  const after = await read(c);
  print(after, "AFTER");
  const ok = verify(after, { ...CAPTURED, voiceApplicationSid: "" });
  console.log(
    ok
      ? "\n  RESTORED and verified field by field. The number is back on GCP.\n"
      : "\n  NOT RESTORED. Fix the fields listed above before walking away.\n"
  );
  process.exitCode = ok ? 0 : 1;
} else {
  console.log("\n  Usage:\n    uk-number.js show\n    uk-number.js point https://<tunnel> --confirm\n    uk-number.js restore --confirm\n");
}
