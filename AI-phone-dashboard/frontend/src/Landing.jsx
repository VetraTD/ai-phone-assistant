import { Link } from "react-router-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BatteryFull,
  CalendarX,
  Check,
  Pause,
  PhoneCall,
  PhoneMissed,
  PhoneOff,
  Play,
  Signal,
  Voicemail,
  Wifi,
} from "lucide-react";
import VetraLogo from "./components/VetraLogo";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { LANDING_TRANSLATIONS, useLandingTranslations } from "./landingTranslations";
import "./Landing.css";

const BRAND_NAME = "VetraTD";
const DEMO_NUMBER = "+1 (817) 601-1171";
const DEMO_TEL = `tel:${DEMO_NUMBER.replace(/[^\d+]/g, "")}`;

// Shared with the dashboard so a visitor's language choice carries over.
const LANG_STORAGE_KEY = "ui_lang";

const privacyOrigin =
  (import.meta.env.VITE_SITE_URL && String(import.meta.env.VITE_SITE_URL).replace(/\/$/, "")) ||
  (typeof window !== "undefined" ? window.location.origin : "https://vetratd.com");

function readInitialLang() {
  try {
    return localStorage.getItem(LANG_STORAGE_KEY) || "en";
  } catch {
    return "en";
  }
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function formatTime(seconds) {
  const total = Math.floor(seconds || 0);
  const mins = String(Math.floor(total / 60)).padStart(2, "0");
  const secs = String(total % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

/** One <audio> element drives both the hero phone and the "hear a real
 * call" player, so pressing play in one place is reflected in the other. */
function useDemoAudio(audioRef) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => setElapsed(audio.currentTime);
    const onDuration = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      setElapsed(0);
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onDuration);
    audio.addEventListener("durationchange", onDuration);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onDuration);
      audio.removeEventListener("durationchange", onDuration);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [audioRef]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, [audioRef]);

  return { isPlaying, elapsed, duration, toggle };
}

/** Adds .is-visible to every [data-reveal] element as it scrolls into view. */
function useReveal(rootRef) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll("[data-reveal]"));

    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
      els.forEach((el) => el.classList.add("is-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [rootRef]);
}

function HeroPhone({ demo, t }) {
  const { isPlaying, elapsed, toggle } = demo;

  return (
    <div className="lp-phone">
      <div className="lp-phone-frame">
        <span className="lp-phone-island" aria-hidden="true" />
        <div className="lp-phone-screen">
          <div className="lp-phone-status" aria-hidden="true">
            <span>9:41</span>
            <span className="lp-phone-status-icons">
              <Signal size={13} strokeWidth={2.4} />
              <Wifi size={13} strokeWidth={2.4} />
              <BatteryFull size={17} strokeWidth={2} />
            </span>
          </div>

          <div className="lp-phone-call">
            <div className={`lp-phone-avatar ${isPlaying ? "is-live" : ""}`} aria-hidden="true">
              <img src="/vetra-mark.png" alt="" width={84} height={84} draggable={false} />
            </div>
            <div className="lp-phone-name">Vetra</div>
            {isPlaying ? (
              <div className="lp-phone-live">
                <span className="lp-phone-eq" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <span className="lp-phone-time">{formatTime(elapsed)}</span>
              </div>
            ) : (
              <div className="lp-phone-sub">
                {elapsed > 0 ? `${t.phonePaused} · ${formatTime(elapsed)}` : t.phoneCalling}
              </div>
            )}
          </div>

          <div className="lp-phone-action">
            <button
              type="button"
              className={`lp-phone-button ${isPlaying ? "is-playing" : ""}`}
              onClick={toggle}
              aria-label={isPlaying ? t.pauseDemo : t.playDemo}
            >
              {isPlaying ? (
                <Pause size={26} strokeWidth={2.4} />
              ) : (
                <PhoneCall size={26} strokeWidth={2.4} />
              )}
            </button>
            <span className="lp-phone-action-label">
              {isPlaying ? t.phonePlaying : t.phoneTapToPlay}
            </span>
          </div>

          <span className="lp-phone-home" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

const PROBLEM_NOTIFICATIONS = [
  { key: "notifMissed", icon: PhoneMissed, className: "lp-notif-1" },
  { key: "notifVoicemail", icon: Voicemail, className: "lp-notif-2" },
  { key: "notifBooking", icon: CalendarX, className: "lp-notif-3" },
  { key: "notifNoAnswer", icon: PhoneOff, className: "lp-notif-4" },
];

function HeroStage({ demo, t }) {
  return (
    <div className="lp-stage">
      <div className="lp-stage-noise" aria-hidden="true">
        {PROBLEM_NOTIFICATIONS.map((n) => {
          const Icon = n.icon;
          return (
            <div key={n.key} className={`lp-notif ${n.className}`}>
              <span className="lp-notif-icon">
                <Icon size={16} strokeWidth={2.2} />
              </span>
              {t[n.key]}
            </div>
          );
        })}
      </div>

      <HeroPhone demo={demo} t={t} />

      <AnsweredCard items={t.answeredItems} label={t.answeredLabel} />
    </div>
  );
}

const ANSWERED_ROTATE_MS = 3800;

/** The sharp card in front of the phone. Cycles through things Vetra
 * handles; pauses on hover/focus and stays on the first item when the
 * visitor prefers reduced motion. */
function AnsweredCard({ items, label }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || items.length < 2 || prefersReducedMotion()) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % items.length), ANSWERED_ROTATE_MS);
    return () => clearInterval(id);
  }, [paused, items.length]);

  const item = items[index % items.length];

  return (
    <div
      className="lp-answered"
      role="group"
      aria-label={label}
      tabIndex={0}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="lp-answered-icon" aria-hidden="true">
        <Check size={16} strokeWidth={3} />
      </span>
      <div key={index} className="lp-answered-body">
        <div className="lp-answered-top">
          <strong>{item.title}</strong>
          <span className="lp-answered-time">{item.time}</span>
        </div>
        <span className="lp-answered-detail">{item.detail}</span>
      </div>
      <span className="lp-answered-dots" aria-hidden="true">
        {items.map((it, i) => (
          <i key={it.title} className={i === index % items.length ? "is-active" : ""} />
        ))}
      </span>
    </div>
  );
}

/** Small illustrative UI fragment shown beside each feature. Example data
 * only, labelled as such, never presented as real customer numbers. */
function FeatureFragment({ id, t }) {
  if (id === "forward") {
    return (
      <div className="lp-frag">
        <span className="lp-frag-label">{t.fragFwdLabel}</span>
        <span className="lp-frag-muted lp-frag-inline">
          <PhoneMissed size={14} strokeWidth={2.4} aria-hidden="true" />
          {t.fragFwdRang}
        </span>
        <div className="lp-frag-row">
          <span className="lp-frag-strong">{t.fragFwdPicked}</span>
          <span className="lp-frag-pill">
            <Check size={12} strokeWidth={3} aria-hidden="true" />
          </span>
        </div>
      </div>
    );
  }
  if (id === "book") {
    return (
      <div className="lp-frag">
        <span className="lp-frag-label">{t.fragBookLabel}</span>
        <div className="lp-frag-row">
          <span className="lp-frag-strong">{t.fragBookWhen}</span>
          <span className="lp-frag-pill">
            <Check size={12} strokeWidth={3} aria-hidden="true" />
          </span>
        </div>
        <span className="lp-frag-muted">{t.fragBookWhat}</span>
      </div>
    );
  }
  if (id === "message") {
    return (
      <div className="lp-frag">
        <span className="lp-frag-label">{t.fragMsgLabel}</span>
        <span className="lp-frag-strong">{t.fragMsgName}</span>
        <span className="lp-frag-quote">{t.fragMsgBody}</span>
      </div>
    );
  }
  if (id === "transfer") {
    return (
      <div className="lp-frag">
        <span className="lp-frag-label">{t.fragXferLabel}</span>
        <span className="lp-frag-strong">{t.fragXferRule}</span>
        <span className="lp-frag-muted lp-frag-inline">
          <ArrowRight size={14} strokeWidth={2.4} aria-hidden="true" />
          {t.fragXferTo}
        </span>
      </div>
    );
  }
  return (
    <div className="lp-frag">
      <div className="lp-frag-row">
        <span className="lp-frag-label">{t.fragDashLabel}</span>
        <span className="lp-frag-mood">{t.fragDashMood}</span>
      </div>
      <span className="lp-frag-body">{t.fragDashBody}</span>
    </div>
  );
}

function ListenPlayer({ demo, t }) {
  const { isPlaying, elapsed, duration, toggle } = demo;
  const pct = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;

  return (
    <div className="lp-player">
      <button
        type="button"
        className="lp-player-button"
        onClick={toggle}
        aria-label={isPlaying ? t.pauseDemo : t.playDemo}
      >
        {isPlaying ? (
          <Pause size={28} strokeWidth={2.4} />
        ) : (
          <Play size={28} strokeWidth={2.4} className="lp-player-play-icon" />
        )}
      </button>
      <div className="lp-player-track" aria-hidden="true">
        <div className="lp-player-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="lp-player-time">
        {formatTime(elapsed)}
        {duration > 0 ? ` / ${formatTime(duration)}` : ""}
      </span>
    </div>
  );
}

export default function Landing() {
  const [lang, setLang] = useState(readInitialLang);
  const t = useLandingTranslations(lang);
  const audioRef = useRef(null);
  const demo = useDemoAudio(audioRef);
  const pageRef = useRef(null);
  useReveal(pageRef);

  useEffect(() => {
    document.documentElement.lang = LANDING_TRANSLATIONS[lang] ? lang : "en";
  }, [lang]);

  const handleLangChange = (code) => {
    setLang(code);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, code);
    } catch {
      // ignore private browsing / blocked storage
    }
  };

  const scrollToListen = (e) => {
    const target = document.getElementById("listen");
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  return (
    <div className="lp lp-dark" ref={pageRef}>
      <a href="#main" className="lp-skip">
        {t.skipToContent}
      </a>

      <header className="lp-header lp-dark">
        <div className="lp-header-inner">
          <VetraLogo to="/" className="lp-logo" name={BRAND_NAME} />
          <nav className="lp-nav" aria-label={t.mainNav}>
            <a href="#how-it-works">{t.navHow}</a>
            <a href="#features">{t.navFeatures}</a>
            <a href="#tailored">{t.navTailored}</a>
            <a href="#pricing">{t.navPricing}</a>
            <a href="#faq">{t.navFaq}</a>
          </nav>
          <div className="lp-header-actions">
            <LanguageSwitcher lang={lang} onChange={handleLangChange} />
            <Link to="/app" className="lp-header-login">
              {t.navLogin}
            </Link>
            <Link to="/app" className="lp-btn lp-btn-primary lp-btn-sm lp-header-cta">
              {t.getStarted}
            </Link>
          </div>
        </div>
      </header>

      <main id="main">
        <section className="lp-hero lp-dark">
          <div className="lp-hero-inner">
            <div className="lp-hero-copy">
              <h1 className="lp-hero-title">
                <span>{t.heroTitleA}</span> <span className="lp-hero-accent">{t.heroTitleB}</span>
              </h1>
              <p className="lp-hero-sub">{t.heroSub}</p>
              <div className="lp-hero-ctas">
                <Link to="/app" className="lp-btn lp-btn-primary">
                  {t.getStarted}
                </Link>
                <a href="#listen" className="lp-btn lp-btn-ghost" onClick={scrollToListen}>
                  <Play size={16} strokeWidth={2.6} aria-hidden="true" />
                  {t.heroListen}
                </a>
              </div>
              <p className="lp-hero-audience">{t.heroAudience}</p>
            </div>
            <HeroStage demo={demo} t={t} />
          </div>
        </section>

        <section className="lp-section lp-gap lp-dark" aria-labelledby="gap-title">
          <div className="lp-container">
            <h2 id="gap-title" className="lp-h2" data-reveal>
              {t.gapTitle}
            </h2>
            <ol className="lp-gap-list">
              {t.gapMoments.map((m) => (
                <li key={m.when} className="lp-gap-item" data-reveal>
                  <span className="lp-gap-when">{m.when}</span>
                  <span className="lp-gap-what">{m.what}</span>
                </li>
              ))}
            </ol>
            <p className="lp-gap-close" data-reveal>
              {t.gapClose}
            </p>
          </div>
        </section>

        <section id="how-it-works" className="lp-section lp-how" aria-labelledby="how-title">
          <div className="lp-container">
            <h2 id="how-title" className="lp-h2" data-reveal>
              {t.howTitle}
            </h2>
            <ol className="lp-steps">
              {t.howSteps.map((step, i) => (
                <li key={step.title} className="lp-step" data-reveal>
                  <span className="lp-step-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <h3 className="lp-h3">{step.title}</h3>
                  <p className="lp-body">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="features" className="lp-section lp-features" aria-labelledby="features-title">
          <div className="lp-container">
            <h2 id="features-title" className="lp-h2 lp-h2-narrow" data-reveal>
              {t.featuresTitle}
            </h2>
            <div className="lp-feature-list">
              {t.features.map((f) => (
                <article key={f.id} className="lp-feature" data-reveal>
                  <div className="lp-feature-copy">
                    <h3 className="lp-feature-title">{f.title}</h3>
                    <p className="lp-body">{f.body}</p>
                  </div>
                  <figure className="lp-feature-visual">
                    <FeatureFragment id={f.id} t={t} />
                    <figcaption className="lp-frag-example">{t.fragExample}</figcaption>
                  </figure>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="tailored" className="lp-section lp-tailored" aria-labelledby="tailored-title">
          <div className="lp-container lp-tailored-inner">
            <div className="lp-tailored-intro" data-reveal>
              <h2 id="tailored-title" className="lp-h2">
                {t.tailorTitle}
              </h2>
              <p className="lp-body lp-tailored-sub">{t.tailorSub}</p>
              <figure className="lp-greeting">
                <blockquote className="lp-greeting-quote">{t.tailorGreeting}</blockquote>
                <figcaption className="lp-greeting-note">{t.tailorGreetingNote}</figcaption>
              </figure>
            </div>
            <ul className="lp-tailored-list">
              {t.tailorItems.map((item) => (
                <li key={item.title} className="lp-tailored-item" data-reveal>
                  <h3 className="lp-h3">
                    {item.title}
                    {item.tag && <span className="lp-tag">{item.tag}</span>}
                  </h3>
                  <p className="lp-body">{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="listen"className="lp-section lp-listen lp-dark" aria-labelledby="listen-title">
          <div className="lp-container lp-listen-inner" data-reveal>
            <h2 id="listen-title" className="lp-h2">
              {t.listenTitle}
            </h2>
            <p className="lp-lead">{t.listenSub}</p>
            <ListenPlayer demo={demo} t={t} />
            <p className="lp-listen-or">
              {t.listenOr}{" "}
              <a href={DEMO_TEL} className="lp-listen-number">
                {DEMO_NUMBER}
              </a>
            </p>
          </div>
        </section>

        <section id="pricing" className="lp-section lp-pricing" aria-labelledby="pricing-title">
          <div className="lp-container lp-pricing-inner" data-reveal>
            <h2 id="pricing-title" className="lp-h2">
              {t.pricingTitle}
            </h2>
            <p className="lp-lead">{t.pricingSub}</p>
            <Link to="/contact" className="lp-btn lp-btn-primary">
              {t.pricingCta}
            </Link>
          </div>
        </section>

        <section id="faq" className="lp-section lp-faq" aria-labelledby="faq-title">
          <div className="lp-container lp-faq-inner">
            <h2 id="faq-title" className="lp-h2" data-reveal>
              {t.faqTitle}
            </h2>
            <div className="lp-faq-list" data-reveal>
              {t.faq.map((item) => (
                <details key={item.q} className="lp-faq-item">
                  <summary className="lp-faq-q">{item.q}</summary>
                  <p className="lp-faq-a">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-section lp-final lp-dark" aria-labelledby="final-title">
          <div className="lp-container lp-final-inner" data-reveal>
            <h2 id="final-title" className="lp-final-title">
              {t.ctaTitle}
            </h2>
            <p className="lp-lead">{t.ctaSub}</p>
            <div className="lp-final-ctas">
              <Link to="/app" className="lp-btn lp-btn-primary">
                {t.getStarted}
              </Link>
              <a href={DEMO_TEL} className="lp-btn lp-btn-ghost">
                {t.ctaDemo}
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer lp-dark">
        <div className="lp-footer-inner">
          <VetraLogo to="/" className="lp-logo vetra-logo-footer" name={BRAND_NAME} />
          <nav className="lp-footer-links" aria-label="Footer">
            <Link to="/app">{t.navLogin}</Link>
            <Link to="/contact">{t.footerContact}</Link>
            <a href={`${privacyOrigin}/legal`}>{t.footerPrivacy}</a>
            <Link to="/legal">{t.footerTerms}</Link>
            <a href={DEMO_TEL}>{DEMO_NUMBER}</a>
          </nav>
          <span className="lp-footer-copy">© {new Date().getFullYear()} {BRAND_NAME}</span>
        </div>
      </footer>

      <audio ref={audioRef}src="/vetra-demo-call.mp3" preload="metadata" />
    </div>
  );
}
