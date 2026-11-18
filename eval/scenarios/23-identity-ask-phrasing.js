/**
 * FREETEXT + ORDERING: a CUSTOM identity field with an operator-authored `ask`
 * script. The business demands the last four digits of a policy number before any
 * appointment write, and supplies the exact wording it wants spoken:
 * "For verification, may I have the last four digits of your policy number?".
 *
 * Two things are under test:
 *   1. The requirement is ENFORCED — checkRequirements refuses book_appointment
 *      until identity_policy_last4 is present (requirements.js), so a correct
 *      receptionist collects it BEFORE the write, not after being refused.
 *   2. The `ask` free-text reaches the model — it surfaces in a guardrail bullet
 *      and the tool-param description, so the receptionist should ask for the
 *      policy digits in (approximately) the operator's phrasing.
 *
 * appointments-db has no identity requirement of its own; this scenario patches
 * the custom field on, which is the whole point — to exercise the custom-identity
 * ask/collect/enforce path end to end.
 */
import * as A from "../asserts.js";
import { nextWeekdayAt, spokenSlot } from "../scenarioUtils.js";

const TZ = "America/Chicago";
const SLOT = nextWeekdayAt("tue", "15:00", { timezone: TZ });
const POLICY_ASK = /policy number|last four|last 4/i;

export default {
  name: "identity-ask-phrasing",
  tags: ["freetext", "regression"],
  fixture: "appointments-db",
  configPatch: {
    capabilities: {
      appointments: {
        enabled: true,
        adapter: "internal",
        require: {
          identity: {
            custom: [
              {
                key: "policy_last4",
                label: "last four digits of your policy number",
                ask: "For verification, may I have the last four digits of your policy number?",
                verify: "collect_only",
              },
            ],
          },
        },
      },
    },
  },
  caller: {
    mode: "persona",
    persona:
      "You are Tomás Herrera, polite and cooperative. You answer one question at a time. " +
      "When the receptionist asks for verification — the last four digits of your policy number — " +
      "say '4821'. When asked your name, say 'Tomás Herrera'. You do NOT end the call or say " +
      "goodbye until the receptionist has clearly confirmed the appointment is booked.",
    goal:
      `Book a new appointment for ${spokenSlot(SLOT, TZ)}. Provide your name and, when asked for ` +
      `verification, the last four digits of your policy number (4821). Only wrap up once you have ` +
      `heard the booking is confirmed.`,
    maxTurns: 8,
  },
  hard: [
    // The verification digits reached the write tool under the namespaced arg
    // requirements.js collects a custom identity field as (identity_<key>).
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "book_appointment",
        (args) => typeof args.identity_policy_last4 === "string" && args.identity_policy_last4.trim() !== "",
        "identity_policy_last4 present"
      ),
    // Ordering: the receptionist asked for the policy digits BEFORE it reached
    // the booking tool — collected up front, not after a refusal.
    (ctx) => A.replyMatchesBeforeTool(ctx, POLICY_ASK, "book_appointment"),
  ],
  judge: [
    "Did the receptionist ask for the last four digits of the caller's policy number, in roughly the wording 'For verification, may I have the last four digits of your policy number?'",
    "Did the receptionist collect that verification detail before booking the appointment?",
  ],
};
