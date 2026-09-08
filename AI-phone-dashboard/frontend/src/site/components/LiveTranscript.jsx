import { memo, useEffect, useRef, useState } from "react";
import { turnIndexForWord } from "./transcriptIndex.js";

const FOLLOW_PAUSE_MS = 4000;

const TranscriptTurn = memo(function TranscriptTurn({ words, turn, label, activeIndex, onSeek, isActiveTurn }) {
  // activeIndex arrives clamped to this turn (-1 when the speaker is elsewhere),
  // so a turn only re-renders when the highlight is inside it.
  const onClick = (e) => {
    const span = e.target.closest("[data-i]");
    if (!span) return;
    const i = Number(span.getAttribute("data-i"));
    if (Number.isFinite(i) && words[i]) onSeek(words[i].start);
  };

  const spans = [];
  for (let i = turn.from; i < turn.to; i++) {
    const cls =
      i === activeIndex ? "tx-word is-active" : activeIndex > i ? "tx-word is-past" : "tx-word";
    spans.push(
      <span key={i} data-i={i} className={cls}>
        {words[i].w}
      </span>
    );
    if (i < turn.to - 1) spans.push(" ");
  }

  return (
    <div className={`tx-turn site-row ${isActiveTurn ? "is-current" : ""}`.trim()} data-turn>
      <div className="site-row__margin tx-turn__who">{label}</div>
      {/* One handler per turn; the spans carry the index. */}
      <p className="site-row__entry tx-turn__words" onClick={onClick}>
        {spans}
      </p>
    </div>
  );
});

/**
 * The transcript as ruled diary rows: speaker in the margin, words on the
 * line, the spoken word lit. Clicking a word seeks the audio to it. The pane
 * follows the active turn while playing and stops following for a few
 * seconds when the reader scrolls it themselves.
 */
export default function LiveTranscript({ words, turns, speakers, activeIndex, playing, onSeek }) {
  const regionRef = useRef(null);
  const [followPaused, setFollowPaused] = useState(false);
  const pauseTimer = useRef(0);

  const activeTurn = turnIndexForWord(turns, activeIndex);

  // Follow: scroll only the region, never the page.
  useEffect(() => {
    if (followPaused || activeTurn < 0) return;
    const region = regionRef.current;
    if (!region) return;
    const el = region.querySelectorAll("[data-turn]")[activeTurn];
    if (!el) return;
    const top = el.offsetTop - region.offsetTop - 12;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof region.scrollTo === "function") {
      region.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
    } else {
      region.scrollTop = top;
    }
  }, [activeTurn, followPaused]);

  const pauseFollow = () => {
    setFollowPaused(true);
    clearTimeout(pauseTimer.current);
    pauseTimer.current = setTimeout(() => setFollowPaused(false), FOLLOW_PAUSE_MS);
  };

  useEffect(() => () => clearTimeout(pauseTimer.current), []);

  return (
    <div className="tx">
      <div
        className="tx__region"
        ref={regionRef}
        role="region"
        aria-label="Call transcript"
        onWheel={pauseFollow}
        onTouchMove={pauseFollow}
      >
        {turns.map((turn, k) => (
          <TranscriptTurn
            key={turn.from}
            words={words}
            turn={turn}
            label={speakers[String(turn.speaker)] || `Speaker ${turn.speaker + 1}`}
            activeIndex={activeIndex >= turn.from && activeIndex < turn.to ? activeIndex : activeIndex >= turn.to ? Infinity : -1}
            isActiveTurn={k === activeTurn}
            onSeek={onSeek}
          />
        ))}
      </div>
      {followPaused && playing ? (
        <button
          type="button"
          className="tx__follow"
          onClick={() => {
            clearTimeout(pauseTimer.current);
            setFollowPaused(false);
          }}
        >
          Follow the call
        </button>
      ) : null}
    </div>
  );
}
