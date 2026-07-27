import { useId } from "react";

/**
 * A radio group rendered as cards.
 *
 * Both the voice picker and the capability adapter pickers are "pick exactly
 * one, and each option needs a sentence of explanation" — a native <select>
 * hides the explanation and the previous voice picker faked it with
 * `<div role="button" tabIndex={0}>`, which is not a radio group: no
 * aria-checked, no arrow keys, and a screen reader announcing eight unrelated
 * buttons.
 *
 * These are real <input type="radio"> in a real <fieldset>, so the browser
 * gives us roving focus, arrow-key selection and the checked state for free.
 *
 * options: [{ value, title, desc?, tags?: string[] }]
 */
export default function ChoiceCards({ legend, options, value, onChange, name }) {
  const generated = useId();
  const groupName = name || generated;

  return (
    <fieldset className="set-fieldset">
      <legend className="set-legend">{legend}</legend>
      <div className="set-choices">
        {options.map((opt) => {
          const selected = opt.value === value;
          return (
            <label key={opt.value} className={`set-choice${selected ? " is-selected" : ""}`}>
              <input
                type="radio"
                name={groupName}
                value={opt.value}
                checked={selected}
                onChange={() => onChange(opt.value)}
              />
              <span className="set-choice-title">{opt.title}</span>
              {opt.desc ? <span className="set-choice-desc">{opt.desc}</span> : null}
              {opt.tags?.length ? (
                <span className="set-choice-tags">
                  {opt.tags.map((t) => (
                    <span key={t} className="set-tag">
                      {t}
                    </span>
                  ))}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
