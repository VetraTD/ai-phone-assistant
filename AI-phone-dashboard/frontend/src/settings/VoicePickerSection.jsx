import { useEffect, useState } from "react";
import { api } from "../api";
import SectionCard from "./SectionCard";

// Cards driven by GET /api/voices (added in this task, mirrors root repo
// config/voices.js — see routes/settings.js). Selecting a card sets
// voice_provider + voice_id; the "Default (Google)" option sets
// voice_provider="google" and clears voice_id, matching
// lib/voice/session.js resolveVoice()'s voice_provider="google" branch
// (skips ElevenLabs entirely). Audio preview is out of scope — there's no
// synth endpoint yet (Phase 5 candidate per the brief) — so cards show
// descriptive text instead.
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

  const provider = value.voice_provider;

  const cardStyle = (active) => ({
    cursor: "pointer",
    borderColor: active ? "var(--vetra-blue)" : undefined,
    boxShadow: active ? "0 0 0 2px rgba(58,143,242,0.18)" : undefined,
  });

  return (
    <SectionCard
      title="Voice"
      description="Choose the voice callers hear. Audio preview isn't available yet — descriptions below give a sense of tone."
    >
      <div
        className="sub-card"
        style={cardStyle(provider === "google")}
        role="button"
        tabIndex={0}
        onClick={() => onChange({ voice_provider: "google", voice_id: "" })}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onChange({ voice_provider: "google", voice_id: "" });
        }}
      >
        <div className="sub-card-title">Default (Google) {provider === "google" ? "· Selected" : ""}</div>
        <div className="detail-block-text">Standard neutral voice — no ElevenLabs voice selected.</div>
      </div>

      {loading ? (
        <div className="empty-note">Loading voices…</div>
      ) : error ? (
        <div className="empty-note">{error}</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
          {catalog.map((voice) => {
            const active = provider === "elevenlabs" && value.voice_id === voice.voiceId;
            return (
              <div
                key={voice.id}
                className="sub-card"
                style={cardStyle(active)}
                role="button"
                tabIndex={0}
                onClick={() => onChange({ voice_provider: "elevenlabs", voice_id: voice.voiceId })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    onChange({ voice_provider: "elevenlabs", voice_id: voice.voiceId });
                  }
                }}
              >
                <div className="sub-card-title">
                  {voice.label} {active ? "· Selected" : ""}
                </div>
                <div className="detail-block-text">{voice.description}</div>
                <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span className="call-pill">{voice.gender}</span>
                  <span className="call-pill">{voice.accent}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}
