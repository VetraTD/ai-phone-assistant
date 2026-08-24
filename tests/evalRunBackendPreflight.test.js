/**
 * eval/run.js's backend preflight.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TEST EXISTS
 * ---------------------------------------------------------------------------
 *
 * `main()` used to open with `if (!process.env.GEMINI_API_KEY) { ... return }`.
 * That is a second copy of a decision that `services/gemini.js`'s `getClient()`
 * already owns, and it had drifted from it: a Vertex deployment has no API key
 * BY DESIGN — the Google Cloud BAA does not cover the Gemini Developer API —
 * so the guard refused to start the one configuration C1 exists to measure.
 *
 * This is the fourth appearance of the same shape in this codebase. The third,
 * in `getReplyStreaming`, threw on every turn of a correctly configured covered
 * deployment and dropped real callers into the take-a-message script; the
 * comment above the surviving check in `getClient` names it and says why that
 * check belongs there and nowhere else.
 *
 * So the preflight now ASKS `getClient()` rather than re-deriving its rules,
 * and the assertion that matters is the POSITIVE one: a Vertex-configured
 * environment with NO API KEY must be accepted. A guard built only from
 * refusals cannot tell "correctly rejects nothing configured" from "rejects
 * everything" — which this repository has already been burned by once, when
 * three passing negative signature tests hid a validator that refused 100% of
 * requests for the life of a deployment.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preflightBackend } from "../eval/run.js";
import { getClient, resetClient } from "../services/gemini.js";

const TOUCHED = [
  "GEMINI_API_KEY",
  "VERTEX_ENABLED",
  "GOOGLE_CLOUD_PROJECT",
  "VERTEX_LOCATION",
  "DEPLOYMENT_MODE",
];

let saved;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
  resetClient();
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetClient();
});

describe("preflightBackend", () => {
  // ---- the positive cases: these are the point of the test ----------------

  it("ACCEPTS a Vertex deployment that has no API key at all", () => {
    process.env.VERTEX_ENABLED = "true";
    process.env.GOOGLE_CLOUD_PROJECT = "vetra-us-staging-c3a3bd";
    process.env.VERTEX_LOCATION = "us";
    expect(preflightBackend()).toBeNull();
  });

  it("ACCEPTS the eu multi-region too, so the UK lane is runnable", () => {
    process.env.VERTEX_ENABLED = "true";
    process.env.GOOGLE_CLOUD_PROJECT = "vetra-uk-prod-c3a3bd";
    process.env.VERTEX_LOCATION = "eu";
    expect(preflightBackend()).toBeNull();
  });

  it("ACCEPTS an AI Studio deployment with an API key and no Vertex config", () => {
    process.env.GEMINI_API_KEY = "test-key-not-used-offline";
    expect(preflightBackend()).toBeNull();
  });

  // ---- the refusals -------------------------------------------------------

  it("REFUSES when neither backend is configured, and says how to fix either", () => {
    const msg = preflightBackend();
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/GEMINI_API_KEY/);
    expect(msg).toMatch(/VERTEX_ENABLED/);
  });

  it("REFUSES a half-configured Vertex rather than falling back to an API key", () => {
    process.env.VERTEX_ENABLED = "true";
    process.env.GEMINI_API_KEY = "test-key-not-used-offline";
    // No GOOGLE_CLOUD_PROJECT / VERTEX_LOCATION.
    const msg = preflightBackend();
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/Refusing to fall back/);
  });

  it("REFUSES VERTEX_LOCATION=global, which would void the residency claim", () => {
    process.env.VERTEX_ENABLED = "true";
    process.env.GOOGLE_CLOUD_PROJECT = "vetra-us-staging-c3a3bd";
    process.env.VERTEX_LOCATION = "global";
    expect(preflightBackend()).toBeTruthy();
  });

  // ---- the drift guard ----------------------------------------------------
  //
  // The defect was a SECOND copy of getClient()'s rules. This asserts the
  // preflight has no rules of its own: it must report getClient's own words.

  it("reports getClient()'s own error text rather than a paraphrase of it", () => {
    let thrown = null;
    try {
      getClient();
    } catch (err) {
      thrown = err.message;
    }
    resetClient();
    expect(thrown).toBeTruthy();
    expect(preflightBackend()).toBe(thrown);
  });
});

// ---------------------------------------------------------------------------
// The entry point actually USES it — a subprocess, because nothing else can say so
// ---------------------------------------------------------------------------
//
// The tests above pass `preflightBackend` its own inputs and check its own
// outputs. They stay green if `main()` stops calling it — verified by putting
// the old `if (!process.env.GEMINI_API_KEY)` back into `main()`, at which point
// the CLI refused a Vertex run again and all seven tests above still passed.
//
// That is this repository's recurring failure shape: a guard correct about its
// subject and blind to the half that matters. `main()` is not exported and
// should not become exported for a test, so the honest check is to run the real
// entry point in a subprocess and assert it gets PAST the backend decision.
//
// `--filter __no_such_scenario__` makes that observable for free: the run stops
// at "No scenarios matched", which is strictly after the preflight and strictly
// before any model call. Zero API spend, and it exercises the real dotenv load,
// the real import graph and the real argv path.
//
// DOTENV_CONFIG_PATH points at an empty file on purpose. Without it the repo's
// own .env supplies GEMINI_API_KEY, the old guard would have passed too, and
// this test would prove nothing — which it did on the first attempt.

describe("eval/run.js entry point", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const RUN_JS = path.join(HERE, "..", "eval", "run.js");

  function runCli(extraEnv) {
    const dir = mkdtempSync(path.join(tmpdir(), "eval-preflight-"));
    const emptyEnvFile = path.join(dir, "empty.env");
    writeFileSync(emptyEnvFile, "");
    const env = { ...process.env, DOTENV_CONFIG_PATH: emptyEnvFile, ...extraEnv };
    delete env.GEMINI_API_KEY;
    try {
      return {
        status: 0,
        out: execFileSync(process.execPath, [RUN_JS, "--filter", "__no_such_scenario__"], {
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      };
    } catch (err) {
      return { status: err.status ?? 1, out: `${err.stdout || ""}${err.stderr || ""}` };
    }
  }

  it("starts a VERTEX run with no API key present anywhere", () => {
    const { out } = runCli({
      VERTEX_ENABLED: "true",
      GOOGLE_CLOUD_PROJECT: "vetra-us-staging-c3a3bd",
      VERTEX_LOCATION: "us",
    });
    // Reached scenario selection => the backend decision let it through.
    expect(out).toMatch(/No scenarios matched/);
    expect(out).not.toMatch(/GEMINI_API_KEY is not set\. Add it to your \.env/);
  }, 60_000);

  it("still refuses when NEITHER backend is configured", () => {
    const { status, out } = runCli({});
    expect(status).not.toBe(0);
    expect(out).toMatch(/GEMINI_API_KEY/);
    expect(out).toMatch(/VERTEX_ENABLED/);
    expect(out).not.toMatch(/No scenarios matched/);
  }, 60_000);
});
