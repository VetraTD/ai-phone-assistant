/**
 * The capability pack contract.
 *
 * A capability pack is everything the receptionist knows about one business
 * capability — appointments, message-taking, quotes, billing — in a single
 * file. Nothing about that capability lives anywhere else: not a branch in
 * services/gemini.js, not a case in services/tools.js, not a field name in
 * lib/voice/session.js.
 *
 * Adding a capability must be ONE new file plus one line in the registry.
 * If it ever requires editing an engine file, the seam is wrong — see
 * docs/superpowers/specs/2026-07-22-capability-packs-design.md, Step C.
 *
 * ---------------------------------------------------------------------------
 * WHAT BELONGS WHERE
 *
 *   ENGINE (hardcoded, never per-tenant)
 *     turn-taking, VAD, barge-in, TTS/STT, circuit breakers, the step machine,
 *     the function-call loop, fallback, safety guardrails, prompt STRUCTURE,
 *     and the two engine tools (set_call_intent, end_call) — end_call always,
 *     set_call_intent unless VOICE_INTENT_MARKER moves it into the reply text.
 *
 *   CAPABILITY PACK (this contract)
 *     which tools exist for a capability, what the prompt says about it, what
 *     its rules are, what happens when a tool runs, and what state effects
 *     follow.
 *
 *   TENANT CONFIG (data, per business)
 *     whether the capability is on, which adapter it uses, its enforced
 *     `require` block, and its free-text `notes`.
 *
 *   ADAPTER (code, swappable per tenant)
 *     where the data actually goes — athenahealth, Google Calendar, the
 *     internal DB, a webhook. Behind one interface per adapter kind.
 *
 * ---------------------------------------------------------------------------
 * KINDS vs VALUES — the rule that keeps this from becoming a workflow DSL
 *
 * The engine owns a small, fixed set of rule KINDS. Operators supply unlimited
 * VALUES of those kinds. A clinic requiring a "dental number" before booking is
 * a new VALUE of the existing `identity` kind — it needs zero code. Inventing a
 * new keyword per customer request would be the same hardcoding trap in a new
 * costume, so new kinds are added rarely and deliberately.
 *
 * Structured config is reserved for things that must be ENFORCED. The test:
 * "if the AI ignores this, does someone get hurt, sued, or angry?" If yes, it
 * is a kind, checked in code. If no, it belongs in the prose `notes` field —
 * prompt text is a request, never a guarantee.
 */

/**
 * @typedef {object} CapabilityConfig
 * @property {boolean} enabled
 * @property {string} [adapter] - adapter id for this capability's adapterKind
 * @property {object} [adapterConfig] - adapter-specific settings/credentials ref
 * @property {object} [require] - the enforced kinds (see RequireBlock)
 * @property {string} [notes] - free-text, pasted into the prompt, NOT enforced
 */

/**
 * The enforced kinds. This list is intentionally short and grows slowly.
 *
 * @typedef {object} RequireBlock
 * @property {IdentityRequirement} [identity] - facts required before a write tool may run
 * @property {boolean} [confirmBeforeWrite] - read-back plus an explicit yes required
 * @property {string[]} [requiredFields] - tool arguments that may not be missing
 * @property {boolean} [businessHoursOnly] - refuse writes while the business is closed
 */

/**
 * @typedef {object} IdentityRequirement
 * @property {string[]} [builtin] - e.g. ["name", "dob", "phone_on_file"]
 * @property {CustomIdentityField[]} [custom]
 */

/**
 * An operator-defined identity field. A VALUE of the `identity` kind — no code
 * is written per field.
 *
 * @typedef {object} CustomIdentityField
 * @property {string} key - stable id, e.g. "dental_number"
 * @property {string} label - human label for the dashboard
 * @property {string} ask - how the receptionist should ask for it, verbatim
 * @property {string} [pattern] - optional RegExp source the value must match
 * @property {"collect_only"|{adapter_field: string}} verify
 *   `collect_only` means the write tool refuses until the field is collected and
 *   matches `pattern`. It does NOT compare the value to any record — that is
 *   `{adapter_field}`, which requires the adapter to declare the field in its
 *   `verifiableFields`, and is deferred until athena production access lands.
 */

/**
 * A tool declaration, in Gemini function-declaration shape plus our own
 * `isAction` marker.
 *
 * @typedef {object} CapabilityTool
 * @property {string} name - must be globally unique across all enabled packs
 * @property {string} description
 * @property {object} parameters - JSON Schema
 * @property {boolean} [isAction] - true if a success is caller-visible and
 *   should unlock same-turn end_call. Replaces the hardcoded ACTION_TOOL_NAMES
 *   list in services/gemini.js.
 * @property {boolean} [isLookup] - true if the tool reads rather than writes;
 *   requirement checks that gate writes do not apply.
 */

/**
 * Prompt contributions. The assembler slots these into the engine's fixed
 * section skeleton — a pack never controls section order or the safety text.
 *
 * The static/dynamic split is load-bearing: Gemini's implicit caching hits on a
 * stable PREFIX, so anything that varies per turn (step, intent, current time)
 * must land in `dynamic`. A pack leaking step-dependent text into `static`
 * collapses cache hit rate with no functional symptom — tests/promptSnapshot.js
 * asserts against exactly that.
 *
 * @typedef {object} CapabilityPrompt
 * @property {object} [static]
 * @property {string[]} [static.capabilities] - clauses for the CAPABILITIES line
 * @property {string[]} [static.protocols] - full sections, e.g. MESSAGE PROTOCOL
 * @property {string[]} [static.guardrails] - bullet lines for GUARDRAILS
 * @property {string[]} [static.toolContract] - bullet lines for TOOL CONTRACT
 * @property {object} [dynamic]
 * @property {Record<string, string>} [dynamic.stepGuidance] - keyed by intent
 */

/**
 * A side effect the engine must apply after a tool succeeds. Replaces the
 * hardcoded `appointmentArgs` / `customerRequestArgs` fields that services/
 * gemini.js and lib/voice/session.js used to name directly.
 *
 * @typedef {object} CapabilityEffect
 * @property {string} capability - owning pack id
 * @property {string} type - pack-defined, e.g. "booked", "cancelled", "recorded"
 * @property {object} data
 */

/**
 * Primitives the engine hands a pack in `onEffect`. A pack may only ask for
 * these — it cannot reach into session state directly.
 *
 * @typedef {object} EngineContext
 * @property {(step: string, trigger: string) => void} setStep
 * @property {(kind: string, payload: object) => void} notify
 * @property {(note: string) => void} addHistoryNote - bracketed system note the
 *   model treats as trusted state, never as caller speech
 * @property {object} config - normalised business config
 */

/**
 * @typedef {object} CapabilityPack
 * @property {string} id
 * @property {boolean} [core] - always on, not opt-in, cannot be disabled
 * @property {string|null} [adapterKind] - e.g. "scheduling"; null if self-contained
 * @property {object} [configSchema] - validates CapabilityConfig; later drives the UI
 * @property {(cfg: CapabilityConfig, ctx: object) => CapabilityTool[]} [tools]
 * @property {(cfg: CapabilityConfig, ctx: object) => CapabilityTool[]} [adapterTools]
 *   Tools whose shape depends on which backend is active. TRANSITIONAL: in Step A
 *   this reproduces today's EHR-vs-DB fork; Step B replaces it with real adapters
 *   and this hook goes away.
 * @property {(cfg: CapabilityConfig, ctx: object) => CapabilityPrompt} [prompt]
 * @property {(cfg: CapabilityConfig) => RequireBlock} [requirements]
 * @property {(toolName: string, args: object, ctx: object) => Promise<object>} [execute]
 * @property {(effect: CapabilityEffect, engine: EngineContext) => void} [onEffect]
 */

export {};
