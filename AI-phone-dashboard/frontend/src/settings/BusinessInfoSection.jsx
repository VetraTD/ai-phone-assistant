import SectionCard from "./SectionCard";
import { textareaStyle } from "./styles";
import { TIMEZONES } from "./constants";

// name, timezone, main_phone, general_info — address fields and
// default_language are intentionally dropped (address_* columns were
// removed by migration 012; default_language was never a real column).
export default function BusinessInfoSection({ value, onChange, phoneNumber }) {
  return (
    <SectionCard title="Business info">
      <div className="filter-field">
        <label>Business name</label>
        <input
          value={value.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Business name"
        />
      </div>
      <div className="filter-field">
        <label>Timezone</label>
        <select value={value.timezone} onChange={(e) => onChange({ timezone: e.target.value })}>
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>
      <div className="filter-field">
        <label>Main phone</label>
        <input
          value={value.main_phone}
          onChange={(e) => onChange({ main_phone: e.target.value })}
          placeholder="Public office number, if different from your Vetra number"
        />
        <span className="field-hint">
          Shown to callers as your office number. Your Vetra receptionist number is{" "}
          {phoneNumber || "not connected yet"}.
        </span>
      </div>
      <div className="filter-field">
        <label>General info</label>
        <textarea
          value={value.general_info}
          maxLength={2000}
          rows={3}
          style={textareaStyle}
          onChange={(e) => onChange({ general_info: e.target.value })}
          placeholder="Free-form info for callers — services, providers, insurance accepted, etc."
        />
        <span className="field-hint">{value.general_info.length}/2000 characters.</span>
      </div>
    </SectionCard>
  );
}
