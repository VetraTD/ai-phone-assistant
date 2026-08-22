import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";
import { createRequire } from "module";
import jwt from "jsonwebtoken";
import { createIdTokenVerifier as esmFactory } from "../lib/auth/idToken.js";

const require = createRequire(import.meta.url);
// The dashboard backend's CommonJS copy. Required from here on purpose: the
// whole forgery battery below runs against BOTH implementations, so a fix
// applied to one and forgotten in the other fails here rather than in
// production. Duplicated modules drift; duplicated modules with one shared test
// suite do not.
const { createIdTokenVerifier: cjsFactory } = require(
  "../AI-phone-dashboard/backend/src/middleware/idToken.js"
);

const IMPLEMENTATIONS = [
  ["voice server (ESM)", esmFactory],
  ["dashboard backend (CJS)", cjsFactory],
];

// ---------------------------------------------------------------------------
// The verifier, forged at every claim it checks.
//
// Every test below except the first is a NEGATIVE one, and the first is the
// only reason the rest mean anything: three tests proving a webhook refused bad
// signatures passed for months while it refused good ones too, and every
// recorded 403 was consistent with the subsystem being entirely off. A gate
// built only from negative cases is not a gate.
//
// Offline. A real key pair is generated here and injected, so nothing talks to
// Google and every forgery is signed for real rather than described.
// ---------------------------------------------------------------------------

const PROJECT = "vetra-shared-c3a3bd";
const ISSUER = `https://securetoken.google.com/${PROJECT}`;
const KID = "test-key-1";
const NOW_MS = 1_755_800_000_000; // fixed, so nothing here depends on the clock

let priv;
let pub;
/** A second, unrelated key pair — an attacker's own. */
let attackerPriv;

beforeAll(() => {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  priv = pair.privateKey.export({ type: "pkcs1", format: "pem" });
  pub = pair.publicKey.export({ type: "spki", format: "pem" });

  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  attackerPriv = other.privateKey.export({ type: "pkcs1", format: "pem" });
});

/** The claims Identity Platform actually issues for an email/password sign-in. */
function claims(overrides = {}) {
  const nowS = Math.floor(NOW_MS / 1000);
  return {
    iss: ISSUER,
    aud: PROJECT,
    sub: "kK3nQm2rSTUvWxYz0123456789ab",
    iat: nowS - 60,
    exp: nowS + 3540,
    auth_time: nowS - 120,
    email: "staff@clinic.test",
    email_verified: false,
    firebase: { identities: { email: ["staff@clinic.test"] }, sign_in_provider: "password" },
    ...overrides,
  };
}

function sign(payload, { key = priv, alg = "RS256", kid = KID } = {}) {
  return jwt.sign(payload, key, { algorithm: alg, header: { kid, alg } });
}

function makeVerifier(createIdTokenVerifier, { key = pub, now = () => NOW_MS, projectId = PROJECT } = {}) {
  return createIdTokenVerifier({
    projectId,
    now,
    getPublicKey: async (requestedKid) => {
      if (requestedKid !== KID) throw new Error("no key for kid");
      return key;
    },
  });
}

describe.each(IMPLEMENTATIONS)("Identity Platform ID token verification — %s", (_label, createIdTokenVerifier) => {
  it("ACCEPTS a genuine token, and returns the identity the servers need", async () => {
    // The assertion that makes every rejection below meaningful. Without it,
    // "refuses forgeries" is equally consistent with refusing everything.
    const v = makeVerifier(createIdTokenVerifier);
    const result = await v(sign(claims()));
    expect(result).toEqual({
      email: "staff@clinic.test",
      uid: "kK3nQm2rSTUvWxYz0123456789ab",
      authTimeSeconds: Math.floor(NOW_MS / 1000) - 120,
    });
  });

  it("refuses a token signed with a DIFFERENT key", async () => {
    const v = makeVerifier(createIdTokenVerifier);
    expect(await v(sign(claims(), { key: attackerPriv }))).toBeNull();
  });

  it("refuses HS256 signed with the PUBLIC key — the algorithm-confusion attack", async () => {
    // The public key is public. If the verifier honours the token's own `alg`,
    // an attacker signs an HS256 token using that public key as the HMAC secret
    // and it verifies. The most important ATTACK in this file.
    //
    // Which barrier stops it, measured rather than assumed: the modules' header
    // pre-check, not the `algorithms: ["RS256"]` pin. Deleting the pin alone
    // leaves this test — and every other one here — green, because nothing with
    // a non-RS256 header reaches jwt.verify. Recorded because the alternative is
    // a test that appears to cover a line it cannot see.
    const forged = jwt.sign(claims(), pub, { algorithm: "HS256", header: { kid: KID, alg: "HS256" } });
    expect(await makeVerifier(createIdTokenVerifier)(forged)).toBeNull();
  });

  it("refuses alg: none", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: KID })).toString("base64url");
    const body = Buffer.from(JSON.stringify(claims())).toString("base64url");
    expect(await makeVerifier(createIdTokenVerifier)(`${header}.${body}.`)).toBeNull();
  });

  it("refuses a token from ANOTHER project — same signer, different issuer", async () => {
    // securetoken is one shared signer for every Firebase project on earth, so
    // a token minted in a stranger's free project carries a VALID signature
    // against the same keys. The issuer check is the only thing between that
    // and a full session.
    const v = makeVerifier(createIdTokenVerifier);
    expect(await v(sign(claims({ iss: "https://securetoken.google.com/someone-elses-project" })))).toBeNull();
  });

  it("refuses a token whose audience is another project", async () => {
    const v = makeVerifier(createIdTokenVerifier);
    expect(await v(sign(claims({ aud: "someone-elses-project" })))).toBeNull();
  });

  it("checks issuer and audience INDEPENDENTLY, not one standing in for the other", async () => {
    // A verifier that only checked `aud` would accept the first of these, and a
    // verifier that only checked `iss` would accept the second. Both are wrong.
    const v = makeVerifier(createIdTokenVerifier);
    expect(await v(sign(claims({ iss: "https://securetoken.google.com/elsewhere" })))).toBeNull();
    expect(await v(sign(claims({ aud: "elsewhere" })))).toBeNull();
  });

  it("refuses an expired token", async () => {
    const nowS = Math.floor(NOW_MS / 1000);
    expect(await makeVerifier(createIdTokenVerifier)(sign(claims({ exp: nowS - 1 })))).toBeNull();
  });

  it("refuses a token issued in the future", async () => {
    const nowS = Math.floor(NOW_MS / 1000);
    expect(await makeVerifier(createIdTokenVerifier)(sign(claims({ iat: nowS + 600, exp: nowS + 4200 })))).toBeNull();
  });

  it("refuses an unknown kid rather than falling back to any key", async () => {
    expect(await makeVerifier(createIdTokenVerifier)(sign(claims(), { kid: "not-a-real-kid" }))).toBeNull();
  });

  it("refuses when the key lookup FAILS — an outage is not an authentication", async () => {
    const v = createIdTokenVerifier({
      projectId: PROJECT,
      now: () => NOW_MS,
      getPublicKey: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await v(sign(claims()))).toBeNull();
  });

  it("refuses a token with no sub, a blank sub, or an absurdly long one", async () => {
    const v = makeVerifier(createIdTokenVerifier);
    expect(await v(sign(claims({ sub: undefined })))).toBeNull();
    expect(await v(sign(claims({ sub: "" })))).toBeNull();
    expect(await v(sign(claims({ sub: "a".repeat(129) })))).toBeNull();
  });

  it("refuses a token with no auth_time, or an auth_time in the future", async () => {
    const v = makeVerifier(createIdTokenVerifier);
    expect(await v(sign(claims({ auth_time: undefined })))).toBeNull();
    expect(await v(sign(claims({ auth_time: Math.floor(NOW_MS / 1000) + 600 })))).toBeNull();
  });

  it("refuses a token with no email — the tenant is resolved BY email", async () => {
    // Migration 034 keys the tenant lookup on the address. A token without one
    // would authenticate and then resolve to no business, producing a 403 that
    // reads as an authorisation bug. Refuse it where the fact is known.
    const v = makeVerifier(createIdTokenVerifier);
    expect(await v(sign(claims({ email: undefined })))).toBeNull();
    expect(await v(sign(claims({ email: "" })))).toBeNull();
  });

  it("refuses garbage that is not a JWT at all", async () => {
    const v = makeVerifier(createIdTokenVerifier);
    for (const junk of ["", "not.a.token", "a.b", "....", "Bearer x"]) {
      expect(await v(junk)).toBeNull();
    }
    expect(await v(undefined)).toBeNull();
    expect(await v(null)).toBeNull();
  });

  it("does NOT require email_verified, and that is a recorded risk not an oversight", async () => {
    // Identity Platform does not verify an address on email/password signup, and
    // neither did Supabase, so requiring it here would lock out every account
    // the B1(2) import creates.
    //
    // THE CONSEQUENCE, written down because it goes live at the import and not
    // before: signup is open, the tenant is resolved by EMAIL, so an address
    // that has a `users` row but NO Identity Platform account can be claimed by
    // a stranger who signs up with it — and they inherit that clinic's tenant.
    // The fix is not here: import every user with localId = users.id and switch
    // the lookup to the uid, which a stranger's new account cannot forge. See
    // the ledger's B1(2) row.
    const v = makeVerifier(createIdTokenVerifier);
    const result = await v(sign(claims({ email_verified: false })));
    expect(result?.email).toBe("staff@clinic.test");
  });

  it("refuses to be constructed without a project id", () => {
    // A verifier with no project has no issuer and no audience to check
    // against. Throwing at construction makes it a boot failure rather than a
    // process that 401s everyone and looks like a password outage.
    expect(() => createIdTokenVerifier({ projectId: "" })).toThrow(/projectId/);
    expect(() => createIdTokenVerifier({})).toThrow(/projectId/);
  });
});

describe.each(IMPLEMENTATIONS)("clock tolerance — %s", (_label, createIdTokenVerifier) => {
  it("accepts a token a few seconds ahead of our clock — ordinary drift", async () => {
    // The acceptance half of the iat check. Refusing everything ahead of the
    // clock would turn a second of NTP drift into a sign-out.
    const nowS = Math.floor(NOW_MS / 1000);
    const v = makeVerifier(createIdTokenVerifier);
    const result = await v(sign(claims({ iat: nowS + 5, auth_time: nowS + 5 })));
    expect(result?.email).toBe("staff@clinic.test");
  });

  it("refuses one far enough ahead to evade the session-age ceiling", async () => {
    // lib/auth/sessionAge.js computes age from `iat` and treats a negative age
    // as skew. A token issued an hour ahead would never age out.
    const nowS = Math.floor(NOW_MS / 1000);
    const v = makeVerifier(createIdTokenVerifier);
    expect(await v(sign(claims({ iat: nowS + 3600, exp: nowS + 7200 })))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The import shape, pinned — the defect that took a real phone call to find.
// ---------------------------------------------------------------------------
describe("the CJS import shapes this module depends on", () => {
  // UNDER VITEST THIS CLASS OF BUG IS INVISIBLE. Vite transforms CJS interop
  // itself, so inside the runner a namespace import may expose names that plain
  // Node does not — which is how `import * as twilio` shipped a webhook that
  // rejected 100% of requests for the life of a deployment. Asserting the shape
  // from in here would assert Vite's behaviour rather than the container's.
  //
  // So: a real Node subprocess. Both packages are CommonJS.
  const cwd = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

  async function inNode(source) {
    const { execFileSync } = await import("node:child_process");
    return execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      encoding: "utf8",
      cwd,
    }).trim();
  }

  it("plain Node does NOT expose jwt.verify on a namespace import", async () => {
    expect(await inNode('import * as ns from "jsonwebtoken"; console.log(typeof ns.verify);')).toBe("undefined");
  });

  it("plain Node DOES expose it on a default import — what the module uses", async () => {
    expect(await inNode('import d from "jsonwebtoken"; console.log(typeof d.verify);')).toBe("function");
  });

  it("plain Node exposes JwksClient on a default import", async () => {
    expect(await inNode('import d from "jwks-rsa"; console.log(typeof d.JwksClient);')).toBe("function");
  });

  it("the module loads and builds a real verifier under plain Node", async () => {
    // The end-to-end version: the two above check the packages, this checks
    // that lib/auth/idToken.js itself survives outside the runner. Its
    // top-level guard throws if `verify` went missing, so reaching "function"
    // proves the whole import chain.
    const out = await inNode(
      'import { createIdTokenVerifier } from "./lib/auth/idToken.js";' +
        ' console.log(typeof createIdTokenVerifier({ projectId: "p", getPublicKey: async () => "" }));'
    );
    expect(out).toBe("function");
  });

  it("the module does not use a namespace import for either package", async () => {
    // Sabotage proved the behavioural tests cannot catch this: Vite's interop
    // papers over exactly the difference that breaks production. Reading the
    // source is the only defence available from in here.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new globalThis.URL("../lib/auth/idToken.js", import.meta.url)),
      "utf8"
    );
    expect(src).not.toMatch(/^import\s+\*\s+as\s+\w+\s+from\s+"(jsonwebtoken|jwks-rsa)"/m);
    expect(src).toMatch(/^import\s+jwt\s+from\s+"jsonwebtoken"/m);
    expect(src).toMatch(/^import\s+jwks\s+from\s+"jwks-rsa"/m);
  });
});
