#!/usr/bin/env node
/**
 * Push credential values from a local .env into Secret Manager.
 *
 *   node scripts/push-secrets.js --project vetra-us-staging-c3a3bd --dry-run
 *   node scripts/push-secrets.js --project vetra-us-staging-c3a3bd
 *
 * ---------------------------------------------------------------------------
 * Why a script instead of four copy-pastes
 * ---------------------------------------------------------------------------
 *
 * The values already exist in `.env`. Moving them by hand means each one passes
 * through a clipboard, a terminal, and shell history — and, if it happens in a
 * chat with an assistant, a transcript. None of those are places a Twilio auth
 * token should end up, and all of them outlive the paste.
 *
 * This reads the file, pipes each value to `gcloud` on stdin, and never prints
 * one. What it prints is names, lengths and outcomes, which is enough to tell a
 * success from a silent no-op and nothing more.
 *
 * ---------------------------------------------------------------------------
 * printf, not echo
 * ---------------------------------------------------------------------------
 *
 * Values go to gcloud via stdin with no trailing newline. `echo` would append
 * one and the newline would become part of the secret. This project has already
 * lost a day to exactly that: a leading newline in a Supabase cell made every
 * business answer as "our office", and the fix was invisible because the value
 * LOOKED right everywhere it was displayed.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";
const GCLOUD = IS_WINDOWS ? "gcloud.cmd" : "gcloud";
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/**
 * env var in .env  ->  secret name in Secret Manager.
 *
 * ELEVENLABS_API_KEY IS DELIBERATELY ABSENT. It is a UK-lane credential with no
 * BAA, the secret does not exist in any US project, and the entire US/UK split
 * exists so that it cannot. If it ever belongs somewhere, it belongs in a UK
 * project and this script should be told about it explicitly rather than
 * inheriting it from a shared .env.
 */
const MAPPING = Object.freeze({
  DEEPGRAM_API_KEY: "deepgram-api-key",
  TWILIO_ACCOUNT_SID: "twilio-account-sid",
  TWILIO_AUTH_TOKEN: "twilio-auth-token",
  SMTP_PASS: "smtp-password",
});

/** Minimal .env reader. Handles `KEY=value`, quotes, comments, blank lines. */
function readDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function parseArgs(argv) {
  let project = null;
  let dryRun = false;
  let envFile = path.join(ROOT, ".env");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1]) project = argv[++i];
    else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--env-file" && argv[i + 1]) envFile = argv[++i];
  }
  return { project, dryRun, envFile };
}

function main() {
  const { project, dryRun, envFile } = parseArgs(process.argv.slice(2));

  if (!project || !PROJECT_ID_RE.test(project)) {
    console.error("Usage: node scripts/push-secrets.js --project <gcp-project-id> [--dry-run] [--env-file PATH]");
    return 2;
  }

  const env = readDotEnv(envFile);
  console.log(`Reading ${path.relative(ROOT, envFile)}; target project ${project}`);
  if (dryRun) console.log("DRY RUN — nothing will be written.\n");

  const plan = [];
  const missing = [];

  for (const [envVar, secret] of Object.entries(MAPPING)) {
    const value = env[envVar];
    if (!value) {
      missing.push(`${envVar} -> ${secret}`);
      continue;
    }
    // Length and a masked shape, never the value. Enough to notice a truncated
    // paste or a placeholder; useless to anyone reading over a shoulder.
    plan.push({ envVar, secret, value, length: value.length });
  }

  for (const p of plan) console.log(`  ${p.envVar.padEnd(20)} -> ${p.secret.padEnd(20)} ${p.length} chars`);
  for (const m of missing) console.log(`  SKIP (not set in .env): ${m}`);

  if (!plan.length) {
    console.error("\nNothing to push.");
    return 1;
  }

  // A trailing newline or space in a .env value is invisible everywhere it is
  // displayed and breaks everything downstream. Refused rather than trimmed:
  // trimming would hide a defect in the source file that will be pasted
  // somewhere else next time.
  const dirty = plan.filter((p) => p.value !== p.value.trim());
  if (dirty.length) {
    console.error(
      `\nRefusing: ${dirty.map((d) => d.envVar).join(", ")} has leading or trailing whitespace in .env. ` +
        "Fix the source file — a stray newline in a credential is invisible and this project has lost a day to one."
    );
    return 1;
  }

  if (dryRun) {
    console.log("\nDry run complete.");
    return 0;
  }

  let failed = 0;
  for (const p of plan) {
    try {
      execFileSync(
        GCLOUD,
        ["secrets", "versions", "add", p.secret, `--project=${project}`, "--data-file=-", "--quiet"],
        {
          // The value goes in on stdin with NO trailing newline, so nothing can
          // append one on the way.
          input: p.value,
          stdio: ["pipe", "pipe", "pipe"],
          shell: IS_WINDOWS,
          env: process.env,
        }
      );
      console.log(`  added version: ${p.secret}`);
    } catch (err) {
      failed++;
      const stderr = String(err.stderr || err.message || "").split("\n").slice(0, 3).join(" ");
      console.error(`  FAILED ${p.secret}: ${stderr}`);
    }
  }

  if (failed) {
    console.error(`\n${failed} secret(s) failed.`);
    return 1;
  }

  console.log(
    "\nDone. Next:\n" +
      "  cd infra/terraform && terraform apply -var='wire_runtime_secrets=true'\n" +
      "\nAnd set staging_caller_allowlist to the number you will test from — staging\n" +
      "refuses every caller until you do, which is deliberate."
  );
  return 0;
}

process.exit(main());
