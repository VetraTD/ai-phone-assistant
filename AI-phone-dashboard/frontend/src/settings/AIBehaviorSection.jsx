import SectionCard from "./SectionCard";
import { textareaStyle } from "./styles";
import { PERSONALITY_PRESETS } from "./constants";

// Matches a `[Tone] <instruction>` first line against the known presets so
// the select reflects whichever preset (if any) is currently applied.
function detectPreset(customInstructions) {
  const firstLine = (customInstructions || "").split("\n")[0] || "";
  const match = PERSONALITY_PRESETS.find((p) => firstLine === `[Tone] ${p.instruction}`);
  return match ? match.key : "";
}

function stripToneLine(customInstructions) {
  const lines = (customInstructions || "").split("\n");
  if (!lines[0]?.startsWith("[Tone]")) return customInstructions || "";
  return lines.slice(1).join("\n").replace(/^\n+/, "");
}

export default function AIBehaviorSection({ value, onChange }) {
  const { greeting, custom_instructions: customInstructions } = value;
  const presetKey = detectPreset(customInstructions);

  const applyPreset = (key) => {
    const rest = stripToneLine(customInstructions);
    if (!key) {
      // "Custom / none" — just remove any existing [Tone] line.
      onChange({ custom_instructions: rest });
      return;
    }
    const preset = PERSONALITY_PRESETS.find((p) => p.key === key);
    const toneLine = `[Tone] ${preset.instruction}`;
    const next = rest ? `${toneLine}\n${rest}` : toneLine;
    onChange({ custom_instructions: next.slice(0, 2000) });
  };

  return (
    <SectionCard title="AI behavior">
      <div className="filter-field">
        <label>Greeting</label>
        <textarea
          value={greeting}
          maxLength={500}
          rows={4}
          style={textareaStyle}
          onChange={(e) => onChange({ greeting: e.target.value })}
          placeholder="Leave blank to use the default greeting"
        />
        <span className="field-hint">
          {greeting.length}/500 characters. Leave this blank to use the default greeting — a time-of-day prefix
          ("Good morning! …") is only added automatically to that default. A custom greeting you type here is
          spoken exactly as written, with no prefix added.
        </span>
      </div>

      <div className="filter-field">
        <label>Personality</label>
        <select value={presetKey} onChange={(e) => applyPreset(e.target.value)}>
          <option value="">Custom / none</option>
          {PERSONALITY_PRESETS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        <span className="field-hint">
          Choosing a personality inserts a one-line tone instruction at the top of House rules below, replacing any
          tone instruction already there.
        </span>
      </div>

      <div className="filter-field">
        <label>House rules</label>
        <textarea
          value={customInstructions}
          maxLength={2000}
          rows={6}
          style={textareaStyle}
          onChange={(e) => onChange({ custom_instructions: e.target.value })}
          placeholder={"House rules for your receptionist — e.g. \"We don't do same-day appointments\""}
        />
        <span className="field-hint">
          {customInstructions.length}/2000 characters. House rules for your receptionist — e.g. "We don't do
          same-day appointments".
        </span>
      </div>
    </SectionCard>
  );
}
