// ---------------------------------------------------------------------------
// G6 -- can we make it say an exact sentence?
//
// G5 left one blocker: session.commentary.append is acknowledged every single
// time and spoken only about 40% of the time. A recording disclosure that
// reaches the caller 1 time in 5 is not a disclosure, so this is the question
// standing between GPT-Live and buildable.
//
// THREE MECHANISMS, one control:
//
//   A  commentary.append, stock frontend prompt          -- the G5 control
//   B  commentary.append, frontend prompt instructed to relay verbatim
//      (the cheapest possible remedy: a prompt change, no new plumbing)
//   C  instructions.append carrying the sentence itself
//      ("Developer guidance for the session remainder")
//
// A FOURTH OPTION IS NOT TESTED HERE BECAUSE IT CANNOT FAIL AT THE VENDOR:
// injecting our own pre-rendered audio into the Twilio leg. Delivery is then a
// property of our code, not a model's decision, and it is almost certainly the
// right answer for a legal disclosure. The only vendor-side question it raises
// is whether the model talks over us, which we settle by not forwarding its
// audio while ours plays. No probe can tell us more than that.
//
// CONFOUND REMOVED FROM G5: that run pushed while the model was often
// mid-sentence, so a miss could have been a collision rather than the mechanism
// failing. Here every push happens after the model has gone quiet. This is the
// BEST case for each mechanism -- if it misses here, it misses.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { waitForSpeechQuiet } from "./lib/gptlive.js";
import { FRONTEND_INSTRUCTIONS, CLIENT_DELEGATION } from "./lib/livePrompt.js";
import { runSession } from "./lib/liveRun.js";
import { normWords } from "./lib/score.js";
import { summary } from "./lib/spendLive.js";

const N = Number(process.env.G6_N || 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SENTENCE = "Your appointment is Thursday the 18th of September at 2:15 pm.";
const FACTS = ["thursday", "18th", "september", "2", "15"];

const VERBATIM_CLAUSE = [
  "",
  "When I send you commentary, say it to the caller word for word, exactly as",
  "written, before you say anything else. Do not rephrase it and do not skip it.",
].join("\n");

const ARMS = {
  A: {
    label: "commentary, stock prompt",
    instructions: FRONTEND_INSTRUCTIONS,
    deliver: (session, deleg, i) => session.commentary(SENTENCE, deleg?.id ?? null, `g6a_${i}`),
  },
  B: {
    label: "commentary, prompt says relay verbatim",
    instructions: FRONTEND_INSTRUCTIONS + VERBATIM_CLAUSE,
    deliver: (session, deleg, i) => session.commentary(SENTENCE, deleg?.id ?? null, `g6b_${i}`),
  },
  C: {
    label: "instructions.append carries the sentence",
    instructions: FRONTEND_INSTRUCTIONS,
    deliver: (session, _deleg, i) =>
      session.raw({
        type: "session.instructions.append",
        event_id: `g6c_${i}`,
        content: `Say this to the caller now, word for word: "${SENTENCE}"`,
        delegation_id: null,
      }),
  },
};

async function take(armKey, i) {
  const arm = ARMS[armKey];
  let pushedAtSessionMs = null;
  let acked = false;

  const { state, marks, priced } = await runSession({
    label: `g6-${armKey}-${i}`,
    probe: "G6",
    fixtures: ["clean_open"],
    instructions: arm.instructions,
    delegation: CLIENT_DELEGATION,
    greetFirst: false,
    tailMs: 12000,
    maxSeconds: 60,
    afterAudio: async ({ session, state: st }) => {
      // Wait for the model to finish its own reply before pushing. G5's
      // ambiguity was that a miss might have been a collision.
      await waitForSpeechQuiet(st, { quietMs: 900, timeoutMs: 12_000 });
      pushedAtSessionMs = st.outputTranscript.length
        ? Math.max(...st.outputTranscript.map((t) => t.end_ms))
        : 0;
      arm.deliver(session, st.delegations[0], i);
      await sleep(9000);
    },
  });

  acked = state.events.some((e) =>
    /commentary\.appended|instructions\.appended/.test(e.type || "")
  );

  const after = state.outputTranscript.filter((t) => t.start_ms >= (pushedAtSessionMs ?? 0));
  const spoken = after.map((t) => t.delta).join("").trim();
  const words = normWords(spoken);
  const missing = FACTS.filter((f) => !words.includes(f));
  const delivered = missing.length === 0;
  const verbatim = spoken.toLowerCase().includes(SENTENCE.toLowerCase().replace(/\.$/, ""));

  const row = {
    arm: armKey, take: i,
    acked, delivered, verbatim,
    missing_facts: missing,
    spoken,
    pushed_at_session_ms: pushedAtSessionMs,
    usd: Number(priced.usd.toFixed(5)),
    error: marks.error ?? null,
  };

  console.log(
    `  arm ${armKey} take ${i}  ${acked ? "acked" : "NO-ACK"}  ` +
    `${delivered ? "DELIVERED" : "not said "}  ${verbatim ? "verbatim" : "paraphrased"}  $${row.usd.toFixed(4)}`
  );
  if (spoken) console.log(`      ${JSON.stringify(spoken.slice(0, 130))}`);
  return row;
}

async function main() {
  console.log(`G6 -- delivery mechanism. N=${N} per arm, alternating, pushed only after quiet.\n`);
  const rows = [];
  for (let i = 1; i <= N; i++) {
    for (const k of Object.keys(ARMS)) rows.push(await take(k, i));
  }

  const byArm = {};
  for (const k of Object.keys(ARMS)) {
    const rs = rows.filter((r) => r.arm === k);
    byArm[k] = {
      label: ARMS[k].label,
      of: rs.length,
      acked: rs.filter((r) => r.acked).length,
      delivered: rs.filter((r) => r.delivered).length,
      verbatim: rs.filter((r) => r.verbatim).length,
      delivery_rate: Number((rs.filter((r) => r.delivered).length / rs.length).toFixed(2)),
      usd: Number(rs.reduce((a, r) => a + r.usd, 0).toFixed(4)),
    };
  }

  const best = Object.entries(byArm).sort((a, b) => b[1].delivery_rate - a[1].delivery_rate)[0];
  const usable = best[1].delivery_rate >= 0.95;

  const out = {
    at: new Date().toISOString(),
    question: "can any vendor mechanism deliver an exact sentence reliably enough for a legal disclosure?",
    bar: "a disclosure must be delivered every time; 0.95 is the floor for calling a mechanism usable",
    sentence: SENTENCE,
    g5_baseline: "commentary.append delivered 4 of 10 across two cases, acked 10 of 10",
    confound_removed: "pushed only after the model went quiet, so a miss is the mechanism and not a collision",
    not_tested: "injecting our own pre-rendered audio into the Twilio leg -- delivery is then our code's property, not the model's decision",
    byArm, rows,
    best_arm: best[0],
    best_rate: best[1].delivery_rate,
    usable_for_a_disclosure: usable,
    spend: summary(),
  };
  fs.writeFileSync("scripts/probes/results-g6.json", JSON.stringify(out, null, 2) + "\n");

  console.log("");
  for (const [k, b] of Object.entries(byArm)) {
    console.log(`arm ${k} (${b.label}): acked ${b.acked}/${b.of}, DELIVERED ${b.delivered}/${b.of}, verbatim ${b.verbatim}`);
  }
  console.log(`\nbest: arm ${best[0]} at ${(best[1].delivery_rate * 100).toFixed(0)}%`);
  console.log(usable
    ? "A vendor mechanism clears the bar. GPT-Live can say what we require."
    : "NO vendor mechanism clears the bar. An exact sentence must come from our own audio, not from the model.");
  console.log(`spend so far: $${summary().spent.toFixed(4)} of $${summary().cap}`);
}

main();
