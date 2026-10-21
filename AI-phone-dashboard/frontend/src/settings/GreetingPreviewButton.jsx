import { useEffect, useRef, useState } from "react";
import { api } from "../api";

const GENERIC_ERROR = "Couldn't play the greeting. Try again in a minute.";

// With responseType "blob" an error body arrives as a Blob too, so the
// server's message has to be read back out of it.
async function errorText(err) {
  const data = err?.response?.data;
  try {
    if (data && typeof data === "object" && typeof data.error === "string") return data.error;
    if (data && typeof data.text === "function") {
      const parsed = JSON.parse(await data.text());
      if (typeof parsed?.error === "string" && parsed.error) return parsed.error;
    }
  } catch {
    /* fall through to the generic message */
  }
  return GENERIC_ERROR;
}

/**
 * "Hear greeting": plays the exact recording callers get at pickup.
 *
 * The recording is made from what is SAVED, so while there are unsaved edits
 * to anything it depends on the button is off and says why -- playing the old
 * recording next to freshly edited text would be a quiet lie.
 */
export default function GreetingPreviewButton({ businessId, previewDirty = false, hint }) {
  const [state, setState] = useState("idle"); // idle | loading | playing | error
  const [message, setMessage] = useState("");
  const audioRef = useRef(null);
  const urlRef = useRef(null);
  const aliveRef = useRef(true);

  const release = () => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      try {
        audio.pause();
      } catch {
        /* nothing to pause */
      }
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  };

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      release();
    };
  }, []);

  const finish = (next, text = "") => {
    release();
    if (!aliveRef.current) return;
    setMessage(text);
    setState(next);
  };

  const stop = () => finish("idle");

  const play = async () => {
    setMessage("");
    setState("loading");
    try {
      const res = await api.get(`/api/business/${businessId}/greeting-clip`, { responseType: "blob" });
      if (!aliveRef.current) return;
      const url = URL.createObjectURL(res.data);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => finish("idle");
      audio.onerror = () => finish("error", GENERIC_ERROR);
      await audio.play();
      if (aliveRef.current && audioRef.current === audio) setState("playing");
    } catch (err) {
      const text = urlRef.current ? GENERIC_ERROR : await errorText(err);
      finish("error", text);
    }
  };

  const loading = state === "loading";
  const playing = state === "playing";

  let status = "";
  if (loading) status = "Making the recording…";
  else if (state === "error") status = message;
  else if (previewDirty) status = "Save your changes to hear them.";
  else if (hint) status = hint;

  return (
    <div className="set-preview">
      <button
        type="button"
        className="set-btn set-btn-sm"
        onClick={playing ? stop : play}
        disabled={loading || (previewDirty && !playing)}
      >
        {playing ? "■ Stop" : "▶ Hear greeting"}
      </button>
      <p
        className={state === "error" ? "set-field-error set-preview-status" : "set-hint set-preview-status"}
        role={state === "error" ? "alert" : undefined}
        aria-live="polite"
      >
        {status}
      </p>
    </div>
  );
}
