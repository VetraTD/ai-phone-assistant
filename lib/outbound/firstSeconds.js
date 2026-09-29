// lib/outbound/firstSeconds.js
/**
 * The first seconds of an outbound call (spec §9.3, revised after spikes A
 * and B, owner-approved; owner decisions O-6..O-8 in Task 14 fix round 2;
 * S3-2 (spec §19, S3-D2) after live round 1's D1/T1/D10 findings). Pure: no
 * timers, no socket, no clock of its own. lib/voice/live/index.js drives it
 * from Twilio's 20 ms media frames -- NOT from audioOut's pump, which stops
 * when its queue is empty and would never fire the silence backstop.
 *
 * THE RULE IS OFCOM'S, AND IT HAS TWO LIMBS: the person hears us within 2 s
 * of starting to speak, or within 2 s of pickup if they never speak. People
 * say "Hello?" 1.87-2.2 s after answering (the owner's two calls), so a line
 * played at pickup talks over them. So:
 *
 *   1. LISTEN FIRST. Nothing plays while the person is silent; their audio
 *      goes to Live from the first frame (index.js does that, as for inbound).
 *   2. THE PERSON SPEAKS. Speech onset is the VAD's SUSTAINED flag
 *      (inboundVad `voiceActive`, ~200 ms of unbroken voice), backdated to the
 *      start of that voiced run (O-6) -- a single loud frame (pickup handling
 *      noise) is not speech, and a real hello keeps its true start.
 *   3. NOBODY SPEAKS: at `silenceBackstopMs` after pickup -- the stream start
 *      minus the measured answer->stream offset -- the backstop is queued
 *      (`backstop_silence`). A voiced run still unconfirmed at that moment
 *      defers it by at most ONSET_CONFIRM_DEFER_MS: confirmed -> step 2,
 *      died -> fire at once.
 *   4. THE BACKSTOP IS SHORT AND INTERRUPTIBLE, BY OUR OWN BARGE ONLY (M6,
 *      fix round 1). Our own local barge (>= CLIP_BARGE_MIN_MS, S3-2, below)
 *      stops it, ordinary audio through the normal audioOut path. The
 *      vendor's OWN `interrupted` does NOT stop it (I1, fix round 1): it
 *      fires whenever LIVE decides the caller interrupted, which can be
 *      true of speech our own gate never forwarded past 300 ms, or of the
 *      seed's own arrival -- neither is evidence the clip should stop, and
 *      clearing it on that signal defeated CLIP_BARGE_MIN_MS entirely.
 *   5. IT IS SEEDED as Live's own turn (spike A's S1 shape, GO 6/6):
 *      - at once, ONLY when nothing was ever open (Live is not generating);
 *      - otherwise (a generation open at fire, on ANY path, or the
 *        slow/hello-end paths regardless) deferred to the clip's end mark
 *        (O-8): a seed interrupts Live's in-progress generation and would,
 *        pre-I1, have cleared our own clip via its `interrupted` -- I1 is
 *        what makes deferring safe rather than merely quieter.
 *      A slow-path clip cut before its end (a barge) is never seeded -- the
 *      person did not hear the whole line.
 *      Model audio produced while it plays is dropped until its end mark
 *      echoes, or the audio is cleared (a cleared mark never echoes), or,
 *      failing both, clip length + BACKSTOP_MARK_GRACE_MS after it began.
 *   6. FIRST-TURN CHECK (G3): the first assistant turn (or the backstop, when
 *      it played in full) must carry an AI disclosure and the business name.
 *      If not, Live is told once to say it now. A backstop CUT while playing
 *      does not count: the check re-arms for Live's next turn. Detect-and-
 *      correct: on Live a sentence cannot be blocked before it is spoken
 *      (live-removes-the-text-chokepoint).
 *   7. MEASURED AT PLAYOUT (O-7): `outbound_first_audio{from_answer_ms,
 *      from_speech_ms, path, measured}` is taken when a mark queued right
 *      before our first audio ECHOES -- i.e. when that audio started playing,
 *      on every path -- not when it was queued. With no echo by the end of the
 *      session, the queue-time values are logged with `measured: "enqueue"`,
 *      never silently in place of the other. The queue deadline itself is
 *      unchanged (pickup + `silenceBackstopMs`).
 *
 * ---------------------------------------------------------------------------
 * S3-2 (2026-09-27, live round 1): THE CLIP ALWAYS PLAYS FIRST.
 * ---------------------------------------------------------------------------
 * Round 1 found three defects in the race this file used to run (Live's own
 * reply competing with the clip):
 *   D1  Live's late first reply double-talked over the opener clip -- the
 *       race let Live start speaking just as the clip was about to fire.
 *   T1  the silent-pickup clip played at 2.09-2.11 s (queued at pickup + 2.0 s,
 *       plus mark-echo latency), and every silent pickup was flagged as a
 *       silent call by the two-limb rule (§13.4) even though the clip DID
 *       play, just outside the 2.0 s window.
 *   D10 a fast answer found no opener clip at all, because dispatch rendered
 *       it AFTER `calls.create` and the person picked up before the render
 *       finished.
 *
 * The owner's fix (spec §19, S3-D2, superseding §9.3 steps 2-3):
 *   - The stored opener clip ALWAYS plays first, at the FIRST of three timers
 *     (never later than the silence deadline, T1's fix -- P-a moved it to
 *     1,750 ms so the clip playing at 2.09-2.11 s still lands inside 2.0 s of
 *     PICKUP once the mark-echo latency is spent):
 *       (a) the person's hello has ENDED and `helloEndGapMs` has passed with
 *           no more voice (`backstop_hello_end` -- new);
 *       (b) onset + `slowLiveMs` (`backstop_slow`, kept, Ofcom limb 2's
 *           latest-from-speech limit);
 *       (c) `silenceBackstopMs` after pickup, nobody having spoken
 *           (`backstop_silence`, kept, P-a's new number).
 *     Live's reply is NEVER waited for, and NEVER allowed to play first: any
 *     audio Live produces before the clip has even been decided is discarded
 *     (the "clip mode" default, `OUTBOUND_FIRST_SPEAKER=clip`). `path=
 *     live_reply` survives ONLY behind `OUTBOUND_FIRST_SPEAKER=live`, the OLD
 *     race, kept for a later switch once `outbound_live_shadow` (below) shows
 *     Live reliably answering under about 1 s.
 *   - STALE-AUDIO DISCARD. Once the clip is queued, whatever generation Live
 *     may already have had in flight is STALE: its audio must never reach the
 *     caller, however long that takes to prove. Two conditions BOTH have to
 *     hold before Live's audio is trusted again:
 *       (i)  the generation that was in flight WHEN THE CLIP WAS QUEUED has
 *            ended -- Live reported `turnComplete` or `interrupted` for it;
 *       (ii) the seed has been sent (unchanged timing: at once on the silence
 *            path, at the clip's end-mark echo on the slow/hello-end paths,
 *            O-8 kept).
 *     A chunk that arrives AFTER the clip's own end mark but BEFORE (i) is
 *     still stale and is still dropped -- the mark is not the signal, the
 *     vendor's own turn-boundary event is. Named risk 4 (a `turnComplete`
 *     that never arrives, muting Ava forever): bounded by
 *     STALE_GENERATION_IDLE_MS / STALE_GENERATION_MAX_MS, below -- never by
 *     a wall clock that can expire mid-generation (final review I1).
 *   - SHADOW MEASUREMENT. Every discarded chunk is counted, and the first
 *     one's timing is kept, so `outbound_live_shadow` can report how fast
 *     Live WOULD have answered had clip mode not discarded it -- without
 *     ever letting the caller hear it. This is what tells a future session
 *     whether Live is fast enough to flip the default back to `live`.
 *   - CLIP BARGE THRESHOLD. A "hello" said while the clip is already playing
 *     (two people greeting each other at once) is short -- about 400-500 ms
 *     -- and should not cut the clip off; a real interruption is longer.
 *     `CLIP_BARGE_MIN_MS` replaces the ordinary (300 ms) barge threshold
 *     ONLY while the clip's own audio is on the wire.
 *   - RENDER BEFORE DIAL (D10). dispatch.js now renders and stores the
 *     opener BEFORE calling `calls.create`, racing the store against
 *     `RENDER_BEFORE_DIAL_MAX_MS` so a slow render can never hold the dial up
 *     for long; the voicemail clip still renders while the phone rings, as
 *     before.
 * ---------------------------------------------------------------------------
 */
import { AI_DISCLOSURE_RE } from "./campaignSchema.js";
import { words } from "./liveRender.js";
import { log as defaultLog } from "../logger.js";

/** The mark queued behind the backstop clip. Its echo lifts the suppression. */
export const BACKSTOP_END_MARK = "outbound-backstop-end";

/**
 * The mark queued behind a COMPLETE first Live turn's own audio (I5,
 * checkpoint 2b review; same device as BACKSTOP_END_MARK). Live generates
 * text faster than audioOut plays it, so the transcript passing the
 * disclosure check is not proof the person HEARD all of it -- this mark's
 * echo is. onAudioCleared re-arms the check if the audio is cut first.
 */
export const FIRST_TURN_END_MARK = "outbound-first-turn-end";

/**
 * The mark queued immediately BEFORE the first frame of our first audio, on
 * every path. Twilio echoes a mark once everything queued ahead of it has
 * played; nothing is ahead of this one, so its echo is when our first audio
 * started playing (plus the return trip, which errs late -- the safe side for
 * a compliance number). O-7.
 */
export const FIRST_AUDIO_MARK = "outbound-first-audio";

/**
 * Spec §9.3's numbers, revised by S3-2 (owner decision P-a, live round 1's
 * T1): `silenceBackstopMs` was 2,000 -- measured PLAYOUT (mark-echo latency
 * on top of the queue time) landed at 2.09-2.11 s, outside the two-limb
 * rule's 2.0 s window, and every silent pickup was flagged as a silent call
 * even though the clip did play. 1,750 gives that latency room to spend
 * without crossing 2.0 s (pinned in tests/outboundFirstSeconds.test.js: T1's
 * margin, `silenceBackstopMs + 150 <= 2000`).
 *
 * `helloEndGapMs` is new (S3-2): once a hello is confirmed, the clip fires
 * `helloEndGapMs` after the voiced run ends (path=backstop_hello_end) if that
 * comes before `slowLiveMs` after onset -- Live's reply is never waited for
 * on this path either. `slowLiveMs` is unchanged: it is Ofcom's OWN "no later
 * than 2 s after speech" limb, not a spike-tuned number.
 */
export const FIRST_SECONDS_DEFAULTS = Object.freeze({
  answerToStreamMs: 350,
  silenceBackstopMs: 1750,
  slowLiveMs: 1600,
  helloEndGapMs: 350,
});

/**
 * How long a voiced run that is still UNCONFIRMED when the silence deadline
 * arrives may hold the backstop back (O-6): the VAD confirms a run after about
 * 200 ms of unbroken voice, so a hello that started just before the deadline
 * gets that long to prove itself.
 */
export const ONSET_CONFIRM_DEFER_MS = 200;

/**
 * After the clip's own length, how long the CLIP-PLAYING state waits for the
 * backstop's end mark before lifting anyway (fix round 1, M9). A mark that
 * never echoes -- a Twilio hiccup, a dropped event -- must not mute Live for
 * the rest of the call. This bounds only "is the clip's own audio still on
 * the wire"; STALE_GENERATION_IDLE_MS / STALE_GENERATION_MAX_MS (below)
 * bound the separate, potentially longer wait for the pre-clip generation to
 * report its own end.
 */
export const BACKSTOP_MARK_GRACE_MS = 1500;

/**
 * No clip at stream start (the render may still be finishing when the person
 * picks up): the stored opener is re-read ONCE, this long before the backstop
 * deadline, so the answer is in hand by the time it fires and the read never
 * delays the backstop itself (fix round 1, I4). A read still outstanding at
 * the deadline counts as a miss: the prompt path.
 */
export const BACKSTOP_REFETCH_LEAD_MS = 400;

/**
 * S3-2, named risk 4: a stale generation's own close (`turnComplete`/
 * `interrupted`) that never arrives must not mute Ava forever. HOW that is
 * bounded changed in the final fix wave (W1, final review I1).
 *
 * WHAT WAS HERE: `STALE_GENERATION_GRACE_MS` = 2,000 ms of WALL CLOCK from the
 * seed, on the premise that "a seed interrupts Live's in-progress generation;
 * the resulting `interrupted` is a same-session round trip". Sim A run 1
 * falsified it on gemini-3.8-live: the stale reply to the pre-clip "Hello?"
 * was a full opener repeat streaming at speaking pace, no `interrupted` ever
 * came, and its `turnComplete` landed 61 ms AFTER the 2 s ran out. The
 * timeout lifted the discard MID-GENERATION, so the rest of that generation
 * played (the audible "...calling on behalf of Harness Test Clinic" tail),
 * and -- because the same timeout also cleared `droppedSinceTurnText` (the
 * NB3 ruling) -- the whole stale opener was then recorded as heard.
 *
 * THE RULE NOW: the discard is CLOSE-DRIVEN. Once condition (i) is armed it
 * holds until that generation's own close, however long it streams. Two
 * bounds only, neither a guess at Live's latency:
 *   - IDLE (`STALE_GENERATION_IDLE_MS`): no stale chunk for this long -- and
 *     at least this long since the wait was armed -- means the generation
 *     ended without reporting its close (the vendor dropped the event). A
 *     generation still streaming never trips it.
 *   - CAP (`STALE_GENERATION_MAX_MS`): a generation that keeps streaming and
 *     never closes. Logged at error level: this is a vendor fault, not a
 *     timing variation.
 * A lift by either bound ABANDONS the stale generation: its text is dropped
 * from the reply accumulator (`discardReplyText`, wired to index.js) and it
 * never reads heard, not even for its own late close -- heard-ness is scoped
 * to the generation, not to a flag a clock clears.
 *
 * Ruling (idle 1,500 ms): the review's own range was 1-1.5 s. The top of it,
 * because the cost is asymmetric: too short, and a stale generation that
 * merely PAUSES (a slow tool round inside it) has its tail played
 * mid-sentence -- audible and incoherent; too long, and on the rare call
 * where the vendor drops a close Ava stays quiet ~1.5 s longer -- dead air,
 * which the silence ladder already bounds. Sim A's stale generation streamed
 * 18 chunks over ~5 s (a chunk every ~280 ms), 5x inside this.
 * Ruling (cap 12,000 ms): the review's own example. A full opener repeat is
 * ~5 s of speech; 12 s from the seed is more than twice that. Cost if wrong:
 * a genuinely longer stale generation (none observed) plays its tail after
 * 12 s -- logged at error so it is seen.
 */
export const STALE_GENERATION_IDLE_MS = 1500;
export const STALE_GENERATION_MAX_MS = 12_000;

/**
 * S3-2: while the clip's own audio is on the wire, a caller run shorter than
 * this does not stop it -- a "hello" said back at the clip is about 400-500
 * ms (fix round 1, I1's own estimate). A longer run does stop it, through the
 * ordinary clearAudio path, and re-arms the first-turn check exactly as any
 * other cut clip does (I1, unchanged). Applies whenever a real clip is
 * playing, in both `firstSpeaker` modes -- it protects the CLIP's own audio,
 * not any one path's timing.
 */
export const CLIP_BARGE_MIN_MS = 600;

/**
 * Checkpoint-A review, C1 (Critical). The ordinary half-duplex gate
 * (lib/voice/live/halfDuplex.js) withholds caller audio in a 500 ms ring
 * sized for LIVE'S OWN short reply, not for a multi-second opener clip: a
 * caller's whole utterance was falling out of that ring long before the clip
 * finished playing, and being silently discarded when it did (confirmed on 3
 * real sim calls, `live_utterance{playing_at_open:true, forwarded:0,
 * dropped_voiced:16}` -- a gatekeeper's "He's out." never reached Live's ASR
 * at all). lib/voice/live/index.js bypasses that gate entirely, for outbound
 * only, while THIS controller's `clipPlaying()` is true, and holds caller
 * frames itself (see index.js's clip-hold buffer) until the seed has gone --
 * bounded by this many milliseconds of frames so a lost end-mark event (M9)
 * or a truly silent stretch cannot grow the buffer without limit.
 *
 * Ruling: 8,000 ms -- the same order of magnitude as
 * RENDER_BEFORE_DIAL_MAX_MS (lib/outbound/dispatch.js), the one other
 * "generous bound on an outbound-clip-adjacent wait" in this codebase,
 * rather than inventing an unrelated scale. A real opener line (one or two
 * sentences of TTS) plays out in a few seconds at most, well inside this;
 * the natural release (the seed going out at the end-mark echo, or M9's own
 * timeout) fires long before this cap is ever reached in practice.
 *
 * WHAT HAPPENS PAST THE CAP: the OLDEST held frame is dropped, one at a
 * time, as each new frame arrives (the caller's most recent words matter
 * more than their first) -- counted (`outbound_clip_hold_dropped`) and
 * logged, never silent. A run pinned at the cap for the rest of a genuinely
 * abnormal call degrades to "the earliest few seconds are lost", the same
 * bounded-loss shape the pre-existing ring already had, rather than an
 * unbounded buffer.
 */
export const CLIP_CALLER_HOLD_MAX_MS = 8_000;

/**
 * F-R2 (2026-09-28, half-2 controller analysis; Direction A -- restores
 * S3-2's own design). The checkpoint-A hold (CLIP_CALLER_HOLD_MAX_MS, above)
 * buffers EVERY caller frame -- voiced AND silent -- for as long as the clip
 * plays, which reintroduced the round-1 D1 double-talk/re-ask defect by a
 * different door: Live had already heard the hello (it arrived before the
 * clip queued, ordinary real-time forwarding), but the hold then withheld
 * every trailing-silence frame that would let Live's OWN end-of-turn VAD
 * finish deciding the hello was over -- so Live never started generating a
 * reply DURING the clip, only once the whole held burst was released in one
 * synchronous shot at the seed. By then the local stale-discard state had
 * already lifted (nothing was ever `generationOpen` for it to snapshot), so
 * the reply Live then generated to the STALE hello sailed straight through:
 * re-asking identity or repeating the opener on top of a caller who was
 * already answering it.
 *
 * Ruling: split what the hold captures. A caller frame that is NOT voiced
 * keeps flowing to Live close to real time, through this short delay line,
 * instead of being captured whole -- so Live's own end-of-turn VAD sees the
 * hello's trailing silence on close to its own schedule and, if it decides
 * to reply, starts generating WHILE the clip is still playing. That reply is
 * then exactly the case S3-2's own stale-discard/refreshStaleSnapshot
 * machinery (this file, C1's own fix -- see the comment there) was already
 * built to catch: `clipPlaying()` (or `staleDiscard`) is still true when the
 * first chunk arrives, so it is discarded and counted (populating
 * `outbound_live_shadow.from_speech_ms` for the first time on this path, as
 * spec S3-D2 requires). In the common case that generation also CLOSES
 * during the clip (re-review M7: turnComplete at +2.44 s, seed at +5.18 s);
 * only a slower one is still open when the seed is sent, and then
 * `refreshStaleSnapshot` keeps the discard armed until it reports its own
 * `turnComplete`/`interrupted` (final wave W1, I1: however long that takes,
 * bounded by the idle/cap pair -- never a wall clock).
 *
 * FIX ROUND 1 (opus review, I1). The first cut latched the hold on ANY raw
 * `voiced` frame -- one loud 20 ms frame (a click, a cough, an early second
 * "Hello?"), or a backstop_slow greeting that was already mid-utterance when
 * the clip fired, brought the defect back in full: everything from that
 * frame on was captured whole again, Live's end-of-turn for the ALREADY-
 * SUPPRESSED generation never fired during the clip, and its reply leaked
 * after the opener exactly as before this file's own fix. `onCallerFrame`'s
 * own vocabulary (O-6) already draws this line -- onset is CONFIRMED speech
 * (the VAD's sustained `voiceActive`, ~`activeMs` of unbroken voice), not one
 * loud frame -- and `routeClipFrame` (lib/voice/live/index.js) now reuses
 * that exact notion: it latches on `voiceActive` transitioning false->true,
 * never on raw `voiced` alone. A click or cough never sustains `activeMs` of
 * unbroken voice, so `voiceActive` never fires for it and it simply ages
 * through the delay line, unlatched, like any other non-content frame.
 *
 * Ruling (the backstop_slow tail / continuing-utterance case, I1's second
 * finding): `routeClipFrame` also tracks whether `voiceActive` was ALREADY
 * true on the very first frame processed for this clip -- i.e. was the
 * caller still mid-utterance, from BEFORE the clip fired, when it started
 * playing (the gatekeeper-greeting shape: backstop_slow can fire mid-
 * sentence by design, Ofcom's "no later than 2 s" limb, so the very next
 * frame is often already voiced). While that holds, frames keep flowing
 * through the delay line UNLATCHED -- exactly like silence -- until
 * `voiceActive` drops back to false (a genuine, hangover-confirmed gap: the
 * SAME utterance has actually ended), rather than latching immediately and
 * starving Live of the trailing-silence signal for a reply it is still
 * mid-way through forming. Only once the caller has gone quiet at least once
 * does the ordinary "latch on a freshly confirmed onset" rule apply. This is
 * the general form of the plain-hello fix: it lets Live's own end-of-turn
 * for ANY utterance already in progress when the clip starts -- not only a
 * finished "Hello?" -- land close to real time, inside the window the
 * existing discard already catches.
 *
 * Ruling (a genuinely NEW utterance during the clip, e.g. a caller who has
 * gone quiet once and then says "Hello? Anyone there?" again -- I1's third
 * finding, which is simultaneously C1's own territory). This IS treated as
 * held speech (invariant 2), not folded into "the same stale hello" and
 * silently discarded: once `voiceActive` confirms a fresh onset (the caller
 * having genuinely gone quiet at least once since the clip fired, per the
 * paragraph above), `routeClipFrame` latches exactly as the plain hello-tail
 * case already did, and whatever Live eventually replies to that HELD
 * content, once released after the seed, is a real answer the caller hears
 * -- never a discarded stale artifact. This is a deliberate choice, not a
 * gap: C1 exists precisely because a caller's genuine new words during the
 * clip must reach Live and get a heard reply, not be generated mid-clip and
 * thrown away unheard. Cost if wrong (treating it as stale instead): a
 * caller who speaks again while Ava is still finishing the opener would get
 * no acknowledgement of what they just said at all until they speak a THIRD
 * time -- worse than the audible-but-late reply this ruling accepts instead.
 *
 * CLIP_HOLD_DELAY_LINE_MS (M5, opus review: no longer reusing
 * ONSET_CONFIRM_DEFER_MS's value -- the two knobs are unrelated: one bounds
 * a compliance deadline deferral, this one only has to outlast how long a
 * confirmed run takes to retroactively drain). 500 ms; see FIX ROUND 2 below
 * for why its own sizing rationale narrowed (it no longer has to cover any
 * part of confirmation -- that moved to its own separate buffer/window).
 *
 * ---------------------------------------------------------------------------
 * FIX ROUND 2 (opus re-review, NB2, 2026-09-28): latching on `voiceActive`
 * let GENUINE in-clip speech reach Live before the seed.
 * ---------------------------------------------------------------------------
 * `voiceActive` needs `activeMs` (200 ms) of UNBROKEN voiced frames --
 * `lib/voice/inboundVad.js`'s own streak resets on any single unvoiced
 * frame. The re-review measured how long real speech actually takes to
 * satisfy that, over the same 39 real TTS WAVs (`vadlatch.mjs`): median
 * 340 ms, p90 1,160 ms, max 1,600 ms from the first voiced frame to
 * confirmation at native level -- and at -12 dB, 16 of 39 utterances never
 * satisfied it AT ALL (a natural micro-gap resets the streak before it ever
 * reaches 200 ms). Every frame between the first voiced frame and that
 * (late, or never-arriving) confirmation was flowing through the delay line
 * UNLATCHED the whole time -- fix round 1's own "reject noise" logic had no
 * way to tell "this hasn't confirmed YET" from "this is a click, not
 * speech", so it kept forwarding. Real result: up to 0.5 s of a caller's
 * actual words reached Live before the seed on 16/39 native-level
 * utterances (C1's own invariant breached), and at -12 dB the caller's
 * whole utterance could flow through in real time on 16/39 -- Live's own
 * (untrusted, pre-seed) reply timing then decides whether the caller hears
 * anything at all, the pre-C1 race reopened by a different door.
 *
 * Ruling: split "is this voiced" from "is this CONFIRMED speech, not noise"
 * into two separate questions, with two separate mechanisms, rather than
 * one flag trying to answer both (which is what made `voiceActive` both too
 * slow for genuine speech and, per round 1's own m1, not actually reliable
 * against a sustained cough either). A raw voiced frame now latches
 * PROVISIONALLY -- the SAME zero-onset-lag property the very first (pre-C1)
 * design had, so nothing of a genuine utterance's own true start can ever
 * leak before we have even started deciding -- into a SEPARATE buffer, not
 * `clipHoldBuffer`. Confirmation is a COUNT of voiced frames within
 * `CLIP_CONFIRM_WINDOW_MS` of the provisional latch (`CLIP_CONFIRM_VOICED_
 * FRAMES`), not `voiceActive`'s strict "consecutive, resets on any gap"
 * rule -- exactly what the re-review's own data says is needed: real speech
 * has natural micro-gaps that reset a consecutive-frame counter but should
 * not reset a WITHIN-WINDOW count. If the count is reached, the provisional
 * buffer folds into the ordinary hold (`pushClipHold`) and routing proceeds
 * exactly as fix round 1 already had it (LATCHED, phase 3). If the window
 * elapses UNCONFIRMED, the provisional buffer is released BACK to Live, IN
 * ORDER, directly (`sendAudio` -- these frames already waited the whole
 * window; queueing them into the delay line for MORE delay would help
 * nobody), and routing falls through to re-evaluate the triggering frame
 * fresh (a genuinely continuing run re-latches provisionally at once; a
 * true blip, now past, resumes ordinary delay-line/watching treatment).
 * Counted, never silent: `outbound_clip_provisional_unlatched`
 * (`lib/voice/metrics.js`).
 *
 * CLIP_CONFIRM_WINDOW_MS = 800, CLIP_CONFIRM_VOICED_FRAMES = 11 (measured:
 * `nb2sim.mjs`, a script adapting the re-review's own `vadlatch.mjs`
 * harness -- same real `createVad`, same 39 real TTS WAVs, same gain/noise
 * grid -- to simulate this exact provisional/confirm/un-latch design and
 * count voiced frames actually released to Live before the seed). Full
 * numbers in the fix round 2 report. Summary: at native, -6 dB and -12 dB,
 * across both noise floors tested, ZERO voiced frames reach Live before the
 * seed and every one of the 39 utterances confirms on its FIRST provisional
 * window (no un-latch cycling at all) -- the exact three acceptance rows
 * the re-review named. Threshold 11 (220 ms) is the SAME boundary fix round
 * 1's own `activeMs=200` already had (an 11th consecutive frame is what
 * first flips `voiceActive` true) -- chosen deliberately, not coincidentally:
 * it is the minimum value that can NEVER be reached by an isolated burst up
 * to 200 ms (10 frames, structurally, regardless of window width), which
 * the acceptance bar requires stay unlatched. Window 800 ms balances two
 * costs: too small and genuine but naturally-gappy speech (a hesitant
 * "H-hello?") can time out before accumulating 11 voiced frames, reopening
 * the leak the fix exists to close; too large and a FALSE provisional latch
 * (background noise briefly crossing the VAD threshold) sits un-released for
 * longer, delaying Live's own view of the clip's silence by that much more.
 * At -18 dB the design does not reach parity with the very-first (pre-C1)
 * mechanism's near-zero never-latch rate -- an unavoidable floor, not a
 * tuning miss: that mechanism's near-zero rate came from having NO
 * confirmation bar at all (one frame, ever, latches forever), which the
 * acceptance bar's own "bursts up to 200 ms must not latch" requirement
 * rules out for THIS design. It IS a real improvement over fix round 1's
 * own -18 dB rate (see the report for the exact counts), which is the
 * comparison that matters: -18 dB was already an accepted, out-of-scope
 * (M4-class) limitation before this round, not a regression introduced by
 * it.
 */
export const CLIP_HOLD_DELAY_LINE_MS = 500;

/**
 * F-R2 fix round 2 (NB2). See the block comment above for the full
 * derivation and the measured numbers. Both apply to the SAME provisional
 * window: `CLIP_CONFIRM_WINDOW_MS` is how long a raw-voiced provisional
 * latch has to accumulate `CLIP_CONFIRM_VOICED_FRAMES` voiced frames before
 * routeClipFrame gives up and releases it back to Live.
 */
export const CLIP_CONFIRM_WINDOW_MS = 800;
export const CLIP_CONFIRM_VOICED_FRAMES = 11;

/**
 * Final wave W1, A18 (F-R2 re-review 1 m7). routeClipFrame's phase 1 (the
 * caller already mid-utterance when the clip fired -- the backstop_slow
 * shape) lets the tail of that utterance flow to Live close to real time,
 * so Live's own end-of-turn for it lands during the clip. It used to end
 * ONLY when the VAD's voiceActive dropped, so a talker whose gaps never
 * reach the VAD's 300 ms hangover was never held at all: every word they
 * said over the clip reached Live before the seed (probe R2: 120 voiced
 * frames on a 3 s tail), and Live's reply to them was discarded as stale --
 * none of it got an answer the caller heard.
 *
 * Ruling: phase 1 lasts at most this long from the clip's first frame, then
 * ordinary phase-2 rules apply (a voiced frame latches provisionally, a
 * confirmed run is held and delivered after the seed). 600 ms = CLIP_BARGE_
 * MIN_MS, on the same reasoning: a hello's tail is about 400-500 ms, and a
 * caller still talking 600 ms into the clip is saying something new -- the
 * clip barge draws the identical line for an unbroken run. Cost if wrong:
 * too short, and the tail of a long greeting is held and answered after the
 * opener (heard, merely later); too long, and more of what the caller says
 * over the clip reaches Live before the seed and gets only a discarded
 * reply.
 */
export const CLIP_PRE_CLIP_TAIL_MAX_MS = CLIP_BARGE_MIN_MS;

/**
 * Final wave W1, I2 (final review; ledger m1). Caller SPEECH still held when
 * the caller hangs up mid-clip is released to Live at hang-up instead of
 * being dropped, and the Live session is kept open for a short, bounded
 * drain so its input transcription of those words reaches the transcript
 * (and the post-call opt-out detector) -- see lib/voice/live/index.js's
 * beginClipHoldDrain for the design. Two bounds:
 *   - SETTLE: the drain ends this long after the LAST caller-transcript
 *     fragment it received. Ruling: 400 ms -- the measured input-transcript
 *     lag p50 on this path is ~412 ms from speech end
 *     (input_transcript_lag_ms_p50, memory transcript-ms-is-not-lag), and a
 *     transcript arriving in fragments is normally complete well inside one
 *     such gap. Cost if wrong: too short, and the tail of a long held
 *     utterance misses its row (the head is written); too long, and the
 *     post-call claim waits a little longer.
 *   - MAX: the drain never holds the teardown longer than this from the
 *     hang-up, transcript or not. Ruling: 2,000 ms, the review's own "≤2 s".
 *     A burst of up to CLIP_CALLER_HOLD_MAX_MS of audio is processed by
 *     Live far faster than real time; the transcript is either there within
 *     2 s or not coming. Cost if wrong: an opt-out whose transcript arrives
 *     after 2 s is still lost (outbound_clip_hold_drain_untranscribed says
 *     how often a drain ends with nothing).
 */
export const CLIP_HOLD_DRAIN_SETTLE_MS = 400;
export const CLIP_HOLD_DRAIN_MAX_MS = 2000;

/** 8 kHz mu-law: one byte per sample. */
const MULAW_BYTES_PER_MS = 8;

const isClip = (buf) => Buffer.isBuffer(buf) && buf.length > 0;

/**
 * The disclosure's own words (AI_DISCLOSURE_RE's alternatives), lower-cased,
 * for the M3 vocabulary below -- never the whole phrase, so a run of these
 * words in any order still recovers a glued token that spans them.
 */
const DISCLOSURE_VOCAB_WORDS = ["ai", "artificial", "intelligence", "automated", "assistant", "virtual"];

/**
 * Does this turn carry the §7 disclosure AND the business name?
 *
 * Dotted spellings ("an A.I. assistant", "A. I.") are folded to "AI" first:
 * a transcript that writes the letters out still said them (fix round 1, M3).
 * The fold is campaignSchema.js's foldDottedAI, shared with liveRender.js.
 *
 * M3 (checkpoint 2b review, H1's tolerance extended here). Live's own output
 * transcription glues words the same way a render's does ("AIassistant",
 * "HarnessTest" for a business called "Harness Test Clinic") -- reusing
 * liveRender.js's `words(text, vocab)` (the ONE shared re-split
 * implementation) with a vocab of the disclosure's own words plus the
 * business name's own words means this can only ever recover words already
 * in one of those two vocabularies, never let something else through.
 *
 * @param {string} text
 * @param {string} businessName
 */
export function firstTurnComplete(text, businessName) {
  const nameWords = words(businessName);
  const vocab = new Set([...DISCLOSURE_VOCAB_WORDS, ...nameWords]);
  // Only a TRUE dotted acronym -- the dot after the I is required -- so "Plan
  // A. I wanted…" is two words, not a disclosure (fix round 3). `words()`
  // applies the shared foldDottedAI itself before anything else.
  const resplit = words(text, vocab).join(" ");
  if (!AI_DISCLOSURE_RE.test(resplit)) return false;
  const name = nameWords.join(" ");
  return name.length > 0 && resplit.includes(name);
}

/**
 * @param {object} o
 * @param {() => number} [o.now] - the session clock; used when onModelAudio/onMark/onSessionEnd/onAssistantTurnText are given no time
 * @param {Buffer|null} o.backstopAudio - 8 kHz mu-law; null/empty = no clip
 * @param {string|null} o.backstopText - the rendered opener, what the clip says; null = no usable line (O-9)
 * @param {{enqueue: (buf: Buffer) => void}} o.audioOut - the NORMAL audio path
 * @param {(name: string) => void} o.sendMark
 * @param {(text: string) => void} o.seed - S1: a lone role:"model" turn, turnComplete:false
 * @param {(text: string) => void} o.noteToModel - the first-turn correction
 * @param {(text: string) => void} [o.promptModel] - the no-clip silence line; defaults to noteToModel
 * @param {(text: string, atMs: number) => void} [o.noteSpoken] - echoGuard.noteSpoken
 * @param {(name: string) => void} [o.bumpCounter] - lib/voice/metrics.js's bumpCounter, for outbound_live_shadow
 * @param {() => Promise<Buffer|null>} [o.refetchBackstopAudio] - one late read of the stored clip, when there was none at stream start
 * @param {number} [o.refetchLeadMs]
 * @param {number} [o.markGraceMs]
 * @param {number} [o.staleGenerationIdleMs]
 * @param {number} [o.staleGenerationMaxMs]
 * @param {() => void} [o.discardReplyText] - final review I1: the reply text
 *   accumulated so far belongs to a stale generation the caller never heard
 *   (abandoned by the idle/cap bound) -- drop it. index.js wires this to its
 *   own reply accumulator; a no-op by default.
 * @param {number} [o.onsetConfirmDeferMs]
 * @param {number} o.streamStartAtMs
 * @param {number} [o.answerToStreamMs]
 * @param {number} [o.silenceBackstopMs]
 * @param {number} [o.slowLiveMs]
 * @param {number} [o.helloEndGapMs]
 * @param {number} [o.clipBargeMinMs]
 * @param {"clip"|"live"} [o.firstSpeaker] - S3-2: "clip" (default) never lets
 *   Live speak first; "live" keeps the pre-S3-2 race, kept for a later switch.
 * @param {string} [o.businessName]
 * @param {string} [o.personaName]
 * @param {object} [o.log]
 * @param {object} [o.logFields] - ids only (callSid, attemptId), on every log line
 */
export function createFirstSecondsController({
  now = () => 0,
  backstopAudio,
  backstopText,
  audioOut,
  sendMark,
  seed,
  noteToModel,
  promptModel,
  noteSpoken = () => {},
  bumpCounter = () => {},
  refetchBackstopAudio = null,
  refetchLeadMs = BACKSTOP_REFETCH_LEAD_MS,
  markGraceMs = BACKSTOP_MARK_GRACE_MS,
  staleGenerationIdleMs = STALE_GENERATION_IDLE_MS,
  staleGenerationMaxMs = STALE_GENERATION_MAX_MS,
  discardReplyText = () => {},
  onsetConfirmDeferMs = ONSET_CONFIRM_DEFER_MS,
  streamStartAtMs,
  answerToStreamMs = FIRST_SECONDS_DEFAULTS.answerToStreamMs,
  silenceBackstopMs = FIRST_SECONDS_DEFAULTS.silenceBackstopMs,
  slowLiveMs = FIRST_SECONDS_DEFAULTS.slowLiveMs,
  helloEndGapMs = FIRST_SECONDS_DEFAULTS.helloEndGapMs,
  clipBargeMinMs = CLIP_BARGE_MIN_MS,
  firstSpeaker = "clip",
  businessName = "",
  personaName = "",
  log = defaultLog,
  logFields = {},
}) {
  const prompt = promptModel ?? noteToModel;
  // "silenceBackstopMs after pickup", on the stream clock.
  const silenceDeadline = streamStartAtMs + (silenceBackstopMs - answerToStreamMs);
  const lineText = typeof backstopText === "string" && backstopText.trim() ? backstopText : null;

  /** The clip to play: the one stored at stream start, or one the late re-read found. Never without its text. */
  let clip = lineText && isClip(backstopAudio) ? backstopAudio : null;
  let clipSource = clip ? "stored" : null;
  /** "idle" -> "pending" -> "done". Once per call. */
  let refetch = "idle";
  /** Confirmed speech onset (backdated to its run's start), or null. */
  let onsetAt = null;
  /** Start of the current voiced run the VAD has not confirmed yet, or null. */
  let runStart = null;
  /** When the silence deadline was first held back for an unconfirmed run. */
  let deferredFrom = null;
  /**
   * S3-2: the timestamp of the most recent VOICED (raw, per-frame) caller
   * frame since onset was confirmed, and when the run since then last went
   * quiet (null while still talking). Drives path=backstop_hello_end and the
   * shadow metric's from_speech_end_ms -- independent of the VAD's own
   * hangover, which is why this is tracked here rather than read off
   * voiceActive.
   */
  let lastVoicedAt = null;
  let helloEndAt = null;
  /** Our first audio was QUEUED: {atMs, path}. */
  let queued = null;
  /** ...and started PLAYING (the first-audio mark echoed): the metrics, measured:"playout". */
  let played = null;
  let firstAudioLogged = false;
  let backstopFired = false;
  /** The no-clip silence path: Live was asked to say the line, and its audio is the backstop. */
  let promptedPath = null;

  // -- Clip-playing state: is the CLIP'S OWN AUDIO currently on the wire? ----
  let clipPlaying = false;
  /** When clipPlaying's own safety lift fires even if the end mark never echoes (M9). */
  let clipPlayingUntil = null;
  let clipPlayingFrom = null;
  /** O-8: a slow/hello-end-path clip seeds when its end mark echoes, not when it fires. */
  let slowSeedPending = false;
  let clipBargeConsumed = false;
  /** A14: the caller's current unbroken voiced run, and the longest one, counted from the clip's own start. */
  let clipRunStartAt = null;
  let clipLongestRunMs = 0;

  // -- Stale-audio discard state (S3-2, named risks 1/2/4) -------------------
  /** Is SOME Live generation currently open (chunks seen, no turnComplete/interrupted yet)? */
  let generationOpen = false;
  /** Live's audio is untrusted until BOTH conditions below hold. */
  let staleDiscard = false;
  /**
   * Condition (i): a generation open when the clip was queued -- or found
   * still (or newly) open when the seed is sent or given up (C1, fix round
   * 2: refreshStaleSnapshot re-checks fresh at both instants, not just at
   * queue time) -- has not yet closed.
   */
  let awaitingStaleGenerationClose = false;
  /**
   * Condition (ii): the seed for THIS clip has been sent -- or (final review
   * A27) given up on for good (giveUpOnSeed), which makes it moot the same
   * way armStaleDiscard's no-seed paths already treat it.
   */
  let seedSent = false;
  /** When the bounded wait for condition (i) was armed (seed sent, given up, or armStaleDiscard). */
  let staleDiscardFrom = null;
  /** ...and the hard cap on it (STALE_GENERATION_MAX_MS). */
  let staleDiscardCapAt = null;
  /** The last chunk discarded: the IDLE bound runs from here (and from staleDiscardFrom, whichever is later). */
  let lastDiscardAtMs = null;
  /**
   * Final review I1: set when the idle/cap bound ABANDONED a generation that
   * never reported its close. Until a chunk actually plays again, whatever
   * Live sends (its late transcript, its late close) is attributed to that
   * abandoned generation -- never heard. The first chunk that plays is a new
   * generation: the accumulator is cut once more and heard-ness resets.
   */
  let abandonedUntilPlay = false;
  /**
   * Final wave W1 (I2): the caller has hung up. index.js keeps the Live
   * session open for a short bounded drain (held speech released to Live so
   * its words reach the transcript), and nothing Live says from here on can
   * be heard by anyone.
   */
  let callerGone = false;
  let discardedChunks = 0;
  let firstDiscardAtMs = null;
  let shadowLogged = false;

  let turnChecked = false;
  /**
   * I5 (checkpoint 2b review): a COMPLETE Live turn passed the disclosure
   * text-check and FIRST_TURN_END_MARK is queued behind its audio, but the
   * check is not yet satisfied -- only the mark's echo (onMark) confirms it.
   * onAudioCleared re-arms (clears this without setting turnChecked) if the
   * audio is cut before the mark comes back.
   */
  let firstTurnMarkPending = false;
  /**
   * Model audio was dropped since the last turn text arrived. That turn was
   * not heard (or not all of it), so its text cannot satisfy the first-turn
   * check -- the case being a barge that re-arms the check (I1) while Live's
   * suppressed reply is still to report its text.
   */
  let droppedSinceTurnText = false;

  function metrics(atMs, path, measured) {
    return {
      from_answer_ms: Math.round(atMs - streamStartAtMs + answerToStreamMs),
      from_speech_ms: onsetAt === null ? null : Math.round(atMs - onsetAt),
      path,
      measured,
    };
  }

  /**
   * Our first audio is about to be queued: the playout mark goes FIRST, so
   * nothing but it precedes the audio on the wire.
   */
  function recordQueued(atMs, path) {
    if (queued) return;
    queued = { atMs, path };
    sendMark(FIRST_AUDIO_MARK);
  }

  function endClipPlaying() {
    clipPlaying = false;
    clipPlayingUntil = null;
  }

  /**
   * S3-2 fix round 1, C1. `awaitingStaleGenerationClose`'s snapshot at QUEUE
   * time (fireBackstop) is necessary but not sufficient: on the slow/
   * hello-end paths the seed is sent later, at the end-mark echo, and Live's
   * reply to the hello usually starts generating IN BETWEEN those two
   * instants (Live's own voice-to-voice latency is longer than
   * helloEndGapMs). A generation that opened after the clip queued but is
   * still open right NOW, at the instant we are about to trust the seed to
   * have corrected it, is exactly as stale as one that was already open at
   * queue time -- it started before the seed either way. Called from every
   * place that is about to newly rely on the seed (sendSeed) or give up on
   * ever sending one (giveUpOnSeed): re-reads `generationOpen` fresh and only
   * ever ADDS to the wait, never clears a genuinely-closed one.
   */
  function refreshStaleSnapshot() {
    if (generationOpen) awaitingStaleGenerationClose = true;
  }

  /**
   * M9: a mark that never echoes lifts clip-playing on a clock, logged.
   * Condition (ii) can never newly become true for THIS clip once this fires
   * (a slow/hello-end seed still pending is dropped, not sent late -- Live
   * may be mid-reply by now, and a seed would interrupt it) -- but M4
   * (fix round 1): that drops ONLY condition (ii). Condition (i) -- is a
   * generation from before this moment still open -- is untouched by a mark
   * merely failing to echo, so it is handed to giveUpOnSeed rather than
   * cleared outright.
   */
  function checkClipPlayingTimeout(atMs) {
    if (!clipPlaying || clipPlayingUntil === null || atMs < clipPlayingUntil) return;
    log.error("outbound_backstop_mark_timeout", { ...logFields, waited_ms: Math.round(atMs - clipPlayingFrom), seed_dropped: slowSeedPending });
    slowSeedPending = false;
    endClipPlaying();
    giveUpOnSeed(atMs);
    // NOT catchMidClipGeneration here (fix round 2, scoping ruling): the mark
    // never echoing is a Twilio hiccup, not the caller doing anything -- the
    // safety lift (M9) exists precisely so a lost event cannot mute Live
    // indefinitely, and item 3's own scenario is the clip ending NORMALLY
    // (its end mark echoing on time). Extending item 3's catch here would
    // make an already-abnormal path hold Live mute even longer.
  }

  /** Start the bounded wait for condition (i): the idle bound and the hard cap both run from here. */
  function armStaleBounds(atMs) {
    staleDiscardFrom = atMs;
    staleDiscardCapAt = atMs + staleGenerationMaxMs;
  }

  /** Condition (ii): actually send the seed, and start condition (i)'s own bounded wait. */
  function sendSeed(atMs) {
    seed(lineText);
    seedSent = true;
    refreshStaleSnapshot(); // C1: re-check now, not just at queue time
    armStaleBounds(atMs);
    maybeLiftStaleDiscard();
  }

  /**
   * M4 (fix round 1). The seed will never be sent for this clip any more --
   * dropped by the mark-timeout (checkClipPlayingTimeout) or by a clear
   * before it could go (onAudioCleared) -- so condition (ii) is abandoned
   * for good. Condition (i) is NOT: if a generation is genuinely open right
   * now (re-checked fresh, same as sendSeed), the discard keeps waiting for
   * it to close, its bounds armed HERE (there is no seed instant to anchor
   * them to any more). Only when nothing was ever open (or it already
   * closed) does this lift immediately.
   *
   * Final review A27 (F-R2 re-review 2's out-of-scope note): this used to
   * leave `seedSent` false, and maybeLiftStaleDiscard requires it -- so the
   * stale generation's OWN close could never lift the discard after a clip
   * barge or an M9 timeout, only the (then wall-clock) grace could. Given up
   * is final: condition (ii) is moot from here, exactly as armStaleDiscard's
   * no-seed paths already treat it, so the close lifts it at once (the same
   * close-driven rule sendSeed's path follows).
   */
  function giveUpOnSeed(atMs) {
    if (!staleDiscard) return;
    seedSent = true;
    refreshStaleSnapshot();
    if (!awaitingStaleGenerationClose) {
      staleDiscard = false;
      // No reprompt here: giveUpOnSeed only ever runs on a HAS-CLIP path
      // (the mark timing out, or a clear before it echoed) -- the no-clip
      // reprompt (N2) is scoped to armStaleDiscard's own no-clip callers.
      return;
    }
    armStaleBounds(atMs);
  }

  /**
   * S3-2 fix round 2 (N1 + item 3). Arms a stale-discard wait with its own
   * bounded grace clock, condition (ii) already trivially satisfied --
   * shared by the no-clip M3 path (there is no seed to send) and
   * catchMidClipGeneration (below; the seed for THIS clip already went, or
   * was dropped, before this NEW generation was noticed).
   */
  function armStaleDiscard(atMs) {
    staleDiscard = true;
    awaitingStaleGenerationClose = true;
    seedSent = true;
    armStaleBounds(atMs);
  }

  /**
   * Item 3 (fix round 2, out-of-scope observation 1 in the re-review). The
   * clip's own audio has just stopped being on the wire (its end mark
   * echoed, the M9 timeout gave up on it, or it was cleared) and staleDiscard
   * already reads false -- the clip's OWN seed wait, if it ever had one,
   * already resolved. But a DIFFERENT generation may have opened WHILE the
   * clip played (the caller answered "yes" mid-clip) and had its head
   * dropped by `clipPlaying` alone: without this, its tail plays
   * mid-sentence the instant nothing blocks it any more -- the exact
   * partial-generation class the M3 ruling forbids, just reached from the
   * has-clip side. Never re-arms something already correctly tracked
   * (guarded on `staleDiscard` already being false).
   */
  function catchMidClipGeneration(atMs) {
    if (staleDiscard || !generationOpen) return;
    armStaleDiscard(atMs);
  }

  /**
   * N2 (fix round 2). The no-clip M3 path drops Live's ONLY reply whole,
   * with nothing else ever said -- unlike the has-clip paths, there is no
   * backstop line the caller already heard. Left alone, the caller hears
   * silence until THEY speak again. Fires exactly once, whichever way the
   * armed discard resolves (a genuine close, via maybeLiftStaleDiscard, or
   * named risk 4's own grace timeout, via checkStaleDiscardTimeout) --
   * reuses the SAME prompt/nudge mechanism (`prompt`, wired to
   * sendDialContent in index.js) the silence path's own no-clip case
   * already uses, rather than inventing a new one.
   *
   * Armed by fireBackstop's M3 block on hello-end/slow ONLY (NB2, fix round
   * 3): the silence path already prompts Live itself a few lines above, so
   * arming this too there fired it TWICE -- once for the silence prompt's
   * own drop-and-close, once here, on top of Live's reply to the first one.
   * Cancelled -- never fired at all -- if the caller speaks again (a voiced
   * frame the VAD counts as speech, AFTER the arm: R1, fix round 4) before the
   * drop resolves (NB1, onCallerFrame): their own speech is what usually
   * closes the dropped generation, and Live's reply to THEM is coming
   * either way, so the nudge would only make it talk over them.
   */
  let noClipRepromptPending = false;
  function fireNoClipReprompt() {
    if (!noClipRepromptPending) return;
    noClipRepromptPending = false;
    prompt(
      lineText
        ? `The person hasn't heard you yet. Say: ${lineText}`
        : `The person hasn't heard you yet. Say briefly, in your own words, that you are ${personaName}, an AI assistant from ${businessName}.`
    );
    bumpCounter("outbound_no_clip_reprompt");
    log.info("outbound_no_clip_reprompt", { ...logFields });
  }

  /** Both (i) and (ii): only then is Live's audio trusted again. */
  function maybeLiftStaleDiscard() {
    if (staleDiscard && seedSent && !awaitingStaleGenerationClose) {
      staleDiscard = false;
      fireNoClipReprompt();
    }
  }

  /**
   * Named risk 4's bound: condition (i) never arriving must not mute forever.
   * See STALE_GENERATION_IDLE_MS / STALE_GENERATION_MAX_MS for the rule and
   * the history (final review I1 replaced a 2 s wall clock that expired
   * mid-generation and let the stale tail play).
   *
   * Lifts ONLY when the stale generation has gone quiet for the idle bound
   * (it ended without reporting its close) or the hard cap has passed. A
   * lift ABANDONS that generation (final review I1, replacing the NB3
   * ruling R2, which cleared `droppedSinceTurnText` here and so made the
   * timed-out stale generation itself read heard -- its whole text then
   * persisted, audited and folded into history):
   *   - the reply text accumulated so far is dropped (`discardReplyText`);
   *   - `abandonedUntilPlay` keeps it unheard until a chunk actually PLAYS,
   *     so its own late transcript and late close never read heard either;
   *   - the first chunk that plays (onModelAudio) is a NEW generation: the
   *     accumulator is cut once more there and heard-ness resets, so the
   *     next heard reply keeps its rows and guards (NB3's own concern) with
   *     none of the stale text glued onto it.
   */
  function checkStaleDiscardTimeout(atMs) {
    if (!staleDiscard || staleDiscardFrom === null) return;
    const idleFrom = Math.max(staleDiscardFrom, lastDiscardAtMs ?? -Infinity);
    const capped = atMs >= staleDiscardCapAt;
    if (!capped && atMs < idleFrom + staleGenerationIdleMs) return;
    const fields = {
      ...logFields,
      reason: capped ? "cap" : "idle",
      waited_ms: Math.round(atMs - staleDiscardFrom),
      idle_ms: Math.round(atMs - idleFrom),
    };
    // The cap is a vendor fault (a generation streaming past it and never
    // closing): error level. The idle bound is the vendor dropping ONE close
    // event: still logged at error, downgraded to a warning.
    if (capped) log.error("outbound_stale_discard_timeout", fields);
    else log.error("outbound_stale_discard_timeout", { ...fields, severity: "warn" });
    staleDiscard = false;
    awaitingStaleGenerationClose = false;
    generationOpen = false;
    droppedSinceTurnText = true;
    abandonedUntilPlay = true;
    discardReplyText();
    fireNoClipReprompt();
  }

  /** I4: one scoped read of a clip stored after the stream started. Never throws, never waits. */
  function startRefetch() {
    refetch = "pending";
    let read;
    try {
      read = Promise.resolve(refetchBackstopAudio());
    } catch (err) {
      read = Promise.reject(err);
    }
    read
      .then(
        (buf) => {
          if (!backstopFired && !clip && lineText && isClip(buf)) {
            clip = buf;
            clipSource = "refetched";
          }
        },
        () => {}
      )
      .finally(() => {
        refetch = "done";
      });
  }

  function fireFirstTurnCorrection() {
    turnChecked = true;
    log.error("outbound_first_turn_incomplete", { ...logFields });
    noteToModel(`Tell them now, briefly: you are ${personaName}, an AI assistant from ${businessName}.`);
  }

  /**
   * The BACKSTOP path only (fireBackstop, below). Unchanged since fix round
   * 1 (I1): the clip's own end mark (BACKSTOP_END_MARK) and the suppression
   * re-arm in onAudioCleared already give this an implicit wait-then-revert
   * -- a pass here is immediate, and onAudioCleared undoes it if the clip is
   * cut before BACKSTOP_END_MARK echoes. Live's OWN first turn does not run
   * through this: see checkFirstTurnFromLive.
   */
  function checkFirstTurn(text) {
    if (turnChecked) return;
    if (!String(text || "").trim()) return; // a tool round with no speech is not a turn
    if (firstTurnComplete(text, businessName)) {
      turnChecked = true;
      return;
    }
    fireFirstTurnCorrection();
  }

  /**
   * I5 (checkpoint 2b review). Live's own first turn, called from BOTH the
   * `interrupted` and `turnComplete` index.js hooks -- `complete` says which.
   *
   * An INTERRUPTED turn never satisfies the check, whatever its text says:
   * the person may only have heard part of it (that is what "interrupted"
   * means), so this returns having done nothing at all -- no note, no mark,
   * still armed for the next turn. Firing a correction here could talk over
   * a barge that was itself the caller answering a disclosure they DID hear.
   *
   * A COMPLETE turn that fails the disclosure text-check corrects at once,
   * same as the backstop. One that PASSES is only provisionally good: text
   * is proof Live GENERATED the disclosure, not proof the person HEARD it
   * (audioOut paces frames after Live has already finished talking) --
   * FIRST_TURN_END_MARK is queued behind this turn's own audio (the same
   * device as BACKSTOP_END_MARK) and the check is satisfied only when that
   * mark echoes (onMark). onAudioCleared re-arms it if the audio is cut
   * first, silently, for the same reason an interrupted turn never satisfies.
   */
  function checkFirstTurnFromLive(text, complete) {
    if (turnChecked || firstTurnMarkPending) return;
    if (!String(text || "").trim()) return; // a tool round with no speech is not a turn
    if (!complete) return; // I5: interrupted -- never satisfies, never corrects here
    if (!firstTurnComplete(text, businessName)) {
      fireFirstTurnCorrection();
      return;
    }
    firstTurnMarkPending = true;
    sendMark(FIRST_TURN_END_MARK);
  }

  function fireBackstop(atMs, path) {
    backstopFired = true;
    // Reported ONLY when this fire really was held back by an unconfirmed run
    // (O-6). A run that confirmed cleared it (fix round 3): a later slow-path
    // fire must not carry the deferral of a deadline it never used.
    const deferral = deferredFrom === null ? {} : { deferred_ms: Math.round(atMs - deferredFrom) };
    if (!clip) {
      // `refetch` says whether a late read was tried and whether it was still
      // out at the deadline ("pending" = too slow, treated as a miss).
      log.error("outbound_backstop_missing", { ...logFields, path, refetch, line: lineText ? "yes" : "none", ...deferral });
      if (path === "backstop_silence") {
        promptedPath = path;
        prompt(
          lineText
            ? `The person hasn't spoken. Say: ${lineText}`
            : `The person hasn't spoken. Say briefly, in your own words, that you are ${personaName}, an AI assistant from ${businessName}.`
        );
      }
      // M3 (fix round 1, Ruling; N1 fix round 2): there is no clip and no
      // seed on this path, so a generation already open at this instant
      // cannot be corrected the way a seed corrects one -- and forwarding it
      // from here on would play its TAIL having dropped its HEAD (this
      // instant is exactly where `neverLetLiveSpeakFirst` in onModelAudio
      // stops applying). Ruling: never forward a partial generation -- drop
      // the WHOLE thing and let the next one speak, the same as any other
      // stale generation, rather than buffer-and-replay it (which would risk
      // exactly the D1 overlap this file exists to prevent, on content we
      // have not vetted at all). "Condition (ii)" does not exist on this
      // path (no seed), so it is trivially satisfied; only condition (i) --
      // this generation closing -- is waited for, BOUNDED (N1, fix round 2:
      // armStaleDiscard arms its bounds -- the ORIGINAL fix here left them
      // unset, so named risk 4 was never actually bounded on this path; the
      // re-review caught Live muted indefinitely at 20/30/60 s with no
      // timeout ever logged. Since final review I1 the bounds are the
      // idle/cap pair, never a wall clock that expires mid-generation).
      //
      // N2 (fix round 2): unlike every has-clip path, there is no backstop
      // line the caller has already heard on this one -- dropping the whole
      // generation with nothing else said leaves them in real silence, not
      // the "short gap" the original report claimed. `noClipRepromptPending`
      // fires a one-off nudge (fireNoClipReprompt) once this armed wait
      // resolves, whichever way.
      if (firstSpeaker === "clip" && generationOpen) {
        armStaleDiscard(atMs);
        // NB2 (fix round 3, re-review 2): the SILENCE path just prompted Live
        // itself, a few lines up (promptedPath/prompt) -- that IS the nudge;
        // arming this SAME reprompt here too meant it fired again the
        // instant the (silence path's own) dropped generation closed, which
        // is usually exactly when Live starts answering prompt 1. The
        // caller heard prompt 1's reply cut off by prompt 2, or the line
        // twice. Scoped away from this one path; hello-end/slow still arm it
        // (they never call `prompt` above).
        if (path !== "backstop_silence") noClipRepromptPending = true;
      }
      return;
    }
    recordQueued(atMs, path);
    // Ordinary audio, the buffer alone: the normal barge-in stops it (subject
    // to CLIP_BARGE_MIN_MS's own threshold, S3-2 -- see onCallerFrame).
    audioOut.enqueue(clip);
    sendMark(BACKSTOP_END_MARK);
    clipPlaying = true;
    clipPlayingFrom = atMs;
    clipPlayingUntil = atMs + Math.ceil(clip.length / MULAW_BYTES_PER_MS) + markGraceMs;
    // S3-2, named risks 1/2: whatever Live may already have had in flight is
    // stale from this instant. Snapshot whether a generation was actually
    // open -- most calls have none (nobody had spoken yet, or Live had not
    // started replying), and the snapshot lets that trivial case lift the
    // discard as soon as the seed goes, exactly as clip-playing's own bound
    // does, rather than inventing a wait for something that was never there.
    // sendSeed/giveUpOnSeed re-check this fresh (C1), so a generation that
    // opens later but before the seed goes is still caught.
    staleDiscard = true;
    awaitingStaleGenerationClose = generationOpen;
    seedSent = false;
    noteSpoken(lineText, atMs);
    // O-8, extended to the new hello-end path AND (I1, fix round 1) to the
    // silence path when a generation happens to be open: Live can be
    // mid-reply to something our OWN onset detector never confirmed (a
    // short "hi", or an O-6 run that died), and seeding into that would
    // interrupt a real generation for no reason. Any path defers to the
    // clip's own end-mark echo whenever `generationOpen` is true at fire;
    // the silence path seeds at once ONLY when nothing was ever open.
    if (path === "backstop_slow" || path === "backstop_hello_end" || generationOpen) {
      slowSeedPending = true;
    } else {
      sendSeed(atMs);
    }
    log.info("outbound_backstop_played", {
      ...logFields,
      path,
      source: clipSource,
      seed: slowSeedPending ? "at_end_mark" : "at_fire",
      ...deferral,
    });
    // The backstop IS the first turn when it plays -- unless it is cut before
    // it finishes, which re-arms the check (onAudioCleared).
    checkFirstTurn(lineText);
  }

  function logFirstAudio(m) {
    if (firstAudioLogged) return;
    firstAudioLogged = true;
    log.info("outbound_first_audio", { ...logFields, ...m });
  }

  /**
   * S3-2: never skipped on a hello call, even when nothing was discarded.
   *
   * Final wave W1:
   *   - A9 (F-R2 M2; spec S3-D2 "logged on every call"): a call with no
   *     confirmed onset (backstop_silence, or a hang-up before anything)
   *     now logs the line too -- both measurements null, with `reason`
   *     saying why. The counter stays a per-HELLO-call count (its meaning
   *     in lib/voice/metrics.js), so it is bumped only when there was one.
   *   - A8 (F-R2 M1 / re-review 1 m3): when Live's discarded reply began
   *     after the clip had started playing, the hello's trailing silence
   *     reached Live through index.js's clip delay line, which holds it back
   *     CLIP_HOLD_DELAY_LINE_MS -- Live's own end-of-turn, and so its
   *     would-be reply, came that much later than it would have without the
   *     clip. Both measurements subtract it (the gate on flipping to `live`
   *     mode must not read our own routing lag as Live being slow);
   *     `delay_line_adjust_ms` says how much, so the raw value is recoverable.
   */
  function logShadow() {
    if (shadowLogged) return;
    shadowLogged = true;
    if (onsetAt === null) {
      log.info("outbound_live_shadow", {
        ...logFields,
        from_speech_ms: null,
        from_speech_end_ms: null,
        discarded_chunks: discardedChunks,
        reason: "no_onset",
      });
      return;
    }
    const hasFirst = discardedChunks > 0 && firstDiscardAtMs !== null;
    // Clip mode only: `live` mode never routes caller audio through the delay line.
    const adjust =
      hasFirst && firstSpeaker === "clip" && clipPlayingFrom !== null && firstDiscardAtMs > clipPlayingFrom ? CLIP_HOLD_DELAY_LINE_MS : 0;
    const fields = {
      ...logFields,
      from_speech_ms: hasFirst ? Math.round(firstDiscardAtMs - onsetAt - adjust) : null,
      from_speech_end_ms: hasFirst && helloEndAt !== null ? Math.round(firstDiscardAtMs - helloEndAt - adjust) : null,
      discarded_chunks: discardedChunks,
      delay_line_adjust_ms: adjust,
      reason: hasFirst ? "measured" : "no_discarded_chunk",
    };
    log.info("outbound_live_shadow", fields);
    bumpCounter("outbound_live_shadow");
  }

  return {
    /**
     * Every inbound frame, ungated: the VAD's verdict. Onset is `voiceActive`
     * (the sustained flag), backdated to the start of the run it confirmed.
     * S3-2 additions: continues tracking the voiced run AFTER onset (for
     * path=backstop_hello_end and the shadow metric) up until the backstop
     * decision is made, and the clip-barge threshold while a real clip plays.
     * @returns {{clipBarge: boolean}} clipBarge: true exactly once, the frame
     *   a sustained caller run crosses CLIP_BARGE_MIN_MS while the clip's own
     *   audio is on the wire. index.js reacts to it (clearAudio + signal
     *   "start"), which itself calls onAudioCleared -- the re-arm is not
     *   this controller's to do twice. M2 (fix round 1): gated on clip mode
     *   -- `live` mode is the pre-S3-2 race verbatim, including the ORDINARY
     *   (lower) barge threshold; CLIP_BARGE_MIN_MS is this file's own new
     *   behaviour, not something "live" ever had.
     */
    onCallerFrame({ voiced, voiceActive, atMs, voicedRunMs = 0 }) {
      let clipBarge = false;
      // Final wave W1 (A14, F-R2 parked P9). The clip barge measures the
      // caller's unbroken voiced run from the clip's OWN start, not the
      // VAD's `voicedRunMs` (the longest run of the whole activation): on
      // backstop_slow the clip fires mid-greeting by design (onset + 1,600
      // ms), so the activation's run was already past CLIP_BARGE_MIN_MS and
      // the opener was cut on its very first frame. `voicedRunMs` is still
      // accepted (index.js passes it) but no longer decides the clip barge.
      void voicedRunMs;
      if (clipPlaying) {
        // The same run arithmetic as the VAD's own voicedRunMs, clipped to
        // the clip: a voiced frame extends (or starts) the run, any quiet
        // frame ends it, and the longest run is forgotten once the
        // activation itself has lapsed.
        if (voiced) {
          if (clipRunStartAt === null) clipRunStartAt = atMs;
          clipLongestRunMs = Math.max(clipLongestRunMs, atMs - clipRunStartAt);
        } else {
          clipRunStartAt = null;
          if (!voiceActive) clipLongestRunMs = 0;
        }
      }
      if (firstSpeaker === "clip" && clipPlaying && !clipBargeConsumed && voiceActive && clipLongestRunMs >= clipBargeMinMs) {
        clipBargeConsumed = true;
        clipBarge = true;
      }
      // NB1 (fix round 3, re-review 2). The caller speaking again, after a
      // no-clip generation was armed for the reprompt (fireBackstop's M3
      // block), is not the dead air the reprompt exists for: in production
      // the caller's OWN speech is usually exactly what closes that
      // generation (Live's `interrupted` fires on hearing them), and
      // reprompting Live right as it is about to answer them just makes it
      // talk over them instead -- the ordinary barge then cuts THAT off, so
      // the caller hears a fragment of the reprompt line on top of it all.
      // A caller who has spoken again is not in dead air: Live's reply to
      // them is coming anyway. Runs regardless of backstopFired/queued --
      // the flag this cancels only ever arms AFTER the backstop has already
      // fired, so it has to look past the block below, which stops tracking
      // once a decision is made.
      //
      // R1 (fix round 4, re-review 3): `voiced &&`, not `voiceActive` alone.
      // voiceActive stays true for the VAD's 300 ms hangover after the
      // caller's LAST voiced frame, and the slow-path decision always lands
      // within 350 ms of that frame -- so the hangover of a hello that ended
      // BEFORE the decision cancelled the reprompt for a caller who then
      // stayed silent (the dead air it exists for). A frame that is voiced
      // AND counted as speech by the VAD is the caller genuinely speaking
      // after the arm; a lone blip the VAD never confirms (a cough) is not.
      if (noClipRepromptPending && voiced && voiceActive) {
        noClipRepromptPending = false;
      }
      if (queued === null && !backstopFired) {
        if (onsetAt === null) {
          if (voiceActive) {
            onsetAt = runStart ?? atMs;
            runStart = null;
            // The run confirmed: any silence-deadline deferral is over and moot.
            deferredFrom = null;
            lastVoicedAt = atMs;
            helloEndAt = null;
          } else if (voiced) {
            if (runStart === null) runStart = atMs;
          } else {
            runStart = null; // the VAD resets an unconfirmed streak on any quiet frame, and so does this
          }
        } else if (voiced) {
          lastVoicedAt = atMs;
          helloEndAt = null;
        } else if (helloEndAt === null) {
          helloEndAt = lastVoicedAt;
        }
      }
      return { clipBarge };
    },

    /** Every inbound frame, after onCallerFrame: Twilio's 20 ms clock. */
    tick(atMs) {
      checkClipPlayingTimeout(atMs);
      checkStaleDiscardTimeout(atMs);
      if (queued !== null || backstopFired) return;
      if (onsetAt === null) {
        if (!clip && refetchBackstopAudio && refetch === "idle" && atMs >= silenceDeadline - refetchLeadMs) startRefetch();
        if (atMs < silenceDeadline) return;
        // O-6: a hello already under way but not yet confirmed holds the
        // silence backstop back, briefly. Confirmed -> the slow/hello-end
        // clock; died -> runStart is null and this fires now.
        if (runStart !== null && atMs < silenceDeadline + onsetConfirmDeferMs) {
          if (deferredFrom === null) deferredFrom = silenceDeadline;
          return;
        }
        fireBackstop(atMs, "backstop_silence");
        return;
      }
      // S3-2: race the hello-end deadline against the slow deadline, whichever
      // is first -- but only in clip mode. `live` mode keeps the OLD race
      // (Live's own reply, via onModelAudio, preempts firing the backstop at
      // all), which never had a hello-end concept.
      const slowDeadline = onsetAt + slowLiveMs;
      const helloEndDeadline = firstSpeaker === "clip" && helloEndAt !== null ? helloEndAt + helloEndGapMs : Infinity;
      const earliestDeadline = Math.min(slowDeadline, helloEndDeadline);
      if (!clip && refetchBackstopAudio && refetch === "idle" && atMs >= earliestDeadline - refetchLeadMs) startRefetch();
      if (atMs < earliestDeadline) return;
      fireBackstop(atMs, helloEndDeadline <= slowDeadline ? "backstop_hello_end" : "backstop_slow");
    },

    /**
     * Model audio is about to be enqueued.
     * @returns {boolean} true to play it, false to drop it
     */
    onModelAudio(atMs = now()) {
      checkClipPlayingTimeout(atMs);
      checkStaleDiscardTimeout(atMs);
      generationOpen = true;
      // Final wave W1 (I2): after the hang-up nobody hears anything. Not
      // counted toward the shadow (it measures how fast Live answers a hello,
      // and it has already been logged by now).
      if (callerGone) {
        droppedSinceTurnText = true;
        return false;
      }
      // S3-2: in clip mode, Live never speaks first -- ANY audio produced
      // before the backstop decision has even been made is discarded, not
      // merely raced against. `live` mode keeps the old behaviour: audio
      // arriving before any backstop fires IS the first audio (path=
      // live_reply). Once a backstop HAS fired (clip or no-clip), this clause
      // is moot either way and staleDiscard (or nothing, on the no-clip path)
      // governs.
      const neverLetLiveSpeakFirst = firstSpeaker === "clip" && !backstopFired;
      // clipPlaying: the clip's OWN audio must never be talked over, whether
      // or not any generation was ever stale (the trivial silence-path case
      // lifts staleDiscard as soon as the seed goes -- see maybeLiftStaleDiscard
      // -- but the clip can still have seconds left to play).
      if (neverLetLiveSpeakFirst || clipPlaying || staleDiscard) {
        discardedChunks += 1;
        if (firstDiscardAtMs === null) firstDiscardAtMs = atMs;
        lastDiscardAtMs = atMs;
        droppedSinceTurnText = true;
        return false;
      }
      // Final review I1: the first chunk that PLAYS after the idle/cap bound
      // abandoned a stale generation opens a new, heard generation. Whatever
      // reply text arrived in between (the abandoned generation's own late
      // transcript) is cut here, so it is never persisted as this one's.
      if (abandonedUntilPlay) {
        abandonedUntilPlay = false;
        droppedSinceTurnText = false;
        discardReplyText();
      }
      recordQueued(atMs, promptedPath ?? "live_reply");
      return true;
    },

    /**
     * A whole assistant turn's transcript, from either index.js hook -- and
     * (S3-2) the generation-boundary event the stale-discard state machine
     * waits for (condition (i)), regardless of whether the turn's audio was
     * ever heard.
     * @param {string} text
     * @param {boolean} [complete=true] - I5: true from the turnComplete hook,
     *   false from the interrupted hook. Default true so a caller that
     *   passes only `text` (every pre-I5 call site) keeps its old meaning.
     * @param {number} [atMs]
     * @returns {boolean} F-R2 fix round 1 (opus review, I2): `heard` -- false
     *   when ANY chunk of this generation's audio was ever discarded (the
     *   SAME whole-generation rule M3 already applies to what plays). index.js
     *   uses this to gate transcript persistence and the outbound turn
     *   detectors for a generation the caller never actually heard, on either
     *   hook -- always `true` on inbound, where nothing ever calls this with
     *   a suppressed generation to begin with.
     */
    onAssistantTurnText(text, complete = true, atMs = now()) {
      generationOpen = false;
      if (awaitingStaleGenerationClose) {
        awaitingStaleGenerationClose = false;
        maybeLiftStaleDiscard();
      }
      checkStaleDiscardTimeout(atMs);
      // Final review I1: an abandoned generation's own late close (nothing
      // has played since the bound abandoned it) is still that generation --
      // `droppedSinceTurnText` is still set for it, so it reads unheard.
      const heard = !droppedSinceTurnText;
      droppedSinceTurnText = false;
      abandonedUntilPlay = false;
      if (heard) checkFirstTurnFromLive(text, complete);
      return heard;
    },

    /** Twilio echoed a mark. */
    onMark(name, atMs = now()) {
      if (name === FIRST_AUDIO_MARK) {
        if (queued && !played) {
          played = metrics(atMs, queued.path, "playout");
          logFirstAudio(played);
        }
        return;
      }
      if (name === BACKSTOP_END_MARK) {
        endClipPlaying();
        // O-8: the slow/hello-end-path clip played to its end; only now is
        // Live told it said the line (and only now does condition (ii)'s
        // clock start).
        if (slowSeedPending) {
          slowSeedPending = false;
          sendSeed(atMs);
        }
        // Item 3 (fix round 2): the SILENCE path's own seed already went at
        // fire, so staleDiscard may already read false here -- but a
        // DIFFERENT generation can have opened WHILE the clip played and had
        // its head dropped. Catch it, or its tail plays mid-sentence now that
        // clipPlaying alone no longer blocks it.
        catchMidClipGeneration(atMs);
        return;
      }
      // I5: Live's own first turn is confirmed HEARD, not merely generated.
      if (name === FIRST_TURN_END_MARK && firstTurnMarkPending) {
        firstTurnMarkPending = false;
        turnChecked = true;
      }
    },

    /**
     * Our audio was cleared -- a local barge, the vendor's `interrupted`, any
     * clearAudio. The backstop's end mark went with the queue and will never
     * echo, so clip-playing has to lift here.
     *
     * AND IF THE CLIP WAS STILL PLAYING, IT WAS CUT (fix round 1, I1): the
     * person may have heard "Hi, is that Sam?" and nothing of "It's Ava, an AI
     * assistant from …". The first-turn check is re-armed, so Live's NEXT turn
     * must carry the disclosure and the name or it is corrected -- and a
     * slow/hello-end-path seed still waiting for the end mark is never sent
     * (O-8).
     *
     * I5: the SAME thing for Live's own first turn. If FIRST_TURN_END_MARK is
     * still pending, this clear took it with the queue -- it will never echo
     * -- so the provisional pass is dropped, silently: `turnChecked` was never
     * set for it, so clearing the pending flag alone re-arms Live's NEXT turn.
     *
     * S3-2: if the seed for this clip was never sent (the clip was cut before
     * its end mark), condition (ii) can never become true for it either --
     * handed to giveUpOnSeed, the SAME M4 (fix round 1) function
     * checkClipPlayingTimeout uses, which drops ONLY (ii) and keeps (i)
     * alive (its own grace clock, started now) if a generation is genuinely
     * still open. A clear AFTER the seed was sent leaves staleDiscard alone:
     * it is either already lifted, or still legitimately waiting on
     * condition (i), and an unrelated later clear must not disturb that wait.
     *
     * I1 (fix round 1): production wiring (lib/voice/live/index.js) no
     * longer routes the vendor's OWN `interrupted` through this while
     * `clipPlaying()` is true, so this normally only fires for a REAL barge
     * (clipBarge, >= CLIP_BARGE_MIN_MS) or a leak-cutter -- this function
     * does not need to know which; it only reacts to "the audio is gone".
     */
    onAudioCleared(atMs = now()) {
      if (clipPlaying) {
        turnChecked = false;
        slowSeedPending = false;
      }
      if (firstTurnMarkPending) firstTurnMarkPending = false;
      endClipPlaying();
      if (!seedSent) giveUpOnSeed(atMs);
      // NOT catchMidClipGeneration here either (fix round 2, scoping
      // ruling): a clear is a BARGE or an explicit cut -- the caller (or a
      // guard) has just acted, and Live's next audio responding to that is
      // exactly what must not be held back. Item 3's own scenario is the
      // clip ending on its own schedule (its end mark echoing normally),
      // not being cut off.
    },

    /**
     * The session is ending. A first audio whose playout mark never echoed
     * (the person hung up first) is logged from its QUEUE time, flagged
     * `measured: "enqueue"` -- never passed off as a playout time. S3-2: also
     * where the shadow measurement is logged, once, on any call where a hello
     * happened at all.
     */
    onSessionEnd() {
      if (queued && !played) logFirstAudio(metrics(queued.atMs, queued.path, "enqueue"));
      logShadow();
    },

    /**
     * @returns {{from_answer_ms: number, from_speech_ms: number|null, path: string, measured: "playout"|"enqueue"}|null}
     *   the playout measurement once the mark has echoed; until then (or if it
     *   never does) the queue-time values, flagged `measured: "enqueue"`
     */
    firstAudio() {
      if (played) return { ...played };
      return queued ? metrics(queued.atMs, queued.path, "enqueue") : null;
    },

    /**
     * Final wave W1: would Live's audio be discarded if it arrived right
     * now? The SAME decision onModelAudio makes (minus its own time checks,
     * which every 20 ms frame's tick() already runs), exposed for the two
     * consumers that act on a generation BEFORE (or without) its audio:
     *   - A16: a transcript fragment arriving while this is true belongs to
     *     a generation the caller will not hear (noteAssistantText, below);
     *   - A19: a tool call arriving while this is true comes from such a
     *     generation (index.js onToolCall refuses the caller-visible ones).
     * Wider than suppressing(): it also covers "clip mode, nothing decided
     * yet" (Live never speaks first) and the post-hang-up drain (I2).
     */
    discardingNow: () =>
      callerGone || (firstSpeaker === "clip" && !backstopFired) || clipPlaying || staleDiscard,

    /**
     * Final wave W1 (A16, F-R2 re-review 1 m5): the streaming text guards
     * gate on droppedThisGeneration(), which only a DISCARDED AUDIO CHUNK
     * used to set -- so a stale generation whose transcript arrived before
     * its first audio chunk slipped through them (probe R7: live_outbound_leak
     * and live_offer_unverified fired, and a spoken leak note went out).
     * index.js calls this on every output-transcription fragment, before the
     * guards: text arriving while Live's audio would be discarded marks the
     * generation dropped, exactly as its first chunk would have.
     */
    noteAssistantText() {
      if (callerGone || (firstSpeaker === "clip" && !backstopFired) || clipPlaying || staleDiscard) {
        droppedSinceTurnText = true;
      }
    },

    /** Final wave W1 (I2): the caller hung up; see `callerGone`. */
    onCallerGone() {
      callerGone = true;
    },

    /** Test/diagnostic seams. */
    suppressing: () => clipPlaying || staleDiscard,
    /**
     * F-R2 fix round 1 (opus review, I2). NARROWER than suppressing(): has
     * ANY audio chunk of the CURRENTLY OPEN generation actually been
     * discarded so far (the same droppedSinceTurnText onAssistantTurnText's
     * own `heard` reads at turn-end, exposed live, mid-turn). clipPlaying()
     * alone is the wrong signal for index.js's streaming text guards --
     * NB4's own scenario (a text-only push, no audio chunk ever sent) proved
     * it: clipPlaying() is true for the WHOLE clip regardless of whether
     * THIS generation's audio was ever actually touched by the suppression,
     * so gating on it there silently broke NB4's already-established
     * "the guard still logs, just does not cut" contract. This one only
     * reads true once index.js's own onModelAudio has actually dropped a
     * chunk belonging to the generation still open right now.
     */
    droppedThisGeneration: () => droppedSinceTurnText,
    // M2 (fix round 1): gated on clip mode. index.js's ONLY use of this is
    // deciding whether to defer to the clipBarge verdict instead of the
    // ordinary barge threshold -- a `live`-mode decision that must not exist,
    // so this reads false there regardless of the internal `clipPlaying`
    // state. `suppressing()` above (the drop-condition seam) is deliberately
    // NOT gated: the clip's own audio must never be talked over in EITHER
    // mode.
    clipPlaying: () => firstSpeaker === "clip" && clipPlaying,
    onsetAt: () => onsetAt,

    /**
     * Fix round 1, item 3: the raw inputs `detectors.js`'s `sessionEndSilent`
     * needs when `firstAudio()` could not confirm a real playout (nothing
     * queued, or an enqueue time whose mark never echoed). `streamStartAtMs`
     * and `answerToStreamMs` are this controller's own constants, closed
     * over at construction; exposed here rather than duplicated at the call
     * site.
     */
    rawState: () => ({ onsetAt, streamStartAtMs, answerToStreamMs }),
  };
}
