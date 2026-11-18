#!/usr/bin/env node
/**
 * Publish a built static site to Firebase Hosting, through the REST API.
 *
 *   node AI-phone-dashboard/frontend/scripts/deploy-hosting.js \n *        --dir <built dir> [--site <id>] [--project <id>]
 *                                  [--config <firebase.json>] [--dry-run]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN `firebase deploy`
 * ---------------------------------------------------------------------------
 *
 * `firebase-tools` keeps its OWN credential store — the state written by
 * `firebase login`, in %APPDATA%/configstore/firebase-tools.json — and that
 * store takes precedence over GOOGLE_APPLICATION_CREDENTIALS. On the
 * workstation this was written on it was logged in as a PERSONAL Gmail
 * account, so `firebase deploy` authenticated as the wrong identity and failed
 * with
 *
 *   Failed to get Firebase project vetra-shared-c3a3bd. Please make sure the
 *   project exists and your account has permission to access it.
 *
 * which reads as "the project is missing" and is "you are signed in as
 * somebody else". The debug log is the only place the real cause appears:
 *
 *   > authorizing via signed-in user (nithinjd06@gmail.com)
 *
 * That is the third credential system on this machine, after gcloud's config
 * and ADC, and it is the second time a tool has silently run as the personal
 * identity — see the ledger's standing fact about Terraform and
 * CLOUDSDK_CONFIG. The REST API takes a bearer token we pass in explicitly, so
 * there is no store to be signed into and no identity to guess at.
 *
 * It also removes firebase-tools from the deploy path entirely, which matters
 * for Cloud Build: no CLI credential dance in a build step, and nothing to
 * install beyond what is already there.
 *
 * ---------------------------------------------------------------------------
 * THE TOKEN
 * ---------------------------------------------------------------------------
 *
 * Three sources, tried in order: HOSTING_TOKEN, the GCE metadata server (which
 * is how it authenticates inside Cloud Build, as the build's service account),
 * then `gcloud auth print-access-token` (the workstation path). The identity
 * must hold firebasehosting.* on the project — `roles/firebasehosting.admin`.
 * It is NOT a credential this script stores, writes or logs.
 *
 * The API also needs an x-goog-user-project header naming the quota project,
 * or every call returns a 403 whose text is about a missing quota project and
 * reads as a permissions problem. Same shape as Terraform's
 * user_project_override — see the ledger.
 *
 * ---------------------------------------------------------------------------
 * THE UPLOAD PROTOCOL, because it is not the obvious one
 * ---------------------------------------------------------------------------
 *
 * Hosting is content-addressed by the SHA256 OF THE GZIPPED BYTES, not of the
 * file. So each file is gzipped once, hashed, and the hash is what
 * :populateFiles is told about; the API then replies with only the hashes it
 * does not already hold, which is why a redeploy of an unchanged site uploads
 * nothing — measured: the second deploy of identical content reported "0 of 28
 * objects need uploading".
 *
 * Getting the hash wrong FAILS LOUDLY, which is worth knowing because the
 * opposite is the intuitive guess. Probed against the live API on a version
 * that was never finalized: :populateFiles happily accepts a raw-file hash and
 * asks you to upload it, and the upload itself is then refused with
 *
 *   400 Couldn't process request (status=400): content hash doesn't match content
 *
 * So there is no silent-404 failure mode to defend against here. The step dies
 * where the mistake is, rather than producing a site that deploys clean and
 * serves nothing.
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const API = "https://firebasehosting.googleapis.com/v1beta1";

function usage(msg) {
  if (msg) console.error(`\n${msg}\n`);
  console.error(
    "usage: node <frontend>/scripts/deploy-hosting.js --dir <built dir> [--site <id>] " +
      "[--project <id>] [--config <firebase.json>] [--dry-run]"
  );
  process.exit(msg ? 1 : 0);
}

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") usage();
    else if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[++i];
    } else usage(`unexpected argument: ${a}`);
  }
  return out;
}

/** Every file under `dir`, as hosting paths ("/index.html", "/assets/x.js"). */
function walk(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    // Dotfiles are excluded to match firebase.json's default `ignore`.
    if (entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, acc);
    else acc.push({ full, hostingPath: "/" + path.relative(base, full).split(path.sep).join("/") });
  }
  return acc;
}

/**
 * The GCE/Cloud Build metadata server. Present inside a build step, absent on a
 * workstation. Tried BEFORE gcloud because the build images this runs in
 * (node:22-slim) have no gcloud, where the gcloud path fails with a bare
 * `spawnSync gcloud ENOENT` that says nothing about what to do instead.
 */
async function metadataToken() {
  const host = process.env.GCE_METADATA_HOST || "169.254.169.254";
  const url = `http://${host}/computeMetadata/v1/instance/service-accounts/default/token`;
  const res = await fetch(url, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`metadata server -> ${res.status}`);
  const body = await res.json();
  if (!body.access_token) throw new Error("metadata server returned no access_token");
  return body.access_token;
}

async function accessToken() {
  if (process.env.HOSTING_TOKEN) return process.env.HOSTING_TOKEN.trim();
  try {
    return await metadataToken();
  } catch {
    // Not on GCE. Fall through to gcloud, which is the workstation path.
  }
  try {
    // Inherits CLOUDSDK_CONFIG, which is how the VetraTD identity is selected.
    //
    // `shell: true` because on Windows gcloud is `gcloud.cmd` and execFileSync
    // without a shell does not apply PATHEXT — it fails with a bare
    // `spawnSync gcloud ENOENT`, which reads as "gcloud is not installed" on a
    // machine where `gcloud` works fine in every terminal. There is no
    // user-supplied input in this command line.
    return execFileSync("gcloud", ["auth", "print-access-token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    }).trim();
  } catch (err) {
    throw new Error(
      "no HOSTING_TOKEN, no metadata server, and `gcloud auth print-access-token` failed. " +
        `Set CLOUDSDK_CONFIG to the VetraTD config, or pass HOSTING_TOKEN. (${err.message})`
    );
  }
}

async function api(token, project, method, url, body, extraHeaders = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    // Without this the API answers 403 with a message about a missing quota
    // project, which reads as an IAM failure. See the header comment.
    "x-goog-user-project": project,
    ...extraHeaders,
  };
  if (body !== undefined && !(body instanceof Uint8Array)) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url.startsWith("http") ? url : `${API}/${url}`, {
    method,
    headers,
    body: body instanceof Uint8Array ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${url} -> ${res.status}\n${text.slice(0, 800)}`);
  }
  return text ? JSON.parse(text) : {};
}

/**
 * firebase.json's `hosting` block, translated to the API's `config` shape.
 * The field names differ: the file says `source`, the API says `glob`.
 */
function versionConfig(hosting) {
  const config = {};
  if (Array.isArray(hosting.rewrites)) {
    config.rewrites = hosting.rewrites.map((r) => ({
      glob: r.source,
      path: r.destination,
    }));
  }
  if (Array.isArray(hosting.headers)) {
    config.headers = hosting.headers.map((h) => ({
      glob: h.source,
      headers: Object.fromEntries(h.headers.map((kv) => [kv.key, kv.value])),
    }));
  }
  return config;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir;
  if (!dir) usage("--dir is required: the directory holding the BUILT site.");

  const project = args.project || process.env.HOSTING_PROJECT;
  if (!project) usage("--project is required (or set HOSTING_PROJECT).");
  // The default site of a Firebase project is named after the project.
  const site = args.site || process.env.HOSTING_SITE || project;

  const configPath = args.config || path.join(dir, "..", "firebase.json");
  let hosting = {};
  try {
    hosting = JSON.parse(readFileSync(configPath, "utf8")).hosting || {};
  } catch {
    console.warn(
      `[hosting] no readable config at ${configPath} — deploying with NO rewrites.\n` +
        "          A single-page app without the /index.html rewrite 404s on every\n" +
        "          route but /, which looks like a broken router."
    );
  }

  const files = walk(dir);
  if (files.length === 0) throw new Error(`${dir} contains no files to deploy.`);

  // Content-addressed by the hash of the GZIPPED bytes. See the header.
  const gz = new Map();
  const manifest = {};
  for (const f of files) {
    const compressed = gzipSync(readFileSync(f.full), { level: 9 });
    const hash = createHash("sha256").update(compressed).digest("hex");
    gz.set(hash, compressed);
    manifest[f.hostingPath] = hash;
  }

  console.log(`[hosting] site=${site} project=${project} files=${files.length}`);
  if (!hosting.rewrites) {
    console.warn("[hosting] WARNING: no rewrites in config — SPA routes will 404.");
  }

  if (args.dryRun) {
    console.log(JSON.stringify({ config: versionConfig(hosting), manifest }, null, 2));
    return;
  }

  const token = await accessToken();

  const version = await api(token, project, "POST", `sites/${site}/versions`, {
    config: versionConfig(hosting),
  });
  console.log(`[hosting] version ${version.name}`);

  const populated = await api(token, project, "POST", `${version.name}:populateFiles`, {
    files: manifest,
  });
  const required = populated.uploadRequiredHashes || [];
  console.log(`[hosting] ${required.length} of ${files.length} objects need uploading`);

  for (const hash of required) {
    const body = gz.get(hash);
    if (!body) throw new Error(`API asked for hash ${hash}, which is not in this build.`);
    await api(token, project, "POST", `${populated.uploadUrl}/${hash}`, body, {
      "Content-Type": "application/octet-stream",
    });
  }

  await api(token, project, "PATCH", `${version.name}?update_mask=status`, {
    status: "FINALIZED",
  });

  const release = await api(
    token,
    project,
    "POST",
    `sites/${site}/releases?versionName=${encodeURIComponent(version.name)}`,
    {}
  );
  console.log(`[hosting] released ${release.name}`);
  console.log(`[hosting] live at https://${site}.web.app`);
}

main().catch((err) => {
  console.error(`[hosting] FAILED: ${err.message}`);
  process.exit(1);
});
