// ---------------------------------------------------------------------------
// A SCRIPTABLE tool executor, and the assertions that read what it recorded.
//
// Every probe before round 3 answered tool calls with a canned instant success
// (lib/tools.js). That was right for measuring latency — it kept our layer out
// of the vendor's number — and it is useless for measuring reliability, because
// no model was ever shown a refusal, a conflict, a slot that had just been
// taken, or a backend that failed. A receptionist that books correctly only
// when the calendar always says yes is not a working receptionist.
//
// This executor returns whatever the scenario tells it to, records every call
// in order with its arguments, and can stall a response to simulate a slow
// backend. The assertions below are deliberately shaped like eval/asserts.js so
// a finding here transfers to the real eval suite rather than needing
// re-litigating in a different vocabulary.
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, (args:object, callIndex:number) => object>} script
 *   Tool name -> result factory. Anything unlisted returns { ok: true }.
 */
export function makeScriptedExecutor(script = {}) {
  const calls = [];
  return {
    calls,
    /** Record the call and produce the scripted result. */
    resultFor(name, args) {
      const idx = calls.filter((c) => c.name === name).length;
      const fn = script[name];
      const result = typeof fn === "function" ? fn(args || {}, idx) : { ok: true };
      calls.push({ name, args: args || {}, result, at: Date.now(), seq: calls.length });
      return result;
    },
    /** Milliseconds to stall before answering — simulates a slow backend. */
    delayFor(name) {
      const d = script.__delays?.[name];
      return typeof d === "number" ? d : 0;
    },
    reset() { calls.length = 0; },
  };
}

// --- assertions --------------------------------------------------------------
// Each returns { pass, name, detail } so a run can print a table rather than
// throwing on the first failure and hiding the rest.

const ok = (name, pass, detail = "") => ({ name, pass: !!pass, detail });

export function toolCalled(calls, name) {
  return ok(`called ${name}`, calls.some((c) => c.name === name));
}

export function toolNotCalled(calls, name) {
  return ok(`did NOT call ${name}`, !calls.some((c) => c.name === name));
}

export function toolBefore(calls, a, b) {
  const ia = calls.findIndex((c) => c.name === a);
  const ib = calls.findIndex((c) => c.name === b);
  if (ia === -1) return ok(`${a} before ${b}`, false, `${a} never called`);
  if (ib === -1) return ok(`${a} before ${b}`, true, `${b} never called (vacuously ordered)`);
  return ok(`${a} before ${b}`, ia < ib, `${a}@${ia} vs ${b}@${ib}`);
}

export function toolCalledWith(calls, name, pred, label) {
  const hits = calls.filter((c) => c.name === name);
  if (!hits.length) return ok(`${name} with ${label}`, false, "never called");
  const match = hits.find((c) => { try { return pred(c.args); } catch { return false; } });
  return ok(`${name} with ${label}`, !!match, match ? "" : `args seen: ${hits.map((h) => JSON.stringify(h.args)).join(" | ").slice(0, 220)}`);
}

export function toolNotCalledWith(calls, name, pred, label) {
  const hits = calls.filter((c) => c.name === name);
  const bad = hits.find((c) => { try { return pred(c.args); } catch { return false; } });
  return ok(`${name} NEVER with ${label}`, !bad, bad ? `offending args: ${JSON.stringify(bad.args).slice(0, 220)}` : "");
}

export function toolCalledAtMost(calls, name, max) {
  const n = calls.filter((c) => c.name === name).length;
  return ok(`${name} at most ${max}x`, n <= max, `called ${n}x`);
}

/** Did the spoken reply claim success the backend never gave? */
export function saidMatches(text, re, label) {
  return ok(label, re.test(text || ""), `said: ${(text || "").slice(0, 160)}`);
}
export function saidNotMatches(text, re, label) {
  return ok(label, !re.test(text || ""), `said: ${(text || "").slice(0, 160)}`);
}

/**
 * Did the model speak a raw tool blob aloud?
 *
 * Gemini 3.1 did this once in five conversations in round 1 — the caller hears
 * ```json {"intent":"book_appointment"}```. It is the same class as the
 * `{reason:}` leak already fixed once in the cascade, except in
 * speech-to-speech there is no text interception point to fix it at, so it can
 * only be counted and prompted against.
 */
export function toolBlobLeak(text) {
  const t = String(text || "");
  const leaked = /```|\{\s*"[a-z_]+"\s*:|\bfunctionCall\b|\bjson\b/i.test(t);
  return ok("no tool blob spoken aloud", !leaked, leaked ? t.slice(0, 200) : "");
}
