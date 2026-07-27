import { Info } from "lucide-react";
import Field from "./Field";
import { TRANSFER_POLICIES } from "./constants";

/**
 * Transfer policy and number.
 *
 * Renders *inside* the transfer capability's card rather than as a panel of
 * its own. Split apart, the two read as contradictions: a card saying transfer
 * is always on, and a separate panel three screens away saying transfers never
 * happen. Together they read as one decision with two halves.
 *
 * These two fields belong to the page-level draft, not to the capability row —
 * which is safe to co-locate only because a capability with no configSchema
 * renders no Save button of its own, so there is no second button here to
 * mistake for the one that saves them. The sticky bar owns both.
 */
export default function TransferRulesSection({ value, onChange }) {
  return (
    <>
      <p className="set-note">
        <Info className="set-note-icon" size={16} aria-hidden="true" />
        <span>
          This card is always on because a caller can always ask for a person. These two settings decide when we
          actually put them through. They save with the rest of the page.
        </span>
      </p>

      <Field label="When may we transfer a caller?">
        {(p) => (
          <select {...p} value={value.transfer_policy} onChange={(e) => onChange({ transfer_policy: e.target.value })}>
            {TRANSFER_POLICIES.map((policy) => (
              <option key={policy.key} value={policy.key}>
                {policy.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field
        label="Ring this number"
        hint="The phone we put callers through to. Include the country code."
      >
        {(p) => (
          <input
            {...p}
            type="tel"
            value={value.transfer_phone_number}
            onChange={(e) => onChange({ transfer_phone_number: e.target.value })}
            placeholder="+447700900123"
          />
        )}
      </Field>
    </>
  );
}
