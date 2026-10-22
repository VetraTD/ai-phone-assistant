import Panel from "./Panel";
import Field from "./Field";
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

// Mirrors the engine's blank-greeting default (lib/voice/session.js buildGreeting
// + strings.js): a time-of-day prefix plus "thanks for calling {name}". Shown so
// "blank" reads as a real, good greeting rather than a scary empty box — which
// is exactly why greeting stays optional rather than required.
function autoGreetingPreview(name) {
  const hour = new Date().getHours();
  const tod = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  return `${tod}, thanks for calling ${name || "our office"}. How can I help you today?`;
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
    <Panel title="What it says" description="The first thing callers hear, and the rules it follows after that.">
      <Field
        label="Greeting"
        optional
        hint={
          greeting
            ? "Spoken exactly as written — nothing is added in front of it."
            : `Left blank, we'll open with: “${autoGreetingPreview(value.name)}” — the time of day updates itself. Type your own to replace it.`
        }
        count={greeting.length}
        max={500}
      >
        {(p) => (
          <textarea
            {...p}
            value={greeting}
            maxLength={500}
            rows={4}
            onChange={(e) => onChange({ greeting: e.target.value })}
            placeholder="Leave blank to use the default greeting"
          />
        )}
      </Field>

      <Field
        label="Tone of voice"
        hint="Picking one writes a single tone line at the top of your house rules below, replacing any tone line already there."
      >
        {(p) => (
          <select {...p} value={presetKey} onChange={(e) => applyPreset(e.target.value)}>
            <option value="">No set tone</option>
            {PERSONALITY_PRESETS.map((preset) => (
              <option key={preset.key} value={preset.key}>
                {preset.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field
        label="House rules"
        optional
        hint="Things your receptionist should always know. Written as instructions, one per line."
        count={customInstructions.length}
        max={2000}
      >
        {(p) => (
          <textarea
            {...p}
            value={customInstructions}
            maxLength={2000}
            rows={6}
            onChange={(e) => onChange({ custom_instructions: e.target.value })}
            placeholder={"e.g. We don't do same-day appointments.\nAlways ask whether they've been in before."}
          />
        )}
      </Field>
    </Panel>
  );
}
