/**
 * Test script: call Athena OAuth token endpoint and print status + response body.
 * Use this to see why token requests fail (e.g. 400 error message from Athena).
 * Run: node scripts/test-athena-token.js
 *
 * Uses .env: ATHENA_* (or set USE_ECC_ATHENA=true for ECC_ATHENA_*).
 * Does not print client ID, client secret, or access_token.
 */

import "dotenv/config";

const USE_ECC = process.env.USE_ECC_ATHENA === "true";
const clientId = USE_ECC ? process.env.ECC_ATHENA_CLIENT_ID : process.env.ATHENA_CLIENT_ID;
const clientSecret = USE_ECC ? process.env.ECC_ATHENA_CLIENT_SECRET : process.env.ATHENA_CLIENT_SECRET;
const tokenUrl = USE_ECC ? process.env.ECC_ATHENA_TOKEN_URL : process.env.ATHENA_TOKEN_URL;

function redact(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = { ...obj };
  if (out.access_token) out.access_token = "[REDACTED]";
  return out;
}

async function main() {
  console.log("Athena token check");
  console.log("Using:", USE_ECC ? "ECC app (ECC_ATHENA_*)" : "Platform app (ATHENA_*)");
  console.log("Token URL:", tokenUrl || "(not set)");
  console.log("");

  if (!clientId || !clientSecret || !tokenUrl) {
    console.error("Missing env. Set ATHENA_CLIENT_ID, ATHENA_CLIENT_SECRET, ATHENA_TOKEN_URL");
    if (USE_ECC) console.error("(Or ECC_ATHENA_* if using ECC app)");
    process.exit(1);
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`,
    },
    body: "grant_type=client_credentials&scope=athena/service/Athenanet.MDP.*",
  });

  const raw = await res.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }

  console.log("HTTP status:", res.status, res.statusText);
  console.log("Response body:", JSON.stringify(redact(body), null, 2));
  if (res.ok) {
    console.log("");
    console.log("Token request succeeded. You can run npm run test:appointments next.");
  } else {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
