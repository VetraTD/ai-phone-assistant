import SectionCard from "./SectionCard";
import { AFTER_HOURS_POLICIES } from "./constants";

export default function AfterHoursSection({ value, onChange }) {
  return (
    <SectionCard title="After-hours behavior">
      <div className="filter-field">
        <label>When the business is closed</label>
        <select
          value={value.after_hours_policy}
          onChange={(e) => onChange({ after_hours_policy: e.target.value })}
        >
          {AFTER_HOURS_POLICIES.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
    </SectionCard>
  );
}
