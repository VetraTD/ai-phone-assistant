import { emptyUsage, addUsage } from "../geminiUsage.js";

// ---------------------------------------------------------------------------
// The per-call record for the Live front-end.
//
// Written against the five defects the last instrument had, because
// scripts/spike/VERDICT.md's honest headline is that most of what a new
// harness measures at first is itself -- five instrument defects against
// roughly one vendor observation, a ratio that matched round 1's.
//
// Two of those five produced a wrong DESIGN conclusion before anything caught
// them, which is why the rules below are structural rather than advisory:
//
//   1. NEVER A BARE MEAN. The playback bucket was zero in 97% of frames, so
//      the mean read 0 and "no echo reaches us, absent at the sample level"
//      was concluded and written down. A nonzero count and a max disproved it
//      inside an hour. Every bucket here reports frames / nonzero / max.
//
//   2. AN EMPTY BUCKET AND A SILENT ONE MUST DIFFER. `mean([])` is 0 and so is
//      the mean of all-silence. A broken instrument and a real finding were
//      indistinguishable in the record. The frame count is what separates them.
//
//   3. ACCUMULATE USAGE. Gemini emits one usageMetadata per turn; keeping the
//      last under-reports 3-4x. Imported from lib/voice/geminiUsage.js rather
//      than re-derived -- re-deriving it is exactly how it broke twice.
//
//   4. NOTHING MAY THROW. A throw in the end-of-call summary loses the whole
//      call's measurements, which is how seven runs were lost once already.
//
//   5. NO CALLER TEXT, EVER. Shape only: which hold rule fired, whether the
//      transcript carried terminal punctuation, how long it was. The caller's
//      utterance is the most sensitive thing on the wire, and
//      tests/logPhiLint.test.js is watching.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.arm - which turn-end strategy ran
 * @param {string} [opts.model]
 * @param {string} [opts.surface]
 * @param {boolean} [opts.languagePinned]
 */
export function createCallSummary({ arm, model = null, surface = null, languagePinned = null }) {
  // Running aggregates rather than kept arrays for the audio buckets: a
  // three-minute call is ~9,000 frames per bucket and there is no question
  // anyone asks of the raw list that count/nonzero/max does not answer.
  const buckets = {
    playing: { frames: 0, nonzero: 0, max: 0, sum: 0 },
    idle: { frames: 0, nonzero: 0, max: 0, sum: 0 },
  };

  const replyAfterLastVoiceMs = [];
  const firstAudioMs = [];
  const transcriptLagMs = [];
  const holdRules = Object.create(null);
  // The measurement that decides whether arm C's advantage is real.
  //
  // classifyHold returns 0 ms for terminal punctuation and 500 ms without it.
  // That branch was written against Deepgram with smart_format on, which
  // punctuates. Whether Gemini's inputAudioTranscription does has never been
  // checked, and if it does not, every utterance takes the 500 ms branch and
  // arm C is just a shorter flat hangover wearing a rule name.
  const punctuation = { classified: 0, has_terminal_punct: 0 };

  let interrupted = 0;
  let interruptedWithoutLocalBarge = 0;
  let barges = 0;
  let turns = 0;
  let usage = emptyUsage();
  let closeReason = null;

  function recordInbound({ rms, playing }) {
    const b = playing ? buckets.playing : buckets.idle;
    const v = Number(rms) || 0;
    b.frames += 1;
    b.sum += v;
    if (v > 0) b.nonzero += 1;
    // Tracked incrementally, so no spread over a five-figure array can throw.
    if (v > b.max) b.max = v;
  }

  return {
    recordInbound,
    recordUsage: (u) => {
      usage = addUsage(usage, u);
    },
    recordTurn: () => {
      turns += 1;
    },
    recordReplyAfterLastVoice: (ms) => push(replyAfterLastVoiceMs, ms),
    recordFirstAudio: (ms) => push(firstAudioMs, ms),
    recordTranscriptLag: (ms) => push(transcriptLagMs, ms),
    recordBarge: () => {
      barges += 1;
    },
    recordInterrupted: ({ corroborated }) => {
      interrupted += 1;
      if (!corroborated) interruptedWithoutLocalBarge += 1;
    },
    recordHoldShape: (shape) => {
      const rule = shape?.rule;
      if (!rule) return;
      holdRules[rule] = (holdRules[rule] || 0) + 1;
      punctuation.classified += 1;
      if (shape.has_terminal_punct) punctuation.has_terminal_punct += 1;
    },
    recordClose: (reason) => {
      closeReason = reason || null;
    },

    build() {
      return {
        arm,
        model,
        surface,
        // Accepted is not honoured, and the doc claim that it is refused
        // outright is already retracted. Recorded per call either way.
        language_pinned: languagePinned,
        turns,

        // ---- audio, per rule 1 and 2 -------------------------------------
        in_frames_playing: buckets.playing.frames,
        in_frames_playing_nonzero: buckets.playing.nonzero,
        in_rms_playing_max: Math.round(buckets.playing.max),
        in_rms_playing_mean: meanOf(buckets.playing),
        in_frames_idle: buckets.idle.frames,
        in_frames_idle_nonzero: buckets.idle.nonzero,
        in_rms_idle_max: Math.round(buckets.idle.max),
        in_rms_idle_mean: meanOf(buckets.idle),

        // ---- latency -----------------------------------------------------
        // The one figure comparable ACROSS arms: caller stops -> caller hears
        // a reply. The vendor's endpointing delay sits inside it in arm A and
        // our own hangover sits inside it in arms B and C.
        reply_after_last_voice_ms_p50: p50(replyAfterLastVoiceMs),
        reply_after_last_voice_ms: replyAfterLastVoiceMs,
        // Manual arms only in practice: the vendor's response to an explicit
        // activityEnd, with our own wait excluded.
        first_audio_ms_p50: p50(firstAudioMs),
        // What decides whether arm C is possible at all.
        input_transcript_lag_ms_p50: p50(transcriptLagMs),

        // ---- turn taking -------------------------------------------------
        interrupted_count: interrupted,
        // An `interrupted` our own VAD never corroborated. Two readings that
        // look identical in this number alone -- our echo, or a caller
        // backchannel below the sustained-speech threshold -- so it is
        // reported, not interpreted.
        interrupted_without_local_barge: interruptedWithoutLocalBarge,
        barges,
        hold_rules: { ...holdRules },
        // classified 0 means arm C never ran. classified > 0 with
        // has_terminal_punct 0 means Gemini does not punctuate its input
        // transcript, and arm C is a shorter flat hangover rather than a
        // content-priced one -- which is a design finding, not a bug.
        punctuation: { ...punctuation },

        usage,
        close_reason: closeReason,
      };
    },
  };
}

function push(arr, ms) {
  const v = Math.round(Number(ms));
  if (Number.isFinite(v)) arr.push(v);
}

/** null, not 0, when nothing was measured: "instant" is a different claim. */
function meanOf(b) {
  return b.frames ? Math.round(b.sum / b.frames) : null;
}

/** null, not 0, for the same reason. */
function p50(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
