#!/usr/bin/env node
/**
 * P26 — take a restored Cloud SQL clone and put it back into SERVICE.
 *
 *   node scripts/restore-drill.js --status
 *   node scripts/restore-drill.js --repoint <clone-instance> [--confirm]
 *   node scripts/restore-drill.js --rollback [--confirm]
 *
 * DRY RUN unless --confirm. Every mutating step prints the exact gcloud command
 * it would run.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Phase 5 Gate 9a measured the half that works: a PITR clone takes 591s, carries
 * all migrations and the tenant row, and matches the source on tier, region,
 * CMEK key, private-IP-only and backup configuration.
 *
 * It lands with a DIFFERENT NAME, a different private IP, a different zone
 * (europe-west2-a -> -c), a fresh server CA, and it is NOT IN tfstate. So the
 * data is back and nothing is serving it. Recovery means repointing
 * CLOUD_SQL_INSTANCE on two Cloud Run services AND the migrate job, then
 * reconciling Terraform state — and until now nothing in this repository
 * documented any of that. An untested recovery path is not a recovery path.
 *
 * ---------------------------------------------------------------------------
 * WHY gcloud AND NOT TERRAFORM, WHICH IS THE WHOLE POINT
 *
 * Recovery has to be FAST and must not depend on the state file being healthy —
 * losing the database and needing a clean plan in the same hour is not a
 * recovery story. So this drives `gcloud run services update`: one API call per
 * workload, reversible in seconds.
 *
 * That deliberately puts the estate out of sync with Terraform. Said out loud
 * rather than hidden: after a real recovery somebody must reconcile state (see
 * docs/runbooks/restore-drill.md, "Afterwards"). Importing a clone into state
 * mid-incident is slower and riskier than fixing state the next morning.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS WILL NOT DO
 *
 * It will not create, delete or promote a Cloud SQL instance, and it will not
 * touch Twilio. Creating the clone is `gcloud sql instances clone`, left manual
 * because that is the step where a typo costs an hour. This script only moves
 * the pointer, which is the part that was never written down.
 * ---------------------------------------------------------------------------
 */

import { execFileSync } from "node:child_process";

const PROJECT = process.env.VETRA_PROJECT || "vetra-uk-edc8ca";
const REGION = process.env.VETRA_REGION || "europe-west2";

// The three workloads that hold a database pointer. The migrate JOB matters as
// much as the services: leaving it on the old instance means the next deploy
// migrates the database nobody is serving.
const WORKLOADS = [
  { kind: "service", name: "voice-uk-prod" },
  { kind: "service", name: "dashboard-api-uk-prod" },
  { kind: "job", name: "vetra-migrate-uk-prod" },
];

const ENV_VAR = "CLOUD_SQL_INSTANCE";

function usage(msg) {
  if (msg) console.error("\n" + msg);
  console.error(
    "\nusage:\n" +
      "  node scripts/restore-drill.js --status\n" +
      "  node scripts/restore-drill.js --repoint <clone-instance-name> [--confirm]\n" +
      "  node scripts/restore-drill.js --rollback [--confirm]\n\n" +
      "  project " + PROJECT + ", region " + REGION + " (override with VETRA_PROJECT / VETRA_REGION)\n" +
      "  --confirm    actually write. Without it, nothing is changed.\n"
  );
  process.exit(1);
}

// `gcloud` on Windows is a .cmd shim. execFileSync will not resolve PATHEXT
// (ENOENT) and will not execute a .cmd directly (EINVAL), so Windows needs
// shell: true — which means the arguments are shell-interpreted, so they must
// be constrained. See assertSafe.
const WIN = process.platform === "win32";
const GCLOUD = WIN ? "gcloud.cmd" : "gcloud";

/**
 * Refuse anything that could change the meaning of a shell command line.
 *
 * Only the clone's instance name arrives from outside this file, and Cloud SQL
 * instance ids are [a-z][a-z0-9-]* anyway — so this rejects nothing legitimate.
 * Worth doing regardless: the one operator-supplied string, on the one code
 * path that runs during an incident, is not where to discover that a stray
 * quote does something surprising.
 */
function assertSafe(value, what) {
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    console.error("\nrefusing " + what + ' "' + value + '": expected only letters, digits, dot, underscore, colon or hyphen.');
    process.exit(1);
  }
  return value;
}

function run(args) {
  return execFileSync(GCLOUD, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: WIN,
  });
}

/** Read one workload's current CLOUD_SQL_INSTANCE. */
function readPointer(w) {
  const path =
    w.kind === "service"
      ? "spec.template.spec.containers[0].env"
      : "spec.template.spec.template.spec.containers[0].env";
  // Quoted: under shell: true an unquoted format string containing parentheses
  // and double quotes is re-parsed by cmd.exe and arrives mangled.
  const inner = "value(" + path + ".filter(\\\"name:" + ENV_VAR + "\\\").extract(value))";
  const fmt = WIN ? '"' + inner + '"' : inner.replace(/\\"/g, '"');
  const noun = w.kind === "service" ? "services" : "jobs";
  try {
    const out = run([
      "run", noun, "describe", w.name,
      "--region=" + REGION,
      "--project=" + PROJECT,
      "--format=" + fmt,
    ]);
    const cleaned = out.trim().replace(/^\[/, "").replace(/\]$/, "").replace(/'/g, "");
    return cleaned || "(unset)";
  } catch (err) {
    const first = String(err.stderr || err.message).trim().split("\n")[0];
    return "(unreadable: " + first + ")";
  }
}

function status() {
  console.log("\nproject " + PROJECT + " - region " + REGION + "\n");
  const seen = new Set();
  for (const w of WORKLOADS) {
    const v = readPointer(w);
    seen.add(v);
    console.log("  " + w.kind.padEnd(8) + " " + w.name.padEnd(26) + " " + ENV_VAR + "=" + v);
  }
  console.log("");
  // Three identical ERRORS are not three agreeing workloads. Checked before the
  // agreement branch, because "all three agree" printed over a total failure to
  // reach the API is exactly the reassuring-but-false output this script exists
  // to avoid during an incident.
  const unreadable = [...seen].filter((v) => v.startsWith("(unreadable"));
  if (unreadable.length) {
    console.log("  COULD NOT READ the current pointer. This is not a clean state - it is no");
    console.log("  information at all. Check gcloud auth and CLOUDSDK_CONFIG before going on.");
    return [...seen];
  }
  if (seen.size > 1) {
    console.log("  WARNING: THE THREE WORKLOADS DISAGREE. A half-finished repoint is worse than");
    console.log("  either end state - the services and the migrate job are on different databases.");
  } else {
    console.log("  all three agree.");
  }
  return [...seen];
}

/** The update command for one workload. Printed in dry run, executed on --confirm. */
function repointCmd(w, instance) {
  const noun = w.kind === "service" ? "services" : "jobs";
  return [
    "run", noun, "update", w.name,
    "--region=" + REGION,
    "--project=" + PROJECT,
    "--update-env-vars=" + ENV_VAR + "=" + instance,
  ];
}

function repoint(instance, confirm) {
  console.log("\n=== BEFORE ===");
  const before = status();

  if (before.length === 1 && before[0] === instance) {
    console.log("\nAlready pointed at " + instance + ". Nothing to do.");
    return;
  }

  console.log("\n=== REPOINT -> " + instance + " ===\n");
  for (const w of WORKLOADS) {
    const cmd = repointCmd(w, instance);
    console.log("  " + (confirm ? "running" : "would run") + ": gcloud " + cmd.join(" "));
    if (!confirm) continue;
    try {
      run(cmd);
      console.log("    ok");
    } catch (err) {
      // Deliberately do NOT continue. A partial repoint splits the estate across
      // two databases, which is worse than either end state, and the operator
      // needs to know exactly where it stopped.
      const first = String(err.stderr || err.message).trim().split("\n")[0];
      console.error("    FAILED: " + first);
      console.error(
        "\n  STOPPED after " + w.name + ". The estate is now SPLIT. Re-run --repoint with\n" +
          "  the same argument to finish, or --rollback to go back."
      );
      process.exitCode = 1;
      return;
    }
  }

  if (!confirm) {
    console.log("\nDRY RUN - nothing changed. Re-run with --confirm.");
    return;
  }

  console.log("\n=== AFTER ===");
  const after = status();
  if (after.length !== 1 || after[0] !== instance) {
    console.error("\n  VERIFY FAILED: expected all three on " + instance + ".");
    process.exitCode = 1;
    return;
  }
  console.log(
    "\nDone. TERRAFORM STATE IS NOW STALE - see docs/runbooks/restore-drill.md,\n" +
      '"Afterwards". Do not run terraform apply until it is reconciled.'
  );
}

const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args.includes("-h")) usage();
const confirm = args.includes("--confirm");

if (args.includes("--status")) {
  status();
} else if (args.includes("--repoint")) {
  const instance = args[args.indexOf("--repoint") + 1];
  if (!instance || instance.startsWith("--")) usage("--repoint needs the clone's instance name.");
  repoint(assertSafe(instance, "instance name"), confirm);
} else if (args.includes("--rollback")) {
  const original = process.env.VETRA_SQL_INSTANCE_ORIGINAL;
  if (!original) {
    usage(
      "--rollback needs VETRA_SQL_INSTANCE_ORIGINAL set to the instance to go back to.\n" +
        "Deliberately not guessed: after a repoint nothing on the estate still records the\n" +
        "original name, and guessing it during an incident is how you point at the instance\n" +
        "you were recovering FROM."
    );
  }
  repoint(assertSafe(original, "VETRA_SQL_INSTANCE_ORIGINAL"), confirm);
} else {
  usage("unrecognised arguments: " + args.join(" "));
}
