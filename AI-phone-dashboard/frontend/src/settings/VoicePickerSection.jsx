import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { api } from "../api";
import Panel from "./Panel";
import ChoiceCards from "./ChoiceCards";

// Cards driven by GET /api/voices (added in this task, mirrors root repo
// config/voices.js — see routes/settings.js). Selecting a card sets
// voice_provider + voice_id; the "Default (Google)" option sets
// voice_provider="google" and clears voice_id, matching
// lib/voice/session.js resolveVoice()'s voice_provider="google" branch
// (skips ElevenLabs entirely). Audio preview is out of scope — there's no
// synth endpoint yet (Phase 5 candidate per the brief) — so cards show
// descriptive text instead.
//
// The cards used to be `<div role="button" tabIndex={0}>`, which is not a way
// to pick one of eight things: no aria-checked, no arrow keys, and a screen
// reader announcing nine unrelated buttons. ChoiceCards renders real radios in
// a real fieldset. The two emitted fields are unchanged.
const GOOGLE_VALUE = "google";

export default function VoicePickerSection({ value, onChange }) {
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get("/api/voices")
      .then((res) => setCatalog(Array.isArray(res.data) ? res.data : []))
      .catch((err) => setError(err?.response?.data?.error || "Failed to load voice catalog"))
      .finally(() => setLoading(false));
  }, []);

  const selected = value.voice_provider === "google" ? GOOGLE_VALUE : value.voice_id || GOOGLE_VALUE;

  const options = [
    // Natural (ElevenLabs) voices first — these are what almost everyone wants.
    ...catalog.map((voice) => ({
      value: voice.voiceId,
      title: voice.label,
      desc: voice.description,
      tags: [voice.gender, voice.accent].filter(Boolean),
    })),
    // The plain fallback goes last, framed honestly as the basic option.
    {
      value: GOOGLE_VALUE,
      title: "Basic voice",
      desc: "A plainer, less lifelike fallback. Fine in a pinch, but most businesses pick one of the natural voices above.",
    },
  ];

  const handleChange = (next) => {
    if (next === GOOGLE_VALUE) onChange({ voice_provider: "google", voice_id: "" });
    else onChange({ voice_provider: "elevenlabs", voice_id: next });
  };

  const selectedLabel = options.find((o) => o.value === selected)?.title;

  return (
    <Panel
      title="Voice"
      description="The voice callers hear. There's no audio preview yet, so the descriptions are your guide."
      badge={selectedLabel ? <span className="set-pill">{selectedLabel}</span> : null}
    >
      {loading ? (
        <p className="set-hint">Loading voices…</p>
      ) : error ? (
        <p className="set-alert set-alert-error" role="alert">
          <TriangleAlert className="set-alert-icon" size={16} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : (
        <ChoiceCards
          legend="Choose a voice"
          name="voice"
          options={options}
          value={selected}
          onChange={handleChange}
        />
      )}
    </Panel>
  );
}
