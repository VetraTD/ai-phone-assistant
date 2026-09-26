# Outbound calling and the August 2026 appeal

**Status: internal note (spec D2).** Written 2026-09-26, the day outbound code is first deployed.

## What the appeal said, and why it was true then

`gcp-suspension-appeal-2026-08-25.md` told Google:

> *this system does not place outbound calls.* It has no call-origination path. The only Twilio call API it uses is `calls(callSid).update()` … There is no dialler, no campaign logic, no contact list, and no mechanism to call a number that has not first called us.

That was accurate on 2026-08-25 and remained accurate on production until this deployment. No production image up to `695b4d9` (revision `voice-uk-prod-00093-tjr`) can originate a call.
- The only `calls.create` in that tree is in two developer scripts, `scripts/latency-probe.js` and `scripts/voice-ab-call.js`.
- Both are excluded from the image by `.dockerignore`'s scripts allow-list.
- They ran from a workstation, only to our own test numbers.

## What changed

A customer (Digile Media) asked for a speed-to-lead call: ring a lead who has just filled in a form, within minutes, to qualify them and book a call. That needs call origination. Outbound Part 1 (`docs/superpowers/specs/2026-09-24-outbound-calling-design.md`) adds it:
- a dialler (`lib/outbound/dispatch.js`);
- campaigns, contacts, consents and a do-not-call list (migrations 042-045);
- Cloud Tasks and a Cloud Scheduler sweep as the alarm clock.

**This is a change to what the appeal described, and it should be stated plainly if Google asks again.** The appeal's "no outbound" sentence is a description of the system on that date, not a promise about its future.

## Why this is not the robocall pattern the appeal was distinguishing us from

The design is consent-only and operator-gated. Every control below is enforced in code, except the last row, which is a prompt instruction (marked):

| Control | Where |
|---|---|
| Global kill switch, **off by default**. It is on only when the literal string `"true"` is set. | `lib/outbound/config.js`, gate check 1 |
| While off, only numbers on `OUTBOUND_TEST_ALLOWLIST` (the operator's own handsets) can be dialled | gate check 1 |
| Per-business switch, off by default | gate check 2 |
| Do-not-call list checked before every dial | gate check 4 |
| Consent required for the campaign's compliance class. Marketing-consented campaigns are **refused at save in Part 1** | gate check 5, `campaignSchema.js` |
| Silent-call hold of 72 h after any call the person answered and heard nothing on (Ofcom persistent-misuse policy) | gate check 6 |
| Calling window inside 08:00–21:00 on the contact's own clock | gate check 7 |
| At most 3 dials per number per day, across campaigns | gate check 9 |
| The caller ID must be a number we own on one of our Twilio accounts | gate check 11 |
| Every call discloses that it is an AI assistant, and the opening line is refused at save if the disclosure is missing. The disclosure must be **heard**, not just written | spec §7, §9.3 |
| No audio recording (code: nothing records). The transcription notice ("This call may be transcribed to help us assist you.") is **a prompt instruction, not code**. It is spoken up front only when the tenant has `recordingDisclosureEnabled` on, and otherwise only if the person asks (`lib/outbound/prompt.js`, `services/gemini.js`) | spec D3/D4 |

**One owner-approved exception (2026-09-26).** The 3-per-day cap is not applied while the kill switch is off. In that state only allow-listed operator handsets are reachable, and live test round 1 needs about 11 calls to one handset. The exception switches itself off when outbound is enabled.

## Deployment state at the time of writing

- 2026-09-26: the outbound code is deployed with `OUTBOUND_ENABLED=false`. The only number on the allow-list is the owner's own US handset.
- Live round 1 calls only that handset, from `+18176011171`, the owner's own test line.
- **Before `OUTBOUND_ENABLED=true` (not done):**
  - the data-subject erasure path must cover `contacts`, `consents`, `suppressions`, `call_attempts.to_number` and `calls.answers` (spec P5);
  - Stage 3 must deliver the opt-out tool, the results webhook and callback recognition;
  - a writer must exist for wrong-number suppression.

## Traffic shape, for anyone reading this after another suspension

This adds new call-origination traffic on Twilio's side, plus two new Google services on this project: Cloud Tasks (queue `outbound-dispatch`) and a Cloud Scheduler job (`outbound-sweep`, every 5 minutes, which POSTs to the service's own OIDC-guarded internal route).

The service now makes two new kinds of outbound request: Twilio REST `calls.create` (to dial) and the Cloud Tasks API (to schedule a dial). Both are existing vendors, Twilio and Google. The media path is the same as inbound: Twilio Media Streams in, Gemini Live WebSockets out. No new vendor is added.
