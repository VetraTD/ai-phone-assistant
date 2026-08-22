#!/usr/bin/env node
/**
 * Push credential values from local env files into Secret Manager.
 *
 *   node scripts/push-secrets.js --project vetra-us-staging-c3a3bd --dry-run
 *   node scripts/push-secrets.js --project vetra-us-staging-c3a3bd \
 *     --from .env --from .env.staging
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
 * This reads the files, pipes each value to `gcloud` on stdin, and never prints
 * one. What it prints is names, lengths, provenance and outcomes: enough to
 * tell a success from a silent no-op, and nothing more.
 *
 * ---------------------------------------------------------------------------
 * Layering, and why it is the point
 * ---------------------------------------------------------------------------
 *
 * `--from` is repeatable and LATER FILES WIN. `.env` holds the production
 * Twilio credentials the live receptionist runs on; `.env.staging` layers a
 * subaccount SID and token on top while Deepgram and SMTP still come from the
 * base file.
 *
 * Maintaining a complete second env file instead would mean every value exists
 * twice, and the copy nobody edits is the one that goes stale and gets pushed.
 *
 * `--from`, not `--env-file`: Node 20.6+ has a BUILT-IN `--env-file` and claims
 * the argument before this script sees it. The failure is
 * `node.exe: .env.staging: not found`, which looks like a missing file and is a
 * flag collision.
 *
 * ---------------------------------------------------------------------------
 * No trailing newline, ever
 * ---------------------------------------------------------------------------
 *
 * Values go to gcloud on stdin with nothing appended. `echo` would add a
 * newline and the newline would become part of the secret. This project has
 * already lost a day to exactly that: a leading newline in a Supabase cell made
 * every business answer as "our office", and it was invisible because the value
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
 * env var  ->  secret name in Secret Manager.
 *
 * ELEVENLABS_API_KEY IS DELIBERATELY ABSENT. It is a UK-lane credential with no
 * BAA, the secret does not exist in any US project, and the entire US/UK split
 * exists so that it cannot. If it ever belongs somewhere it belongs in a UK
 * project, named explicitly, not inherited from a shared .env.
 */
const MAPPING = Object.freeze({
  DEEPGRAM_API_KEY: "deepgram-api-key",
  TWILIO_ACCOUNT_SID: "twilio-account-sid",
  TWILIO_AUTH_TOKEN: "twilio-auth-token",
  SMTP_PASS: "smtp-password",
});

/**
 * Shapes for the credentials whose format is documented and stable.
 *
 * The failure this catches is a template created and never filled in. Only
 * Twilio is checked strictly, because only Twilio publishes a format worth
 * relying on.
 */
const FORMATS = Object.freeze({
  TWILIO_ACCOUNT_SID: { re: /^AC[0-9a-f]{32}$/i, expected: "AC followed by 32 hex characters" },
  TWILIO_AUTH_TOKEN: { re: /^[0-9a-f]{32}$/i, expected: "32 hex characters" },
});

/** Words that only appear in a value nobody has replaced yet. */
const PLACEHOLDER_RE = /xxxx|changeme|placeholder|your[-_]?(sid|token|key|password)/i;

/** Minimal env reader. Handles `KEY=value`, quotes, comments, blank lines. */
function readEnvFile(file) {
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
  const from = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1]) project = argv[++i];
    else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--from" && argv[i + 1]) from.push(argv[++i]);
  }
  if (!from.length) from.push(path.join(ROOT, ".env"));
  return { project, dryRun, from };
}

const USAGE = [
  "Usage: node scripts/push-secrets.js --project <gcp-project-id> [--dry-run] [--from PATH]...",
  "",
  "--from is repeatable and later files win, which is how a staging subaccount",
  "overrides the production Twilio credentials in .env:",
  "  --from .env --from .env.staging",
].join("\n");

function main() {
  const { project, dryRun, from } = parseArgs(process.argv.slice(2));

  if (!project || !PROJECT_ID_RE.test(project)) {
    console.error(USAGE);
    return 2;
  }

  // Refused rather than skipped. A typo'd overlay path would silently fall back
  // to the base file, which here means pushing PRODUCTION Twilio credentials
  // into staging while every line of output looks entirely normal.
  const missingFiles = from.filter((f) => !fs.existsSync(f));
  if (missingFiles.length) {
    console.error(`No such env file: ${missingFiles.join(", ")}`);
    return 2;
  }

  // Later files win. `seen` tracks keys that APPEARED in some file whatever
  // their value, because `env` cannot tell an empty value from an absent one.
  const env = {};
  const source = {};
  const seen = {};
  for (const f of from) {
    for (const [k, v] of Object.entries(readEnvFile(f))) {
      seen[k] = true;
      env[k] = v;
      source[k] = path.basename(f);
    }
  }

  console.log(`Reading ${from.map((f) => path.relative(ROOT, f)).join(" then ")}; target project ${project}`);
  if (dryRun) console.log("DRY RUN - nothing will be written.");
  console.log("");

  const plan = [];
  const absent = [];
  for (const [envVar, secret] of Object.entries(MAPPING)) {
    const value = env[envVar];
    if (!value) {
      absent.push(envVar);
      continue;
    }
    plan.push({ envVar, secret, value, length: value.length, from: source[envVar] });
  }

  for (const p of plan) {
    const len = String(p.length).padStart(3);
    console.log(`  ${p.envVar.padEnd(20)} -> ${p.secret.padEnd(20)} ${len} chars   from ${p.from}`);
  }
  for (const a of absent) console.log(`  SKIP (not set in any --from file): ${a}`);

  // A key present-but-EMPTY in an overlay is the trap this script exists to
  // avoid. It contributes nothing, so the key is reported as "not set" and
  // skipped, which reads like a benign no-op and is not: whatever is already in
  // Secret Manager stays, and on staging that may be a production credential
  // pushed on an earlier run. An unedited template must fail, not quietly
  // change nothing.
  const emptyOverrides = Object.keys(MAPPING).filter((k) => seen[k] && !env[k]);
  if (emptyOverrides.length) {
    console.error("");
    console.error(`Refusing: ${emptyOverrides.join(", ")} appear in a --from file with an EMPTY value.`);
    console.error("  An empty override is not a no-op. The key is skipped, whatever is already in");
    console.error("  Secret Manager stays, and on staging that may be a production credential from");
    console.error("  an earlier run. Fill the value in, or delete the line to use the base file.");
    return 1;
  }

  if (!plan.length) {
    console.error("");
    console.error("Nothing to push.");
    return 1;
  }

  // Format, placeholder and whitespace checks run BEFORE the dry run reports
  // success. A dry run that passes on a placeholder taught you nothing.
  const rejected = [];
  for (const p of plan) {
    const fmt = FORMATS[p.envVar];
    if (fmt && !fmt.re.test(p.value)) {
      rejected.push(`${p.envVar} (from ${p.from}) is not ${fmt.expected}`);
    } else if (PLACEHOLDER_RE.test(p.value)) {
      rejected.push(`${p.envVar} (from ${p.from}) still looks like a placeholder`);
    }
    // Surrounding whitespace is REFUSED rather than trimmed. Trimming hides a
    // defect in the source file that gets pasted somewhere else next time.
    if (p.value !== p.value.trim()) {
      rejected.push(`${p.envVar} (from ${p.from}) has leading or trailing whitespace`);
    }
  }

  if (rejected.length) {
    console.error("");
    console.error("Refusing:");
    for (const r of rejected) console.error(`  ${r}`);
    return 1;
  }

  if (dryRun) {
    console.log("");
    console.log("Dry run complete.");
    return 0;
  }

  let failed = 0;
  for (const p of plan) {
    try {
      execFileSync(
        GCLOUD,
        ["secrets", "versions", "add", p.secret, `--project=${project}`, "--data-file=-", "--quiet"],
        { input: p.value, stdio: ["pipe", "pipe", "pipe"], shell: IS_WINDOWS, env: process.env }
      );
      console.log(`  added version: ${p.secret}`);
    } catch (err) {
      failed++;
      const stderr = String(err.stderr || err.message || "").split("\n").slice(0, 3).join(" ");
      console.error(`  FAILED ${p.secret}: ${stderr}`);
    }
  }

  if (failed) {
    console.error("");
    console.error(`${failed} secret(s) failed.`);
    return 1;
  }

  console.log("");
  console.log("Done. Next:");
  console.log("  cd infra/terraform");
  console.log("  terraform apply -var='wire_runtime_secrets=true' \\");
  console.log("                  -var='staging_caller_allowlist=[\"+1YOURNUMBER\"]'");
  console.log("");
  console.log("Staging refuses every caller until that list has a number in it.");
  return 0;
}

process.exit(main());
