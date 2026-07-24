import Panel from "./Panel";
import Field from "./Field";
import { TIMEZONES } from "./constants";

// name, timezone, main_phone, general_info — address fields and
// default_language are intentionally dropped (address_* columns were
// removed by migration 012; default_language was never a real column).
export default function BusinessInfoSection({ value, onChange, phoneNumber }) {
  return (
    <Panel title="Business info" description="The basics your receptionist mentions when it answers.">
      <Field label="Business name">
        {(p) => (
          <input
            {...p}
            value={value.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="Business name"
          />
        )}
      </Field>

      <Field label="Timezone" hint="Your opening hours are read in this timezone.">
        {(p) => (
          <select {...p} value={value.timezone} onChange={(e) => onChange({ timezone: e.target.value })}>
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field
        label="Main phone"
        optional
        hint={`Your own office number, if it's different from the one Vetra answers. Vetra answers ${
          phoneNumber || "no number yet"
        }.`}
      >
        {(p) => (
          <input
            {...p}
            type="tel"
            value={value.main_phone}
            onChange={(e) => onChange({ main_phone: e.target.value })}
            placeholder="Public office number, if different"
          />
        )}
      </Field>

      <Field
        label="About your business"
        recommended
        hint={
          value.general_info.trim()
            ? "Anything a caller might ask about — what you do, who works there, which insurance you take."
            : "Add this so your receptionist can actually answer questions about you — it's the single most useful thing to fill in."
        }
        count={value.general_info.length}
        max={2000}
      >
        {(p) => (
          <textarea
            {...p}
            value={value.general_info}
            maxLength={2000}
            rows={4}
            onChange={(e) => onChange({ general_info: e.target.value })}
            placeholder="e.g. We're a family dental practice. We accept most major insurance and offer free first consultations."
          />
        )}
      </Field>
    </Panel>
  );
}
