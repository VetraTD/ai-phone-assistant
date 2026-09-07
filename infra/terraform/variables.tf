variable "org_id" {
  description = <<-EOT
    GCP organization ID. Numeric, not a domain.

    ATTEMPT 2: `208508072539` (`vetratd-org`), which NOBODY CREATED — Google
    auto-provisions an organization for a new account at signup, with six
    secure-by-default policies already set on it. Probed 2026-08-28; the
    account holds `roles/resourcemanager.organizationAdmin` on it.

    This is not the attempt-1 org. `564252011558` and every project under it
    were suspended on 2026-08-25 and are gone.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[0-9]{6,}$", var.org_id))
    error_message = "org_id must be the numeric organization ID (e.g. 208508072539), not the domain name."
  }
}

variable "billing_account" {
  description = "Cloud Billing account ID in XXXXXX-XXXXXX-XXXXXX form."
  type        = string

  validation {
    condition     = can(regex("^[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{6}$", var.billing_account))
    error_message = "billing_account must look like 01C71E-7C0893-377AE9."
  }
}

variable "bootstrap_project_id" {
  description = <<-EOT
    The project Terraform's own API calls are billed and quota'd against. It is
    NOT where resources land.

    ATTEMPT 2 ORDERING, and it is the reverse of where attempt 1 ended up:
    NONE OF THE THREE PROJECTS EXIST YET, so the first apply cannot route its
    own API calls through one of them. It points at the scratch project until
    `core` exists, then moves — README, "After the first apply".

    ⚠ WHATEVER THIS POINTS AT NEEDS EVERY API IN `local.terraform_quota_apis`
    ENABLED ON IT, BEFORE THE FIRST APPLY. Not "the ones you think you need" —
    the whole list. The failure is a 403 that NAMES THIS PROJECT and reads as a
    permissions problem:

      Cloud Resource Manager API has not been used in project ... or it is
      disabled

    Attempt 1 recorded this trap FIVE separate times, each time as a separate
    failed apply dying on a different missing API, and it fired again on
    2026-08-28. Enabling an API is free. See the README's bootstrap section.
  EOT
  type        = string
}

variable "project_prefix" {
  description = "Prefix for generated project IDs. Project IDs are globally unique and immutable."
  type        = string
  default     = "vetra"
}

variable "project_id_suffix" {
  description = <<-EOT
    The suffix baked into every project ID: `<prefix>-<key>-<suffix>`.

    Originally a `random_id`, to stop a first apply failing on a globally-taken
    name like `vetra-us-prod`. That purpose is spent — the projects exist, and
    a project ID is IMMUTABLE. Leaving it random meant the IDs were reproducible
    only from Terraform state, so losing state renamed every project. Which is
    exactly what happened: B0a's state is gone and the projects are not.

    Set it to the recorded suffix and the module can be rebuilt from the config
    alone. Leave it empty and a fresh `random_id` is generated, which is correct
    only for a genuinely new organization.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.project_id_suffix == "" || can(regex("^[a-z0-9]{4,12}$", var.project_id_suffix))
    error_message = "project_id_suffix must be 4-12 lowercase alphanumerics, or empty to generate one."
  }
}

# ---------------------------------------------------------------------------
# The stack -> project map.
#
# A STACK is a logical unit — "the UK production environment". A PROJECT is a
# GCP billing, quota and IAM boundary.
#
# ATTEMPT 2: THREE STACKS, THREE PROJECTS, AND THE KEYS ARE NO LONGER THE SAME
# STRINGS. `uk-prod` lands in project `uk`, `us-prod` in `us`, `shared` in
# `core`. Project IDs are built from the PROJECT key (projects.tf), so this map
# is what makes them `vetra-uk-<suffix>` instead of `vetra-uk-prod-<suffix>`.
#
# In attempt 1 this variable was a DIAL: six stacks, and pointing two of them at
# one project was the 6 -> 4 collapse the billing account's 5-linked-project cap
# forced. THAT CAP IS GONE — the billing account is paid. What is left is the
# indirection itself, which is still worth having: it is the seam that lets a
# stack move between projects without a module rewrite, and it is the reason
# `local.projects` derives a project's attributes as the UNION of its stacks.
#
# What a merge may NEVER touch: `us-prod` and `uk-prod`. A validation below
# refuses it. That split is the credential boundary — a US project holds no
# ElevenLabs key — and Cloud SQL instances and Identity Platform tenants cannot
# be moved between projects afterwards, so it would be close to permanent.
# ---------------------------------------------------------------------------
variable "stack_projects" {
  description = <<-EOT
    Which project each stack lives in. Keys are the three stacks; values are the
    project key each one is provisioned into.

    The default is the attempt-2 estate and is meant to be used as-is. Point two
    stacks at one project and they share it, with the sharing project taking the
    UNION of their locations, APIs and PHI flag — never the intersection.
  EOT
  type        = map(string)

  default = {
    uk-prod = "uk"
    us-prod = "us"
    shared  = "core"
  }

  validation {
    condition = length(setsubtract(
      ["uk-prod", "us-prod", "shared"],
      keys(var.stack_projects)
    )) == 0
    error_message = "stack_projects must name all three stacks: uk-prod, us-prod, shared."
  }

  validation {
    condition = length(setsubtract(
      keys(var.stack_projects),
      ["uk-prod", "us-prod", "shared"]
    )) == 0
    error_message = "stack_projects may name ONLY uk-prod, us-prod and shared. A stack key with no entry in local.stacks fails later, deep inside a for-expression, with an error that names neither this variable nor the typo."
  }

  # Attempt 1 asserted here that every value must itself be a KEY of this map,
  # because back then a project inherited its namesake stack's display name and
  # region. It does not any more — `local.projects` derives both from the stacks
  # actually in the project — so that assertion is void and would refuse the
  # correct default. What still has to hold is that the value can be part of a
  # project ID: `<prefix>-<value>-<suffix>` must be a legal, DNS-shaped name.
  validation {
    condition     = alltrue([for v in values(var.stack_projects) : can(regex("^[a-z][a-z0-9-]{0,20}[a-z0-9]$", v))])
    error_message = "Every project key must be lowercase alphanumerics and hyphens, starting with a letter — it is spliced into the project ID as <prefix>-<key>-<suffix>, and a project ID is IMMUTABLE."
  }

  # The credential boundary, as a validation rather than a comment. A merge that
  # put a prod stack in a shared project would silently undo the one property
  # the split exists to make structural.
  validation {
    condition = alltrue([
      for s in ["us-prod", "uk-prod"] :
      length([for k, v in var.stack_projects : k if v == var.stack_projects[s]]) == 1
    ])
    error_message = "us-prod and uk-prod must each have a project to themselves. The prod split is the credential boundary — a US project holding no ElevenLabs key — and Cloud SQL and Identity Platform cannot be moved between projects afterwards."
  }
}

# ---------------------------------------------------------------------------
# The compliance tier the deployed services run in.
# ---------------------------------------------------------------------------
variable "deployment_mode" {
  description = <<-EOT
    `standard` or `hipaa`, passed to every voice service as `DEPLOYMENT_MODE`.

    `standard` ON BOTH LANES, and that is the decision rather than a default
    nobody revisited. There is NO GCP BAA. US healthcare is closed on Twilio's
    $2,000/month BAA, which no amount of Google configuration reaches around,
    so a covered US lane would be a compliance claim resting on an uncovered
    telephony leg.

    `hipaa` STAYS IN THE CODE AND IN THE TESTS AND IS DEPLOYED NOWHERE. The
    covered-vendor guard, the credential boundary and the CMEK assertions are
    all still exercised by the suite; what is not paid for is running them.

    ⚠ THIS IS NOT A ONE-LINE FLIP, whatever the type suggests. Setting `hipaa`:
      * makes the voice service REFUSE TO BOOT if a Deepgram credential is
        present (`checkCoveredVendors`) — so the US lane needs Google STT v2,
        which needs the CMEK key ring speech.tf provisions and the out-of-band
        `npm run stt:cmek` PATCH that no Terraform resource can replace;
      * leaves `elevenlabs-api-key` scoped UK-only in secrets.tf, so a covered
        US service has no voice either.
    Read the parked finding in the Phase 2 ledger section before trying it.
  EOT
  type        = string
  default     = "standard"

  validation {
    condition     = contains(["standard", "hipaa"], var.deployment_mode)
    error_message = "deployment_mode must be \"standard\" or \"hipaa\". lib/bootChecks.js accepts no other value and exits on one it does not recognise."
  }
}

variable "project_deletion_policy" {
  description = <<-EOT
    What `terraform destroy` is allowed to do to a PROJECT. "PREVENT" or "DELETE".

    PREVENT by default. See the long note in projects.tf: a deleted project
    holds its ID for 30 days, project deletion is on this repo's owner-present
    list, and B0a demonstrated that state is the fragile half while the projects
    are the durable one.

    Set DELETE only for a genuinely disposable environment.
  EOT
  type        = string
  default     = "PREVENT"

  validation {
    condition     = contains(["PREVENT", "DELETE"], var.project_deletion_policy)
    error_message = "project_deletion_policy must be \"PREVENT\" or \"DELETE\"."
  }
}

variable "project_display_names" {
  description = <<-EOT
    Display names, keyed by PROJECT (not stack).

    This stopped being an "override" in attempt 2 and became the primary source.
    Project keys are no longer stack keys, so the fallback — the display name of
    the project's sole stack — would name a project `uk` "Vetra UK Prod", which
    is the old estate's vocabulary in the one place someone forms their mental
    model of what is running. The default below names all three.

    Unlike the project ID, the display name is MUTABLE, so getting it wrong is
    cheap. Keep it that way: a project hosting more than one stack must say so.

    ⚠ NO PARENTHESES. Measured on the first Phase 4 plan, 2026-08-28: "Vetra US
    (dark)" was REFUSED by the provider before anything was created --
    `name must be 4 to 30 characters with lowercase and uppercase letters,
    numbers, hyphen, single-quote, double-quote, space, and exclamation point`.
    `terraform validate` does NOT catch it (the value is a plain string), and
    because `google_project.this` is a for_each, the one bad member aborted the
    plan walk and every downstream resource went unplanned -- so the symptom was
    an 8-resource plan, not an obviously-cosmetic error.
  EOT
  type        = map(string)
  default = {
    uk   = "Vetra UK"
    us   = "Vetra US - dark"
    core = "Vetra Core"
  }
}

variable "adopt_existing_projects" {
  description = <<-EOT
    Projects that already exist in GCP and should be ADOPTED into state rather
    than created, keyed by project key. Drives `import` blocks in imports.tf.

    This exists because B0a's local state was lost while the resources it
    created were not. Import blocks are the right shape for that: `plan` renders
    exactly what would be adopted and writes nothing, so the state change
    happens on an apply the owner runs, not on a plan a session runs.

    EMPTY IS THE STEADY STATE. Fill it for the adoption apply, then empty it —
    Terraform errors on an import block targeting an address already in state.
  EOT
  type        = map(string)
  default     = {}
}

variable "adopt_existing_org_policies" {
  description = <<-EOT
    Org-node policy constraints that already exist and should be adopted rather
    than created, e.g. ["iam.disableServiceAccountKeyCreation"]. Same reasoning
    and same lifecycle as adopt_existing_projects.
  EOT
  type        = list(string)
  default     = []
}

variable "owner_principals" {
  description = <<-EOT
    Principals with full access to every project, in `user:email` form.
    The founder who administers the infrastructure.
  EOT
  type        = list(string)
}

variable "shared_only_principals" {
  description = <<-EOT
    Principals granted access to `vetra-shared` ONLY — Artifact Registry and
    Cloud Build — and to no project that can hold PHI.

    This is the per-founder split. A cofounder working on the website and the
    build pipeline has no reason to reach vetra-us-prod, and here that is
    enforced by IAM rather than by remembering. Leave empty if nobody needs it;
    an empty list grants nothing, which is the correct default.
  EOT
  type        = list(string)
  default     = []
}

variable "us_region" {
  description = "Region for the US (HIPAA) stack."
  type        = string
  default     = "us-central1"
}

variable "uk_region" {
  description = "Region for the UK (GDPR) stack. europe-west2 is London."
  type        = string
  default     = "europe-west2"
}

variable "labels" {
  description = "Labels applied to every project."
  type        = map(string)
  default = {
    managed-by = "terraform"
    system     = "vetra-receptionist"
  }
}

# ---------------------------------------------------------------------------
# B3.
# ---------------------------------------------------------------------------
variable "dashboard_url" {
  description = <<-EOT
    The address owner notifications link to, INCLUDING the path.

    `services/notifications.js` deliberately carries no caller or patient
    information — email and SMS are not covered channels, so the message says
    which business and what KIND of thing happened, and the details stay behind
    authentication. That makes the link the entire usable content of the
    notification. Without it the text reads "Open your Vetra dashboard for the
    details" and names no dashboard, which `lib/bootChecks.js` announces at boot
    as a notice rather than a fatal.

    The dashboard BACKEND reads it too, for the Art. 15 appointment export mail
    (`routes/appointments.js`), so both services get it.

    IT MUST CARRY `/app`, AND A BARE ORIGIN IS WRONG RATHER THAN MERELY UGLY.
    Firebase Hosting rewrites `**` to index.html and the SPA routes client-side:
    `/` is the marketing Landing page and `/app` is the dashboard. A link to the
    origin drops a member of staff who clicked "you have a new appointment" onto
    a marketing page.

    The host must also appear in `dashboard_domains`, and that is checked below
    rather than trusted. The two are independent settings that have to agree:
    `dashboard_domains` is the CORS allow-list for the dashboard API, so a
    DASHBOARD_URL pointing at an origin missing from it produces a link that
    loads a sign-in form and is then refused on every API call — which surfaces
    to a member of staff, in an email, as a dashboard that is simply broken.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.dashboard_url == "" || can(regex("^https://[^/]+/.+", var.dashboard_url))
    error_message = "dashboard_url must be an https:// URL WITH a path — e.g. https://<host>/app. The bare origin serves the marketing page, not the dashboard."
  }

  validation {
    # Cross-variable validation, which needs Terraform >= 1.9 — already required
    # in versions.tf. The check exists because these two settings are edited in
    # different places for different reasons and nothing else would notice them
    # disagreeing until a clinic reported a broken link.
    condition = (
      var.dashboard_url == "" ||
      !can(regex("^https://([^/]+)/", var.dashboard_url)) ||
      contains(var.dashboard_domains, regex("^https://([^/]+)/", var.dashboard_url)[0])
    )
    error_message = "dashboard_url's host is not in dashboard_domains, so the dashboard API would refuse it on CORS. Add the host there, or point this at one that is already listed."
  }
}

variable "dashboard_domains" {
  description = <<-EOT
    Domains the dashboard is served from, beyond localhost and the two
    Google-owned defaults. Identity Platform will only send a password-reset or
    verification continue URL to an authorized domain, so a domain missing here
    produces a reset email whose link is refused — a failure that surfaces to a
    locked-out member of staff rather than to a deploy.

    IT IS ALSO THE ONLY SOURCE OF THE DASHBOARD API'S CORS ALLOW-LIST
    (cloud-run-dashboard.tf), and that is the half with teeth. The backend
    defaults to vetratd.com and www; the SPA is served from Firebase Hosting at
    `<shared>.web.app`, which is neither. Leave this empty and the deployed
    dashboard renders its sign-in form and is refused on every API call —
    verified in a browser, not inferred.

    NO LONGER EMPTY ON PURPOSE. It was, while B5's load balancer waited on DNS;
    the owner chose Firebase Hosting instead on 2026-08-23, which needs no DNS,
    so the reason for leaving it blank is gone. Set it to the hosting origin.

    STILL OUTSTANDING, and deliberately not bundled into that change:
    browser_key_restrictions on google_apikeys_key.identity_platform_web. The
    referrer is now a known value rather than a guess, so it is finally
    possible — but it is hardening that is not required to serve the dashboard,
    and adding an untestable failure mode to the one apply that has to succeed
    is how a working deploy becomes a locked-out clinic. See identity-platform.tf.
  EOT
  type        = list(string)
  default     = []

  validation {
    # A bare hostname, never a URL. Identity Platform wants "app.vetratd.com";
    # pasting "https://app.vetratd.com/" is accepted by the API and matches
    # nothing, which fails as a reset link that silently does not work.
    condition     = alltrue([for d in var.dashboard_domains : can(regex("^[a-z0-9.-]+$", d))])
    error_message = "dashboard_domains takes bare hostnames — no scheme, no path, no trailing slash."
  }
}

# ---------------------------------------------------------------------------
# THE INTENT ROUND-TRIP. Added 2026-09-01, after a live call measured it.
#
# Unset, the model is offered `set_call_intent` as a real tool and calls it
# BEFORE it speaks — so every turn costs TWO sequential model round-trips, and
# the caller waits through both. Measured on `voice-uk-prod-00003-znz`:
# `llm_tool_ms` 1,669-2,001ms for a tool whose own `tool_duration` is 5-7ms,
# then `llm_reply_after_tool_ms` 1,028-1,421ms on top. `llm_ttfb_ms` came to
# 2,772-3,422ms, which was 72-97% of each turn.
#
# The architectural fix already exists and has been ON IN RAILWAY since
# 2026-08-04: the model writes `<<intent:x>>` as the first line of its reply
# and `services/gemini.js` strips it, so the intent rides the reply that was
# going to be streamed anyway. Measured then: `llm_ttfb_ms` 1,836 -> 940ms
# (-49%), `true_v2v_ms` p50 3,062 -> 2,607ms, turns paying a tool round-trip
# 80% -> 35%.
#
# ⚠ NOTHING IN THIS MODULE HAD EVER SET IT, so the GCP estate ran the slow path
# while `main` ran the fast one — and the migration's stated requirement is that
# the receptionist behave IDENTICALLY. This is the same failure shape as
# DEEPGRAM_REGION and CALL_STATE_STORE: a flag that exists, is documented in
# `.env.example`, is covered by tests, and is set by no deployment.
#
# ⚠ THE VALUE IS COMPARED AS A STRING. `services/gemini.js:486` is
# `process.env.VOICE_INTENT_MARKER === "true"` — so it is rendered explicitly
# rather than interpolated from the bool, and `false` reaches the same code path
# as unset rather than being a third state.
#
# Defaulted ON to match Railway. A deployment that wants the tool path back sets
# this to false and should say why in the ledger, because it costs ~2s a turn.
# ---------------------------------------------------------------------------
variable "voice_intent_marker" {
  description = <<-EOT
    Route the call intent through a marker in the reply text instead of a
    speech-blocking `set_call_intent` tool call.

    ON in Railway since 2026-08-04. Worth ~2s per turn: without it every turn
    pays two sequential model round-trips before the caller hears a word.
  EOT
  type        = bool
  default     = true
}

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
