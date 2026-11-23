import Panel from "./Panel";
import Field, { CheckField } from "./Field";
import { LANGUAGES } from "./constants";

// validateLanguagesSpoken (settingsValidation.js) rejects an empty array —
// toggling off the last remaining language is a no-op here rather than
// producing an invalid save.
// `only` shows "languages" or "notice" alone, for the Voice agent tab.
export default function LanguagesSection({ value, onChange, only }) {
  const show = (key) => !only || only === key;
  const langs = value.languages_spoken;

  const toggle = (key) => {
    const isLast = langs.length === 1 && langs[0] === key;
    if (isLast) return;
    const next = langs.includes(key) ? langs.filter((l) => l !== key) : [...langs, key];
    onChange({ languages_spoken: next });
  };

  return (
    <Panel
      title={only === "languages" ? "Languages" : only === "notice" ? "Call notice" : "Languages & call notice"}
      description={
        only
          ? undefined
          : "Which languages the voice agent can switch to mid-call, and whether callers are told the call may be transcribed."
      }
    >
      {show("languages") ? (
      <fieldset className="set-fieldset">
        <legend className="set-legend">Languages spoken</legend>
        <div className="set-checklist">
          {LANGUAGES.map((lang) => {
            const checked = langs.includes(lang.key);
            const isLast = checked && langs.length === 1;
            return (
              <label key={lang.key} className="set-check">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isLast}
                  onChange={() => toggle(lang.key)}
                />
                <span className="set-check-text">{lang.label}</span>
              </label>
            );
          })}
        </div>
        <p className="set-hint">At least one language has to stay on, so the last one can't be switched off.</p>
      </fieldset>
      ) : null}

      {show("notice") ? (
        <>
      <CheckField
        checked={value.recording_disclosure_enabled}
        onChange={(recording_disclosure_enabled) => onChange({ recording_disclosure_enabled })}
        hint="Some places require this by law. Check what applies where you are."
      >
        Tell callers the call may be transcribed
      </CheckField>

      {value.recording_disclosure_enabled ? (
        <Field label="What we say" hint="Spoken at the very start, before the greeting.">
          {(p) => (
            <input
              {...p}
              value={value.recording_disclosure_text}
              maxLength={500}
              onChange={(e) => onChange({ recording_disclosure_text: e.target.value })}
              placeholder="This call may be transcribed to help us assist you."
            />
          )}
        </Field>
      ) : null}
        </>
      ) : null}
    </Panel>
  );
}
