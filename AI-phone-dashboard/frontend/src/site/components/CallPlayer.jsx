import { Pause, Play } from "lucide-react";
import LiveTranscript from "./LiveTranscript.jsx";
import { formatClock } from "./transcriptIndex.js";
import "./CallPlayer.css";

/**
 * The real demo call: a ruled page whose rows are the transcript, with the
 * player's controls on the bottom rule. The parent owns the <audio> ref and
 * the clock (from useAudioClock) so the diary page beside it can react to the
 * same time.
 */
export default function CallPlayer({ audioRef, clock, call }) {
  const { transcript } = call;
  const { playing, currentTime, duration, activeIndex, toggle, seek } = clock;
  const hasDuration = Number.isFinite(duration) && duration > 0;

  return (
    <div className="player site-page">
      <div className="player__head site-row">
        <div className="site-row__margin player__label">Call</div>
        <div className="site-row__entry player__meta">
          <span className={`player__dot ${playing ? "is-live" : ""}`.trim()} aria-hidden="true" />
          <span className="player__clinic">{call.clinic}</span>
          <span className="player__context site-muted">{call.context}</span>
        </div>
      </div>

      <LiveTranscript
        words={transcript.words}
        turns={transcript.turns}
        speakers={transcript.speakers}
        activeIndex={activeIndex}
        playing={playing}
        onSeek={seek}
      />

      <div className="player__controls">
        <button
          type="button"
          className="player__toggle"
          onClick={toggle}
          aria-label={playing ? "Pause the call" : "Play the call"}
        >
          {playing ? (
            <Pause size={20} strokeWidth={2.2} aria-hidden="true" />
          ) : (
            <Play size={20} strokeWidth={2.2} aria-hidden="true" />
          )}
        </button>
        <input
          type="range"
          className="player__scrub"
          min={0}
          max={hasDuration ? duration : 0}
          step={0.1}
          value={Math.min(currentTime, hasDuration ? duration : 0)}
          disabled={!hasDuration}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Position in the call"
          aria-valuetext={`${formatClock(currentTime)} of ${formatClock(duration)}`}
        />
        <span className="player__time site-tabular">
          {formatClock(currentTime)} / {formatClock(duration)}
        </span>
      </div>

      <audio ref={audioRef} src={transcript.source} preload="metadata" />
    </div>
  );
}
