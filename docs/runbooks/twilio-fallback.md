# Twilio fallback — what to do by hand

Batch-3 S5. Owner runbook. `<prod base>` is the service's `BASE_URL` (no trailing
slash), e.g. the `voice-uk-prod-…run.app` address. Every `gcloud` line needs
`CLOUDSDK_CONFIG=~/.gcloud-vetra2` in front; `P=vetra-uk-edc8ca`, `R=europe-west2`.

## 1. What the fallback does

When our server cannot answer a call, Twilio runs a small program of ours (the
Function in `twilio/fallback/fallback.js`). It rings the business's transfer
number, showing OUR number as the caller. If nobody answers, the caller leaves a
message, and our server files it automatically once it is reachable again.

A call that comes back from our own number, or from the transfer number, is
refused (loop protection). So **always test from a phone that is NOT the transfer
number.**

## 2. Buying a number by hand

Numbers are bought in the Twilio console, not by our code.

1. Use **account A** for UK numbers (it holds the approved UK regulatory bundle).
   Account B is the US account.
2. Phone Numbers → Buy a number → Voice → buy it.
3. Open the number → Voice Configuration:
   - **A call comes in**: Webhook, `https://<prod base>/twilio/live-voice`, HTTP POST.
   - **Call status changes** (StatusCallback): `https://<prod base>/twilio/status`,
     HTTP POST. **Set this on EVERY hand-configured number on BOTH accounts.**
     Pending dials end there and the call-completion write depends on it.
4. Save. Then set `businesses.phone_number` to that exact E.164 string
   (`+441372…`, no spaces, no leading newline) with `scripts/set-business-config.js`
   through the migrate job.

## 3. Create the Function — once per Twilio account (A and B)

1. Console → Functions & Assets → Services → Create Service, name `vetra-fallback`.
2. Add + → Add Function → path `/fallback`.
3. Paste the whole of `twilio/fallback/fallback.js` over the template.
4. Set visibility to **Protected**.
5. Settings → Environment Variables → add `VOICEMAIL_URL` =
   `https://<prod base>/twilio/voicemail` → Add → Save.
6. Click **Deploy All** and wait for it to finish.
7. Copy the Function URL, like `https://vetra-fallback-1234.twil.io/fallback`.

The default Node runtime is fine; the file has no dependencies.

## 4. Print each number's URL

Run once per account, with that account's Function URL (use only the numbers
that live on that account):

```bash
CLOUDSDK_CONFIG=~/.gcloud-vetra2 gcloud run jobs execute vetra-migrate-uk-prod \
  --args=scripts/fallback-urls.js,--base,https://vetra-fallback-1234.twil.io/fallback \
  --project=$P --region=$R --wait
```

Then read the job's logs. Each business prints as:

```
[fallback] +441372656055  Brightwork Studio
[fallback]   https://vetra-fallback-1234.twil.io/fallback?n=%2B442071234567&t=20&v=Polly.Amy
```

`n` is the transfer number, `t` how long it rings (20, or 45 when the business
chose "own voicemail"), `v` the voice for the apology. The script is read-only.

If a line follows saying **no transfer number in this URL**, that number's
fallback will take a message instead of ringing anyone. The reason is on the
line:

- no transfer number set, or not in `+country-code` format: fix it with
  `set-business-config`, then re-run.
- costs more than our standard rate (`allow_pricier_numbers`): decide whether
  you accept the price. If yes, set `allow_pricier_numbers` to `true` (the value
  goes in base64, like every `--set`) with `set-business-config`, then re-run.
- premium-rate, over our ceiling, or no price known: pick a different transfer
  number.

The script prints every number we have; ignore the ones on the other account.

## 5. Paste the URL into each number

Phone Numbers → Manage → Active numbers → the number → Voice Configuration →
**Primary handler fails** → Webhook → paste the printed URL → **HTTP POST** →
Save. Re-open the number and check the URL saved whole, including `%2B`.

## 6. When to re-run step 4 and re-paste

- a business's transfer number changes,
- a business changes its "if nobody picks up" choice,
- a new number is added,
- a number moves between accounts.

## 7. After an outage

Console → Monitor → Logs → Calls, filtered to the outage window, and Recordings.
Any recording our server never filed (its callback could not reach us) must be
forwarded to the business by hand. The catch-up job is deferred.

## 8. Blocking a caller

`scripts/block-caller.js` through the migrate job, same shape as
`set-business-config`: a dry run first, read the output, then repeat with
`--confirm`.

```bash
... --args=scripts/block-caller.js,--add,+447700900555,--reason,"abusive calls",--business,+441372656055,--days,30
... --args=scripts/block-caller.js,--remove,+447700900555
... --args=scripts/block-caller.js,--list
```

`--business` and `--days` are optional (no `--business` blocks the number for
every business; no `--days` lasts until removed). Output shows the last 4 digits only.

## 9. Quick test

1. Point a spare number's "Primary handler fails" at the real URL, and its "A
   call comes in" at a dead URL (so our server looks down).
2. Call it from a phone that is NOT the transfer number.
3. Answer on the transfer phone: you talk to the caller, and the transfer phone
   shows OUR number. Hang up.
4. Call again and do not answer: leave a message. It appears in the dashboard
   once the server is reachable.
5. Put the spare number's "A call comes in" back.
