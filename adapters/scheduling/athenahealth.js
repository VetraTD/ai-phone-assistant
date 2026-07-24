/**
 * athenahealth scheduling adapter.
 *
 * A thin routing layer over the existing integrations/athenahealth.js client —
 * that file holds the OAuth handling, practice/department resolution and the
 * quirks of their API, and is deliberately NOT rewritten here. This adapter
 * only answers "which backend, and what can it prove".
 *
 * Execution goes through services/integrations.js executeIntegration, the same
 * path it always did, so behavior is unchanged by the adapter existing.
 */

/** @type {import("./types.js").SchedulingAdapter} */
export default {
  id: "athenahealth",
  label: "athenahealth",

  // Not a self-serve dashboard choice: EHR onboarding is a partner process the
  // operator sets up out of band. Stays a fully valid adapter in the engine so
  // a clinic configured to it directly keeps working — it is just not offered
  // in the settings picker.
  selfServe: false,

  // An EHR holds the patient record, so it can genuinely check a caller
  // against name + date of birth — the same pair a human receptionist uses.
  // customfields.* is where a practice-specific identifier like a "dental
  // number" would live, and is what a future verify_against would compare to.
  verifiableFields: ["name", "dob", "phone_on_file", "patient_id", "customfields.*"],

  /**
   * Before business_capabilities existed, having an enabled athenahealth
   * integration WAS the routing decision. Honoured so a business that has not
   * been configured yet still reaches the same appointment book.
   */
  claimsIntegration(integrations) {
    return integrations.some((i) => i.enabled && i.provider === "athenahealth");
  },

  /** The integration row this adapter executes through. */
  integrationFor(integrations) {
    return integrations.find((i) => i.enabled && i.provider === "athenahealth") || null;
  },

  /**
   * The EHR tools are exposed to the model directly (get_caller_appointments,
   * book_appointment_in_ehr, ...) and executed via executeIntegration, so this
   * adapter does not reimplement them. Marked explicitly rather than left
   * undefined so the distinction is legible: not "unsupported", but "routed
   * elsewhere".
   */
  routesThroughIntegration: true,
  lookupByCaller: null,
  book: null,
  cancel: null,
  reschedule: null,
  checkAvailability: null,
  findSlots: null,
};
