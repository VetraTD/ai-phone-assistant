import SectionCard from "./SectionCard";
import { TRANSFER_POLICIES } from "./constants";

export default function TransferRulesSection({ value, onChange }) {
  return (
    <SectionCard title="Transfer rules">
      <div className="filter-field">
        <label>Transfer policy</label>
        <select
          value={value.transfer_policy}
          onChange={(e) => onChange({ transfer_policy: e.target.value })}
        >
          {TRANSFER_POLICIES.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="filter-field">
        <label>Transfer phone number</label>
        <input
          value={value.transfer_phone_number}
          onChange={(e) => onChange({ transfer_phone_number: e.target.value })}
          placeholder="+447700900123"
        />
      </div>
    </SectionCard>
  );
}
