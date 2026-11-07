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
 * link-only (notifyCustomerRequest in services/notifications.js): it carries no
 * name, number or message, only "a caller left a message" and the dashboard
 * link. The email that does carry the details is notifyCallRequests, sent from
 * the rows as they stand at call end, so a correction is already in it, and a
 * healthcare-tier business never gets details by email at all. The details the
 * owner reads are the row's, and the row is what a correction fixes. Holding the email back for a correction that may never come would buy
 * nothing and would put a dropped call between the caller and their message.
 *
 * Shared by capabilities/messages.js and capabilities/quotes.js -- the two
 * packs whose effect is a customer_requests row -- on every front-end that
 * dispatches their effects (Live and the cascade both pass engine.call.callId).
 */

// Words that carry no reason of their own, English and Spanish. A reason made
// only of these ("call me back") is treated as missing: it matches, and it
// never overwrites a reason already on the row.
const STOP_WORDS = new Set(
  (
    "the and for about with that this they them their there wants want wanted would like call calling called back " +
    "please regarding message callback asked asking said says tell telling let know from have has had need needs some " +
    "someone can could you your are was were will just also get give his her she him its into onto over our out who " +
    "what when where which why how then than any all not but got make made see say ask " +
    "que quiere quieren queria llamen llame llamar llamada llamarle devolver devuelva sobre para con una uno unos unas " +
    "los las del por sus esta este esto eso como cuando donde porque pero tambien también mensaje favor dice dijo " +
    "tiene necesita hablar gracias señor señora usted ella él"
  ).split(/\s+/)
);

/** Crude plural/tense folding -- "bill" and "billing" are the same reason. */
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w);

const nameWords = (n) =>
  String(n || "")
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** The words that say what a request is about -- not stop words, and not the caller's own name. */
function reasonWords(text, names = new Set()) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !names.has(w))
      .map(stem)
  );
}

/**
 * The same reason: at least half of all the words the two reasons use are
 * shared (Jaccard >= 1/2). "about the invoice" / "wants to discuss the invoice"
 * is one reason; "tell billing about the invoice" / "tell sales about the
 * invoice" is two; a reason with no words of its own matches anything.
 */
function sameReason(a, b, names) {
  const A = reasonWords(a, names);
  const B = reasonWords(b, names);
  if (!A.size || !B.size) return true;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / (A.size + B.size - shared) >= 0.5;
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The same person: a name missing on either side, the same first name ("Jon" /
 * "Jon Doe"), or a spelling fix ("Jon" / "John", "Smith" / "Smyth" -- at most a
 * third of the letters differ). The number never vouches for a person: two
 * people can call from one phone ("Jon" / "Jane").
 */
function samePerson(a, b) {
  const A = nameWords(a);
  const B = nameWords(b);
  if (!A.length || !B.length) return true;
  if (A[0] === B[0]) return true;
  const x = A.join(" ");
  const y = B.join(" ");
  return editDistance(x, y) / Math.max(x.length, y.length) <= 0.34;
}

/**
 * Is `next` a correction of `prev`, or a different request?
 *
 * Ruling (S3, revised after the opus review): a correction is the same person
 * about the same reason; the number is free to change, because fixing it is
 * the commonest correction. Wrong one way, a correction files as new -- two
 * rows and two emails, which is what every correction did before this, and
 * nothing is lost. Wrong the other way would overwrite a message, so the bar
 * for "same" is the higher one.
 *
 * @param {{ callerName?: string|null, message?: string|null }} prev
 * @param {{ callerName?: string|null, message?: string|null }} next
 */
export function sameRequest(prev, next) {
  const names = new Set([...nameWords(prev.callerName), ...nameWords(next.callerName)]);
  return samePerson(prev.callerName, next.callerName) && sameReason(prev.message, next.message, names);
}

/** Does this text say what the request is about, beyond stop words and the caller's name? */
export function hasReason(text, callerName) {
  return reasonWords(text, new Set(nameWords(callerName))).size > 0;
}

/**
 * @typedef {{ callerType: string|null, answers: Array<{ label: string, answer: string }> }} Details
 */

export const CALLER_TYPES = ["new_enquiry", "existing_customer", "personal", "supplier", "sales_pitch", "other"];

const MAX_ANSWERS = 20;
const MAX_LABEL = 60;
const MAX_ANSWER = 500;

const squash = (s) => s.replace(/\s+/g, " ").trim();
const labelKey = (s) => squash(s).toLowerCase();

/**
 * A model's `caller_type` and `details` args, made safe to store. Junk is dropped
 * entry by entry; whitespace (newlines too) is collapsed BEFORE the clamp so
 * padding cannot eat the length budget. Nothing usable left returns null.
 *
 * @param {{ caller_type?: unknown, details?: unknown }} [args]
 * @returns {Details|null}
 */
export function detailsFromArgs({ caller_type, details } = {}) {
  const callerType = CALLER_TYPES.includes(caller_type) ? caller_type : null;
  const answers = [];
  if (Array.isArray(details)) {
    for (const entry of details) {
      if (answers.length >= MAX_ANSWERS) break;
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.label !== "string" || typeof entry.answer !== "string") continue;
      const label = squash(entry.label).slice(0, MAX_LABEL).trim();
      const answer = squash(entry.answer).slice(0, MAX_ANSWER).trim();
      if (!label || !answer) continue;
      answers.push({ label, answer });
    }
  }
  if (!callerType && !answers.length) return null;
  return { callerType, answers };
}

/**
 * Merge a later save's details onto the stored ones. Labels match after trim,
 * whitespace collapse and lowercase; a later answer replaces the earlier in
 * place (earlier position, later spelling); a partial save never drops an
 * earlier answer. The answers cap at 20: a new label past the cap is dropped,
 * a replacement still works, so repeated saves cannot grow the row unbounded.
 *
 * @param {Details|null|undefined} stored
 * @param {Details|null|undefined} incoming
 * @returns {Details|null}
 */
export function mergeDetails(stored, incoming) {
  const answers = Array.isArray(stored?.answers) ? stored.answers.map((a) => ({ ...a })) : [];
  const at = new Map(answers.map((a, i) => [labelKey(a.label), i]));
  for (const a of Array.isArray(incoming?.answers) ? incoming.answers : []) {
    const key = labelKey(a.label);
    const next = { label: squash(a.label), answer: a.answer };
    if (at.has(key)) answers[at.get(key)] = next;
    else if (answers.length < MAX_ANSWERS) {
      at.set(key, answers.length);
      answers.push(next);
    }
  }
  const callerType = incoming?.callerType || stored?.callerType || null;
  if (!callerType && !answers.length) return null;
  return { callerType, answers };
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
 * @param {{ requestType: string, callerName: string|null, callbackNumber: string|null, message: string|null, preferredTime: string|null, details?: Details|null }} opts.row
 *   `details` is a lead's answers (see detailsFromArgs). On a match they are merged onto the stored
 *   details; when the match is the same person with a reworded reason, the stored message is kept.
 * @param {(message: string|null) => string} [opts.reasonOf] - the part of a stored message that names the
 *   request (quotes: the description, not its "Address:"/"Urgency:" labels)
 * @param {(stored: string|null, next: string|null) => string|null} [opts.mergeMessage] - the message a
 *   correction writes, given the row's (quotes: keep an address the re-record left out)
 * @param {string|null} [opts.fallbackNumber] - used on INSERT only: a correction that names no number
 *   keeps the one on the row
 * @returns {Promise<{ id: string, corrected: boolean, ownerNoticePending: boolean }|null>} null when nothing
 *   was written. ownerNoticePending: true on a correction; on an insert, true only when there is a call row.
 */
export function saveCustomerRequest({
  db,
  businessId,
  callId,
  callSid = null,
  row,
  reasonOf = (m) => m,
  mergeMessage = null,
  fallbackNumber = null,
}) {
  return serializeByCall(callId, async () => {
    if (callId) {
      const updated = await db.withTenantSafe(
        businessId,
        async () => {
          const existing = await db.listCallCustomerRequests(callId, businessId, row.requestType);
          // Newest first, so a correction of a correction lands on the row it fixes.
          const sameKind = (existing || []).find((r) =>
            sameRequest(
              { callerName: r.caller_name, message: reasonOf(r.message) },
              { callerName: row.callerName, message: reasonOf(row.message) }
            )
          );
          // A save that carries a lead's answers belongs to the person, not to
          // the wording of the reason: the model rewords it as the call goes on.
          const samePersonOnly = sameKind
            ? null
            : row.details
              ? (existing || []).find((r) => samePerson(r.caller_name, row.callerName))
              : null;
          const match = sameKind || samePersonOnly;
          if (!match) return null;
          // A re-record that says no more than "wants a call back" must not
          // replace "about the invoice 4471": null keeps the row's message.
          // A person-only match never rewrites the stored reason.
          const message = samePersonOnly || !hasReason(reasonOf(row.message), row.callerName)
            ? null
            : mergeMessage
              ? mergeMessage(match.message, row.message)
              : row.message;
          const { details: incoming, ...rest } = row;
          const update = { id: match.id, businessId, ...rest, message };
          // Merged, never replaced: a partial save must not wipe an earlier answer.
          if (incoming) update.details = mergeDetails(match.details, incoming);
          const id = await db.updateCustomerRequest(update);
          return id ? { id, corrected: true, ownerNoticePending: true } : null;
        },
        { operation: "updateCustomerRequest", callSid }
      );
      if (updated) return updated;
    }
    const id = await db.withTenantSafe(
      businessId,
      () =>
        db.createCustomerRequest({
          businessId,
          callId,
          ...row,
          callbackNumber: row.callbackNumber || fallbackNumber || null,
          ownerNoticePending: Boolean(callId),
        }),
      { operation: "createCustomerRequest", callSid }
    );
    return id ? { id, corrected: false, ownerNoticePending: Boolean(callId) } : null;
  });
}
