import SectionCard from "./SectionCard";
import { LANGUAGES } from "./constants";

// validateLanguagesSpoken (settingsValidation.js) rejects an empty array —
// toggling off the last remaining language is a no-op here rather than
// producing an invalid save.
export default function LanguagesSection({ value, onChange }) {
  const langs = value.languages_spoken;

  const toggle = (key) => {
    const isLast = langs.length === 1 && langs[0] === key;
    if (isLast) return;
    const next = langs.includes(key) ? langs.filter((l) => l !== key) : [...langs, key];
    onChange({ languages_spoken: next });
  };

  return (
    <SectionCard title="Languages">
      <div className="filter-field">
        <label>Languages spoken</label>
        <div className="checkbox-list">
          {LANGUAGES.map((lang) => (
            <label key={lang.key} className="checkbox-item">
              <input
                type="checkbox"
                checked={langs.includes(lang.key)}
                onChange={() => toggle(lang.key)}
              />
              <span>{lang.label}</span>
            </label>
          ))}
        </div>
        <span className="field-hint">At least one language must stay selected.</span>
      </div>

      <label className="checkbox-item">
        <input
          type="checkbox"
          checked={value.recording_disclosure_enabled}
          onChange={(e) => onChange({ recording_disclosure_enabled: e.target.checked })}
        />
        <span>Play a call-recording disclosure at the start of each call</span>
      </label>

      {value.recording_disclosure_enabled ? (
        <div className="filter-field">
          <label>Disclosure text</label>
          <input
            value={value.recording_disclosure_text}
            maxLength={500}
            onChange={(e) => onChange({ recording_disclosure_text: e.target.value })}
            placeholder="This call may be recorded for quality and training purposes."
          />
        </div>
      ) : null}
    </SectionCard>
  );
}
