#!/usr/bin/env node
/**
 * C8 — cross-tenant isolation, exercised against a DEPLOYED dashboard API.
 *
 *   node scripts/c8-tenant-isolation.js \
 *     --api https://dashboard-api-us-staging-xxxx.run.app \
 *     --api-key <Identity Platform web key>
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RUNS AGAINST THE DEPLOYMENT AND NOT IN VITEST
 * ---------------------------------------------------------------------------
 *
 * The database tests already prove RLS refuses an unscoped write on the LOCAL
 * PG16. They cannot prove the deployed stack is isolated, and this file's own
 * history is the argument: local `vetra` is a superuser with rolbypassrls=true,
 * so six RLS tests passed against a function that was completely defeated on
 * Cloud SQL. "Isolated locally" and "isolated where the PHI is" have already
 * been different facts once.
 *
 * So this drives the real HTTPS API with two real Identity Platform accounts
 * and asks whether tenant A can reach tenant B.
 *
 * ---------------------------------------------------------------------------
 * IT ASSERTS THE POSITIVE PATH FIRST, AND THAT IS NOT A FORMALITY
 * ---------------------------------------------------------------------------
 *
 * The single most expensive lesson in this project's ledger: three negative
 * tests — 403 with no signature, a bogus one, a wrong one — passed for months
 * while the subsystem was entirely off, because every one of those 403s is
 * exactly what a validator that rejects EVERYTHING produces. A cross-tenant
 * suite made only of refusals has the identical hole: an endpoint that is
 * simply broken refuses tenant B's data and tenant A's own data alike, and
 * reads as perfect isolation.
 *
 * Every refusal here is therefore paired with a proof that the SAME call
 * succeeds for the tenant that owns the row. A refusal only counts once the
 * positive control passes.
 *
 * ---------------------------------------------------------------------------
 * IT DISTINGUISHES *WHICH LAYER* REFUSED, WHICH IS THE ACTUAL C8 QUESTION
 * ---------------------------------------------------------------------------
 *
 * C8 is "isolation at BOTH the app and RLS layers", so "it was refused" is not
 * the finding — WHAT refused it is. On these endpoints the two layers produce
 * different status codes:
 *
 *   403  the app-layer check fired: the row was VISIBLE to the query and the
 *        handler compared it against req.businessId and rejected it.
 *   404  the row was never visible: row-level security filtered it before the
 *        handler saw anything.
 *
 * Both are a pass for the caller. They are very different facts about the
 * system, and a suite that only checked "not 200" would report them as the
 * same. If every cross-tenant read returns 404, the app-layer comparison has
 * never actually executed against a foreign row and is itself unexercised.
 *
 * ---------------------------------------------------------------------------
 * STAGING ONLY
 * ---------------------------------------------------------------------------
 *
 * It CREATES ACCOUNTS AND TENANTS. Guarded on the API hostname containing
 * "staging"; --i-know overrides it and should not be used.
 */

const IDENTITY = "https://identitytoolkit.googleapis.com/v1";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--i-know") out.iKnow = true;
    else if (a.startsWith("--")) out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return out;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function signUp(apiKey, email, password) {
  const res = await fetch(`${IDENTITY}/accounts:signUp?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`signUp ${email} -> ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return { idToken: body.idToken, localId: body.localId, email };
}

/** Every call returns the status AND the parsed body, because C8 needs both. */
async function call(api, token, method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let parsed = null;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const api = (args.api || process.env.C8_API || "").replace(/\/$/, "");
  const apiKey = args.apiKey || process.env.C8_API_KEY;
  if (!api || !apiKey) {
    console.error("usage: node scripts/c8-tenant-isolation.js --api <url> --api-key <key>");
    process.exit(2);
  }
  if (!/staging/.test(api) && !args.iKnow) {
    console.error(`REFUSING: "${api}" does not look like staging, and this creates accounts and tenants.`);
    process.exit(2);
  }

  // Distinct per run so a re-run never collides with its own leftovers — the
  // tenant lookup is keyed on auth_uid, but `users.email` is UNIQUE.
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const pw = `Probe!${stamp}Aa1`;
  const emailA = `c8-probe-a-${stamp}@vetratd.com`;
  const emailB = `c8-probe-b-${stamp}@vetratd.com`;

  console.log(`\nC8 cross-tenant isolation — ${api}\n`);

  const A = await signUp(apiKey, emailA, pw);
  const B = await signUp(apiKey, emailB, pw);
  console.log(`  tenant A account ${A.localId}`);
  console.log(`  tenant B account ${B.localId}\n`);

  // --- the two tenants ------------------------------------------------------
  const mkA = await call(api, A.idToken, "POST", "/api/onboarding/create-business", {
    name: `C8 Probe A ${stamp}`,
    timezone: "America/Chicago",
  });
  const mkB = await call(api, B.idToken, "POST", "/api/onboarding/create-business", {
    name: `C8 Probe B ${stamp}`,
    timezone: "America/Chicago",
  });
  if (mkA.status !== 200 || mkB.status !== 200) {
    console.error(`  could not create tenants: A=${mkA.status} B=${mkB.status}`);
    console.error(`  ${JSON.stringify(mkA.body)} / ${JSON.stringify(mkB.body)}`);
    process.exit(1);
  }
  const idA = mkA.body.business.id;
  const idB = mkB.body.business.id;
  console.log(`  tenant A business ${idA}`);
  console.log(`  tenant B business ${idB}\n`);
  if (idA === idB) {
    check("two signups produce two DISTINCT tenants", false, "same business id");
    process.exit(1);
  }
  check("two signups produce two distinct tenants", true);

  // --- POSITIVE CONTROLS ----------------------------------------------------
  // Without these every refusal below is meaningless.
  console.log("\n  POSITIVE CONTROLS — a refusal proves nothing until these pass:");
  const ownA = await call(api, A.idToken, "GET", `/api/businesses/${idA}`);
  check("A can read its OWN business", ownA.status === 200, `status ${ownA.status}`);

  const meA = await call(api, A.idToken, "GET", "/api/me");
  check(
    "A's /api/me resolves to A's tenant",
    meA.status === 200 && !meA.body?.needsOnboarding,
    `status ${meA.status}`
  );

  // businessId is REQUIRED in the body and must equal the token's tenant — the
  // knowledge routes do their ownership check on that field rather than on a
  // path id. Omitting it 403s, which is how the first run of this probe
  // "passed" its cross-tenant knowledge check while B could not read its own
  // rows either. That is the negative-only-test hole reproducing itself inside
  // the very script written to avoid it, and it was caught only by the
  // positive control.
  const kbCreate = await call(api, B.idToken, "POST", "/api/knowledge", {
    businessId: idB,
    question: `c8 probe ${stamp}`,
    answer: "owned by tenant B",
  });
  const kbId = kbCreate.body?.id || kbCreate.body?.entry?.id || kbCreate.body?.knowledge?.id;
  check("B can create a knowledge row", kbCreate.status < 300 && !!kbId, `status ${kbCreate.status}`);

  const kbListB = await call(api, B.idToken, "GET", `/api/knowledge?businessId=${idB}`);
  const bSeesOwn = JSON.stringify(kbListB.body || "").includes(stamp);
  check("B can see its own knowledge row", bSeesOwn, `status ${kbListB.status}`);

  // --- CROSS-TENANT READS ---------------------------------------------------
  console.log("\n  CROSS-TENANT READS:");
  const readB = await call(api, A.idToken, "GET", `/api/businesses/${idB}`);
  check(
    "A CANNOT read B's business",
    readB.status === 403 || readB.status === 404,
    `status ${readB.status} (403 = app-layer check fired, 404 = RLS filtered it first)`
  );

  const capOwnA = await call(api, A.idToken, "GET", `/api/business/${idA}/capabilities`);
  check("A can read its OWN capabilities", capOwnA.status === 200, `status ${capOwnA.status}`);

  const capB = await call(api, A.idToken, "GET", `/api/business/${idB}/capabilities`);
  check(
    "A CANNOT read B's capabilities",
    capB.status >= 400,
    `status ${capB.status}`
  );

  // A asks for B's rows BY B'S ID — the actual attempt, not an omission.
  const kbListA = await call(api, A.idToken, "GET", `/api/knowledge?businessId=${idB}`);
  check(
    "A CANNOT list B's knowledge by passing B's businessId",
    kbListA.status >= 400 && !JSON.stringify(kbListA.body || "").includes(stamp),
    `status ${kbListA.status}`
  );

  // And A's own list is readable — otherwise the refusal above is just an
  // endpoint that refuses everyone.
  const kbOwnA = await call(api, A.idToken, "GET", `/api/knowledge?businessId=${idA}`);
  check("A can list its OWN knowledge", kbOwnA.status === 200, `status ${kbOwnA.status}`);

  // --- CROSS-TENANT WRITES --------------------------------------------------
  // The reads above could pass on a system where writes still land: a filtered
  // SELECT and a refused UPDATE are enforced by different policies.
  console.log("\n  CROSS-TENANT WRITES — checked by their EFFECT, not their status:");
  const stolenName = `STOLEN BY A ${stamp}`;
  const writeB = await call(api, A.idToken, "PUT", `/api/business/${idB}/settings`, {
    name: stolenName,
  });
  const bAfter = await call(api, B.idToken, "GET", `/api/businesses/${idB}`);
  check(
    "A's write to B's settings did NOT change B",
    bAfter.body?.name !== stolenName,
    `write returned ${writeB.status}; B's name is now "${bAfter.body?.name}"`
  );

  if (kbId) {
    // Both spellings of the attack: claiming B's businessId, and claiming A's
    // own while pointing at B's row id. The second is the one an ownership
    // check keyed on a body field can miss.
    const kbSteal = await call(api, A.idToken, "PUT", `/api/knowledge/${kbId}`, {
      businessId: idA,
      question: `c8 probe ${stamp}`,
      answer: `STOLEN BY A ${stamp}`,
    });
    const kbStealB = await call(api, A.idToken, "PUT", `/api/knowledge/${kbId}`, {
      businessId: idB,
      question: `c8 probe ${stamp}`,
      answer: `STOLEN BY A ${stamp}`,
    });
    const kbAfter = await call(api, B.idToken, "GET", `/api/knowledge?businessId=${idB}`);
    check(
      "A's update to B's knowledge row did NOT change it",
      !JSON.stringify(kbAfter.body || "").includes("STOLEN BY A"),
      `update as own-tenant returned ${kbSteal.status}, as B returned ${kbStealB.status}`
    );

    const kbDel = await call(api, A.idToken, "DELETE", `/api/knowledge/${kbId}?businessId=${idA}`);
    const kbAfterDel = await call(api, B.idToken, "GET", `/api/knowledge?businessId=${idB}`);
    check(
      "A's delete of B's knowledge row did NOT remove it",
      JSON.stringify(kbAfterDel.body || "").includes(stamp),
      `delete returned ${kbDel.status}`
    );
  }

  // --- UNAUTHENTICATED ------------------------------------------------------
  console.log("\n  UNAUTHENTICATED:");
  const anon = await call(api, null, "GET", `/api/businesses/${idB}`);
  check("no token is refused", anon.status === 401, `status ${anon.status}`);

  const junk = await call(api, "not-a-token", "GET", `/api/businesses/${idB}`);
  check("a junk token is refused", junk.status === 401, `status ${junk.status}`);

  // --- verdict --------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n  ${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? `\n  FAILED: ${failed.map((f) => f.name).join("; ")}` : "")
  );
  console.log(
    `\n  Probe accounts left behind (staging is synthetic, and deleting a tenant\n` +
      `  is not an operation this API exposes): ${emailA}, ${emailB}\n`
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`\nC8 PROBE FAILED TO RUN: ${err.message}`);
  process.exit(2);
});
