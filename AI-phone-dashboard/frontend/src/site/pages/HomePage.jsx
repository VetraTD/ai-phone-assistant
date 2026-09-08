import { useRef } from "react";
import { usePageMeta } from "../usePageMeta.js";
import { useAudioClock } from "../hooks/useAudioClock.js";
import { DEMO_CALL } from "../content/demoCall.js";
import { GO_LIVE } from "../content/siteConfig.js";
import SiteButton from "../components/SiteButton.jsx";
import CallPlayer from "../components/CallPlayer.jsx";
import DiaryPage from "../components/DiaryPage.jsx";
import "./HomePage.css";

export default function HomePage() {
  usePageMeta({
    title: null,
    description:
      "Vetra answers your business's phone calls, books appointments in your own diary, takes messages and writes down every call. Set up with you by hand.",
    path: "/",
  });

  const audioRef = useRef(null);
  const clock = useAudioClock(audioRef, DEMO_CALL.transcript.words);

  return (
    <>
      <section className="hero site-section" aria-labelledby="hero-title">
        <div className="site-container hero__grid">
          <div className="hero__copy">
            <h1 id="hero-title" className="site-h1 hero__title site-rise">
              A receptionist that answers your phone and keeps your diary.
            </h1>
            <p className="site-lead hero__lead site-rise site-rise--2">
              Vetra takes the calls you can’t. It books, moves and cancels appointments in your own
              book, takes messages, and writes down everything that was said. We set it up with you,
              and you are {GO_LIVE}.
            </p>
            <div className="hero__cta site-rise site-rise--3">
              <SiteButton to="/contact">Request access</SiteButton>
            </div>
          </div>

          <div className="hero__player site-rise site-rise--4" id="call">
            <CallPlayer audioRef={audioRef} clock={clock} call={DEMO_CALL} />
          </div>

          <div className="hero__diary site-rise site-rise--4">
            <DiaryPage currentTime={clock.currentTime} call={DEMO_CALL} />
          </div>
        </div>
      </section>
    </>
  );
}
