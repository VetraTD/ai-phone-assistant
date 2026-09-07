# GCP Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the Gemini Live front-end onto the existing GCP estate so one Cloud Run service serves both front-ends against one Cloud SQL database, then retire Railway and Supabase.

**Architecture:** The estate is already built and merged — `feat/gcp-2` is 0 commits ahead of `main`. `voice-uk-prod` in `europe-west2` serves the cascade today against Cloud SQL `vetra-uk` on private IP with IAM auth. The Live front-end shares that database, prompt, tools and capability packs already; what is missing is its *configuration*. This plan adds the Gemini credential and the two `LIVE_*` variables to Terraform, adds a boot check so a missing credential refuses the deploy instead of silently downgrading every call to the cascade, adds the mid-call instrument, then deploys and cuts over.

**Tech Stack:** Node 18+ ESM, Express 5, Vitest, Terraform 1.15.x, Google Cloud Run / Cloud SQL / Secret Manager, Twilio Media Streams, `@google/genai`.

**Spec:** `docs/superpowers/specs/2026-09-06-gcp-cutover-design.md`

## Global Constraints

- **Branch.** Work on `feat/gcp-live-cutover`, branched from `main`. Do not commit to `main`.
- **gcloud identity.** Every `gcloud` invocation must set `CLOUDSDK_CONFIG=~/.gcloud-vetra2`. The account `admin@vetratd.com` is RESTRICTED at Google and `gcloud` fails outright under it.
- **Control plane project** is `vetra-core-edc8ca` (427725568491). Not `vetra-shared`, which belonged to the suspended attempt 1.
- **Projects:** `vetra-uk-edc8ca` (462445274080), `vetra-us-edc8ca` (dark), `vetra-core-edc8ca`.
- **Terraform state** is `gs://vetra-tfstate-edc8ca`. Never `terraform init -backend=false` without checking the cached backend first.
- **`DEPLOYMENT_MODE` is `standard` everywhere.** Not `hipaa`. This is a locked decision.
- **`LIVE_SURFACE` = `aistudio`, `LIVE_MODEL` = `gemini-3.1-flash-live-preview`.** Do not substitute a Vertex model.
- **Money.** Tasks 1–4 spend nothing. Tasks 5–6 make real GCP and Twilio changes and require the owner present. Do not run them unattended.
- **Gates that must hold at every commit:** `terraform fmt` exit 0, `terraform validate` Success, and **zero prompt snapshots moved**. A moved snapshot means the receptionist's prompt changed and this plan changes no prompt.

**Out of scope, deliberately** — spec §6 (uptime alerting, CI, dashboard frontend hosting, mid-call fallback itself, dashboard PHI-access audit). Those become their own plan. This plan ships the mid-call *instrument* only.

---

### Task 1: Boot check — a Live front-end that cannot connect must not boot

**Why this is first:** `createLiveClient` throws when `GEMINI_API_KEY` is absent, and the tier-2 fallback catches that throw *correctly*. So a deploy that forgets the credential serves every caller on the cascade and sounds fine. Without this check, the rest of the plan can appear to succeed while doing nothing.

**Files:**
- Modify: `lib/bootChecks.js` (add `checkLiveSurface`, register it in `assertBootConfig`)
- Test: `tests/bootChecks.test.js`

**Interfaces:**
- Consumes: `liveSurface(env)` and `LIVE_MODEL_DEFAULT` from `lib/voice/live/client.js`; `FATAL`, `ANNOUNCE`, and the module-local `set()` helper in `lib/bootChecks.js`.
- Produces: `export function checkLiveSurface(env) -> { findings: Array<{code, severity, detail}>, surface: "aistudio"|"vertex" }`. Finding codes: `live_surface_not_configured` (FATAL), `live_surface_not_covered` (FATAL), `live_surface` (ANNOUNCE).

- [ ] **Step 1: Write the failing tests**

Append to `tests/bootChecks.test.js`. Note the import line at the top of that file must gain `checkLiveSurface`.

```javascript
describe("checkLiveSurface — a front-end that cannot connect must not boot", () => {
  it("aistudio without a key is fatal — tier 2 would mask it and every call would serve the cascade", () => {
    const { findings } = checkLiveSurface({ DEPLOYMENT_MODE: "standard" });
    expect(codes(findings.filter((f) => f.severity === FATAL))).toContain("live_surface_not_configured");
  });

  it("aistudio with a key boots", () => {
    const { findings, surface } = checkLiveSurface({
      DEPLOYMENT_MODE: "standard",
      GEMINI_API_KEY: "AIza-test-key",
    });
    expect(findings.filter((f) => f.severity === FATAL)).toEqual([]);
    expect(surface).toBe("aistudio");
  });

  it("vertex without GOOGLE_CLOUD_PROJECT is fatal", () => {
    const { findings } = checkLiveSurface({ DEPLOYMENT_MODE: "standard", LIVE_SURFACE: "vertex" });
    expect(codes(findings.filter((f) => f.severity === FATAL))).toContain("live_surface_not_configured");
  });

  it("vertex with a project boots, and needs no key", () => {
    const { findings, surface } = checkLiveSurface({
      DEPLOYMENT_MODE: "standard",
      LIVE_SURFACE: "vertex",
      GOOGLE_CLOUD_PROJECT: "vetra-uk-edc8ca",
    });
    expect(findings.filter((f) => f.severity === FATAL)).toEqual([]);
    expect(surface).toBe("vertex");
  });

  // checkCoveredVendors CANNOT catch this: NON_COVERED_VENDORS["gemini-developer-api"]
  // has `credentials: []`, so no credential scan reaches it. assertVendorAllowed
  // would throw at construction — and tier 2 would swallow that throw too.
  it("aistudio in hipaa mode is fatal even with a key present", () => {
    const { findings } = checkLiveSurface({
      DEPLOYMENT_MODE: "hipaa",
      GEMINI_API_KEY: "AIza-test-key",
    });
    expect(codes(findings.filter((f) => f.severity === FATAL))).toContain("live_surface_not_covered");
  });

  it("announces the surface and model on every boot", () => {
    const { findings } = checkLiveSurface({
      DEPLOYMENT_MODE: "standard",
      GEMINI_API_KEY: "AIza-test-key",
    });
    const announced = findings.find((f) => f.code === "live_surface");
    expect(announced.severity).toBe(ANNOUNCE);
    expect(announced.detail).toContain("gemini-3.1-flash-live-preview");
  });

  it("assertBootConfig refuses to boot when the Live surface is unconfigured", () => {
    expect(() =>
      assertBootConfig(
        {
          DEPLOYMENT_MODE: "standard",
          DEEPGRAM_API_KEY: "dg-key",
          DATABASE_URL: "postgres://u:p@localhost:5432/db",
          IDENTITY_PLATFORM_PROJECT_ID: "vetra-uk-edc8ca",
        },
        { log: () => {} }
      )
    ).toThrow(/live_surface_not_configured/);
  });

  // The literal in bootChecks must not drift from the code that actually connects.
  it("announces the same default the client would use", () => {
    const { findings } = checkLiveSurface({ DEPLOYMENT_MODE: "standard", GEMINI_API_KEY: "k" });
    const announced = findings.find((f) => f.code === "live_surface");
    expect(announced.detail).toContain(LIVE_MODEL_DEFAULT);
  });
});
```

Add to the existing import at the top of `tests/bootChecks.test.js`:

```javascript
import { checkLiveSurface } from "../lib/bootChecks.js";
import { LIVE_MODEL_DEFAULT } from "../lib/voice/live/client.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/bootChecks.test.js -t "checkLiveSurface"`
Expected: FAIL — `checkLiveSurface is not a function` / import error.

- [ ] **Step 3: Implement `checkLiveSurface`**

Add to `lib/bootChecks.js`, immediately after `checkSttConfig` and before `assertBootConfig`. Add the import at the top of the file alongside the existing imports:

```javascript
import { liveSurface, LIVE_MODEL_DEFAULT } from "./voice/live/client.js";
```

```javascript
/**
 * The Live front-end must be able to reach a model, or not answer at all.
 *
 * ---------------------------------------------------------------------------
 * Why this is FATAL and not a notice
 * ---------------------------------------------------------------------------
 *
 * `createLiveClient` THROWS when the credential for the selected surface is
 * missing. `/twilio/live-voice` catches every throw and hands the caller to the
 * cascade — which is correct, and is exactly what makes this invisible. A
 * deployment missing GEMINI_API_KEY answers every call, sounds fine, books
 * appointments, and is running the front-end we thought we had replaced.
 * `live_connect_fallback` would be pegged, but nothing reads a counter at 3am.
 *
 * So the failure is moved from "every call, silently" to "the deploy, loudly".
 *
 * ---------------------------------------------------------------------------
 * The hipaa case, and why checkCoveredVendors cannot cover it
 * ---------------------------------------------------------------------------
 *
 * NON_COVERED_VENDORS["gemini-developer-api"] carries `credentials: []` — there
 * is no credential name for a scan to find, so the covered-vendor check reads
 * clean while the Developer API is exactly what the process would call.
 * `assertVendorAllowed` does refuse at construction, but that refusal is a
 * throw, and tier 2 swallows throws. Same silence, different door.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ findings: Array<{ code: string, severity: string, detail: string }>, surface: string }}
 */
export function checkLiveSurface(env = process.env) {
  const findings = [];
  const surface = liveSurface(env);
  const mode = (env.DEPLOYMENT_MODE || "").trim().toLowerCase();

  if (surface === "vertex") {
    if (!set(env.GOOGLE_CLOUD_PROJECT)) {
      findings.push({
        code: "live_surface_not_configured",
        severity: FATAL,
        detail:
          "LIVE_SURFACE=vertex needs GOOGLE_CLOUD_PROJECT. createLiveClient refuses to fall back " +
          "to the Gemini Developer API here, and /twilio/live-voice would catch that refusal and " +
          "serve every caller on the cascade instead — a downgrade nobody would hear.",
      });
    }
  } else {
    if (!set(env.GEMINI_API_KEY)) {
      findings.push({
        code: "live_surface_not_configured",
        severity: FATAL,
        detail:
          "GEMINI_API_KEY is not set and LIVE_SURFACE is not vertex, so the Live front-end cannot " +
          "open a session. /twilio/live-voice would fall back to the cascade on EVERY call and the " +
          "deployment would sound correct while running the front-end it was supposed to replace. " +
          "The key belongs in Secret Manager (scripts/push-secrets.js), not .env.",
      });
    }
    if (mode === "hipaa") {
      findings.push({
        code: "live_surface_not_covered",
        severity: FATAL,
        detail:
          "LIVE_SURFACE=aistudio in a DEPLOYMENT_MODE=hipaa process. The Gemini Developer API is " +
          "not a Google Cloud service and the Cloud BAA does not reach it, while a Live session " +
          "carries the caller's entire utterance. checkCoveredVendors cannot see this — " +
          "gemini-developer-api has no credential name to scan for. Covered alternative: " +
          "LIVE_SURFACE=vertex with GOOGLE_CLOUD_PROJECT.",
      });
    }
  }

  // Announced every boot. Which company processes caller speech, and on which
  // model, is the most consequential fact about this deployment and it is
  // selected by two variables that are easy to leave unset.
  findings.push({
    code: "live_surface",
    severity: ANNOUNCE,
    detail:
      `Live front-end surface: ${surface === "vertex" ? "Vertex AI" : "Gemini Developer API (AI Studio)"}` +
      `, model ${env.LIVE_MODEL || LIVE_MODEL_DEFAULT}` +
      (surface === "vertex" ? ` in ${env.VERTEX_LOCATION || "europe-west1"}` : ""),
  });

  return { findings, surface };
}
```

Then register it in `assertBootConfig`'s findings array, after `checkSttConfig(env).findings`:

```javascript
    ...checkSttConfig(env).findings,
    ...checkLiveSurface(env).findings,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/bootChecks.test.js`
Expected: PASS, all of them, including the pre-existing cases.

- [ ] **Step 5: Run the full root suite — this file runs at every boot, so a regression here is an outage**

Run: `npm test`
Expected: PASS. Compare the count against the last recorded gate (2604 passing at the last port). **Zero prompt snapshots moved.**

- [ ] **Step 6: Commit**

```bash
git add lib/bootChecks.js tests/bootChecks.test.js
git commit -m "feat(boot): refuse to boot a Live front-end that cannot reach a model

createLiveClient throws without the credential for the selected surface,
and /twilio/live-voice catches every throw to hand the caller to the
cascade. That is correct and it is what makes the misconfiguration
invisible: a deploy missing GEMINI_API_KEY answers every call, sounds
fine, and runs the front-end it was meant to replace.

Also fatal for aistudio in hipaa mode. checkCoveredVendors cannot catch
that one - gemini-developer-api carries credentials: [] so no scan
reaches it - and assertVendorAllowed's refusal is a throw, which tier 2
swallows through the same door."
```

---

### Task 2: Terraform — the Gemini credential, UK lane only

**Files:**
- Modify: `infra/terraform/secrets.tf` (one entry in `var.runtime_secrets.default`)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: Secret Manager secret `gemini-api-key` in `vetra-uk-edc8ca`, granted to the UK runtime service account, rendered onto both Cloud Run services as `GEMINI_API_KEY`.

**Why one entry is the whole change:** `cloud-run.tf:644` carries a `dynamic "env"` block iterating `var.runtime_secrets`, gated on `var.wire_runtime_secrets`. Adding the entry creates the secret, creates the IAM grant, and renders the variable — there is no second edit.

- [ ] **Step 1: Add the secret entry**

In `infra/terraform/secrets.tf`, inside `variable "runtime_secrets"`'s `default` map, after the `elevenlabs-api-key` entry:

```hcl
    gemini-api-key = {
      env_var = "GEMINI_API_KEY"
      lanes   = ["uk"]
      purpose = "The Live front-end's session credential. UK ONLY, and for the same reason as elevenlabs-api-key: the Gemini Developer API is not a Google Cloud service, so no BAA reaches it, and a Live session carries the caller's entire utterance. A US project must never hold it. Note that checkCoveredVendors cannot enforce this at boot - gemini-developer-api has no credential name to scan for - so this lane list IS the control, and lib/bootChecks.js checkLiveSurface is the second line."
    }
```

- [ ] **Step 2: Format and validate**

```bash
cd infra/terraform
terraform fmt
terraform validate
```
Expected: `fmt` exits 0 and rewrites nothing; `validate` prints `Success`.

- [ ] **Step 3: Confirm the derived wiring in `terraform console`, before any apply**

```bash
cd infra/terraform
terraform console
```
Then:
```
> local.runtime_secret_grants["uk-prod/gemini-api-key"].env_var
```
Expected: `"GEMINI_API_KEY"`.
```
> [for k, v in local.runtime_secret_grants : k if strcontains(k, "gemini")]
```
Expected: UK stacks only. **If any `us` stack appears, stop** — the lane boundary has not held and that is the control this entry rests on.

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/secrets.tf
git commit -m "feat(infra): the Gemini Live credential, UK lane only

Same boundary as elevenlabs-api-key and for the same reason: the Gemini
Developer API is not a Google Cloud service, no BAA reaches it, and a
Live session carries the caller's whole utterance. A US project must
never be able to read it.

One entry is the whole change - cloud-run.tf's dynamic env block over
var.runtime_secrets creates the secret, the grant and the variable."
```

---

### Task 3: Terraform — pin the Live surface and model

**Files:**
- Modify: `infra/terraform/variables.tf` (two variables)
- Modify: `infra/terraform/cloud-run.tf` (two `env` blocks in the voice service container)

**Interfaces:**
- Consumes: nothing.
- Produces: `LIVE_SURFACE` and `LIVE_MODEL` rendered on `voice-uk-prod`.

**Why pin a value that is already the default:** `LIVE_MODEL_DEFAULT` is a `-preview` model Google can withdraw on their own schedule. `client.js` already says "overridable so a withdrawal is a variable." Pinning makes the response to a withdrawal a Terraform edit rather than a code change during an outage. And rendering `LIVE_SURFACE` explicitly means the most consequential fact about the deployment — which company processes caller speech — is readable from the service definition instead of inferred from an absent variable.

- [ ] **Step 1: Add the variables**

Append to `infra/terraform/variables.tf`:

```hcl
# ---------------------------------------------------------------------------
# WHICH SURFACE SERVES THE LIVE SESSION, and therefore which company processes
# the caller's speech.
#
# `aistudio` is the Gemini Developer API. It is NOT a Google Cloud service: no
# ADC, no residency guarantee, no BAA. It is chosen anyway because it is the
# only surface `gemini-3.1-flash-live-preview` exists on, and because the
# alternative is a DIFFERENT MODEL that has never taken a call on this system.
#
# The latency argument for Vertex does not exist, measured: AI Studio 3.1 model
# leg p50 1043ms (n=25) against Vertex 2.5 in europe-west1 at 1053ms. And
# europe-west2 serves NO Live model on any surface - HTTP 400 at the WebSocket
# upgrade, 24 model/region cells probed - so "the data stays in the UK" cannot
# be promised for Live at all. The nearest Live region that exists is Belgium.
#
# The case for switching is compliance, not performance, and it has a date:
# before the first paying client, or immediately if 3.1 is withdrawn.
# ---------------------------------------------------------------------------
variable "live_surface" {
  description = "Live front-end surface: `aistudio` (Gemini Developer API) or `vertex`."
  type        = string
  default     = "aistudio"

  validation {
    condition     = contains(["aistudio", "vertex"], var.live_surface)
    error_message = "live_surface must be `aistudio` or `vertex`. lib/voice/live/client.js resolves anything unrecognised to aistudio silently, which is right while a caller is on the line and wrong in a deploy variable."
  }
}

# ---------------------------------------------------------------------------
# PINNED because it is a `-preview` model. Google can withdraw it on their
# schedule, not ours. Pinning here makes the response a variable change rather
# than a code change made under time pressure.
# ---------------------------------------------------------------------------
variable "live_model" {
  description = "Live model id. Must exist on `var.live_surface`."
  type        = string
  default     = "gemini-3.1-flash-live-preview"
}
```

- [ ] **Step 2: Render them onto the voice service**

In `infra/terraform/cloud-run.tf`, in the voice container's env section — put these immediately after the `DEEPGRAM_REGION` block, which is the closest neighbour in kind (a value the code reads and the module once failed to send):

```hcl
      # -------------------------------------------------------------------
      # WHICH COMPANY PROCESSES CALLER SPEECH ON THE LIVE PATH. Rendered
      # explicitly even though `aistudio` is the code's default, for the same
      # reason DEEPGRAM_REGION above is: an absent variable and a chosen one
      # are indistinguishable from the service definition, and this is not a
      # fact anyone should have to infer.
      #
      # Its absence is now also a FATAL boot check - lib/bootChecks.js
      # checkLiveSurface - because tier 2 catches the client's throw and would
      # otherwise serve every caller on the cascade in silence.
      # -------------------------------------------------------------------
      env {
        name  = "LIVE_SURFACE"
        value = var.live_surface
      }

      env {
        name  = "LIVE_MODEL"
        value = var.live_model
      }
```

- [ ] **Step 3: Format and validate**

```bash
cd infra/terraform
terraform fmt
terraform validate
```
Expected: `fmt` exits 0; `validate` prints `Success`.

- [ ] **Step 4: Sabotage-verify the validation rule**

Temporarily set `live_surface = "aistdio"` (a typo) in `terraform.tfvars`, run `terraform validate`, and confirm it FAILS with the custom error message. Then remove the line. A validation rule nobody has seen fail is a rule nobody knows works.

- [ ] **Step 5: Audit the three other variables the route reads and Terraform does not send**

Spec §3 names these. They are the same bug class as `CALL_STATE_STORE`, `DEEPGRAM_REGION` and `DB_POOL_MAX`, which each shipped read-but-unrendered.

```bash
grep -n "TRANSFER_NUMBER\|UNROUTED_TRANSFER_NUMBER\|CALL_MAX_DURATION_MINUTES" server.js lib/voice/live/*.js
grep -n "TRANSFER_NUMBER\|CALL_MAX_DURATION" infra/terraform/cloud-run.tf
```

For each of the three, decide **explicitly** and record the decision as a comment in `cloud-run.tf`:

- If the code's default is correct in production → add a one-line comment in `cloud-run.tf` next to the `DEEPGRAM_REGION` block naming the variable and why it is deliberately not rendered. An unrendered variable with no comment is indistinguishable from an oversight, which is how the last three got shipped.
- If the default is wrong in production → add a `variable` to `variables.tf` and an `env` block, in the same shape as `LIVE_SURFACE` above.

`TRANSFER_NUMBER` and `UNROUTED_TRANSFER_NUMBER` decide where a caller goes when the assistant hands off or the number is unrouted. If they are unset in production, find out what the code does with an unset value **before** deciding it is fine.

- [ ] **Step 6: Commit**

```bash
git add infra/terraform/variables.tf infra/terraform/cloud-run.tf
git commit -m "feat(infra): render LIVE_SURFACE and LIVE_MODEL on the voice service

Both are pinned rather than defaulted. LIVE_MODEL because 3.1 is a
-preview model Google can withdraw on their schedule, and client.js
already says a withdrawal should be a variable. LIVE_SURFACE because
which company processes caller speech should be readable from the
service definition, not inferred from an absent variable - the same
mistake DEEPGRAM_REGION, CALL_STATE_STORE and DB_POOL_MAX each made."
```

---

### Task 4: The mid-call instrument

**Why an instrument and not the fix:** a mid-call socket drop is still silence for the caller. Closing it needs an `action` URL on `<Connect>`, a Twilio mechanism nobody here has tried, and shipping an untested vendor mechanism during a platform migration means a bad call has two candidate causes. Four fixes on 2026-09-06 each introduced a defect, every one shipped on a single call's evidence. So this task ships the *rate*, and the fix gets decided against data.

**Files:**
- Create: `lib/voice/live/closeKind.js`
- Modify: `lib/voice/metrics.js` (register two counters)
- Modify: `lib/voice/live/index.js:3044` (the `onclose` callback)
- Test: `tests/liveCloseCounters.test.js` (create)

**Interfaces:**
- Consumes: `bumpCounter` and `getLatencyStats` / `clearStats` from `lib/voice/metrics.js`; `summary.recordClose(reason)` at `lib/voice/live/summary.js:113`.
- Produces: `export function classifyClose(e) -> "clean"|"abnormal"` from `lib/voice/live/closeKind.js`; counters `live_close_clean` and `live_close_abnormal`.

**Why a separate file for one function:** `lib/voice/live/index.js` is 3,271 lines and importing it pulls the whole Live session in. A pure classifier belongs where a unit test can reach it in isolation.

**How counters are read:** there is no `counters()` export. `getLatencyStats().turnTaking` is the registry, and `clearStats()` resets it — the pattern `tests/liveConnectFallback.test.js:108` already uses.

**Both halves are required.** A fault-only counter reads zero for a clean run and for a run that never got there. `live_close_clean` is what makes a zero on the other one mean something.

- [ ] **Step 1: Write the failing test**

Create `tests/liveCloseCounters.test.js`:

```javascript
// A mid-call socket drop is silence for the caller, and the fix for it is
// deliberately not built yet. This is the instrument that decides whether it
// needs to be: the RATE, on real calls, rather than an argument.
//
// Both counters exist on purpose. A fault-only counter reads zero for a clean
// call and for a call that never reached the socket at all.
import { describe, it, expect, beforeEach } from "vitest";
import { bumpCounter, getLatencyStats, clearStats } from "../lib/voice/metrics.js";
import { classifyClose } from "../lib/voice/live/closeKind.js";

const counters = () => getLatencyStats().turnTaking;

describe("classifyClose — telling a hang-up from a drop", () => {
  beforeEach(() => clearStats());

  it("a normal close is clean", () => {
    expect(classifyClose({ code: 1000, reason: "" })).toBe("clean");
  });

  it("a close with no event at all is clean — the vendor closed without saying why after a finished call", () => {
    expect(classifyClose(undefined)).toBe("clean");
  });

  it("a 1006 abnormal closure is abnormal", () => {
    expect(classifyClose({ code: 1006, reason: "" })).toBe("abnormal");
  });

  it("a 1011 internal error is abnormal", () => {
    expect(classifyClose({ code: 1011, reason: "internal error" })).toBe("abnormal");
  });

  it("a 1008 policy violation is abnormal — this is the vendor concurrency cap", () => {
    expect(classifyClose({ code: 1008, reason: "quota" })).toBe("abnormal");
  });

  it("both counters are registered so a zero can be read", () => {
    bumpCounter("live_close_clean");
    bumpCounter("live_close_abnormal");
    expect(counters().live_close_clean).toBe(1);
    expect(counters().live_close_abnormal).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/liveCloseCounters.test.js`
Expected: FAIL — `classifyClose` is not exported.

- [ ] **Step 3: Register the counters**

In `lib/voice/metrics.js`, in the same registry that holds `live_connect_ok` (around line 596), after `"live_connect_fallback"`:

```javascript
  // -------------------------------------------------------------------------
  // HOW THE LIVE SOCKET ENDED. The mid-call fallback is deliberately not built
  // -- it needs an `action` URL on <Connect> that nobody here has tried -- so
  // this pair is what decides whether it needs to be, on real calls rather
  // than on an argument.
  //
  // The clean half is not decoration. Without it, a deployment where no call
  // ever reached the socket reads exactly like a deployment where every call
  // ended politely.
  // -------------------------------------------------------------------------
  "live_close_clean",
  // The socket ended in a way the caller would have heard as silence.
  "live_close_abnormal",
```

- [ ] **Step 4: Implement `classifyClose` and wire the `onclose` callback**

Create `lib/voice/live/closeKind.js`:

```javascript
/**
 * Did this socket end, or did it drop?
 *
 * A close with no event is CLEAN, deliberately. The vendor closes without a
 * code after a finished call, and counting that as a fault would put the
 * abnormal rate at 100% and make the number useless on its first reading.
 *
 * @param {{ code?: number, reason?: string }|undefined} e
 * @returns {"clean"|"abnormal"}
 */
export function classifyClose(e) {
  const code = e?.code;
  if (code === undefined || code === null) return "clean";
  return code === 1000 || code === 1005 ? "clean" : "abnormal";
}
```

Then in `lib/voice/live/index.js`, add the import alongside the other `./` imports:

```javascript
import { classifyClose } from "./closeKind.js";
```

and replace the `onclose` callback at `lib/voice/live/index.js:3044`:

```javascript
          onclose: (e) => {
            const kind = classifyClose(e);
            bumpCounter(kind === "clean" ? "live_close_clean" : "live_close_abnormal");
            if (kind === "abnormal") {
              // Logged as well as counted: the counter says how often, and only
              // the log says which code, which is what picks the fix.
              log.error("live_close_abnormal", {
                callSid,
                code: e?.code ?? null,
                reason: e?.reason || null,
              });
            }
            summary.recordClose(e?.reason || null);
          },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/liveCloseCounters.test.js`
Expected: PASS.

- [ ] **Step 6: Run the full root suite**

Run: `npm test`
Expected: PASS, **zero prompt snapshots moved**.

- [ ] **Step 7: Commit**

```bash
git add lib/voice/metrics.js lib/voice/live/closeKind.js lib/voice/live/index.js tests/liveCloseCounters.test.js
git commit -m "feat(live): count how the socket ended, so the mid-call fix can be decided

A mid-call drop is still silence for the caller and the fix is
deliberately not in this change - it needs an action URL on <Connect>
that nobody here has tried, and an untested vendor mechanism is the
wrong thing to ship during a cutover.

Both halves are registered. A fault-only counter reads zero for a clean
run and for a run that never got there. A close with no code counts as
clean on purpose: the vendor closes silently after a finished call, and
counting that as a fault would peg the rate at 100% on first reading."
```

---

### Task 5: Deploy — **owner present, real GCP contact, real money**

Do not run this task unattended. It changes a live estate.

**Files:** none. This is operational.

**Interfaces:**
- Consumes: Tasks 1–4 merged to `main`.
- Produces: `voice-uk-prod` serving a revision built from `main`, with Live configured.

- [ ] **Step 1: Merge the branch to `main` and push**

```bash
git checkout main && git merge --no-ff feat/gcp-live-cutover && git push origin main
```

Note: if `main` fast-forwards to a SHA Railway staging already built, Railway produces **no prod deployment** and Redeploy does not rescue it — Redeploy rebuilds the ACTIVE deployment's commit. `--no-ff` above avoids that. Railway must keep serving for the rollback window in Task 6.

- [ ] **Step 2: Read the pending migration set off the live instance — do not assume it**

Cloud SQL is private-IP only, so this runs from inside the VPC:

```bash
CLOUDSDK_CONFIG=~/.gcloud-vetra2 gcloud run jobs execute vetra-migrate-uk-prod \
  --project vetra-uk-edc8ca --region europe-west2 \
  --args=--status --wait
```
Expected: a list of applied and pending migrations. 041 (`business_live_voice`) is expected pending. **Record the actual list** — the count is what step 4 verifies against.

- [ ] **Step 3: Apply the secret container only — its value cannot exist yet, and the service must not roll onto it empty**

`infra/terraform/secrets.tf`'s own header says Cloud Run refuses to start a revision whose secret cannot be resolved, and `cloud-run.tf`'s dynamic `env` block references `gemini-api-key` at `version = "latest"`. A plain `terraform apply` here would create the secret container AND roll the voice service onto it, empty, in the same apply — and that revision fails to start.

This is the U2 pattern (`docs/superpowers/plans/gcp-migration-ledger.md`, "FIVE secret values in `vetra-uk-prod-c3a3bd`, and it cannot happen before a partial apply"): target the secret resource, fill it, then apply the rest.

```bash
cd infra/terraform
terraform plan -target='google_secret_manager_secret.runtime' -out=secret.tfplan
terraform apply secret.tfplan
```
Expected: one resource added — `gemini-api-key`'s container, empty, no version. **If the plan also proposes the IAM grant or a new voice service revision here, stop** — this step exists to keep those apart from a secret that still holds nothing.

- [ ] **Step 4: Push the Gemini key value — directly, not through `push-secrets.js`**

`scripts/push-secrets.js`'s `MAPPING` docstring deliberately excludes `ELEVENLABS_API_KEY`, and now names `GEMINI_API_KEY` alongside it for the identical reason: both are UK-lane-only credentials with no BAA, neither secret exists in any US project, and the whole point of `MAPPING` is that a `--project vetra-us-...` invocation cannot inherit them from a shared `.env`. Adding either back to `MAPPING` breaks that boundary. **Do not add it, here or later.**

Add the version directly, and confirm by reading metadata — never the value:
```bash
export CLOUDSDK_CONFIG=~/.gcloud-vetra2
printf '%s' 'PASTE THE VALUE HERE — never a variable that could land in a log or shell history' | \
  gcloud secrets versions add gemini-api-key --project=vetra-uk-edc8ca --data-file=-
gcloud secrets versions list gemini-api-key --project=vetra-uk-edc8ca --limit=1
```
Expected: one version, `ENABLED`, with a `CREATED` timestamp — enough to confirm it landed without the command ever printing what it holds.

- [ ] **Step 5: The full apply, now that the secret has a value**

```bash
cd infra/terraform
terraform plan -out=live.tfplan
```
Read the plan. Expected: the IAM binding granting `gemini-api-key` to the UK runtime service account, and a new voice service revision carrying `GEMINI_API_KEY`, `LIVE_SURFACE`, `LIVE_MODEL` — on the image already running, since `image_tag` is untouched here. **If the plan proposes to replace the Cloud SQL instance or touch the KMS key ring, stop.**

```bash
terraform apply live.tfplan
```

- [ ] **Step 6: Build the image from `main`**

```bash
CLOUDSDK_CONFIG=~/.gcloud-vetra2 gcloud builds submit \
  --project vetra-uk-edc8ca \
  --config cloudbuild.yaml \
  --service-account=projects/vetra-uk-edc8ca/serviceAccounts/vetra-deployer@vetra-uk-edc8ca.iam.gserviceaccount.com \
  --substitutions=_IMAGE_TAG=$(git rev-parse --short HEAD)
```

`--service-account=vetra-deployer` is required: the default compute service account 403s on the Cloud Build source bucket.

**Do not trust cloudbuild.yaml's own migration guard** (P13) — it overrides WORKDIR with `/workspace`, so it reads the source rather than the image and cannot see what it claims to check.

- [ ] **Step 7: Verify the image by reading it, against `/app`**

```bash
CLOUDSDK_CONFIG=~/.gcloud-vetra2 gcloud run jobs execute vetra-migrate-uk-prod \
  --project vetra-uk-edc8ca --region europe-west2 \
  --args=--status --wait
```
Three controls, as in Phase 4: the migration count matches step 2's list, `041_business_live_voice.sql` is present, and `lib/voice/live/client.js` exists in the image.

- [ ] **Step 8: Run the migrate job — BEFORE the service rolls**

```bash
CLOUDSDK_CONFIG=~/.gcloud-vetra2 gcloud run jobs execute vetra-migrate-uk-prod \
  --project vetra-uk-edc8ca --region europe-west2 --wait
```
A service rolling ahead of its schema has bitten this project twice.

- [ ] **Step 9: Roll the voice service**

```bash
cd infra/terraform
terraform apply -var="image_tag=$(git rev-parse --short HEAD)"
```

`image_tag` defaults to `"0000000"`, a tag that does not exist. Passing it is not optional.

- [ ] **Step 10: Assert on the serving revision — six reads, not "a call worked"**

```bash
curl -s https://$(cd infra/terraform && terraform output -raw twilio_webhook_base | sed 's|https://||')/
```
The root page prints `Build: <sha> (<branch>)` with no token — the fastest way to answer "is my commit deployed?".

Then read the boot log:
```bash
CLOUDSDK_CONFIG=~/.gcloud-vetra2 gcloud logging read \
  'resource.labels.service_name="voice-uk-prod" AND textPayload:"[boot]"' \
  --project vetra-uk-edc8ca --limit 30 --freshness=10m
```

Required:
1. `Build:` sha equals `git rev-parse --short HEAD`
2. `[boot] notice live_surface: ... AI Studio ..., model gemini-3.1-flash-live-preview`
3. `db_backend cloudsql/IAM`
4. `call_state_store_selected store=pg shared=True`
5. `DEEPGRAM_REGION=eu`
6. **no `[boot] FATAL` line of any kind**

**If `live_surface_not_configured` appears, the service did not start and the key did not land.** That is this plan's boot check doing its job — fix step 4 and re-roll.

---

### Task 6: Cutover, verification call, and retirement — **owner present**

**The cutover here is smaller than it sounds.** `+441372656055` already points at GCP — `scripts/uk-number.js:64` records its live `voiceUrl` as `https://voice-uk-prod-462445274080.europe-west2.run.app/twilio/voice`, the **cascade** route. Railway is not in this number's path at all. The change is one path segment on the same host: `/twilio/voice` → `/twilio/live-voice`. The script appends `/twilio/live-voice` itself.

- [ ] **Step 1: Export account A's credentials and read the number live**

The token is in Secret Manager and deliberately not in `.env` — this number is on account A.

```bash
export TWA_SID=$(CLOUDSDK_CONFIG=~/.gcloud-vetra2 gcloud secrets versions access latest \
  --secret=twilio-account-sid --project=vetra-uk-edc8ca)
export TWA_TOK=$(CLOUDSDK_CONFIG=~/.gcloud-vetra2 gcloud secrets versions access latest \
  --secret=twilio-auth-token --project=vetra-uk-edc8ca)
node scripts/uk-number.js show
```

Confirm the live values match the `NUMBERS.uk` block in the script. **If they differ, stop and reconcile** — the restore path restores to *that block*, so a stale block means the restore puts the number somewhere it has never been. The last time this file was trusted rather than checked it was wrong.

Also confirm `voiceApplicationSid` is empty. A non-empty one silently overrides `voiceUrl`, so "voiceUrl is correct" is not on its own a statement that the number will reach the right place.

- [ ] **Step 2: Point it at the Live route on the same GCP host**

```bash
node scripts/uk-number.js point https://voice-uk-prod-462445274080.europe-west2.run.app
```

Run it once with no `--confirm` first — it prints BEFORE and the exact fields it will set, and changes nothing. Read that, then re-run with `--confirm`.

Use the Cloud Run service host, **never the load balancer `.uri` output** — a signature computed over the `.uri` host returns 403, verified in Phase 5.

- [ ] **Step 3: Confirm the read-back the script performs**

`point --confirm` re-reads the number and prints `AFTER`, then either "Pointed at the rig" or "MISMATCH — do not call yet". **Do not dial on a MISMATCH.** Never trust the update's own response: a leading newline in a routing value once made every business answer as "our office", and it looked correct everywhere it was displayed.

- [ ] **Step 4: The call. Call 1 must be the COLD one**

`cpu_idle` evidence appears only on turn one after an idle gap, and a second call spends it for ~15 minutes.

- Call 1 (cold): book an appointment. Listen for time-to-first-word after you stop speaking, dead air over ~2s, being cut off, whether it says the tenant's name and sounds British.
- Call 2: reschedule it.
- Call 3: barge in mid-sentence, and cough.

- [ ] **Step 5: Reconcile the calls against the database and the counters**

```bash
CLOUDSDK_CONFIG=~/.gcloud-vetra2 gcloud logging read \
  'resource.labels.service_name="voice-uk-prod" AND jsonPayload.event="counters"' \
  --project vetra-uk-edc8ca --limit 5 --freshness=30m
```

Required: `live_close_clean > 0` **and** `live_connect_fallback == 0`. **Not `live_connect_ok`** — it bumps inside `/twilio/live-voice`'s try block, which allowlists the caller, looks up the business and mints the stream token, and returns before any model is ever contacted; `createLiveClient` only runs later, inside `connectLive` in the WebSocket handler. A deploy with no Gemini key bumps `live_connect_ok` on every call too: pickup, dead air while `connectLive` throws and the socket closes with no verb behind `<Connect>`, then a hangup — never the cascade, and never distinguishable from a real connection on this counter alone. `live_close_clean` can: it bumps only from the Live socket's `onclose`, after a session that actually opened and closed at code 1000 or 1005 (Task 4 of this plan), so it cannot be reached without a real model session. Non-zero `live_connect_fallback` still means what it always did — callers served by the cascade without knowing; the fallback working, not a caller lost, but not a successful cutover either.

Record `live_close_abnormal` against `live_close_clean`. That ratio is the input to the mid-call fallback decision and this is its first reading.

Then verify the appointment rows say what the caller was told:
```bash
node scripts/db-inspect.js --appointments --since 1h
```

- [ ] **Step 6: Decide the number's resting state, and say which**

`restore --confirm` puts it back to `/twilio/voice` — the **cascade on GCP**, not Railway.

```bash
node scripts/uk-number.js restore --confirm
```

If the calls went well, the owner may prefer to leave it on `/twilio/live-voice`. Either is fine; **record which, in `docs/live-frontend-RESTORE.md`**, rather than leaving the number's state as an accident nobody wrote down.

- [ ] **Step 7: Railway stays warm for one week**

Do not delete anything yet. Note what the rollback actually is, since it differs by number: for `+441372656055` it is `uk-number.js restore --confirm`, one API call to GCP's cascade route — Railway is not involved. Railway's warm week protects `+18176011171`, which points at Railway staging and is `ASSISTANT_NUMBER` in `.env`, so `npm run probe` breaks the moment Railway stops. Set a reminder, and decide before the date whether the probe's dial plan needs a new target.

- [ ] **Step 8: After the week — retire Railway and Supabase**

1. Railway: delete the `staging` and `production` services.
2. Supabase: delete the project.
3. Sweep credentials — remove `SUPABASE_*` and Railway-specific values from local `.env` files. `SUPABASE_TIMEOUT_MS` is the exception: `services/db.js` still honours it as a fallback name for `DB_TIMEOUT_MS`, so removing it from `.env.example` fails `tests/envInventory.test.js`. Change the code first or leave the variable.
4. Run `npx vitest run tests/envInventory.test.js` — it fails in both directions and will catch a documented-but-dead variable.
5. Park account B's two numbers. Do not release them.

- [ ] **Step 9: Update the ledger and the roadmap**

Add a session row to `docs/superpowers/plans/gcp-migration-ledger.md` in the existing table format: what was done, what is left. Update `docs/roadmap.md` phase 2 ("Infrastructure — one canonical deployment, one database") with what actually closed and what did not.

```bash
git add docs/superpowers/plans/gcp-migration-ledger.md docs/roadmap.md docs/live-frontend-RESTORE.md
git commit -m "docs: the Live front-end runs on GCP, and Railway is gone"
```

---

## What this plan does not close

Written down so the next session does not have to rediscover it:

- **Phase 1's outstanding leg.** A UK business ringing from a UK handset. Every call here is dialled by the owner.
- **Vertex 2.5 is unmeasured** on the corrected 10-tool harness. Trigger: before the first paying client, or immediately if 3.1 is withdrawn.
- **Mid-call silence.** Instrumented by Task 4, not fixed.
- **Spec §6** — uptime alerting, CI, dashboard frontend hosting, dashboard PHI-access audit. Its own plan.
- **Precondition 6** — a Google account belonging to Josh holding `billing.admin` and `organizationAdmin`.

---

## Task 5 as EXECUTED, 2026-09-07 — two commands in this plan were wrong

Task 5 ran end to end and all ten steps passed. Two of its commands did not
work as written and were corrected in flight. Both are recorded here because
the failure each produces names something else.

**Steps 2 and 7 — the migrate job invocation.** `migrate-job.tf:177-185` sets
`command = ["node"]` and `args = ["scripts/migrate.js", "--init-if-empty"]`.
`--args=--status` REPLACES the whole args list, so the container ran
`node --status` and exited 9 with `bad option: --status`. The working form
keeps the script path:

```bash
--args=scripts/migrate.js,--status
```

**Step 6 — the build command was wrong in three ways at once**, and failed
with `HTTPError 412: 'us' violates constraint 'constraints/gcp.resourceLocations'`,
which names a location policy and not any of the three actual mistakes. The
authoritative command is the one in `cloudbuild.yaml`'s own header (corrected
2026-09-02): the build belongs to **`vetra-core-edc8ca`**, which owns Artifact
Registry, with THAT project's deployer service account, and the substitution is
**`_TAG`**, not `_IMAGE_TAG`:

```bash
CLOUDSDK_CONFIG=~/.gcloud-vetra2 gcloud builds submit   --config=cloudbuild.yaml   --project=vetra-core-edc8ca   --service-account=projects/vetra-core-edc8ca/serviceAccounts/vetra-deployer@vetra-core-edc8ca.iam.gserviceaccount.com   --substitutions=_TAG=$(git rev-parse --short HEAD)
```

Build `ad4836e3` SUCCESS in 40s once used.

**Also learned:** `terraform` on this machine needs `TF_DISABLE_PLUGIN_TLS=1`
on every command that loads provider schemas, or all three providers fail with
`x509: certificate signed by unknown authority` — a local TLS interceptor
breaking Terraform's loopback plugin mTLS. Session-local, never committed.

**Result:** `voice-uk-prod` serving `818cca8`, revision
`voice-uk-prod-00010-jt9`, `041_business_live_voice.sql` applied before the
roll, all six step-10 reads green, no `[boot] FATAL`.
