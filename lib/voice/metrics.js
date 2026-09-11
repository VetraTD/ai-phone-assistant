import { performance } from "node:perf_hooks";
import { recordTurnLatency } from "../logger.js";

// ---------------------------------------------------------------------------
// Per-turn latency tracker for the real-time voice pipeline.
//
// One `createTurnMetrics(callSid)` tracker is created per call and stored on
// the call's state object. Pipeline stages call `mark(name)` as they happen;
// `finishTurn()` computes the deltas for the completed turn, appends the
// result to a module-level ring buffer (for the /api/debug/latency endpoint),
// and forwards the payload to the structured logger.
//
// Stage names (call in this order over the life of one turn):
//   audio_speech_end  — the caller ACTUALLY stopped talking, back-computed from
//                       Deepgram's word timings (see sttStream.getLastFinalLagMs).
//                       Everything between here and speech_end is Deepgram's
//                       endpointing window + network + inference — time the
//                       caller is waiting that this process cannot otherwise see.
//   speech_end        — Deepgram final transcript triggers the turn
//   stt_final         — STT finalized (currently same instant as speech_end)
//   context_wait_start/_end — bracket the first turn's wait on the call-start
//                       prefetch. Marked only when the wait is real, so the
//                       delta is null on turns 2+.
//   llm_request       — about to start the Gemini streaming call
//   llm_first_tool    — first tool of the turn finished executing. Only set on
//                       turns that call one. Exists because llm_first_chunk is
//                       stamped on the first TEXT delta, so a turn that emits a
//                       function call and no text in its first round hides that
//                       whole round-trip inside llm_ttfb_ms. Splitting it is
//                       what makes set_call_intent's cost visible at runtime
//                       rather than inferred from a probe run.
//   llm_first_chunk   — first text delta received from Gemini
//   tts_first_byte    — first sentence's TTS audio finished synthesizing
//   first_audio_sent  — first Twilio media frame of the turn was ENQUEUED
//   first_frame_wire  — that frame was actually written to the Twilio socket.
//                       Non-zero because audioOut paces playout (LOOKAHEAD_MS)
//                       rather than dumping the utterance into Twilio's buffer.
//
// The two outermost marks exist because `voice_to_voice_ms` measures
// speech_end -> first_audio_sent, which is an in-process window: it excludes
// both the STT tail before it and the pacing gap after it. `true_v2v_ms` spans
// audio_speech_end -> first_frame_wire and is the number a caller experiences.
//
// Instrumentation must never break a call: every public function here is
// try/catch-safe and returns a harmless value on any internal failure.
// ---------------------------------------------------------------------------

const RING_BUFFER_MAX = 500;

/** Module-level ring buffer of finished-turn payloads, newest at the end. */
export let _ringBuffer = [];
// Deltas discarded for being negative — see finishTurn. Non-zero means marks
// are landing out of order, which is a real defect in the instrument.
let negativeDeltas = 0;

// ---------------------------------------------------------------------------
// Turn-taking counters.
//
// Separate from the per-turn ring buffer because these events are not
// turn-scoped: a suppressed nudge or an extended hold happens BETWEEN turns,
// and several can occur inside one. They exist so turn-taking behavior is
// countable across a batch of test calls ("did the ladder fire at all, and
// how often did caller speech hold it off?") rather than only greppable.
// ---------------------------------------------------------------------------

const COUNTER_NAMES = [
  "nudges_fired",
  "nudges_suppressed",
  "silence_hangups",
  "holds_started",
  "holds_extended",
  "holds_capped",
  "barge_ins",
  // Turns discarded because the caller turned out not to be finished — they
  // resumed while the reply was still being prepared and nothing was audible.
  // Deliberately NOT counted as barge_ins: a barge is the caller interrupting
  // an answer they can hear, this is the pipeline having guessed the turn
  // ended too early. Conflating them would hide whichever one regressed.
  "resume_aborts",
  // Resumptions we could have acted on but did not — almost always because a
  // tool round had already started (a booking may already be written). A high
  // number here next to a low resume_aborts means the guard is doing the work.
  "resume_aborts_declined",
  // Replies delayed by the post-barge settle window (session.js
  // POST_BARGE_SETTLE_MS) — the count of interruptions that did NOT turn into
  // a start/stop collision.
  "barge_settles",
  // Transcripts rejected as the AI's own audio bleeding back into the mic
  // (lib/voice/echoGuard.js). Split by source because an interim echo costs a
  // false barge-in while a final echo costs a whole wasted turn — on a
  // speakerphone call both should be non-zero while `barge_ins` stays flat.
  "echo_suppressed_interim",
  "echo_suppressed_final",
  // Times the runaway-barge backstop fired (session.js loop breaker). Should
  // be 0 in normal operation: a non-zero value means the echo guard and the
  // settle window let a start/stop loop through, and is a bug report.
  "loop_breaker_trips",
  // Times the model went quiet mid-turn long enough that a hold line played
  // (lib/voice/llmTurn.js stall watchdog) — usually a slow tool round.
  "llm_stalls",
  // Caller turns whose audio came from the Google fallback rather than
  // ElevenLabs. Non-zero means callers are not hearing the intended voice —
  // exhausted credits, an outage, or an open breaker. Until this existed the
  // only trace was a log line, so on 2026-08-04 two full probe runs were
  // measured on the fallback and the 8x rise in tts_ttfb_ms read as an
  // unexplained latency regression instead of "the voice is degraded".
  "tts_fallback_turns",
  // An intent marker reached toSpeakable, meaning the primary strip in
  // services/gemini.js missed it. Must be 0. The defensive strip repairs it, so
  // without this counter the one caller-audible failure of VOICE_INTENT_MARKER
  // would leave no trace — and a latency probe cannot hear.
  "intent_marker_leaks",
  // Internal implementation vocabulary ("API", "webhook", a UUID, an HTTP
  // status) caught on its way to TTS by lib/voice/speakableText.js. Must be 0.
  //
  // Non-zero means something upstream is still handing the model — or the
  // caller — words from inside the system: operator free-text carrying one,
  // or the model improvising. The guard removes the word so the call survives,
  // but the whole point of counting is that a silent scrub would hide whether
  // the upstream fixes actually worked. A latency probe cannot hear a leak;
  // this is what makes one visible without somebody listening for it.
  "internal_term_leaks",
  // Function calls Gemini wrote into the TEXT channel instead of emitting as
  // structured functionCall parts. Must be 0.
  //
  // Non-zero means callers are hitting the 2026-08-04 defect: the pseudo-call
  // is spoken aloud ("default api get caller appointments from db") AND the
  // tool never runs, so the caller gets a promise followed by silence and the
  // model has no result to reason from. This counter is how the rate becomes
  // visible without anyone listening; the two below say what happened next.
  "text_channel_tool_calls",
  // Turns where the model was asked to re-issue such a call properly.
  "text_channel_reasks",
  // Turns where it did not, and the caller got the can't-complete line
  // instead. The gap between reasks and this is the recovery rate.
  "text_channel_unrecovered",
  // Recovery rounds whose TEXT was thrown away because the turn had already
  // spoken. The re-ask forces mode:ANY, and on 2026-08-29 the model obliged
  // with the function call AND a second goodbye, which the caller heard on top
  // of the first. Non-zero is the fix working, not a fault.
  "text_channel_reask_text_suppressed",
  // Turns where the model told the caller it was checking or updating
  // something and called no tool at all — the shape that produced three
  // consecutive silent turns on 2026-08-04. Must be 0; the caller is owed a
  // result and the engine had to go ask for one.
  "promise_only_turns",
  // ...and the subset where asking again did not help either, so the caller
  // got the can't-complete line. These are the calls to go listen to.
  "promise_only_unrecovered",
  // A tool hit its deadline and the caller was released rather than left
  // waiting on it. Must be 0: a non-zero value means a database or integration
  // call is running long enough to be audible as dead air.
  "tool_timeouts",
  // A tool threw. The vendor's message is in the log, never in the reply.
  "tool_errors",
  // Calls where the caller spoke over the uninterruptible greeting and what
  // they said was DISCARDED. Expected to be non-zero — it is the measure of how
  // often the gate costs a caller a repeat, which is the price paid for never
  // promoting a cough or a speakerphone reflection to the first turn. A sharp
  // rise means greetings got longer, or callers are being trained to talk over
  // them; either way the greeting, not the gate, is what to shorten.
  "greeting_speech_discarded",
  // The greeting's completion mark never arrived and the watchdog had to
  // reopen barge-in. Must be 0. Non-zero means Twilio marks or the TTS done
  // path are unreliable, and every one of those calls spent up to
  // VOICE_GREETING_GUARD_MAX_MS unable to be interrupted.
  "greeting_guard_expired",
  // Assistant turns that did / did not read from an explicit Gemini context
  // cache, counted only while GEMINI_EXPLICIT_CACHE is on. Read from Google's
  // own usageMetadata, so they report what was BILLED, not what this process
  // intended.
  //
  // These exist because the expensive failure is silent. If a provider refuses
  // to create the cache — the open question on Vertex, where "not supported" is
  // classified as permanent and parks the entry forever — every call still
  // works, still sounds identical, and quietly costs ten times the input price
  // until a bill arrives. `llm_cache_hits` flat at zero with the flag on is the
  // alarm. Expect roughly one miss per call (the create is in flight during the
  // first turn unless the pickup warm won the race) and hits thereafter.
  "llm_cache_hits",
  "llm_cache_misses",
  // A caller-appointment lookup tool ran while the call-start snapshot
  // (ctx.callerContext.upcomingAppointments) already held rows — and while it
  // did not. These two decide whether a caller-data cache is worth building.
  //
  // The cost being counted is NOT a database round trip. services/gemini.js
  // sends every tool result back to Gemini for another streaming round, so a
  // lookup whose answer we already had costs a whole extra model turn. Nobody
  // has ever measured how often that happens, and the feature that would fix
  // it (prefetch everything about the caller and serve tools from it) is
  // several days of work aimed at an unmeasured number. Warm/cold is the
  // cheapest thing that can settle it.
  //
  // "Warm" means the snapshot was non-empty, not that it necessarily contained
  // the specific answer — deliberately the loose reading, because it is an
  // upper bound on what a cache could save, and an upper bound that comes out
  // small closes the question outright.
  "lookup_tool_context_warm",
  "lookup_tool_context_cold",
  // The hard-name spelling gate in services/tools.js, which until now kept its
  // whole accounting in per-call `capabilityState` and reported nothing.
  //
  // _refusals is how often a write was held back for a spelling. It is not a
  // fault count: the gate turned a misheard "Nathan Darla" into a stored
  // "Nithin Dodla" on a real call, which is the entire reason it exists.
  //
  // _cap_reached is the one to watch. spellMissCap refusals in, the gate opens
  // and the name is written EXACTLY AS HEARD, because the alternative is a
  // livelock against a caller whose phrasing the detector never recognises.
  // That escape hatch is deliberate and it is also how a wrong name reaches the
  // database, so the rate it fires at decides whether the ceiling is right.
  "spelling_gate_refusals",
  // -------------------------------------------------------------------------
  // THE CALLER ANSWERED THE SPELLING QUESTION AND THE TRANSCRIPT LOST IT.
  //
  // Call CA9e3788, 2026-09-10: 2,180 ms of the caller spelling their name
  // transcribed to ZERO characters, and 2,900 ms to four. The gate's escape
  // hatch read that same transcript, so it recorded neither the spelling nor a
  // miss -- unsatisfiable and unexhaustible at once, and the booking was
  // refused four times and never happened.
  //
  // This counts the answers the audio saw and the text did not. Read it beside
  // `spelling_gate_refusals`: if this is climbing, the loop that used to be
  // unbounded is now ending, and the name is being written as heard rather than
  // not written at all.
  // -------------------------------------------------------------------------
  "spelling_voiced_answer_counted",
  "spelling_gate_cap_reached",
  // A booking that reached book_appointment with no client_name at all.
  //
  // NOT prefixed `live_`: the invariant is in the appointments pack and does
  // not know which front-end called it, same reasoning as the postcall_ family
  // below. The first deployed booking wrote client_name: null with a phone
  // number and a symptom and nobody attached to it, and a null name also meant
  // the spelling gate was never consulted -- it fires on the name being
  // WRITTEN, so no name meant no gate.
  "booking_refused_no_name",
  // The promise gate (lib/voice/promiseGate.js). _swapped is the model having
  // announced a wait and the engine having replaced that announcement with one
  // keyed to the tool that actually ran; _kept is a promise that turned out to
  // be true and was spoken as written.
  //
  // _swapped is the rate the PROMPT half of this change is supposed to drive
  // down: if the model stops volunteering a wait line on tool turns, the code
  // gate stops having anything to catch. Flat and high means the prompt change
  // is not holding and the gate is carrying the whole fix on its own.
  "hold_line_promise_swapped",
  "hold_line_promise_kept",
  // A hold line actually reached the caller, and a tool call that did no work
  // and therefore said nothing — a gate refusal before execution, or an answer
  // served from the call's own state without touching a backend.
  //
  // Neither of these existed until 2026-08-31, and their absence is why two
  // rounds of hold-line fixes shipped "verified" while a caller still heard the
  // wrong line three seconds late. Nothing in this codebase recorded that a
  // hold line had played at all — only session_filler_failed, the error path.
  // A behaviour with no counter cannot be checked, only re-reported.
  "hold_line_played",
  "hold_line_suppressed",
  // The semantic end-of-turn arbiter (lib/voice/endpointArbiter.js), which is
  // OFF unless VOICE_SEMANTIC_ENDPOINT=true. _flushed is a hold cut short
  // because the model judged the caller finished; _extended is one lengthened
  // because it judged them mid-sentence.
  //
  // Both being zero with the flag ON does NOT mean the caller was always
  // judged correctly — it means no verdict ever arrived inside its hold, which
  // is the failure mode to watch for. The arbiter fails open by design, so a
  // model that is simply too slow looks exactly like one that is never needed.
  "semantic_endpoint_flushed",
  "semantic_endpoint_extended",
  // ---------------------------------------------------------------------
  // Speech-to-speech front-end guards (lib/voice/live/guards.js).
  //
  // Both invariants live in the reducer rather than the prompt, because "at
  // most once" in a prompt does not hold in this codebase, and both need to
  // be COUNTED rather than logged: the question worth answering is not "did
  // it ever fire" but "how often does the model try this".
  //
  // Registered here and not only inside the guard module, because
  // bumpCounter drops unknown names silently — a guard whose counter is
  // unregistered fires, blocks, logs, and reports nothing.
  // ---------------------------------------------------------------------
  //
  // A booking refused because no availability check ever returned that slot.
  // Non-zero means the model tried to book a time nobody offered the caller.
  // The backend's own re-check would not have caught it: that asks whether
  // the slot is free, never whether it was offered.
  "live_guard_availability_blocked",
  // A duplicate write suppressed. 3.1 doubled end_call in 2 of 26 trials and
  // 2.5 produced a doubled book_appointment; this is what those cost when
  // nothing stops them.
  "live_guard_duplicate_suppressed",
  // A booking tool ran with the availability invariant NOT in force, because
  // the business's availability tool has a response shape this repo cannot
  // read (an EHR's get_available_slots comes back from athena). The guard
  // fails open there deliberately — a false block would stop that business
  // booking at all — so this counter is how a silent gap stays visible.
  "live_guard_availability_unarmed",

  // ---------------------------------------------------------------------
  // LVX21 -- the outbound leak guard on the speech-to-speech path.
  //
  // The cascade filters model text through speakableText.js before TTS. On
  // the Live path the model IS the voice, so the only warning that backend
  // words reached a caller is outputAudioTranscription arriving after the
  // fact. These say what happened to it.
  //
  // Note that sanitizeOutbound bumps `internal_term_leaks` itself when it
  // changes text, so a Live leak also lands there. Read these for the Live
  // path; that one mixes both front-ends.
  // ---------------------------------------------------------------------
  //
  // The assistant spoke a tool name, parameter name, or structural blob.
  // Non-zero means a caller heard, or nearly heard, our internals.
  "live_outbound_leaks",
  // A leak caught while audio was still queued, and cut before playout.
  "live_outbound_cuts",
  // A leak caught with nothing left to cut -- the words already reached the
  // caller. Counted separately because "we cut it" and "we were too late"
  // are the difference between a guard and a log line, and the transcript
  // lag that decides which is unmeasured on a real call.
  "live_outbound_cut_missed",
  // The model was told it leaked and asked to continue plainly. At most one
  // per model turn, so this also bounds the note traffic.
  "live_outbound_reasks",

  // ---------------------------------------------------------------------
  // The disciplines getReplyStreaming has and the Live tool loop did not.
  // Handoff section 8 asked for the reply assembly to be extracted rather
  // than duplicated; a simpler loop was built instead, and these count what
  // that loop was missing.
  // ---------------------------------------------------------------------
  //
  // A turn that asked for more tool rounds than the cap allows. The cascade
  // bounds this with MAX_FC_ROUNDS; the Live loop ran whatever the model
  // asked for, without limit.
  "live_tool_rounds_capped",
  // A turn that promised the caller an action ("one moment, let me check")
  // and called no tool. The cascade re-asks with the tool call forced; here
  // it can only ask.
  "live_promise_only_turns",
  // A turn that ran a tool and said nothing at all, which on a path with no
  // TTS leg is silence the caller sits through.
  "live_zero_text_turns",
  // A caller-visible write that was asked for and did not happen: the spelling
  // gate, the configured requirements, a pack's own invariant, the Live
  // availability guard, or an execution failure.
  //
  // Counted apart from the attempt count because they answer different
  // questions. "Did the model do anything" cannot express "did the caller ask
  // for something that did not happen", and reading the first as the second is
  // what made the promise guard blind to LVX34 and the claim guard blind to
  // LVX31. A suppressed duplicate is excluded -- that write already succeeded.
  "live_tool_refusals",
  // THE LVX34 SHAPE. A write was refused this turn and the assistant answered
  // by telling the caller someone would ring them back.
  //
  // The refusal always carries an instruction -- "ask the caller to spell it
  // and wait" -- so this is the model treating an instruction as a failure and
  // falling back to taking a message. Observed twice on one real call, and the
  // near miss is worse than what was heard: after spellMissCap refusals the
  // gate opens and writes the name exactly as it was misheard.
  "live_deferral_after_refusal",
  // A note the guards wanted to send and did not, because this call has had
  // its fill. A note provokes a model turn, which can provoke a note; this
  // is what makes a ping-pong visible instead of expensive.
  "live_turn_notes_capped",
  // The assistant told the caller an action was COMPLETE on a turn where no
  // tool ran, and none ran on the turn before either.
  //
  // Every other guard on this path sits BELOW the tool layer -- the
  // availability invariant, the idempotency cache, the round cap all fire on
  // calls that are actually made. This one is the only thing that can see a
  // call that was never made at all, which is the failure observed on
  // 2026-09-03: five invented appointment slots and a confirmed booking, with
  // no tool events in the log and no row in the database.
  //
  // Counts only. Acting on it is behind LIVE_CLAIM_GUARD=act and stays off
  // until this number says how often it fires on calls where nothing is wrong,
  // because a false positive that demands action gets a second booking.
  //
  // WIDENED 2026-09-03 and the reason is that the number above was wrong. Both
  // halves of the condition counted ATTEMPTED tool calls, so a refused call
  // switched the guard off -- and on a real deployed call the spelling gate
  // refused a write, the assistant then claimed something was done, and the
  // post-call read found no row, while this counter stayed 0. A counter that is
  // the designated input to "is it safe to act on this" was reading low, in the
  // direction that makes the guard look quieter than it is. It now counts tools
  // that actually EXECUTED. Expect a higher number; that is it seeing cases it
  // was blind to, not the model getting worse.
  //
  // First live check, 2026-09-03: an ordinary successful booking said "Yes,
  // it's booked for Monday September 7th at ten AM" -- a claim the guard
  // matched and judged -- with book_appointment completing on the same turn
  // and the row in the database. It did not fire. One true negative on the
  // common case, which is the one that matters before this is ever allowed to
  // speak.
  "live_claim_without_action",
  // LVX93. The same question with the look-back restricted to tools that can
  // CHANGE something.
  //
  // live_claim_without_action treats every tool alike, so a
  // check_appointment_availability that ran the previous turn vouches for a
  // "your appointment is booked" claim on this one. Measured on a real call
  // 2026-09-09: availability ran, book_appointment was REFUSED by the spelling
  // gate, the caller was told "so I have you booked", and the guard was silent.
  //
  // A strict SUPERSET of the counter above, so the difference between the two
  // is exactly the population the narrow condition misses. Counter only -- the
  // guard's own condition, and therefore what any caller hears, is unchanged
  // until this number says what acting on it would cost.
  "live_claim_unbacked_by_action",
  // The assistant offered specific appointment times on a call where no
  // availability response had ever put a slot on the record.
  //
  // The earlier and more dangerous half of the same failure. By the time
  // live_claim_without_action fires, the caller has already chosen from a list
  // that was invented; this fires while they are still choosing. On the call
  // that prompted both, the assistant read out five slots -- "nine AM, nine
  // thirty AM, ten AM, ten thirty AM, and eleven AM" -- with no tool call
  // anywhere in the session.
  "live_offer_unverified",
  // Whether the offer was still in audioOut's queue when we recognised it.
  // LVX80.
  //
  // The pair, not either alone. On this front-end the transcript lags the audio
  // it describes and audioOut paces that audio out over real time, so a guard
  // that detects a thing has NOT necessarily prevented it -- and "we cut it"
  // and "we were too late" must never collapse into one number. The leak
  // guard's equivalent pair is the benchmark: seven cut, four missed. This
  // matches a phrase rather than a single word, so it should read better.
  //
  // A read where cut_missed dominates is the evidence that would justify paying
  // latency for a playout hold. Until then it does not, and nothing here costs
  // the caller a millisecond.
  "live_offer_cuts",
  "live_offer_cut_missed",
  // ---------------------------------------------------------------------
  // LVX29 -- the post-call read (lib/postCallVerify.js).
  //
  // Registered here rather than only in that module because bumpCounter
  // drops unknown names silently, and a reconciliation that reports nothing
  // is indistinguishable from a call where nothing was wrong.
  //
  // NOT prefixed `live_`: the module acts on the appointment row and knows
  // nothing about which front-end took the call. The cascade is expected to
  // drive the identical function once this has run on real Live calls.
  // ---------------------------------------------------------------------
  // How many calls got as far as reading the database. The denominator for
  // every counter below it; without it a zero is unreadable, because "never
  // fired" and "never ran" look identical.
  "postcall_verify_runs",
  // end_call refused because the caller's last utterance was ENTIRELY filler.
  //
  // "Is there anything else?" / "umm" / line closed, on a real call. A
  // hesitation is someone thinking, not someone saying no, and from the
  // caller's side that is being hung up on mid-word.
  //
  // Structurally impossible on the cascade, which is why this is new: Deepgram
  // text passes through cleanTranscript and a pure hesitation arrives as an
  // empty turn. On the Live path the model IS the ASR, so the filler reaches it
  // verbatim and gets read as an answer.
  "end_call_refused_hesitation",
  // The OTHER refusal branch, which had no counter until 2026-09-09.
  //
  // The generic gate refuses when the step machine is not wrapping up, no
  // action has completed this turn or this call, and the caller has taken fewer
  // than two turns. It fired twice on the calls of 2026-09-09 and left no trace
  // anywhere except `tool_duration success=false` -- a per-tool timing line,
  // not a decision record. Both LVX96 sightings were found by reading the call
  // by hand, because "why did the gate refuse?" was unanswerable from counters.
  //
  // A refusal that is uncounted AND overruled by the sign-off detector cannot
  // be found afterwards at all, which is what made it a P0 rather than a
  // curiosity.
  "end_call_refused_generic",
  // The same reading, for every OTHER write.
  //
  // The hang-up gate above protected the hang-up and nothing else: on a real
  // call the caller said "Ah!" and the assistant executed a reschedule AND a
  // name correction off it, then announced both as done. Every action tool now
  // asks the same question the hang-up did. See LVX56.
  //
  // Note the predicate is isHesitationOnly, NOT stripFillers: stripFillers
  // reduces "Okay", "Right" and "Mm-hmm" to nothing, and a gate built on it
  // would refuse a booking on the commonest confirmation in English.
  // A completion claim the detector actually SAW.
  //
  // The positive half of the LVX27 family. `claims: 0` on a postcall_verify
  // line has always had two readings -- nothing was claimed, or nothing was
  // recognised -- and on 2026-09-03 the second was true twice while the first
  // was assumed, which is how row_without_claim came to be filed as a false
  // alarm on two consecutive calls. See LVX57.
  "live_claim_detected",
  // WHICH ACT the claim named, inferred from a slot nobody had to parse.
  //
  // "We're all set for Monday, September 14th, at 1 PM" names no verb, so the
  // action probes return `unspecified` and any write vouches for it -- which is
  // how CAbdff67b2 reported clean while a cancellation stood in for a booking
  // that never happened. It DOES name a time a real availability call had
  // returned, and a completion claim naming a verified future slot is a booking
  // confirmation. This counts the promotion.
  //
  // Read against live_claim_detected: if it fires on turns where nothing is
  // wrong, the promotion is too eager and this is the number that says so.
  "live_claim_action_from_slot",
  // THE CLAIM WAS MADE TRUE. LVX114, and the point of the whole exercise.
  //
  // The assistant said a booking was done, no tool had done it, and the engine
  // recovered both essential fields, verified each against something that did
  // not come from the model, and performed the write. The caller hears nothing
  // different; the sentence stops being a lie.
  "claim_completed_in_code",
  // The completion was attempted and the tool layer said no.
  //
  // NOT a failure of this feature -- it is the gates doing their job, and the
  // commonest cause is a hard name the caller has not spelled yet, which stashes
  // a pendingWrite that the existing spelling retry picks up later. Counted
  // separately from the unrecoverable case because they need opposite readings.
  "claim_completion_refused",
  // A field could not be recovered or could not be verified, so nothing was
  // written and the caller was asked instead.
  //
  // The three causes are a time that matched no verified slot, a name nowhere in
  // the caller's own words or records, and an ambiguous sentence naming two
  // verified slots. All three are the safety rule holding.
  "claim_completion_unrecoverable",
  // Rung two of the ladder: the caller was asked, plainly, once.
  //
  // Deliberately says nothing went wrong. Three calls running, an internal
  // message reaching the caller produced "I'm sorry, the booking didn't go
  // through" and "I'm not sure why it's not updating"; LVX105 deleted a line
  // asking for an apology for exactly this reason.
  "claim_confirm_asked",
  // A claim with no row behind it, WRITTEN DOWN AND SENT TO A HUMAN. LVX97.
  //
  // The claim note asks the model to correct itself and sometimes it does; on
  // call 7aef50 it retracted, booked for real, and read the row back. An hour
  // earlier, same tenant, same config, same tools, it fabricated a consultation
  // and then denied it to the caller's face. Nothing in the system could tell
  // those two calls apart, and nothing needs to: this fires on the database
  // disagreeing with the call, not on the model agreeing to anything.
  "postcall_claim_reconciled",
  // The reconciliation itself failed -- an insert that returned no row (the RLS
  // failure mode: the service runs NOBYPASSRLS, so an unscoped write matches
  // nothing and reports success) or a throw. Counted separately because
  // "nothing to report" and "the reporting broke" must never read the same.
  "postcall_claim_reconcile_failed",
  // -------------------------------------------------------------------------
  // LVX98. The internal correction that the caller hears. COUNT ONLY.
  //
  // Every assistant turn carrying text is checked, so a call where nothing was
  // apologised for and a call where this never ran do not read the same.
  // -------------------------------------------------------------------------
  "live_apology_checked",
  // The turn OPENED with an apology. Includes clean refusals -- "I apologize,
  // but I can only book appointments for future dates" is a correct thing to
  // say -- which is why the pair below exists rather than this number alone.
  "live_apology_turn",
  // The same, on a turn that followed a note WE sent. This is LVX98's
  // population: on call 7aef50 the claim note produced the right outcome (an
  // unbacked claim retracted, a real booking, a row that exists) and six
  // escalating apologies delivered to the caller across a third of the call.
  //
  // The defect is the CHANNEL, not the intervention. LVX97, the same night, is
  // what the silent alternative looks like: a fabricated booking that was never
  // retracted and was then denied to the caller's face. This number is what
  // decides whether an output filter is worth its false-cut risk.
  "live_apology_after_note",
  // The leak note's ceiling was reached and we stopped talking to the model.
  //
  // The note is delivered as a synthetic user turn -- the only engine-to-model
  // channel available when no tool call is in flight -- so a model already
  // emitting meta-text gets handed more text. LVX37 recorded six such cycles
  // with turns: 0 and a caller who heard silence; 2026-09-09 recorded two, then
  // a recovery. Past two the note is measurably part of the loop.
  //
  // The guard is NOT capped by this: detection, the audio cut and every other
  // counter continue for the whole call. Only the note stops.
  "live_outbound_notes_capped",
  // -------------------------------------------------------------------------
  // LVX95. THE CONFIRMATION CAME AFTER THE WRITE.
  //
  // Call be9bd6, 2026-09-09: three cancellations committed at 04:53:13 and the
  // confirmation question asked at 04:53:27, with end_call six seconds after
  // that. Every claim on the call was true and every row changed as asked; the
  // defect is ordering, and the caller heard a safeguard that had already been
  // overtaken by the write.
  // -------------------------------------------------------------------------
  // Turns on which an ACTION tool actually executed. The denominator, so a call
  // that never wrote and a call that wrote cleanly do not read the same zero.
  "write_turns_checked",
  // One of those turns ALSO put the action to the caller as a question -- the
  // signature of be9bd6 exactly. Target: zero across real calls.
  "write_confirm_after_write",
  // The gate's own reading, taken at the tool boundary: did the assistant's
  // PREVIOUS completed turn read this action back? The pair reports on every
  // write whether or not the gate is switched on, which is what will show the
  // gate working on real calls rather than only in tests.
  "write_confirm_readback_prev_turn",
  "write_confirm_readback_missing",
  // The gate's condition was not met. Counted even when the gate is off, so its
  // firing rate is readable from the first call rather than reconstructed
  // afterwards -- the mistake end_call_refused_abandoned made, where the
  // situation counter and the action counter arrived at different times.
  "write_order_would_refuse",
  // ...and it actually refused. The difference from would_refuse is the off
  // switch and the ceiling.
  "write_order_refused",
  // The per-call ceiling released a write the gate would otherwise have refused
  // again. THE NUMBER THAT SAYS confirmReadBackRe IS TOO NARROW: a phrasing
  // list cannot be completed, and without a ceiling an unrecognised read-back
  // is refuse, ask, get a yes, refuse again, forever.
  "write_order_gate_ceiling",
  // -------------------------------------------------------------------------
  // THE CEILING THAT COUNTS ATTEMPTS RATHER THAN GATES.
  //
  // Call CA9e3788: four book_appointment attempts refused, no row, and the
  // caller told "that's all set". Two by the write-order gate, two by the
  // spelling gate. Both have a ceiling of two, and neither reached it, because
  // each saw only half the attempts while the caller sat through all four.
  //
  // This fires when one attempted WRITE has been refused three times by any
  // combination of gates. Keyed to the proposal WITHOUT the name, so a spelling
  // correction does not reset it and a genuinely new time does. Distinct from
  // write_order_gate_ceiling, which still reports that gate's own limit: if this
  // one is carrying the load, the gates are alternating and neither knows it.
  // -------------------------------------------------------------------------
  "write_attempt_budget_released",
  // A change tool called with no appointment to change. The model claimed a
  // booking it had not made, believed itself, and reached for
  // correct_appointment_name on a row that did not exist -- twice. Counted so
  // the frequency of that belief is readable, since the claim guard only sees
  // the sentence and this sees what it made the model DO.
  "write_skipped_no_target",
  // The consent gate was skipped because the caller had ALREADY BEEN TOLD.
  // LVX114.
  //
  // The write-order gate asks "did the caller agree to this?", and that question
  // is moot once the assistant has announced the thing as done: the caller is
  // going to hang up believing it happened, and the only choice left is whether
  // the database matches what they heard. Refusing the write there does not
  // protect them, it guarantees they get nothing.
  //
  // Every other gate still runs on this path. If this number ever climbs far
  // above claim_completed_in_code, the skip is being spent on writes that then
  // fail somewhere else and the reason is worth reading.
  "write_consent_skipped_completing_claim",
  // A time-writing tool allowed BECAUSE its slot was verified.
  //
  // The positive twin of live_guard_availability_blocked. A call where every
  // write was properly checked and a call that never attempted a write both
  // reported zero before this existed.
  "live_guard_availability_allowed",
  // A write refused because the name on it did not come from the caller.
  //
  // The name was already on file, which used to silence the spelling gate
  // outright -- "the record IS the spelling". On a real call the caller never
  // said a name at all (their turn transcribed as "Hay en el Tindala"), the
  // model lifted one off an existing row, and it was written. The database now
  // holds two rows with that value, the second created by a call on which
  // nobody said it. See LVX53, and LVX28 which predicted it.
  "write_refused_name_provenance",
  // The positive twin: an on-file name the caller DID say this call, so the
  // bypass was granted and the returning caller was not re-interrogated.
  "write_name_provenance_ok",
  // A change tool given an appointment_id that resolves to no row.
  //
  // Distinct from an ownership refusal, and the distinction is LVX74: a caller
  // was told their own appointment was "not booked under your number" because
  // the model guessed an id and the row was not found. The positive twin is
  // postcall_changed_rows -- a change that lands shows up there, so a call with
  // neither is a call that never tried.
  "write_refused_appointment_not_found",
  "write_refused_hesitation",
  // The positive half, and the reason the pair exists.
  //
  // Bumped every time an action tool passes the consent check. Without it a
  // clean call and a call that never attempted a write both read
  // write_refused_hesitation: 0, which is precisely how LVX45 sat in the tree
  // for a day looking fixed while its gate was unreachable.
  "write_consent_checked",
  // A caller turn whose transcript is not usable as speech at all.
  //
  // An English turn came back as the Korean characters "에레는" and was answered
  // "Great, 8 AM on Tuesday, September 8th, is available" -- and the call booked
  // from it. There is no confidence score on this vendor's inputTranscription,
  // so this is a script-range judgement on the text. See LVX50.
  "live_unusable_transcript",
  // The positive half: a caller turn was actually examined for usability.
  //
  // Bumped once per call, on the first caller turn seen. A zero here means the
  // check never ran -- no caller ever spoke, or the wiring broke -- which is a
  // different fact from "every turn was fine", and the two are indistinguishable
  // without it.
  "live_transcript_script_checked",
  // The assistant was told to ask for a spelling NOW, in the turn the caller
  // gave their name.
  //
  // The prompt already instructs this in as many words -- "ask them right then,
  // while you are still taking details" -- and on a real call the model
  // collected everything, said "that's all confirmed, anything else?", and only
  // then asked. A prompt line is a request, never a guarantee; this is the
  // counted nudge that fires at the moment the name arrives.
  "live_spelling_ask_nudged",
  // The nudge was ELIGIBLE to fire: a name was seen and the spelling was not
  // settled, whether or not a note went out.
  //
  // The positive twin, and the diagnostic that was missing. When the nudge did
  // not fire on the two calls after it shipped, nothing distinguished "the
  // trigger did not match how this caller spoke" from "no name was given on
  // that call" -- and the first was true. Eligible with no nudge means the
  // assistant had already asked; eligible zero while the write gate refuses
  // means the trigger is still blind. See LVX44.
  "live_spelling_nudge_eligible",
  // Rows the post-call read actually FOUND, counted one per row.
  //
  // The positive half of this family, and it was missing. Every other counter
  // here fires on a fault, so a call that booked correctly and a call that never
  // reached the booking both report all zeros -- and a harness run on 2026-09-03
  // drove an entire booking conversation and could not distinguish them. An
  // instrument that can only see failure cannot confirm a fix.
  //
  // Per row, not per call: "booked one" and "cancelled three in one turn" are
  // different facts, and LVX33 is about the second.
  "postcall_booked_rows",
  "postcall_changed_rows",
  // A confirmation actually handed to Twilio, built from the row.
  "postcall_confirm_sent",
  // A real row with no usable number on it. Deliberately NOT redirected to
  // the number the caller rang from -- the owner's decision on 2026-09-03 is
  // that this is reported to the business, because a row whose phone differs
  // from the caller ID may differ on purpose.
  "postcall_confirm_skipped_no_phone",
  // A confirmation NOT sent because the call's own verdict was bad. LVX114.
  //
  // The send loop used to check the mode and nothing else, so a call whose row
  // carries the wrong name -- LVX72's exact shape, verdict write_abandoned --
  // still texted the caller a confirmation quoting it. A confirmation is a
  // promise that the row is right, and it must not outrun the verdict that says
  // whether it is.
  "postcall_confirm_skipped_verdict",
  // A confirmation NOT sent because the booking already sent one.
  //
  // capabilities/appointments.js onEffect texts the caller the moment a booking
  // succeeds. When consent is on file BOTH paths fire and the caller gets two
  // messages for one appointment, to two possibly different numbers. The
  // post-call one is the duplicate, because it is the later of the two.
  "postcall_confirm_skipped_duplicate",
  // The row's number is not the number that rang us.
  //
  // NOT a reason to redirect or to refuse: booking for somebody else is
  // legitimate and the owner's rule is that the row's number wins. But
  // `client_phone` is whatever the model transcribed -- LVX114 has it reading
  // "that's 469-933-8887?" back off a lossy channel -- and one wrong digit
  // sends a person's name and appointment time to a stranger. Counted before it
  // is ever anything more than counted.
  "postcall_confirm_number_mismatch",
  "postcall_confirm_failed",
  // THE ONE THAT MATTERS. The assistant claimed a completed action and the
  // database has nothing to show for it -- LVX27's fabrication, measured per
  // call instead of per turn. Unlike live_claim_without_action this survives
  // the turn it happened on, so a claim that trailed its tool by two turns
  // cannot be counted as a lie.
  // A tool that was refused and never afterwards succeeded.
  //
  // Structural, and stronger than matching sentences because it does not depend
  // on how the model phrased anything. The call that found it announced a name
  // change that never happened, and postcall_verify reported "ok" because an
  // unrelated booking had succeeded in the same conversation. See LVX72.
  "postcall_write_abandoned",
  "postcall_claim_without_row",
  // Wrote something and never said so. Much less serious, and worth counting
  // because it is the false-positive shape for any future "tell the business"
  // channel: a call that books correctly and ends abruptly lands here.
  "postcall_row_without_claim",
  // A booked EFFECT with no row behind it. Distinct from a fabrication: the
  // tool ran and reported success, so this is a write that failed or was
  // scoped out by row-level security, and the fix is in a different place.
  "postcall_row_mismatch",
  // -------------------------------------------------------------------------
  // LVX70 -- what the vendor was actually GIVEN, per caller utterance.
  //
  // The entry was nearly settled on two counters reading zero, and neither
  // could see the thing in question: echo_suppressed_interim is bumped only by
  // the cascade and is structurally zero on every Live call, and
  // echo_suppressed_final watches transcript CONTENT, not the audio path.
  //
  // The gate that discards caller audio -- lib/voice/live/halfDuplex.js, which
  // withholds every frame while we are speaking and drops the ring outright if
  // playback ends without a confirmed barge -- had no counter at all.
  //
  // These four are an INSTRUMENT, not a guard. Nothing behaves differently
  // because of them. They exist to decide one question that cannot be settled
  // by reading code: when a caller says "okay" and gets silence, did the vendor
  // ever receive the audio?
  //
  //   live_utterance_all_withheld > 0   -> ours. Changing LIVE_TURN_END is
  //                                        irrelevant; the fix is in the gate.
  //   all_withheld 0, late/no > 0       -> the vendor held the turn open.
  // -------------------------------------------------------------------------
  //
  // The positive twin. A caller speech episode that opened and closed, counted
  // whatever happened to it afterwards. Without this, a call where the
  // instrument never ran and a call with nothing wrong both read as all-zeros,
  // which is what LVX45 turned out to be.
  "live_utterance_observed",
  // Every frame of an episode was withheld by the half-duplex gate and then
  // discarded. The model was never given the audio, so no endpointing setting
  // on either side could have ended that turn.
  "live_utterance_all_withheld",
  // The episode closed and no transcript was ever attributed to it.
  "live_utterance_no_transcript",
  // A transcript arrived far outside the measured lag band (113-360 ms) for the
  // episode it belongs to -- the signature of the vendor holding a turn open
  // and emitting the words later, merged into a subsequent utterance.
  "live_utterance_late_transcript",
  // -------------------------------------------------------------------------
  // The connect-time fallback on /twilio/live-voice.
  //
  // Until 2026-09-04 a failure in that route was SILENCE -- the worst outcome
  // available on a prospect's call, and worse than either voicemail or a wrong
  // answer, because the first thing a business judging call quality concludes
  // is that the software is broken.
  //
  // The positive twin is not optional here. A demo call that connected cleanly
  // and a demo call that never reached the route at all are the same all-zeros
  // reading without it, and "did the number even point at us?" is exactly the
  // question a failed demo raises.
  // -------------------------------------------------------------------------
  "live_connect_ok",
  // The Live front-end could not be handed the call, and the caller was routed
  // to the cascade instead. Non-zero means a caller was served by tier 3
  // without knowing it -- which is the fallback working, not a caller lost.
  "live_connect_fallback",
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
  // -------------------------------------------------------------------------
  // WHICH VOICE answered, and which of the three routes chose it.
  //
  // All three are POSITIVE counters, which is unusual here and is the point.
  // Choosing a voice is never a fault, so there is no fault half to pair with
  // -- but "the tenant's own voice was used" and "this code never ran at all"
  // must not read the same, and a single counter cannot say which of the three
  // ladder rungs fired. Exactly one is bumped per session.
  //
  // They also answer the question the accent bug turned on. `language_source:
  // default` in one log line is what identified it; the voice had no equivalent
  // and could not be diagnosed from a log at all.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // LVX48's tool, and the pair that says whether it worked.
  //
  // A caller asked for a note on their appointment and was told "I've added
  // that note for you" when no tool existed that could. add_appointment_note
  // is that tool; these two say which of its paths a call actually took.
  //
  // The refusal counter is the fault half, and it is the one that matters most
  // on a demo: it fires when a caller asked for something to be recorded and
  // there was no booking to record it against, which is the moment the old
  // behaviour invented a claim.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // LVX77. A name the caller never said, written into an appointment row.
  //
  // The first UK-tenant call booked "Jane Doe" for a caller who said no such
  // thing, on an empty appointments table, so it could not have come off a
  // record. Every instrument called that call clean -- postcall_verify returned
  // `ok` -- which is why a counter exists at all.
  //
  // COUNTED, NOT ENFORCED. Refusing on this signal was built and reverted the
  // same day: it cannot separate a fabricated name from an ASR-mangled one, and
  // enforcing it would reintroduce the lost booking LVX72 removed. It therefore
  // OVER-COUNTS and is a screen, not a verdict: non-zero means look at the row.
  //
  // The positive twin is first and load-bearing -- the check needs both a
  // written name and a transcript, so "every name was legitimate" and "this
  // never ran" would otherwise read the same.
  // -------------------------------------------------------------------------
  "booking_name_provenance_checked",
  "booking_name_never_spoken",
  "appointment_note_added",
  "appointment_note_refused_no_row",
  "live_voice_source_env",
  "live_voice_source_tenant",
  "live_voice_source_default",
  // -------------------------------------------------------------------------
  // LVX25 and the "anything else" tic -- COUNTED, not instructed.
  //
  // Seven separate prompt instructions already tell the model to ask one
  // question at a time: services/gemini.js:906 and :1705,
  // capabilities/appointments.js:597, :605 and :628, capabilities/quotes.js:74,
  // capabilities/messages.js:83. It stacks questions anyway. An eighth would
  // make the other seven weaker, which is this file's standing rule about
  // adding prompt text that competes with prompt text already there.
  //
  // So: count in the reducer, the way the spelling cap and the claim guard are
  // counted. "At most once" in a prompt does not hold in this codebase; a
  // number does. Nothing acts on these yet -- the claim guard's own ladder was
  // count first, act once the counter says how often it fires when nothing is
  // wrong, and that ladder is what kept LIVE_CLAIM_GUARD honest.
  // -------------------------------------------------------------------------
  //
  // The positive twin: every assistant turn that carried text and was examined.
  // Without it, a call with no stacked questions and a call where auditTurn
  // never ran are the same all-zeros reading.
  "live_reply_turns_checked",
  // A single assistant turn that asked for more than one thing.
  //
  // WAS "more than one question mark", and this comment argued for that on two
  // grounds until 2026-09-07. One of them still holds and is kept below. The
  // other did not survive LVX82: exact and free is worth nothing if the number
  // is blind to the shape being complained about. On the first deployed Live
  // calls this fired five times reading `marks: 2` while the caller was hearing
  // roughly five asks a turn, because "Can I take your name, date of birth, and
  // what it is for?" is ONE question mark.
  //
  // What survives from the old argument: counting "?" is immune to LVX73, where
  // a vendor transcription fragment that was never spoken cannot manufacture a
  // question mark. The conjunction half is NOT immune to that, and a fragment
  // carrying ", and what" can trip it. Stated as the price of seeing the shape.
  "live_stacked_questions",
  // The asks themselves, not the turns carrying them. LVX82.
  //
  // `live_stacked_questions` is one bump per offending turn however many things
  // that turn asked, so a fix that takes a five-part question down to two moves
  // it by zero. This is what a behaviour fix has to move, read against
  // `live_reply_turns_checked`.
  //
  // countAsks returns a LOWER BOUND, so this total is a floor and not a census.
  // That is sufficient here and only here: scoring a fix needs the number to be
  // monotone and comparable between runs, not exact. Do not quote it as "the
  // caller heard N questions".
  "live_stacked_asks_total",
  // "Is there anything else I can help you with today?", anywhere in the turn.
  // Five of five turns on one call, five consecutive on another.
  "live_closing_tic",
  // -------------------------------------------------------------------------
  // LVX78. The assistant repeating itself, word for word, within a few turns.
  //
  // Found only because a caller half-remembered "something repeated in an
  // unnatural way" and could not say what. Reading four calls back by hand
  // turned up three instances -- a whole booking read back twice in consecutive
  // turns (16 identical words, including the caller's phone number), a goodbye
  // delivered twice with a silence nudge between, and a greeting delivered
  // twice. postcall_verify returned `ok` for the call carrying the first.
  //
  // Compared over a WINDOW of the last few turns rather than only the previous
  // one, because the doubled goodbye had our own silence nudge sitting between
  // its two halves and a previous-turn-only check would have missed it.
  // -------------------------------------------------------------------------
  //
  // The positive twin: a turn that had something to be compared AGAINST. The
  // first assistant turn of every call has no predecessor, so "no repeats" and
  // "nothing was ever compared" would otherwise read the same.
  "live_repeat_pairs_checked",
  // A turn sharing a long verbatim run with a recent one. The run LENGTH is
  // logged and the run itself never is: the sixteen-word instance contained the
  // caller's phone number, which is exactly what LVX24 was about.
  "live_repeated_phrase",
  // -------------------------------------------------------------------------
  // THE SAME NUMBER, SPLIT BY WHETHER ANYONE ASKED. LVX102/LVX107, 2026-09-10.
  //
  // `live_repeated_phrase` had no caller condition, so it counted answers as
  // repeats -- a caller asks "when's my appointment?" twice and both answers
  // are, correctly, near-identical. It also counted every read-back the
  // write-order gate forces, which meant the number climbed as that gate did
  // its job. 25+ firings in a day, none of them readable.
  //
  // These two sum to `live_repeated_phrase`, which is left alone deliberately:
  // redefining it for a third time would silently break every comparison with a
  // call from before today, and LVX102 is on file precisely because someone
  // would then read the change as a regression.
  //
  // `_unprompted` is the one that means something -- the assistant restating
  // itself into silence, which is the defect LVX78 was filed for. `_responsive`
  // is expected to carry nearly all the volume and to be almost entirely
  // benign. The cutter has had this discriminator since LVX78; the counter
  // never did, which is the whole of the discrepancy.
  // -------------------------------------------------------------------------
  "live_repeated_phrase_unprompted",
  "live_repeated_phrase_responsive",
  // -------------------------------------------------------------------------
  // LVX78's cutter -- the half that ACTS, rather than counting.
  //
  // The owner's words: "it says the same thing twice in a row... that is a big
  // issue." The log agreed exactly -- two turns twelve seconds apart listing
  // the same three appointment slots, with no caller speech between them, which
  // to an ear is one stream repeating itself.
  //
  // The positive twin is first and it is doing real work here: the check only
  // runs while the model is mid-turn and the caller has been silent since the
  // last one, so "nothing repeated" and "the cutter never got the chance" would
  // otherwise be the same all-zeros reading.
  // -------------------------------------------------------------------------
  "live_repeat_cut_checked",
  // Audio actually cut. Capped per call: LVX21 is the standing record of what a
  // hair trigger costs on this path, and a cutter that fires every turn would be
  // worse than the repeat it removes.
  "live_repeat_cut",
  // The greeting repeated itself and was DELIBERATELY not cut.
  //
  // The owner heard a clipped greeting on 2026-09-06: the cutter fired three
  // times in 173ms during the opening line. A doubled greeting is annoying; a
  // mangled one is the first thing every caller hears. The cascade has protected
  // this turn since before this front-end existed -- "the greeting is
  // uninterruptible: barge-in is disarmed until it finishes."
  //
  // Counted rather than acted on, so we still learn how often the greeting
  // doubles without spending the first impression to find out.
  "live_repeat_would_cut_greeting",
  // -------------------------------------------------------------------------
  // THE OPENING LINE, SPOKEN AGAIN MID-CALL. 2026-09-10.
  //
  // The one above is the greeting doubling AT THE START, where it is left
  // alone. This is the opposite case and it is a defect: a caller heard the
  // whole greeting spliced onto the end of an ordinary sentence, three minutes
  // in, with no space between them.
  //
  // The cause was not a re-send. The opening line lives in the system
  // instruction, the prompt is frozen at connect, and it read "Nothing has been
  // said to the caller yet. Open the call by saying this..." in the present
  // tense for the whole call. The wording is now first-turn-only; this counts
  // and cuts when that is ignored, because a cap in a prompt is a request.
  //
  // TWO counters because a fault-only number cannot tell a clean call from a
  // call that never reached the check. `_respoken` is every detection;
  // `_respoken_cut` is the subset where audio was actually dropped, which stops
  // at MAX_GREETING_ECHO_CUTS. A gap between them means the allowance ran out
  // and the caller heard it.
  // -------------------------------------------------------------------------
  "live_greeting_respoken",
  "live_greeting_respoken_cut",
  // -------------------------------------------------------------------------
  // A promised callback message, written at the end of the call because the
  // spelling gate refused it and the model never asked for the spelling.
  //
  // 2026-09-06: the caller asked for a callback, record_customer_request was
  // refused, and the assistant said "I'll fix it so someone calls you back by
  // the next business day". customer_requests ended the call with zero rows.
  //
  // Three mechanisms had already asked for the spelling -- the nudge note, the
  // gate's refusal text and the prompt -- and the model asked about the number,
  // the message and the urgency instead. A refusal is a request, and the model
  // can decline it.
  // -------------------------------------------------------------------------
  "message_saved_last_chance",
  // The last chance was taken and the write STILL failed. The message is gone
  // and nothing else will save it, which is the one case worth an alert.
  "message_lost_at_close",
  // -------------------------------------------------------------------------
  // The goodbye and the hang-up, 2026-09-06.
  //
  // The assistant said "Thanks for calling Digile Media, and have a great day!"
  // and then did nothing at all -- end_call never ran, the line stayed open, and
  // the silence ladder nudged eleven seconds later. A receptionist that says
  // goodbye and then waits is not a receptionist.
  //
  // The positive twin counts every turn with text that was examined for a
  // sign-off, so "it never said goodbye" and "this never ran" are separable.
  // -------------------------------------------------------------------------
  "live_goodbye_checked",
  // A sign-off was spoken and the model had not called end_call, so we armed
  // the exit ourselves.
  "live_goodbye_armed_exit",
  // LVX96 route A. The sign-off was there, and we did NOT arm off it, because
  // end_call had been refused on this same turn.
  //
  // The two guards collided on 2026-09-09. end_call's declaration makes the
  // model write its farewell in the same response as the call, so a refused
  // end_call always leaves a farewell already spoken; this detector then read
  // it and closed the line the gate had just held open. Twice in one evening,
  // both times within two seconds of the assistant asking the caller a
  // question.
  //
  // Read against live_goodbye_armed_exit. Their sum is every sign-off seen, and
  // the split says how often the two rules actually meet on one turn.
  "live_goodbye_suppressed_by_refusal",
  // LVX96 route B. A hang-up intent thrown away because the caller kept talking.
  //
  // `endCallArmed` had no reset in the entire file, so an end_call that could
  // not be honoured on the turn it was requested stayed pending forever and was
  // retried at the end of every subsequent turn. This counts the intents that
  // are now discarded instead -- each one a hang-up that would have landed on a
  // live conversation.
  "live_end_call_latch_cleared",
  // The same staleness reached through the OTHER door, counted only.
  //
  // The exit was armed and is about to be cancelled because the caller spoke;
  // the latch survives that and will re-arm at the end of the next turn. Not
  // acted on in this round: a caller who says "bye" over the goodbye relies on
  // that retry to actually end the call, and changing it needs its own number
  // first.
  "live_end_call_latch_stale_after_cancel",
  // The caller spoke while a hang-up was pending, and it was called off.
  //
  // Before this, clearAudio() ran the exit -- so barging in during a goodbye
  // hung the caller up FASTER, which is the opposite of what anyone wants and
  // the opposite of what was asked for.
  "live_exit_cancelled_by_caller",
  // -------------------------------------------------------------------------
  // The exit refusing to arm because the caller had JUST interrupted.
  //
  // Cancelling an armed exit turned out not to be enough. The exit arms at turn
  // end, which is AFTER the goodbye has played -- so the interruption lands
  // before there is anything to cancel. Observed 2026-09-06: barge during the
  // goodbye, exit armed 1.6s later, caller hung up on regardless.
  //
  // The positive twin counts every hang-up that reached the check, so "nobody
  // interrupted" and "this never ran" stay separable.
  // -------------------------------------------------------------------------
  "live_exit_arm_checked",
  "live_exit_refused_recent_barge",
  // -------------------------------------------------------------------------
  // LVX72's prevention half, in its count-only form.
  //
  // A write refused, answered by the caller, never retried, and announced as
  // done. postcall_verify detects it after the fact; nothing stops it mid-call,
  // so the caller still hangs up believing a change happened.
  //
  // The prevention is the end_call gate -- refuse the hang-up once while an
  // abandoned write is outstanding. It is bounded and uses machinery that
  // already exists, and it carries a real hair-trigger risk: a caller who
  // changed their mind mid-change would be held on the line. LVX21 is what a
  // hair trigger costs here.
  //
  // So the gate is not built. These two answer the question that decides
  // whether it is safe to build: on real calls, how often would a caller have
  // been held?
  // -------------------------------------------------------------------------
  //
  // The positive twin: an end_call reached the check at all. Zero here means
  // the wire is broken, which is precisely how the hesitation gate sat
  // unreachable for the life of a deployment while its fault counter read 0.
  "end_call_abandoned_check_ran",
  // An end_call arrived with an action tool refused and never completed. This
  // is the number that decides whether refusing is safe.
  "end_call_would_refuse_abandoned",
  // LVX74's positive twin. An appointment_id a change tool needed and did not
  // have, answered from the caller's own call-start snapshot instead of by
  // asking the model to go and look it up.
  //
  // The fault half is write_refused_appointment_not_found. Without this one, a
  // call where the model always supplied a real id and a call where the
  // resolver never ran are the same all-zeros reading -- and every guard in
  // the 2026-09-04 round that went unexercised was distinguishable only
  // because a positive counter sat next to the fault one.
  "write_appointment_id_resolved",
  // LVX70's fix, and the positive twin of live_utterance_all_withheld.
  //
  // Caller speech that was withheld during our own playback and then RELEASED
  // when playback ended, instead of being discarded. Non-zero means the gate
  // rescued a word the caller would otherwise have had to say twice; zero on a
  // call with all_withheld above zero means the release threshold is too high.
  "live_gate_speech_released",
  // LVX72's refusal, once it started refusing rather than only counting.
  //
  // end_call_would_refuse_abandoned counts the SITUATION and keeps counting it
  // whether or not the refusal is spent; this counts the refusal actually
  // issued, and it can never exceed 1 per call. The two diverging means the
  // model tried to hang up on an unsaved write more than once, which is worth
  // knowing and is invisible from either number alone.
  "end_call_refused_abandoned",
  // -------------------------------------------------------------------------
  // LVX72's REAL fix: the write the spelling gate refused, re-issued by us.
  //
  // Four calls lost a booking on one path -- the gate refuses pending a
  // spelling, the caller spells it, the model announces the booking and never
  // calls the tool again. Three separate refusal texts asked it to and all
  // three were ignored, because a refusal message is a request. So the retry
  // stopped being a request.
  //
  // attempted is the positive twin and it is the important one: it says the
  // path RAN. refused says the retry itself was declined -- by the availability
  // invariant, the provenance check or the consent gate, all of which still
  // apply because the retry goes through handleToolCall rather than around it.
  // -------------------------------------------------------------------------
  "write_retry_attempted",
  "write_retried_after_spelling",
  "write_retry_refused",
  // The retry saved a booking whose name the caller had SINCE spelled, so the
  // row carries the pre-spelling name until the model corrects it.
  //
  // Not a fault exactly -- the alternative was no booking at all -- but it is
  // the honest cost of replaying stale arguments, and it is the number that
  // says how often correct_appointment_name is being asked for on top.
  "write_retry_name_unspelled",
];

// First live check of both guards together, 2026-09-03. An ordinary booking
// where the caller asked "what times do you have free on Tuesday?": three
// sentences matched the offer shape, one matched the claim shape, and
// `verified_slots` was 94 with `book_appointment` completing on the claiming
// turn. Neither guard fired, and the database row matched the spoken time
// exactly. A true negative on both, with real material to judge -- which is
// what `verified_slots` in the summary now makes checkable after the fact.

/** @type {Record<string, number>} */
let _counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));

/**
 * Increment a turn-taking counter. Unknown names are ignored rather than
 * silently creating fields, so a typo at a call site can't invent a metric.
 * Never throws — instrumentation must not break a call.
 * @param {string} name - one of COUNTER_NAMES
 */
export function bumpCounter(name) {
  try {
    if (Object.prototype.hasOwnProperty.call(_counters, name)) _counters[name] += 1;
  } catch {
    // Metrics must never break a call.
  }
}

/**
 * Add N to a counter, for the ones that total a quantity rather than tally
 * events. Same unknown-name rule as bumpCounter, and the same promise never to
 * throw.
 *
 * A non-finite or negative `by` is dropped rather than coerced: a counter that
 * can go backwards is worse than one that misses an increment, because the
 * first invalidates every reading taken before it and the second costs one.
 *
 * @param {string} name - one of COUNTER_NAMES
 * @param {number} by - how much to add
 */
export function bumpCounterBy(name, by) {
  try {
    if (!Number.isFinite(by) || by <= 0) return;
    if (Object.prototype.hasOwnProperty.call(_counters, name)) _counters[name] += by;
  } catch {
    // Metrics must never break a call.
  }
}

// ---------------------------------------------------------------------------
// classifyHold attribution.
//
// The hold is the single largest piece of latency this codebase controls
// outright: lib/transcriptUtils.js parks a transcript for 1500-2000ms before
// the turn starts, and the branch that fires on any final without terminal
// punctuation charges 1500ms. The rule name is already logged per hold, but a
// log line can't answer "which branch, how often, how many seconds of the
// call". Aggregating count AND total ms per rule does: a rule that fires twice
// for 2000ms each matters less than one firing thirty times for 1500ms.
//
// Zero-cost rules are counted too — terminal_punctuation's share is the
// denominator that says whether the hold is a common tax or an edge case.
// ---------------------------------------------------------------------------

/**
 * Rule names produced by classifyHold (lib/transcriptUtils.js), plus the two
 * decisions session.js makes around it: "complete" (isIncomplete said no, so
 * classifyHold was never consulted — the free case) and "post_barge_settle"
 * (the settle window outbid whatever classifyHold wanted).
 */
const HOLD_RULE_NAMES = [
  "complete",
  "empty",
  "trailing_conjunction",
  "trailing_lead_in",
  // recordHoldRule silently DROPS unknown names, so a rule missing from this
  // list is a hold nobody can see in /api/debug/latency — and this file's own
  // warning is that an unmeasured hold is how the last one went unnoticed.
  "trailing_incomplete",
  "partial_digits",
  "terminal_punctuation",
  "no_terminal_punctuation",
  "post_barge_settle",
];

function freshHoldRules() {
  return Object.fromEntries(HOLD_RULE_NAMES.map((n) => [n, { count: 0, totalMs: 0 }]));
}

/** @type {Record<string, {count: number, totalMs: number}>} */
let _holdRules = freshHoldRules();

/**
 * Record one classifyHold decision. Unknown rule names are ignored rather than
 * silently creating fields, matching bumpCounter. Never throws.
 * @param {string} rule - one of HOLD_RULE_NAMES
 * @param {number} holdMs - ms this decision parked the transcript (0 is meaningful)
 */
export function recordHoldRule(rule, holdMs) {
  try {
    const entry = Object.prototype.hasOwnProperty.call(_holdRules, rule)
      ? _holdRules[rule]
      : null;
    if (!entry) return;
    entry.count += 1;
    if (typeof holdMs === "number" && Number.isFinite(holdMs)) entry.totalMs += holdMs;
  } catch {
    // Metrics must never break a call.
  }
}

/** Stages whose pairwise deltas are reported (and tracked in getLatencyStats). */
const DELTA_SPECS = [
  ["stt_endpoint_ms", "audio_speech_end", "speech_end"],
  ["stt_tail_ms", "speech_end", "stt_final"],
  // How long turn 1 waited on the call-start prefetch (knowledge, integrations,
  // callerContext). Null on every turn but the first — see startTurn, which
  // only marks when the wait is real. This time is ALSO counted inside
  // stt_tail_ms above, because speech_end is stamped from the true end of
  // speech and stt_final at "now": the two overlap by design, and subtracting
  // this from that is what tells you whether a slow first turn was Deepgram or
  // Supabase.
  ["context_wait_ms", "context_wait_start", "context_wait_end"],
  ["llm_ttfb_ms", "llm_request", "llm_first_chunk"],
  // Both null on turns with no tool call — finishTurn writes null for any delta
  // whose marks are absent, and getLatencyStats filters non-numbers, so the
  // percentiles below are computed over tool-calling turns only.
  // How long the MODEL took to decide to call a tool. llm_first_tool_call has
  // been marked since the marker work but was never turned into a stat, so the
  // two halves of a tool turn — the model deciding, and the tool running — were
  // one undifferentiated blob. "It takes 4-5 seconds when a tool runs" cannot
  // be acted on until you know which half that is.
  ["llm_tool_call_ms", "llm_request", "llm_first_tool_call"],
  ["llm_tool_ms", "llm_request", "llm_first_tool"],
  // ...and the difference between the two above is the tool's own execution.
  ["tool_exec_ms", "llm_first_tool_call", "llm_first_tool"],
  ["llm_reply_after_tool_ms", "llm_first_tool", "llm_first_chunk"],
  // The stopwatch number. How long the caller sat in silence, from the true end
  // of their speech, before the hold line reached them — endpointing, the
  // transcript hold, the model's round trip and the tool-hold delay all
  // included, because all four are what the caller experiences as the wait.
  //
  // Null on turns with no hold line, which is most of them.
  //
  // Reconstructing this from llm_first_tool + a constant was the only option
  // before, and it is exactly the kind of arithmetic that hides a regression:
  // the constant was 1500ms of assumption sitting on top of measured data.
  ["hold_line_ms", "audio_speech_end", "hold_line"],
  ["tts_ttfb_ms", "llm_first_chunk", "tts_first_byte"],
  ["playout_ms", "first_audio_sent", "first_frame_wire"],
  ["voice_to_voice_ms", "speech_end", "first_audio_sent"],
  ["true_v2v_ms", "audio_speech_end", "first_frame_wire"],
];

/**
 * Create a per-call turn-metrics tracker.
 * @param {string} callSid
 * @returns {{mark: Function, finishTurn: Function}}
 */
export function createTurnMetrics(callSid) {
  let marks = new Map(); // stage name -> timestamp (ms), insertion-ordered
  let turnIndex = 0;

  /**
   * Record a timestamp for a pipeline stage. Repeat marks of the same name
   * within a turn are ignored (first one wins). Never throws.
   * @param {string} name - one of the stage names described above
   * @param {number} [atMs] - optional explicit timestamp (ms) for tests;
   *   defaults to `performance.now()`.
   */
  function mark(name, atMs) {
    try {
      if (!name || marks.has(name)) return;
      const ts = typeof atMs === "number" && !Number.isNaN(atMs) ? atMs : performance.now();
      marks.set(name, ts);
    } catch {
      // Metrics must never break a call.
    }
  }

  /**
   * Finish the current turn: compute the metrics payload, record it, and
   * start a new (empty) turn implicitly. Never throws.
   * @param {Record<string, unknown>} [extra] - extra fields merged into the payload (e.g. {barged_in: true})
   * @returns {object|null} the payload, or null if fewer than 2 marks were set
   */
  function finishTurn(extra = {}) {
    const currentMarks = marks;
    marks = new Map(); // a new turn implicitly starts now, regardless of outcome below

    try {
      if (currentMarks.size < 2) {
        return null;
      }

      const reference = currentMarks.has("speech_end")
        ? currentMarks.get("speech_end")
        : currentMarks.values().next().value;

      const payload = { callSid, turnIndex };
      for (const [name, ts] of currentMarks) {
        payload[name] = Math.round(ts - reference);
      }

      for (const [deltaName, fromStage, toStage] of DELTA_SPECS) {
        const have = currentMarks.has(fromStage) && currentMarks.has(toStage);
        const ms = have ? Math.round(currentMarks.get(toStage) - currentMarks.get(fromStage)) : null;
        // A NEGATIVE duration is not a slow turn, it is a broken measurement.
        //
        // Observed on staging 2026-08-30: tool_exec_ms -930, true_v2v_ms -9871,
        // playout_ms -12199. Marks land out of order on a barged turn, where a
        // successor generation overlaps the one being abandoned. Recording them
        // was bad enough; nothing downstream filtered them either, so every
        // p50/p95 on the debug endpoint was being computed over impossible
        // values and quietly understating real latency.
        //
        // Dropped to null (the same shape as a mark that never arrived) and
        // counted, so the corruption stays visible instead of just disappearing.
        if (ms != null && ms < 0) {
          payload[deltaName] = null;
          negativeDeltas++;
        } else {
          payload[deltaName] = ms;
        }
      }

      if (extra && typeof extra === "object") {
        Object.assign(payload, extra);
      }

      _ringBuffer.push(payload);
      if (_ringBuffer.length > RING_BUFFER_MAX) {
        _ringBuffer.shift();
      }

      turnIndex++;

      try {
        recordTurnLatency(payload);
      } catch {
        // A logging failure must never break the call.
      }

      return payload;
    } catch {
      return null;
    }
  }

  return { mark, finishTurn };
}

/**
 * Compute a percentile from a sorted-ascending array of numbers.
 * @param {number[]} sorted
 * @param {number} p - 0-100
 * @returns {number|null}
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

const STAT_STAGES = [
  "true_v2v_ms",
  "voice_to_voice_ms",
  "stt_endpoint_ms",
  "stt_tail_ms",
  // First turns only, so n here is much smaller than for the stages around it.
  "context_wait_ms",
  "llm_ttfb_ms",
  "llm_tool_call_ms",
  "llm_tool_ms",
  "tool_exec_ms",
  "llm_reply_after_tool_ms",
  // Null on every turn without a hold line, so n here is far smaller than for
  // the stages around it — the same caveat as context_wait_ms.
  //
  // Added a few hours after hold_line_ms itself, because the span alone was
  // only readable one turn at a time in `recent`. The question this instrument
  // exists to answer ("the hold line was late — how late, typically?") is a
  // distribution, and it was not reachable without this line.
  "hold_line_ms",
  "tts_ttfb_ms",
  "playout_ms",
];

/**
 * Summarize prompt-cache effectiveness over the ring buffer.
 *
 * Gemini's implicit caching only hits on a stable prefix, and the system
 * instruction is deliberately split into a static prefix + dynamic tail
 * (services/gemini.js buildSystemInstruction) to make that possible. Whether
 * it actually works has never been measurable: the token count was logged at
 * DEBUG and then dropped. A hit rate near 0 means the whole prefix is being
 * re-billed and re-processed every turn — worth fixing before any LLM vendor
 * benchmark, because it inflates TTFB on every candidate equally.
 *
 * @param {object[]} buffer
 * @returns {{samples: number, turnsWithHit: number, hitRatePctP50: number|null, cachedTokensP50: number|null}}
 */
function summarizeCache(buffer) {
  const rates = [];
  const cachedCounts = [];
  let turnsWithHit = 0;

  for (const p of buffer) {
    const prompt = p.prompt_tokens;
    const cached = p.cached_tokens;
    if (typeof prompt !== "number" || !Number.isFinite(prompt) || prompt <= 0) continue;
    // A missing cached count alongside a known prompt count is a measured
    // ZERO, not missing data: Gemini omits cachedContentTokenCount entirely
    // when nothing was cached. Skipping those turns reported a completely dead
    // cache as an empty table, which reads as "not instrumented" rather than
    // "the prefix is never being reused".
    const cachedNum = typeof cached === "number" && Number.isFinite(cached) ? cached : 0;
    rates.push((cachedNum / prompt) * 100);
    cachedCounts.push(cachedNum);
    if (cachedNum > 0) turnsWithHit += 1;
  }

  const sortedRates = [...rates].sort((a, b) => a - b);
  const sortedCached = [...cachedCounts].sort((a, b) => a - b);
  const rateP50 = percentile(sortedRates, 50);

  return {
    samples: rates.length,
    turnsWithHit,
    hitRatePctP50: rateP50 === null ? null : Math.round(rateP50),
    cachedTokensP50: percentile(sortedCached, 50),
  };
}

/**
 * Compute latency statistics over the current ring buffer.
 * @returns {{count: number, byStage: Record<string, {p50: number|null, p95: number|null, max: number|null}>, recent: object[]}}
 */
export function getLatencyStats() {
  const byStage = {};
  for (const stage of STAT_STAGES) {
    const values = _ringBuffer
      .map((p) => p[stage])
      .filter((v) => typeof v === "number" && !Number.isNaN(v))
      .sort((a, b) => a - b);
    byStage[stage] = {
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      max: values.length ? values[values.length - 1] : null,
    };
  }

  return {
    count: _ringBuffer.length,
    byStage,
    turnTaking: { ..._counters },
    holdRules: structuredClone(_holdRules),
    cache: summarizeCache(_ringBuffer),
    negativeDeltas,
    recent: _ringBuffer.slice(-20),
  };
}

/** Reset the ring buffer and counters. For tests. */
export function clearStats() {
  _ringBuffer = [];
  _counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  _holdRules = freshHoldRules();
  negativeDeltas = 0;
}

/**
 * Compute avg/p95 voice-to-voice turn latency for a single call, from
 * whatever turns for that callSid are still in the ring buffer. The ring
 * buffer isn't indexed per-call (it's a flat, cross-call rolling window) —
 * turn payloads carry `callSid`, so this just filters it directly. Cheap
 * enough at RING_BUFFER_MAX (500) to not need a real index.
 * @param {string} callSid
 * @returns {{avgMs: number, p95Ms: number, count: number} | null} null if no
 *   turns were recorded for this call (e.g. degraded-mode voicemail calls
 *   that never went through the real-time pipeline).
 */
export function getCallStats(callSid) {
  const values = _ringBuffer
    .filter((p) => p.callSid === callSid)
    .map((p) => p.voice_to_voice_ms)
    .filter((v) => typeof v === "number" && !Number.isNaN(v))
    .sort((a, b) => a - b);
  if (values.length === 0) return null;
  const avgMs = Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
  const p95Ms = percentile(values, 95);
  return { avgMs, p95Ms, count: values.length };
}
