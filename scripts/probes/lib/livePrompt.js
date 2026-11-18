// ---------------------------------------------------------------------------
// The prompt split GPT-Live requires.
//
// OpenAI's migration guide is explicit that you do NOT copy an existing system
// prompt into a Live session: "split your existing prompt between the voice
// model and the backend", keeping conversation style up front and moving
// detailed workflows and tool-use instructions to the backend. The voice model
// is documented as having "a small context window" and the prompting guide says
// to start simple and only add a rule to change a specific behaviour.
//
// So the frontend prompt here is SHORT and hand-written, and the backend gets
// the real 10-tool production prompt unchanged. Any other arrangement would
// make the arms incomparable: arm R's backend and arm C's brain must be reading
// the same instructions, or a difference between them could just be a
// difference in what we told them.
//
// The frontend prompt below carries exactly one non-obvious instruction -- do
// not state availability or confirm a booking before the backend answers. That
// is there because G4 measures whether it obeys, and a probe that never asked
// would be measuring nothing. It is the honest version of the production rule,
// not a hint designed to make the arm look good.
// ---------------------------------------------------------------------------
import { SYSTEM_PROMPT, BUSINESS_CONFIG, OPENAI_TOOLS, TOOL_NAMES } from "./prompt.js";

export const FRONTEND_INSTRUCTIONS = [
  `You are the receptionist answering the phone for ${BUSINESS_CONFIG.businessName}.`,
  "Speak naturally and briefly, the way a person on a phone does.",
  "",
  "You do not have access to the diary, the price list, or any customer record.",
  "Delegate anything that needs one: appointments, availability, prices, opening",
  "hours, taking a message, or anything about a specific customer.",
  "",
  "While you are waiting for an answer, it is fine to acknowledge the caller and",
  "say you are checking. Do not state a time or date as available, and do not say",
  "a booking is made, until the answer comes back.",
].join("\n");

/** The real production prompt, unchanged. Arm R's backend reads this. */
export const BACKEND_INSTRUCTIONS = SYSTEM_PROMPT;

/**
 * Responses-shape tools. The Realtime shape in prompt.js is already
 * {type:"function", name, description, parameters}, which is what
 * delegation.responses.tools takes, so the declarations pass through untouched.
 * Verified against ResponsesDelegationConfig in the generated SDK types.
 */
export const RESPONSES_TOOLS = OPENAI_TOOLS;

export const RESPONSES_DELEGATION = {
  type: "responses",
  responses: {
    model: "gpt-5.6-luna",
    instructions: BACKEND_INSTRUCTIONS,
    tools: RESPONSES_TOOLS,
    tool_choice: "auto",
    // PLAN-gptlive.md: the migration guide says to start with this false --
    // "collect calls from completed output-item events even if a terminal
    // lifecycle snapshot has output: []".
    parallel_tool_calls: false,
  },
};

/** Arm C. Omitting delegation entirely also selects the client; explicit is clearer. */
export const CLIENT_DELEGATION = { type: "client" };

export { TOOL_NAMES };
