/**
 * THROWAWAY. Point the spike number at the spike, and put it back.
 *
 *   node scripts/spike/twilio-point.mjs --show
 *   node scripts/spike/twilio-point.mjs --to-spike https://s2s-spike-xxx.a.run.app/spike/voice/<secret>
 *   node scripts/spike/twilio-point.mjs --restore
 *
 * A script rather than a remembered API call, because the failure mode of
 * "repoint it back afterwards" is forgetting, and a number left pointing at a
 * deleted Cloud Run service fails in a way that reads as a Twilio fault.
 *
 * The restore values are HARDCODED from what the number actually held on
 * 2026-09-02, not read back from Twilio at restore time -- reading them back
 * would faithfully restore whatever the last mistake set.
 *
 * Uses Twilio ACCOUNT B credentials from .env. GCP does not hold this account's
 * token; see scripts/spike/RESTORE.md.
 */
import "dotenv/config";
import twilio from "twilio";

/** Captured 2026-09-02 before any change. See scripts/spike/RESTORE.md. */
const NUMBER_SID = "PN58e27f5f39727c40b279354409155ec3";
const EXPECTED_NUMBER = "+18176011171";
const ORIGINAL = Object.freeze({
  voiceUrl: "https://ai-phone-assistant-staging.up.railway.app/twilio/voice",
  voiceMethod: "POST",
  statusCallback: "https://ai-phone-assistant-staging.up.railway.app/twilio/status",
  statusCallbackMethod: "POST",
});

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function show(n) {
  console.log(
    JSON.stringify(
      {
        number: n.phoneNumber,
        voiceUrl: n.voiceUrl,
        voiceMethod: n.voiceMethod,
        statusCallback: n.statusCallback,
        statusCallbackMethod: n.statusCallbackMethod,
      },
      null,
      1
    )
  );
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];

  const current = await client.incomingPhoneNumbers(NUMBER_SID).fetch();
  if (current.phoneNumber !== EXPECTED_NUMBER) {
    // The SID is the identifier, but a mismatch means the recorded facts are
    // stale and every assumption downstream of them is suspect.
    throw new Error(
      `SID ${NUMBER_SID} is ${current.phoneNumber}, expected ${EXPECTED_NUMBER}. Refusing to touch it.`
    );
  }

  if (mode === "--show" || !mode) {
    show(current);
    return;
  }

  if (mode === "--to-spike") {
    const url = args[1];
    if (!url || !url.startsWith("https://") || !url.includes("/spike/voice/")) {
      throw new Error("--to-spike needs the full https .../spike/voice/<secret> URL");
    }
    console.log("before:");
    show(current);
    const updated = await client.incomingPhoneNumbers(NUMBER_SID).update({
      voiceUrl: url,
      voiceMethod: "POST",
      // statusCallback deliberately untouched. The spike serves no /twilio/status
      // and a callback into a 404 is noise, not a failure -- while changing it
      // is one more thing to put back.
    });
    console.log("after:");
    show(updated);
    console.log("\nRESTORE WITH: node scripts/spike/twilio-point.mjs --restore");
    return;
  }

  if (mode === "--restore") {
    console.log("before:");
    show(current);
    const updated = await client.incomingPhoneNumbers(NUMBER_SID).update({ ...ORIGINAL });
    console.log("after:");
    show(updated);
    const ok =
      updated.voiceUrl === ORIGINAL.voiceUrl &&
      updated.statusCallback === ORIGINAL.statusCallback;
    console.log(ok ? "\nRESTORED" : "\nRESTORE DID NOT TAKE -- check the console by hand");
    process.exitCode = ok ? 0 : 1;
    return;
  }

  throw new Error(`unknown mode ${mode}. Use --show, --to-spike <url>, or --restore.`);
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
