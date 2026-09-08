import { useCallback, useEffect, useState } from "react";
import { findActiveWordIndex } from "../components/transcriptIndex.js";

/**
 * Follow an <audio> element and report which transcript word is being spoken.
 *
 * `timeupdate` fires about four times a second, which is too coarse to light
 * words as they are said, so while the audio plays a requestAnimationFrame
 * loop reads `currentTime` and updates React state only when the active word
 * (or the displayed second) changes. rAF is paused in background tabs, so
 * `timeupdate` stays wired as the fallback there.
 */
export function useAudioClock(audioRef, words) {
  const [state, setState] = useState({
    playing: false,
    currentTime: 0,
    duration: NaN,
    activeIndex: -1,
  });

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;

    let raf = 0;
    let lastIndex = -1;
    let lastSecond = -1;

    const update = (hint) => {
      const t = audio.currentTime || 0;
      const idx = findActiveWordIndex(words, t, hint);
      const sec = Math.floor(t);
      if (idx !== lastIndex || sec !== lastSecond) {
        lastIndex = idx;
        lastSecond = sec;
        setState((s) => ({ ...s, currentTime: t, activeIndex: idx }));
      }
    };

    const loop = () => {
      update(lastIndex);
      if (!audio.paused && !audio.ended) raf = requestAnimationFrame(loop);
    };

    const onPlay = () => {
      setState((s) => ({ ...s, playing: true }));
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    };
    const onPause = () => {
      cancelAnimationFrame(raf);
      setState((s) => ({ ...s, playing: false }));
      update(lastIndex);
    };
    const onEnded = () => {
      cancelAnimationFrame(raf);
      lastIndex = -1;
      setState((s) => ({ ...s, playing: false, activeIndex: -1 }));
    };
    const onSeeked = () => {
      lastIndex = -1;
      update(-1);
    };
    const onDuration = () => {
      setState((s) => ({ ...s, duration: audio.duration }));
    };
    const onTimeUpdate = () => {
      if (typeof document !== "undefined" && document.hidden) update(lastIndex);
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("seeked", onSeeked);
    audio.addEventListener("loadedmetadata", onDuration);
    audio.addEventListener("durationchange", onDuration);
    audio.addEventListener("timeupdate", onTimeUpdate);

    if (Number.isFinite(audio.duration)) onDuration();

    return () => {
      cancelAnimationFrame(raf);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("seeked", onSeeked);
      audio.removeEventListener("loadedmetadata", onDuration);
      audio.removeEventListener("durationchange", onDuration);
      audio.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [audioRef, words]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      const p = audio.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } else {
      audio.pause();
    }
  }, [audioRef]);

  const seek = useCallback(
    (t) => {
      const audio = audioRef.current;
      if (!audio || !Number.isFinite(t)) return;
      audio.currentTime = Math.max(0, t);
    },
    [audioRef]
  );

  return { ...state, toggle, seek };
}
