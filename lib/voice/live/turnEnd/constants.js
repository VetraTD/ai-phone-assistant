/**
 * The spike's hangover, carried forward as a PLACEHOLDER and labelled as one.
 *
 * scripts/spike/s2s-bridge.js chose 1,200 ms with a comment saying it was flat
 * on purpose, because classifyHold needs text and the arrival time of that text
 * was the very thing being measured. It was never tuned.
 *
 * It then turned out to be the single largest cost in the manual arm: the felt
 * gap was 2,246 ms against 1,325 ms with the vendor's own detector, and almost
 * all of that ~900 ms difference is this number. The spike's own verdict says
 * it plainly — the value "needs choosing deliberately rather than inheriting
 * the spike's placeholder".
 *
 * It is still the default here, because changing it would replace a measured
 * placeholder with an unmeasured guess, and the arm that pays it is not the
 * arm that ships. Choose it from a live-call round, not from this file.
 */
export const DEFAULT_HANGOVER_MS = 1_200;

/**
 * Silence required before arm C will act on a hold at all.
 *
 * Matches `lib/voice/inboundVad.js`'s own `hangoverMs` of 300, so the floor
 * here and the floor the VAD applies to `isActive` agree. Kept explicit rather
 * than inherited: inboundVad's hangover is constructor-tunable, and a strategy
 * whose timing silently tracks another module's default is a strategy whose
 * measurements move when somebody tunes that module for an unrelated reason.
 */
export const DEFAULT_MIN_SILENCE_MS = 300;

/**
 * Arm C's backstop, for the case the spike never tested: no transcript.
 *
 * Arm C is the only arm whose turn end depends on a message arriving from the
 * vendor. `inputAudioTranscription` was measured at 113-360 ms on nine calls,
 * which is comfortably inside any hold — but "measured on nine calls" is not
 * "cannot fail", and if it never arrives the caller is never answered.
 */
export const DEFAULT_BACKSTOP_MS = 1_200;

/** Sustained voiced speech during our own playback before it counts as a barge. */
export const DEFAULT_BARGE_MS = 300;
