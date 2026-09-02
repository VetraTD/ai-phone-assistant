// ---------------------------------------------------------------------------
// MOVED to lib/voice/geminiUsage.js. This file is a re-export, kept so the
// probe suite's imports do not change.
//
// It moved because of where it was, not because of what it does. `scripts/`
// is not in the Dockerfile COPY list, so nothing that ships in the production
// image could import from here -- and scripts/spike/s2s-bridge.js, needing
// exactly this logic, inlined a copy of it with a comment explaining why. The
// copy then reproduced the very defect this module was written to fix
// (backlog LVX5, harness defect #1 in docs/speech-to-speech-handoff.md
// section 11): usage overwritten per turn instead of accumulated.
//
// "Reuse the instrument, do not re-derive it" is not advice a comment can
// enforce when the instrument is unreachable from the code that needs it.
// ---------------------------------------------------------------------------
export { emptyUsage, addUsage } from "../../../lib/voice/geminiUsage.js";
