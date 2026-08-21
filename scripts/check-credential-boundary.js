#!/usr/bin/env node
/**
 * CI gate: no non-covered vendor credential may exist in a PHI project.
 *
 *   node scripts/check-credential-boundary.js --project vetra-us-prod-xxxxxx
 *
 * Exit codes, and the difference between them is the whole design:
 *
 *   0  checked, and the boundary holds
 *   1  checked, and a forbidden secret EXISTS. Fail the deploy.
 *   2  COULD NOT CHECK. Also fails the deploy.
 *
 * Exit 2 matters. "I could not verify" must never render as "verified" — that
 * is the silent-failure class this codebase treats as a defect rather than a
 * nuisance. A missing gcloud, an expired credential or an unreadable project
 * all land here, loudly, instead of quietly passing.
 *
 * ---------------------------------------------------------------------------
 * Why project IDs are not hardcoded
 * ---------------------------------------------------------------------------
 *
 * This repository is public. The project IDs are identifiers rather than
 * credentials, but there is no reason to publish a map of the account, which is
 * why terraform.tfvars is gitignored. So: pass --project, set
 * VETRA_PHI_PROJECTS, or let this read the gitignored tfvars.
 *
 * ---------------------------------------------------------------------------
 * Secret Manager not enabled == zero secrets == PASS
 * ---------------------------------------------------------------------------
 *
 * That is a real pass and not a skip. If the API is off, no secret of any name
 * exists in the project, which is exactly the property being asserted. It is
 * reported explicitly rather than folded into a silent success.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { findForbiddenSecrets, FORBIDDEN_IN_PHI_PROJECTS } from "../lib/credentialBoundary.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Windows needs both halves of this and neither is obvious.
//
// The SDK installs `gcloud.cmd`, and execFileSync does not apply PATHEXT to a
// bare name — `gcloud` is ENOENT. Naming the `.cmd` directly then hits the
// other wall: since the CVE-2024-27980 fix, Node refuses to execFile a .cmd or
// .bat without a shell, and returns EINVAL. So Windows takes the shell path.
//
// Both failures surface as "could not verify", which fails the deploy — safe,
// but it would fail it on every developer machine for a reason that has nothing
// to do with the boundary. CI is Linux; the person running this before pushing
// is not.
const IS_WINDOWS = process.platform === "win32";
const GCLOUD = IS_WINDOWS ? "gcloud.cmd" : "gcloud";

// Going through a shell means the project ID is interpolated into a command
// line, so it is validated first — against Google's actual project-ID grammar,
// which is narrow enough that anything passing it is inert in a shell.
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_UNVERIFIED = 2;

function parseArgs(argv) {
  const projects = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1]) projects.push(argv[++i]);
  }
  return { projects };
}

/**
 * Project IDs, in precedence order: flag, env, gitignored tfvars.
 *
 * ONLY THE US LANE. This is the part that is easy to get backwards, and getting
 * it backwards fails the deploy on a correct configuration:
 *
 *   us-prod     must NOT hold an ElevenLabs key. HIPAA, no BAA. Checked.
 *   uk-prod     KEEPS ElevenLabs and Deepgram — settled 2026-08-19. GDPR has no
 *               covered-products restriction and an Art. 28 DPA suffices. NOT
 *               checked, and checking it would be a bug.
 *   *-staging   holds both credential sets by design under the 4-project merge.
 *               That is the documented cost of losing the rehearsal, which is
 *               why this check on production exists at all.
 *
 * So the fallback selects the `us-prod` key specifically, not everything ending
 * in `-prod`.
 */
const US_PROD_KEY = "us-prod";

/**
 * `name = "value"` at the top level of a tfvars file.
 *
 * Parsed line by line rather than with a built RegExp. The first version built
 * the pattern inside a template literal, where `\s` is not an escape sequence
 * and JS silently collapses it to a bare `s` — so the pattern became
 * `^s*project_id_suffixs*=...` and matched nothing, forever, with no error.
 */
function tfvar(src, name) {
  for (const line of src.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(name)) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0 || trimmed.slice(0, eq).trim() !== name) continue;
    const value = trimmed.slice(eq + 1).trim();
    const quoted = value.match(/^"([^"]*)"/);
    if (quoted) return quoted[1];
  }
  return null;
}

function resolveProjects(flagProjects) {
  if (flagProjects.length) return { projects: flagProjects, source: "--project" };

  const fromEnv = (process.env.VETRA_PHI_PROJECTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length) return { projects: fromEnv, source: "VETRA_PHI_PROJECTS" };

  // Composed from the two tfvars values that are PERMANENT, rather than read
  // from a list that is not.
  //
  // The first version of this read `adopt_existing_projects`, which was the
  // only place mapping a project key to a real ID — and whose whole documented
  // lifecycle is "empty it once the adoption apply has succeeded". Emptying it
  // turned this gate into exit 2 on every run. It failed SAFE, which is the
  // only reason that was a bug and not an outage, but a gate that breaks when
  // an unrelated variable is tidied up is a gate that gets switched off.
  //
  // `project_prefix` and `project_id_suffix` are both immutable facts about the
  // account: a project ID cannot change, so neither can they.
  const tfvarsPath = path.join(ROOT, "infra", "terraform", "terraform.tfvars");
  if (fs.existsSync(tfvarsPath)) {
    const src = fs.readFileSync(tfvarsPath, "utf8");
    const prefix = tfvar(src, "project_prefix") || "vetra";
    const suffix = tfvar(src, "project_id_suffix");
    if (suffix) {
      return { projects: [`${prefix}-${US_PROD_KEY}-${suffix}`], source: "infra/terraform/terraform.tfvars" };
    }
  }

  return { projects: [], source: null };
}

/**
 * @returns {{ names: string[] } | { unavailable: string } | { apiDisabled: true }}
 */
function listSecrets(projectId) {
  if (!PROJECT_ID_RE.test(projectId)) {
    return { unavailable: `"${projectId}" is not a valid GCP project ID. Refusing to shell out with it.` };
  }

  try {
    const out = execFileSync(
      GCLOUD,
      ["secrets", "list", `--project=${projectId}`, "--format=value(name)", "--quiet"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: IS_WINDOWS,
        // The VetraTD identity is isolated from the workstation's default
        // gcloud config on purpose. Inherit CLOUDSDK_CONFIG rather than setting
        // it — in CI there is one identity and no such directory.
        env: process.env,
      }
    );
    return { names: out.split("\n").map((s) => s.trim()).filter(Boolean) };
  } catch (err) {
    const stderr = String(err.stderr || err.message || "");
    if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(stderr)) {
      return { apiDisabled: true };
    }
    return { unavailable: stderr.split("\n").slice(0, 4).join("\n").trim() || "gcloud failed with no output" };
  }
}

function main() {
  const { projects: flagProjects } = parseArgs(process.argv.slice(2));
  const { projects, source } = resolveProjects(flagProjects);

  console.log("Credential boundary check");
  console.log(`  Rules: ${FORBIDDEN_IN_PHI_PROJECTS.map((r) => r.vendor).join(", ")}`);

  if (!projects.length) {
    console.error(
      "\nCOULD NOT CHECK: no PHI project named.\n" +
        "  Pass --project <id>, set VETRA_PHI_PROJECTS, or provide infra/terraform/terraform.tfvars.\n" +
        "  Not naming a project is not the same as the boundary holding."
    );
    return EXIT_UNVERIFIED;
  }

  console.log(`  Projects (${source}): ${projects.join(", ")}\n`);

  let unverified = 0;
  const violations = [];

  for (const projectId of projects) {
    const result = listSecrets(projectId);

    if (result.apiDisabled) {
      console.log(`  ${projectId}: Secret Manager not enabled — zero secrets exist. PASS.`);
      continue;
    }

    if (result.unavailable) {
      console.error(`  ${projectId}: COULD NOT LIST SECRETS\n${result.unavailable.replace(/^/gm, "      ")}`);
      unverified++;
      continue;
    }

    const found = findForbiddenSecrets(result.names);
    console.log(`  ${projectId}: ${result.names.length} secret(s), ${found.length} forbidden.`);
    for (const v of found) violations.push({ projectId, ...v });
  }

  if (violations.length) {
    console.error("\nBOUNDARY VIOLATED. This deploy must not proceed.\n");
    for (const v of violations) {
      console.error(`  ${v.projectId} holds "${v.secret}" — ${v.vendor}`);
      console.error(`    ${v.why}\n`);
    }
    console.error(
      "  Delete the secret from this project. Do not add an exception here:\n" +
        "  the project is the boundary, and a project that never held the key has nothing to leak."
    );
    return EXIT_VIOLATION;
  }

  if (unverified) {
    console.error(`\nCOULD NOT CHECK ${unverified} project(s). Failing — unverified is not verified.`);
    return EXIT_UNVERIFIED;
  }

  console.log("\nBoundary holds.");
  return EXIT_OK;
}

process.exit(main());
