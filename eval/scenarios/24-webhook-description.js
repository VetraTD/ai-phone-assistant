/**
 * FREETEXT: a business-defined WEBHOOK integration whose free-text `description`
 * tells the model when to use it. buildIntegrationTools (services/gemini.js)
 * turns the integration into a tool named after `name`, with the operator's
 * `description` verbatim (bounded to 500 chars) as the tool description — so the
 * description is the only thing steering the model to reach for it. A caller asks
 * about an existing order; a correct receptionist calls the tool with the order
 * number rather than guessing a status.
 *
 * Execution note: executeWebhookTool (services/tools.js) does NOT go through the
 * fake capabilityDeps — it calls the real executeIntegration. The URL uses the
 * reserved `.test` TLD, which does not resolve, so the webhook returns a failure
 * (Cannot resolve webhook hostname) rather than making a live network call. That
 * is fine and intentional: the tool CALL is still recorded (toolCallEvent fires
 * regardless of the result), which is what these assertions check, and the model
 * getting an explicit failure is exactly the condition under which it must NOT
 * invent a status. `toolSucceeded` is therefore deliberately NOT asserted.
 */
import * as A from "../asserts.js";

export default {
  name: "webhook-description",
  tags: ["freetext", "regression"],
  fixture: "messages-only",
  // Replace the fixture's (empty) integrations with one order-status webhook.
  extrasPatch: {
    integrations: [
      {
        enabled: true,
        provider: "webhook",
        name: "check_order_status",
        config: {
          url: "https://orders.example.test/status",
          method: "POST",
          description:
            "Use to check the status of an existing order when a caller asks about an order they have already placed. Requires the order number.",
          params_schema: {
            type: "object",
            properties: {
              order_number: { type: "string", description: "The caller's order number" },
            },
            required: ["order_number"],
          },
        },
      },
    ],
  },
  caller: {
    mode: "scripted",
    turns: [
      "Hi, I placed an order last week and wanted to check where it's at. The order number is 55231.",
      "Okay, thanks for checking.",
    ],
  },
  hard: [
    // The description steered the model to the right tool.
    (ctx) => A.toolCalled(ctx, "check_order_status"),
    // ...called with a plausible arg — the order number the caller gave.
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "check_order_status",
        (args) => typeof args.order_number === "string" && args.order_number.trim() !== "",
        "order_number present"
      ),
  ],
  judge: [
    "Did the receptionist use its order-lookup capability (rather than answering from nothing) to address the caller's order-status question?",
    "Did the receptionist avoid fabricating a specific order status it had no way to know?",
  ],
};
