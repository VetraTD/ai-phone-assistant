#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Point Speech-to-Text v2 at a customer-managed encryption key.
//
//   npm run stt:cmek -- --project vetra-us-staging-c3a3bd \
//                       --location us-central1 \
//                       --key projects/.../cryptoKeys/vetra-speech-us-staging
//
//   npm run stt:cmek -- --project ... --location ... --check
//
// WHY THIS IS A SCRIPT AND NOT TERRAFORM
//
// The Google Terraform provider implements NO part of the Speech v2 API
// (hashicorp/terraform-provider-google#18878, still open). There is no
// google_speech_config resource, so the one PATCH that points Speech at the
// key infra/terraform/speech.tf creates cannot be expressed there.
//
// This script is the remedy, NOT the control. A step somebody has to remember
// is not a control. The control is assertSttEncryption() in
// lib/voice/sttGoogle.js, which reads this same Config at boot and refuses to
// start a covered deployment when kms_key_name is empty — so forgetting to run
// this produces a service that will not come up, rather than one that quietly
// sends audio Google could retain under its own keys.
//
// Needs `speech.config.update`, which lives only in roles/speech.admin. The
// runtime service account deliberately does NOT have it: it holds a custom
// role with `speech.config.get` alone, so the process whose boot check
// enforces CMEK has no way to switch CMEK off. Run this as an operator.
// ---------------------------------------------------------------------------

import { v2 } from "@google-cloud/speech";

function parseArgs(argv) {
  const args = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") args.project = argv[++i];
    else if (a === "--location") args.location = argv[++i];
    else if (a === "--key") args.key = argv[++i];
    else if (a === "--check") args.check = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const project = args.project || process.env.GOOGLE_CLOUD_PROJECT;
const location = args.location || process.env.STT_LOCATION || "us-central1";

if (!project) {
  console.error("Missing --project (or GOOGLE_CLOUD_PROJECT).");
  process.exit(1);
}
if (location === "global") {
  console.error(
    "Refusing `global`: a global Speech endpoint may process audio in any region on earth, " +
      "which voids the data-location control this key exists to support."
  );
  process.exit(1);
}
if (!args.check && !args.key) {
  console.error(
    "Missing --key. Take it from `terraform output speech_cmek_keys`, which is where the key ring " +
      "and rotation are actually managed."
  );
  process.exit(1);
}

const client = new v2.SpeechClient({
  apiEndpoint: `${location}-speech.googleapis.com`,
  projectId: project,
});
const name = `projects/${project}/locations/${location}/config`;

if (args.check) {
  const [config] = await client.getConfig({ name });
  const key = (config?.kmsKeyName || "").trim();
  console.log(`${name}\n  kmsKeyName: ${key || "(NONE — a covered deployment will refuse to boot)"}`);
  process.exit(key ? 0 : 1);
}

// The key must live in the SAME region as the config. A key ring elsewhere is
// not a key Speech can use, and the error names neither the key nor the
// region.
if (!args.key.includes(`/locations/${location}/`)) {
  console.error(
    `Key ${args.key} is not in locations/${location}. Speech-to-Text can only use a key in its ` +
      "own region; a cross-region key fails with a message that names neither."
  );
  process.exit(1);
}

const [updated] = await client.updateConfig({
  config: { name, kmsKeyName: args.key },
  updateMask: { paths: ["kms_key_name"] },
});

console.log(`Updated ${updated.name}`);
console.log(`  kmsKeyName: ${updated.kmsKeyName}`);
console.log(
  "\nIf this failed with a KMS permission error, the Speech service agent is missing\n" +
    "roles/cloudkms.cryptoKeyEncrypterDecrypter on the key. Terraform grants it\n" +
    "(google_kms_crypto_key_iam_member.speech) and the grant can take a moment to propagate."
);
