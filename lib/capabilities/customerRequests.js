/**
 * One message per request, however many times the caller corrects it.
 *
 * Round A1 S3 (review finding I3, owner 2026-10-13). The message protocol tells
 * the model to summarise once, record straight away, and "if they correct
 * anything, record it again with the fix" (capabilities/messages.js). Each
 * record used to INSERT a customer_requests row and email the owner, so a
 * caller who said "no, it's 0 1 2 4" left two rows and two emails, the first
 * one wrong. The model keeps re-recording; this module turns the re-record into
 * an UPDATE of the row it corrects.
 *
 * The owner email is NOT moved. It stays at the first save, because it is
 * link-only by design (services/notifications.js): it carries no name, number
 * or message, only "a caller left a message" and the dashboard link. The
 * details the owner reads are the row's, and the row is what a correction
 * fixes. Holding the email back for a correction that may never come would buy
 * nothing and would put a dropped call between the caller and their message.
 *
 * Shared by capabilities/messages.js and capabilities/quotes.js -- the two
 * packs whose effect is a customer_requests row -- on every front-end that
 * dispatches their effects (Live and the cascade both pass engine.call.callId).
 */

// Words that carry no reason of their own. A reason made only of these
// ("call me back") is treated as missing, which matches anything: a record
// that names no reason fills one in rather than starting a new request.
const STOP_WORDS = new Set(
  (
    "the and for about with that this they them their there wants want wanted would like call calling called back " +
    "please regarding message callback asked asking said tell telling let know from have has had need needs some " +
    "someone can could you your are was were will just also get give his her she him its into onto over our out who " +
    "what when where which why how then than any all not but got make made see say"
  ).split(/\s+/)
);

/** Crude plural/tense folding -- "bill" and "billing" are the same reason. */
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w);

function reasonWords(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
      .map(stem)
  );
}

/**
 * The same reason: more than half of the shorter reason's words appear in the
 * other. "about the invoice" / "wants to discuss the invoice" is one reason;
 * "tell billing about the invoice" / "tell sales about the invoice" is two.
 */
function sameReason(a, b) {
  const A = reasonWords(a);
  const B = reasonWords(b);
  if (!A.size || !B.size) return true;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / Math.min(A.size, B.size) > 0.5;
}

const nameWords = (n) =>
  String(n || "")
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Same person by name: identical, or the same first name ("Jon" / "Jon Doe"). Missing matches anything. */
function sameName(a, b) {
  const A = nameWords(a);
  const B = nameWords(b);
  if (!A.length || !B.length) return true;
  return A.join(" ") === B.join(" ") || A[0] === B[0];
}

/** Same number by its last ten digits. Fewer than seven digits ("the number I'm calling from") matches anything. */
function sameNumber(a, b) {
  const A = String(a || "").replace(/\D/g, "");
  const B = String(b || "").replace(/\D/g, "");
  if (A.length < 7 || B.length < 7) return true;
  return A.slice(-10) === B.slice(-10);
}

/**
 * Is `next` a correction of `prev`, or a different request?
 *
 * Ruling (S3): a correction keeps the reason and fixes the name OR the number
 * -- one thing at a time, which is how a caller corrects a read-back. A
 * different reason, or a different name AND a different number, is a different
 * request. Wrong one way, a correction files as new: two rows and two emails,
 * which is what every correction did before this -- nothing is lost. Wrong the
 * other way would overwrite a message, so the bar for "same" is the higher one.
 *
 * @param {{ callerName?: string|null, callbackNumber?: string|null, message?: string|null }} prev
 * @param {{ callerName?: string|null, callbackNumber?: string|null, message?: string|null }} next
 */
export function sameRequest(prev, next) {
  return (
    sameReason(prev.message, next.message) &&
    (sameName(prev.callerName, next.callerName) || sameNumber(prev.callbackNumber, next.callbackNumber))
  );
}

// One chain per call. Two records dispatched in the same turn run their
// effects back to back with no await between, so without this the second
// would look for the first's row before it exists and file a duplicate. A
// call lives in one process, so an in-process chain is the whole of it.
const chains = new Map();

function serializeByCall(callId, task) {
  if (!callId) return task();
  const run = (chains.get(callId) || Promise.resolve()).then(task, task);
  const tail = run.catch(() => {});
  chains.set(callId, tail);
  tail.then(() => {
    if (chains.get(callId) === tail) chains.delete(callId);
  });
  return run;
}

/**
 * Write a customer request: update the row it corrects, or insert a new one.
 *
 * Two tenant units, not one. A failed UPDATE aborts its transaction, and the
 * insert that must follow it (Ruling: a correction that cannot be written as an
 * update is filed as new, never dropped) needs a transaction of its own.
 *
 * @param {object} opts
 * @param {object} opts.db - engine.deps.db
 * @param {string} opts.businessId
 * @param {string|null} opts.callId - calls.id; null (no call row) matches nothing
 * @param {string|null} [opts.callSid]
 * @param {{ requestType: string, callerName: string|null, callbackNumber: string|null, message: string|null, preferredTime: string|null }} opts.row
 * @returns {Promise<{ id: string, corrected: boolean }|null>} null when nothing was written
 */
export function saveCustomerRequest({ db, businessId, callId, callSid = null, row }) {
  return serializeByCall(callId, async () => {
    if (callId) {
      const updated = await db.withTenantSafe(
        businessId,
        async () => {
          const existing = await db.listCallCustomerRequests(callId, businessId, row.requestType);
          // Newest first, so a correction of a correction lands on the row it fixes.
          const match = (existing || []).find((r) =>
            sameRequest({ callerName: r.caller_name, callbackNumber: r.callback_number, message: r.message }, row)
          );
          if (!match) return null;
          const id = await db.updateCustomerRequest({ id: match.id, businessId, ...row });
          return id ? { id, corrected: true } : null;
        },
        { operation: "updateCustomerRequest", callSid }
      );
      if (updated) return updated;
    }
    const id = await db.withTenantSafe(
      businessId,
      () => db.createCustomerRequest({ businessId, callId, ...row }),
      { operation: "createCustomerRequest", callSid }
    );
    return id ? { id, corrected: false } : null;
  });
}
