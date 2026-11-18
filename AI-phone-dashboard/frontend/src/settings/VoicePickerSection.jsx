import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { api } from "../api";
import Panel from "./Panel";
import ChoiceCards from "./ChoiceCards";

// ---------------------------------------------------------------------------
// The voice callers hear — from whichever front-end is actually answering.
//
// THIS PANEL WAS WIRED TO NOTHING (LVX84). It wrote voice_provider and
// voice_id, which are ElevenLabs settings that only the cascade reads. Every
// production call is served by the Live front-end, which reads
// businesses.live_voice and businesses.locale — so a business could pick a
// voice, watch it save, reload and see it selected, and hear exactly the same
// call as before. A control that appears to work is worse than a missing one.
//
// Which front-end is serving is a DEPLOYMENT fact, not a derivable one: it is
// decided by the Twilio number's voiceUrl, which lives at Twilio. The backend
// declares it on /api/live-voices and this renders whichever set is real.
//
// Still no audio preview on either path. On the Live side that gap is sharper
// than it looks — see the note rendered beside the voice list.
// ---------------------------------------------------------------------------
const GOOGLE_VALUE = "google";
const DEFAULT_VOICE = "";

export default function VoicePickerSection({ value, onChange }) {
  const [catalog, setCatalog] = useState([]);
  const [live, setLive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api.get("/api/voices").then((res) => (Array.isArray(res.data) ? res.data : [])),
      api.get("/api/live-voices").then((res) => res.data),
    ])
      .then(([voices, liveData]) => {
        setCatalog(voices);
        setLive(liveData);
      })
      .catch((err) => setError(err?.response?.data?.error || "Failed to load voice catalog"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Panel title="Voice" description="The voice callers hear.">
        <p className="set-hint">Loading voices…</p>
      </Panel>
    );
  }

  if (error) {
    return (
      <Panel title="Voice" description="The voice callers hear.">
        <p className="set-alert set-alert-error" role="alert">
          <TriangleAlert className="set-alert-icon" size={16} aria-hidden="true" />
          <span>{error}</span>
        </p>
      </Panel>
    );
  }

  return live?.frontend === "cascade" ? (
    <CascadeVoice value={value} onChange={onChange} catalog={catalog} />
  ) : (
    <LiveVoice value={value} onChange={onChange} live={live} />
  );
}

// ---------------------------------------------------------------------------
// The Live front-end: a Gemini prebuilt voice, and the accent it holds.
// ---------------------------------------------------------------------------
function LiveVoice({ value, onChange, live }) {
  const voices = live?.voices || [];
  const locales = live?.locales || [];

  const selectedVoice = value.live_voice || DEFAULT_VOICE;
  const selectedLocale = value.locale || "";

  const voiceOptions = [
    {
      value: DEFAULT_VOICE,
      title: "Use the default for this language",
      desc: "Whatever we currently consider the best match for the accent below. Changes when we find a better one.",
    },
    ...voices.map((v) => ({
      value: v.name,
      title: v.label,
      // The evidence IS the description. There is nothing else honest to put
      // here: nobody can hear these from this page.
      desc: v.evidence,
    })),
  ];

  const localeOptions = [
    // ALWAYS PRESENT, including once an accent has been chosen. NULL is a real
    // setting here -- migration 025 defines it as "derive from your phone
    // number's country" -- and it is the right one for most tenants. An option
    // that vanishes the moment you pick something else is a one-way door.
    {
      value: "",
      title: "Work it out automatically",
      desc: "Chosen from your phone number's country. Right for most businesses.",
    },
    ...locales.map((l) => ({
      value: l.id,
      title: l.label,
      desc: l.description,
    })),
  ];

  const selectedVoiceLabel = voiceOptions.find((o) => o.value === selectedVoice)?.title;

  return (
    <>
      <Panel
        title="Accent and language"
        description="What your receptionist speaks, and how it says dates and phone numbers. Set this before picking a voice — the default voice follows it."
      >
        <ChoiceCards
          legend="Choose an accent"
          name="locale"
          options={localeOptions}
          value={selectedLocale}
          // Empty string, not null. The snapshot baseline holds "" for an
          // unset locale, so sending null here would make "no change" read as
          // a change on every save. The backend maps "" to NULL.
          onChange={(next) => onChange({ locale: next })}
        />
      </Panel>

      <Panel
        title="Voice"
        description="The voice callers hear."
        badge={selectedVoiceLabel ? <span className="set-pill">{selectedVoiceLabel}</span> : null}
      >
        {/*
          A DELIBERATELY UNFLATTERING NOTE, and it belongs in the product rather
          than in a comment. These five are a shortlist we rendered to audio
          files and compared, not a vendor catalogue — and a file is 24 kHz
          while a phone call is 8 kHz and throws away everything above about
          3.4 kHz, which is where a lot of what makes a voice pleasant lives.
          Two of them have already been picked from the files and then
          disappointed on a real call. Saying so is what stops that happening a
          third time.
        */}
        <p className="set-hint">
          There's no preview here, and a preview would only half help: these were compared as
          audio files, and a phone line strips out much of what makes a voice sound good. The notes
          below say what each one has actually done on a real call.
        </p>
        <ChoiceCards
          legend="Choose a voice"
          name="live_voice"
          options={voiceOptions}
          value={selectedVoice}
          onChange={(next) => onChange({ live_voice: next })}
        />
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------------------
// The cascade front-end: an ElevenLabs voice, or the plain Google fallback.
//
// Kept whole rather than deleted. The cascade still exists, is still tested,
// and is still what a stack with LIVE_SURFACE unset would run.
// ---------------------------------------------------------------------------
function CascadeVoice({ value, onChange, catalog }) {
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
      <ChoiceCards
        legend="Choose a voice"
        name="voice"
        options={options}
        value={selected}
        onChange={handleChange}
      />
    </Panel>
  );
}
