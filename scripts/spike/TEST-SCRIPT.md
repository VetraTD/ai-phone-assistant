# What to say on the spike calls

Hold this while you dial **+18176011171**. Each item exists because something
specific is unknown — the "why" column is what makes it worth your minute.

**What NOT to test: anything tool-shaped.** The spike declares **zero tools** —
no calendar, no availability, no booking, no database. If you ask it to book it
will take the details and say someone will confirm. That is correct behaviour
here, not a bug. Booking correctness is measured by the eval port (handoff §7
step 4), not by a phone.

**The spike cannot fail on latency.** +18176011171 is a US number and you are on
a UK handset, so every turn carries an international leg production does not
have. Note whether the pauses feel tolerable; ignore the absolute number.

---

## Call 1 — handset to your ear

Ordinary use. Establishes whether it works at all before the echo test.

| # | Do this | Listening for | Why it is on the list |
|---|---|---|---|
| 1 | **Say nothing** for the first 3 seconds | Is the business name intact, or is the front of the greeting clipped? | Greeting clipping was a real reported defect on the cascade. Different stack, same failure surface. |
| 2 | "Hello, what time do you open on Saturday?" | Does the pause before it answers feel tolerable? | The felt cost of ~1.4 s/turn. No probe had a phone line. |
| 3 | **Trail off and stop:** "I wanted to ask about, uh…" then go **silent for 3 seconds** | Does it cut in over you, or wait? | **The one to watch.** §3 retraction #4: 3.1 interrupted trailing-off callers 5/5 on default VAD, and manual activity detection fixed it 3/3 — in a harness with no phone line. This is that fix meeting a real one. |
| 4 | "My name is Nithin. N, I, T, H, I, N." | Does it get the spelling, and read it back right? | Letters through a 300–3400 Hz channel are where spelling died before. |
| 5 | "My mobile is oh seven seven double oh, nine hundred, one two three." | Does it keep the digits, including "double oh"? | Digit strings are the other thing band-limiting destroys. |
| 6 | Ask "what should I expect at a first appointment?" then **cut in after ~2 s**: "sorry — actually…" | Does it stop promptly? Does it then hear what you actually said? | Barge-in has never been tried with a real echo path. The bridge holds 500 ms of your audio back so your first syllable is not lost — this checks that it works. |
| 7 | "Do you take NHS patients or is it private only?" | Accent, and vocabulary: "surgery"/"practice", "mobile", "post code". Any Americanism at all. | You asked for British. Vocabulary gives it away faster than vowels. |
| 8 | "That's all, thanks. Bye." | Does it close cleanly, or keep going? | Doubled goodbyes are a defect this codebase has shipped before. |

---

## Call 2 — SPEAKERPHONE. **This is the call the spike exists for.**

Without this one the spike answers nothing. Set up for the worst case, not the
politest one:

- **Volume up.** Loud enough that you can hear it across the room.
- **Phone flat on a hard surface** — a desk or table, not a sofa. Hard surfaces
  reflect; soft ones absorb the very thing being tested.

| # | Do this | Listening for | Why |
|---|---|---|---|
| 1 | Ask "what should I expect at a first appointment?" then **say absolutely nothing** and let it talk all the way through | **Does it interrupt itself?** Does it stop mid-sentence, restart, or trail into confusion with nobody speaking? | **This is the whole spike (prediction P1).** With no acoustic echo cancellation anywhere in this pipeline, its own voice coming back off the speaker is exactly what cut the assistant off on live cascade calls. Speech-to-speech does not fix that by itself. |
| 2 | While it is talking: **cough once**, then **tap the desk** | Does either stop it? | A cough is a ~200 ms high-energy burst — indistinguishable from speech to anything that only measures energy. This is why the bridge requires 300 ms of *sustained* voice. |
| 3 | While it is talking, **genuinely interrupt**: "sorry, can I ask something else?" | Does it stop, and did it hear the whole sentence? | The guard must not have made real barge-in impossible. Both failure directions matter. |
| 4 | Ask another question and let it answer fully | Any repeated or doubled sentences? | 3.1 measured 0 doubled utterances in 90 turns — but with no echo path in existence. |
| 5 | Anywhere: does it ever speak something that is not words? | Any JSON, braces, or a bare word like `end_call` | It declares no tools, so a leak here would be new information. |

---

## Call 3 — SPEAKERPHONE again, `auto` arm

**Needs a redeploy first — tell me and I will flip it.** One command, ~1 minute.

Repeat **Call 2 item 1 only**: ask the long question, stay silent, listen.

This is the comparison arm — the vendor's own voice-activity detection instead
of ours. Prediction P2 is that it self-interrupts and is audibly worse than
call 2, because far-end VAD sits at the other end of a WebSocket and cannot know
that the speech it hears is our own output. If call 3 is *not* worse, then the
half-duplex gating is not doing the work the design assumes, and that is a
finding worth more than a comfortable confirmation.

---

## After each call

Say so and I will pull the numbers from Cloud Logging:

- `echo_return_loss_db` beside `noise_floor_db` — how far below our own output
  your inbound audio sat while we were talking, and the room's floor for
  comparison, so ambient noise cannot be mistaken for echo.
- `interrupted_without_local_barge` — the model cut itself off while our VAD saw
  no sustained speech. **On speakerphone this is the echo signature.**
- `input_transcript_lag_ms` — decides whether `echoGuard` and `classifyHold`
  can survive into the real front-end at all.
- `language_pinned` — whether the model accepted `en-GB`, which the handoff
  claims from vendor docs it does not.
- `reply_after_last_voice_ms` — comparable across arms.

Results go in `scripts/spike/VERDICT.md` against the eight predictions written
before you dialled. **A prediction that missed is recorded as a miss.**

## Not liking the voice

`SPIKE_VOICE` is env-swappable — Puck, Charon, Kore, Fenrir, Aoede, Leda, Orus,
Zephyr. They are documented by name, not by accent, so if Kore does not sound
British, say so and I will try another for the price of a redeploy.
