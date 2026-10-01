# Outbound: the AI answers live (no recorded opener) -- design

**Status:** owner-approved design (2026-10-01), spec awaiting owner review. Branch: `feat/outbound-stage4`
(production is `voice-uk-prod-00096-n5p` @ `b4d462d`, `OUTBOUND_ENABLED=false`).
**Supersedes:** spec `2026-09-24-outbound-calling-design.md` §19 S3-D2 ("the stored opener clip ALWAYS plays
first") and the stage-3 plan's S3-2 clip-first behaviour, for the default mode only. Clip mode stays as a rollback.

## 1. Why

On the 2026-10-01 R2 calls the owner heard the recorded opener start ~0.35 s after "Hello?" -- "if I speak a
second later it will interrupt" -- and saw the deeper problem: the recording plays the same line whatever the
person said. "Is this a scam call?" gets "Hi, is that Nithin? It's Ava...", and the actual question is answered one
turn late. Owner decision: the first line is the AI's own live reply to what the person said, everywhere.

Measured facts this design rests on (production `outbound_live_shadow`, 3 real calls 09-30/10-01): Live's natural
reply to "Hello?" arrives **1,495-1,782 ms after the person stops** (1,696-2,021 ms after they start). Today's clip
fires at hello-end + 350 ms (`helloEndGapMs`), cannot be stopped by speech under 600 ms (`CLIP_BARGE_MIN_MS`), and
cuts into any greeting at onset + 1,600 ms (`slowLiveMs`).

**The 2-second rule.** UK (Ofcom persistent-misuse policy) and US (FTC Telemarketing Sales Rule abandoned-call
safe harbour) both treat a call as abandoned when the answering person is not connected within 2 s. The US text
counts from the **completed greeting**; the code's stricter "from onset" reading (`slowLiveMs`) would make any
human caller breach it on a long greeting ("Brightwork Clinic, Sarah speaking, how can I help?"). This design
measures from the **end of the person's speech** in both countries. The UK reading goes on counsel's existing
sign-off list (`docs/outbound-eu-calling-floor.md` owner sign-offs) -- it must clear before any real lead is called,
like every other item there. Every call logs the number so a breach is visible (section 5).

## 2. Behaviour (new default)

`OUTBOUND_FIRST_SPEAKER` keeps two values. `live` is REDEFINED as below and becomes the default; `clip` is today's
behaviour, unchanged, kept as a one-setting rollback (no redeploy). The old `live` race (Live first, clip as a
backstop at onset + 1,600 ms) is removed -- it never ran on a real call, and it would still have played the clip on
most calls (Live is usually slower than 1,600 ms from onset).

In `live` mode:
1. **No opener clip** is rendered, stored, or played; there is no clip hold, no stale-generation discard and no seed
   (nothing is ever discarded, so the D-R2-3 refusal never triggers -- it stays in place for `clip` mode).
   The voicemail and transfer-miss clips are unchanged (machine answers and failed transfers still use them).
2. **The person speaks first** (the normal case): their audio goes straight to Live; Live's reply is forwarded as
   soon as it starts. No timer cuts in; Live's own turn detection decides when they have finished.
3. **The person says nothing:** at **3 s after the media stream starts (~the answer)** (owner: "a human caller waits 3-4 s") the AI says a short
   "Hello?" -- spoken by Live via the existing `speakLine` path, cued early enough that it is HEARD at 3.0 s
   (+/- 0.5 s). If they speak at any point before that, the cue is cancelled and they are answered instead. After
   the "Hello?", the existing silence ladder (`SILENCE_THRESHOLDS`, `buildSilenceNudge`) runs as today.
4. **Live fails** (session does not open, or no Live audio within 6 s of the person finishing their first
   utterance): log `outbound_live_unresponsive` (ERROR, alert policy), end the call, and let the normal retry
   schedule re-dial. No recorded fallback (owner: no recording).

## 3. The first reply (outbound prompt, `lib/outbound/prompt.js`)

A new FIRST REPLY block, ahead of the CALL PLAN. The first thing the AI says, whatever was said to it:
1. **Answers what they actually said**, in the same sentence or the next.
2. **Says who it is: the persona name, that it is an AI assistant, and the business** -- always, in the first reply.
3. **Checks it is the right person** ("Am I speaking with Nithin?") unless they already said so.
It never gives the reason for the call before identity is confirmed (unchanged privacy rule).

Worked examples (they go into the prompt as examples, one per line):

| They say | First reply |
|---|---|
| "Hello?" / "Yes?" / "Who's this?" | "Hi, this is Ava, an AI assistant calling from Digile Media. Am I speaking with Nithin?" |
| "Nithin speaking" / "This is Nithin" | "Hi Nithin, this is Ava, an AI assistant calling from Digile Media." (identity confirmed -- a self-identification is a clear yes) then the reason, per the CALL PLAN |
| "Brightwork Clinic, how can I help?" (a business greeting) | "Hi, this is Ava, an AI assistant calling from Digile Media -- could I speak to Nithin, please?" (gatekeeper row) |
| "Is this a scam call?" / "Is this a sales call?" | "No, not a scam -- I'm Ava, an AI assistant calling from Digile Media. Am I speaking with Nithin?" |
| "How did you get my number?" | "I'm Ava, an AI assistant from Digile Media, returning an enquiry. Am I speaking with Nithin?" (nothing more until confirmed) |
| "Stop calling me" | the exact opt-out sentence, prefixed "This is Ava, an AI assistant from Digile Media --" then `opt_out` |
| "Not a good time" | intro + "When would be a good time to call back?" then `schedule_callback` |

**Customisation.** The campaign's `opener` template keeps its validation (`{business_name}` required, an AI
disclosure bounded by literal text, 120 rendered characters) and its placeholders, but its meaning changes from
"the recorded line" to "the intro the first reply is built on". The `speed_to_lead` template's default becomes
`"Hi, this is {persona_name}, an AI assistant calling from {business_name}. Am I speaking with {first_name}?"`.
`persona_name` is unchanged. Set via the admin script today; the dashboard campaign editor is stage 4b.

## 4. Hold and transfer ("Hold on, I'll get him")

New SITUATIONS row plus a code state, because a prompt alone does not keep a model quiet through hold music.
- **Entering hold:** the person says hold on / one moment / I'll get him / I'll put you through. The AI says one short
  line ("Sure, thank you.") and the call enters `on_hold` (set by a new engine-owned tool `wait_on_hold`, declared
  only on outbound -- the same pattern as `confirm_identity`).
- **While on hold:** the silence ladder is suspended; Live's audio is NOT forwarded to the caller unless an input
  transcript with real words has arrived since the last model turn (hold music and silence produce none, so the
  model cannot talk to the music). Cap: **120 s**; at the cap the AI ends the call and records
  `set_call_outcome other` ("hold timeout"), and the retry schedule applies.
- **Leaving hold:** a person speaks (transcript with words). The AI restarts with the FIRST REPLY rules -- intro +
  name check -- because the person now on the line has not heard it. If the original speaker comes back
  ("He's not available after all"), the gatekeeper row applies.
- Identity confirmed before the hold stays confirmed only if the returning voice says so; otherwise the name check
  runs again (the confirm_identity first-confirmation rules are unchanged).

## 5. Guards and metrics (code, not prompt)

- **Disclosure check.** After the first assistant turn completes, its output transcript is tested with the
  campaign schema's `AI_DISCLOSURE_RE`. Missing: log `outbound_disclosure_missing` (ERROR, added to the ONE alert
  policy) and cue the next turn to say it ("say plainly that you are an AI assistant calling from {business}").
  An unusable/empty output transcript counts as missing (fail closed).
- **First-reply time.** `outbound_first_reply {path: speech|silence_hello, from_speech_end_ms, from_answer_ms}` on
  every call; `from_speech_end_ms > 2000` also logs `outbound_first_reply_slow` (warn). This replaces
  `outbound_live_shadow` and `outbound_first_audio` in `live` mode (both stay in `clip` mode).
- **Early opt-out then hang-up.** Today's S4-2 rule (Deepgram one-shot of untranscribed held audio, else close
  `held_for_review`) exists only for clip-hold audio. In `live` mode the caller's audio from the answer until the
  first input transcript is kept in a small buffer (cap 15 s); if the call ends with caller speech in that buffer
  and no transcript, the same S4-2 path runs on it (`transcribeMulawOnce`, EU endpoint, then held_for_review). This
  is one of the rules that must hold before `OUTBOUND_ENABLED=true`, so it cannot be dropped with the clip.

## 5b. Read-back of key answers (owner addition 2026-10-01)

On the R2 Hello call the clinic name came through Live's own speech recognition as "best college" and was saved
without a check. Live's caller transcript is lossy (names, emails, spellings), so the AI cannot tell a mangled
answer from a real one -- only the person can.
- **What:** for a qualification question marked `confirm: true` in the campaign (schema: optional boolean on each
  `questions[]` entry, default `false`; `text`-type questions only), the AI repeats the answer back before saving
  it: "Brightwork Clinic -- did I get that right?" A yes saves it; a correction replaces it and is read back once
  more; a second failure saves the latest version and logs `qualification_answer_uncertain {key}` (no third ask -- a
  caller should never be stuck in a spelling loop; no storage change, so no migration).
- **How (code, not only prompt):** `record_answer` for a `confirm: true` question is REFUSED unless a read-back
  turn for that key happened earlier in the call (the engine records the read-back when the AI's output transcript
  contains the answer value it is about to save, normalised); the refusal text tells the AI to read it back first.
  A refused write counts by key, so the gate cannot loop (cap: 2 refusals per key, then the write goes through
  logged `qualification_answer_uncertain`). Prompt: one CALL PLAN line ("for questions marked confirm, read the answer back first").
- **Defaults:** `speed_to_lead` marks nothing `confirm` (unchanged behaviour); the R2 campaign config
  (`r1-config.mjs 20|21`) sets `clinic_name` to `confirm: true` for the re-test.
- **Tests:** schema accepts/refuses the key; the gate refuses a first write, allows after a read-back, passes
  `uncertain` after 2 refusals (sabotage each); a paid sim with a scripted mangled name checks the read-back
  happens and the correction is saved.

## 6. What does not change

Inbound (byte-identical prompts; all 110 goldens), the legal floor and calling windows, AMD and the voicemail clip,
the gatekeeper/household/child privacy rules, callback recognition, `confirm_identity` rules, the call plan after
identity, post-call. `clip` mode is untouched and still passes its own tests.

## 7. Testing

- **Unit (pure controller, `tests/outboundFirstSeconds.test.js`, `live` mode):** no clip is ever queued; the
  silence "Hello?" is cued so it is heard at 3.0 +/- 0.5 s and is cancelled by speech at 2.9 s; Live audio is
  forwarded from its first chunk; Live-unresponsive ends the call at 6 s; on_hold suppresses the ladder and drops
  model audio without a worded transcript, releases on a worded transcript, ends at 120 s. Sabotage each (one
  batch, committed first, restored by Edit).
- **Prompt:** FIRST REPLY block present on outbound only; examples render with the campaign's persona/business/name;
  the two-tenant leak test still passes; inbound goldens unchanged.
- **Guards:** disclosure check RED on a reply without "AI", GREEN with; unusable transcript = missing. Early-hang-up
  buffer reaches the S4-2 path (both ends real: the test drives the real buffer into the real S4-2 handler, no invented stub).
- **Paid sims (ask first, ~$0.25):** hello; "is this a scam?"; "Nithin speaking"; business greeting; silence;
  gatekeeper ("He's out, try tomorrow at ten"); hold-then-new-person. Each with a criterion that can fail
  (disclosure in reply 1, name check unless self-identified, no reason before confirmation, first-reply time,
  silence "Hello?" heard 2.5-3.5 s, no model audio during hold).
- **Gate:** root suite (Norton bundle), test:db, census, full corpus:sabotage once at the final head.
- **Real calls after deploy (owner's US handset, 08:00-20:00 CDT):** Hello, Gatekeeper, Hold-transfer.

## 8. Considerations raised for the owner

1. **Latency feel.** Every first reply now arrives ~1.5 s after the person stops -- like someone thinking, slower
   than the clip. Tuning Live's end-of-speech sensitivity for the first turn could save a few hundred ms but makes
   cutting people off more likely (the original complaint). Measure from the `outbound_first_reply` numbers first.
2. **Voicemail before AMD answers.** Twilio's machine detection reports ~3.5 s after pickup; until then Live may
   greet the voicemail greeting, and that greeting ends up on the recording before the voicemail clip. The clip
   mode had the same race. The SITUATIONS voicemail row still applies.
3. **No recorded fallback when Live is down.** The person hears silence for up to 6 s, then the call ends and
   retries. Owner chose no recording; the alert makes it visible.
4. **UK counsel item** (section 1) -- before any UK/EU lead.
5. **Cost:** slightly lower (no opener render, ~$0.0024/call) and the dial no longer waits for that render.

## 9. Out of scope

Phone menus (IVR "press 1"); non-English answerers (later stage); dashboard editing of the intro (stage 4b);
Live VAD tuning (consideration 1).
