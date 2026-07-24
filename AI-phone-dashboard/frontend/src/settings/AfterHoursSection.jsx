import { Info } from "lucide-react";
import Panel from "./Panel";
import Field from "./Field";
import { AFTER_HOURS_POLICIES } from "./constants";

// "Offer to book for later" only makes sense if the receptionist can book at
// all. Offering it to a non-appointment business used to tell the engine to
// reach for a booking tool it never had (services/gemini.js after-hours
// switch, now also guarded there). So the option is hidden unless Appointments
// is on — except we never silently drop a value already saved: if the stored
// policy is book_later while appointments are off, we keep showing it, flagged.
export default function AfterHoursSection({ value, onChange, appointmentsEnabled }) {
  const current = value.after_hours_policy;

  const options = AFTER_HOURS_POLICIES.filter(
    (policy) => policy.key !== "book_later" || appointmentsEnabled || current === "book_later"
  );

  const staleBookLater = current === "book_later" && !appointmentsEnabled;

  return (
    <Panel title="When you're closed" description="What happens on a call that arrives outside the hours above.">
      <p className="set-note">
        <Info className="set-note-icon" size={16} aria-hidden="true" />
        <span>
          Your receptionist still answers every call. This only decides what it offers the caller once it knows
          you're closed.
        </span>
      </p>

      <Field
        label="Handle out-of-hours calls by"
        error={
          staleBookLater
            ? "This needs Appointments turned on. Until then, closed-hours callers are offered a message instead."
            : undefined
        }
      >
        {(p) => (
          <select {...p} value={current} onChange={(e) => onChange({ after_hours_policy: e.target.value })}>
            {options.map((policy) => (
              <option key={policy.key} value={policy.key}>
                {policy.label}
                {policy.key === "book_later" && staleBookLater ? " (needs Appointments)" : ""}
              </option>
            ))}
          </select>
        )}
      </Field>
    </Panel>
  );
}
