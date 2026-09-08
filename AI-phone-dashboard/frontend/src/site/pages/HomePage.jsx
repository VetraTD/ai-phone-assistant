import { useRef } from "react";
import { usePageMeta } from "../usePageMeta.js";
import { useAudioClock } from "../hooks/useAudioClock.js";
import { DEMO_CALL } from "../content/demoCall.js";
import { GO_LIVE, HOSTING_REGION, LANGUAGES } from "../content/siteConfig.js";
import SiteButton from "../components/SiteButton.jsx";
import CallPlayer from "../components/CallPlayer.jsx";
import DiaryPage from "../components/DiaryPage.jsx";
import CallMoments from "../components/CallMoments.jsx";
import SetupDays from "../components/SetupDays.jsx";
import CallRecord from "../components/CallRecord.jsx";
import FaqList from "../components/FaqList.jsx";
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

  // "Hear it" on a moment: jump the call there, start it, bring the player into view.
  const hear = (t) => {
    clock.seek(t);
    const audio = audioRef.current;
    if (audio && audio.paused) {
      const p = audio.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
    const target = document.getElementById("call");
    if (target) {
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    }
  };

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

          <div className="hero__player site-anchor site-rise site-rise--4" id="call">
            <CallPlayer audioRef={audioRef} clock={clock} call={DEMO_CALL} />
          </div>

          <div className="hero__diary site-rise site-rise--4">
            <DiaryPage currentTime={clock.currentTime} call={DEMO_CALL} />
          </div>
        </div>
      </section>

      <section className="site-section site-section--tint site-anchor" id="on-a-call" aria-labelledby="moments-title">
        <div className="site-container home__split">
          <div className="home__split-head">
            <h2 id="moments-title" className="site-h2">
              What happened on that call
            </h2>
            <p className="site-lead">
              Minute by minute. The words are the receptionist’s own; nothing has been rewritten.
            </p>
          </div>
          <div className="home__split-body">
            <CallMoments onHear={hear} />
          </div>
        </div>
      </section>

      <section className="site-section site-anchor" id="set-up" aria-labelledby="setup-title">
        <div className="site-container">
          <div className="home__head">
            <h2 id="setup-title" className="site-h2">
              Set up with you. Live in three business days.
            </h2>
            <p className="site-lead">
              There is no sign-up form and nothing for you to configure alone. We do it together, then
              you go live.
            </p>
          </div>
          <SetupDays />
        </div>
      </section>

      <section className="site-section site-section--tint site-anchor" id="afterwards" aria-labelledby="record-title">
        <div className="site-container home__split">
          <div className="home__split-head">
            <h2 id="record-title" className="site-h2">
              What you see afterwards
            </h2>
            <p className="site-lead">
              Every call leaves a written record in your dashboard. This is the record for the call
              above; the summary line is an example of what the receptionist writes.
            </p>
          </div>
          <div className="home__split-body">
            <CallRecord />
          </div>
        </div>
      </section>

      <section className="site-section site-anchor" id="who" aria-labelledby="who-title">
        <div className="site-container home__who">
          <h2 id="who-title" className="site-h2">
            Who it is for
          </h2>
          <div className="home__who-text">
            <p className="site-p">
              UK businesses that take bookings and calls all day: dental and medical practices, trades,
              salons, small law firms. Anywhere the phone rings while you are with someone else.
            </p>
            <p className="site-p">
              Vetra speaks {LANGUAGES.slice(0, -1).join(", ")} and {LANGUAGES[LANGUAGES.length - 1]},
              with a choice of voices. Data is hosted in {HOSTING_REGION}. UK first; the United States
              follows.
            </p>
          </div>
        </div>
      </section>

      <section className="site-section site-section--tint site-anchor" id="questions" aria-labelledby="faq-title">
        <div className="site-container home__split">
          <div className="home__split-head">
            <h2 id="faq-title" className="site-h2">
              Questions
            </h2>
            <p className="site-lead">
              Anything else, ask us directly when you request access.
            </p>
          </div>
          <div className="home__split-body">
            <FaqList />
          </div>
        </div>
      </section>

      <section className="site-section site-section--ink closing" aria-labelledby="closing-title">
        <div className="site-container closing__inner">
          <h2 id="closing-title" className="site-h2 closing__title">
            Stop losing calls.
          </h2>
          <p className="closing__lead">
            Tell us about your business. We set it up with you, and you are {GO_LIVE}.
          </p>
          <SiteButton to="/contact" variant="on-ink">
            Request access
          </SiteButton>
        </div>
      </section>
    </>
  );
}
