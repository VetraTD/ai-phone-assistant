import { Link } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import {
  Phone,
  PhoneCall,
  CalendarCheck,
  ClipboardList,
  FileText,
  MessageSquareText,
  Clock,
  LineChart,
  ShieldCheck,
  Hash,
  Inbox,
  LayoutDashboard,
  Signal,
  Wifi,
  BatteryFull,
  Pause,
  Check,
  ArrowUp,
  TrendingDown,
  Sparkles,
  Bell,
  Moon,
  Globe,
} from "lucide-react";
import VetraMark from "./components/VetraMark";
import VetraLogo from "./components/VetraLogo";
import {
  CURRENCY_SYMBOLS,
  COST_COMPARISON,
  LANDING_PLANS,
  ANNUAL_FREE_MONTHS,
  detectCurrencyFromLocale,
  formatLandingPrice,
  getDisplayPrice,
  getStoredCurrency,
  storeCurrency,
} from "./landingPricing.js";
import "./Landing.css";

const DEMO_NUMBER = "+1 (817) 601-1171";

function HeroPhone() {
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTime = () => setElapsed(audio.currentTime);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      setElapsed(0);
    };

    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, []);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  };

  const formatTime = (seconds) => {
    const total = Math.floor(seconds || 0);
    const mins = String(Math.floor(total / 60)).padStart(2, "0");
    const secs = String(total % 60).padStart(2, "0");
    return `${mins}:${secs}`;
  };

  return (
    <div className="hero-phone">
      <div className="hero-phone-frame">
        <span className="hero-phone-island" />
        <div className="hero-phone-screen">
          <div className="hero-phone-status">
            <span className="hero-phone-time">9:41</span>
            <span className="hero-phone-status-icons">
              <Signal size={14} strokeWidth={2.4} />
              <Wifi size={14} strokeWidth={2.4} />
              <BatteryFull size={18} strokeWidth={2} />
            </span>
          </div>

          <div className="hero-call">
            <div className="hero-call-avatar-circle">
              <span className="hero-call-avatar-initial">V</span>
            </div>
            <div className="hero-call-name">Vetra</div>
            {isPlaying ? (
              <div className="hero-call-live">
                <span className="hero-call-eq">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <span className="hero-call-time">{formatTime(elapsed)}</span>
              </div>
            ) : (
              <div className="hero-call-sub">
                {elapsed > 0 ? `paused · ${formatTime(elapsed)}` : "calling…"}
              </div>
            )}
          </div>

          <div className="hero-call-action">
            <button
              type="button"
              className={`hero-call-green ${isPlaying ? "is-playing" : ""}`}
              onClick={togglePlay}
              aria-label={isPlaying ? "Pause demo call" : "Play demo call"}
            >
              {isPlaying ? (
                <Pause size={28} strokeWidth={2.4} />
              ) : (
                <PhoneCall size={28} strokeWidth={2.4} />
              )}
            </button>
            <span className="hero-call-action-label">
              {isPlaying ? "Playing demo call" : "Tap to hear a real call"}
            </span>
          </div>

          <span className="hero-phone-home" aria-hidden />
        </div>
      </div>
      <audio ref={audioRef} src="/vetra-demo-call.mp3" preload="none" />
    </div>
  );
}

const privacyOrigin =
  (import.meta.env.VITE_SITE_URL && String(import.meta.env.VITE_SITE_URL).replace(/\/$/, "")) ||
  (typeof window !== "undefined" ? window.location.origin : "https://vetratd.com");

function readInitialCurrency() {
  if (typeof window === "undefined") return "USD";
  return getStoredCurrency() || detectCurrencyFromLocale();
}

const CORE_FEATURES = [
  {
    icon: Phone,
    title: "Dedicated phone number",
    desc: "A local or toll-free number that's yours alone.",
    note: "Already have a number? Port it across at no extra charge.",
  },
  {
    icon: Clock,
    title: "24/7 call answering",
    desc: "Every call answered, day or night, including weekends and holidays.",
    note: "No voicemail, no hold music, no missed opportunities.",
  },
  {
    icon: Sparkles,
    title: "Natural, human-like voice",
    desc: "Callers get a warm, real conversation, not a robotic phone menu.",
    note: "Most callers can't tell they're speaking to an AI.",
  },
  {
    icon: MessageSquareText,
    title: "Answers common questions",
    desc: "Vetra replies to your callers' most-asked questions instantly.",
    note: "Add your own custom Q&A so answers always match your business.",
  },
  {
    icon: FileText,
    title: "Messages & call summaries",
    desc: "Every call captured with a clear written summary in your dashboard.",
    note: "Includes caller details, intent, and sentiment at a glance.",
  },
  {
    icon: PhoneCall,
    title: "Smart call transfers",
    desc: "Route callers to the right person or team using your own rules.",
    note: "Set different transfer destinations for different caller types.",
  },
  {
    icon: Moon,
    title: "After-hours handling",
    desc: "Decide what happens outside opening hours, automatically.",
    note: "Take a message, transfer urgent calls, or keep booking 24/7.",
  },
  {
    icon: Bell,
    title: "Instant notifications",
    desc: "Get alerted the moment a call needs your attention.",
    note: "Summaries delivered straight to your email after every call.",
  },
  {
    icon: Globe,
    title: "Multilingual ready",
    desc: "Handle calls in multiple languages with a single setting.",
    note: "Your greeting and call handling follow the language you choose.",
  },
];

export default function Landing() {
  const revealRefs = useRef([]);
  const [currency, setCurrency] = useState(readInitialCurrency);
  const [billing, setBilling] = useState("monthly");

  const selectCurrency = (next) => {
    setCurrency(next);
    storeCurrency(next);
  };

  useEffect(() => {
    const sections = revealRefs.current || [];
    if (!sections.length) return;

    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      sections.forEach((el) => el && el.classList.add("reveal-visible"));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("reveal-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.16 }
    );

    sections.forEach((el) => el && observer.observe(el));

    return () => observer.disconnect();
  }, []);

  const [showScrollTop, setShowScrollTop] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setShowScrollTop(window.scrollY > window.innerHeight * 1.5);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToTop = () => {
    const reduceMotion =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  };

  return (
    <div className="landing-page">
      <div className="landing-announcement" role="region" aria-label="Launch announcement">
        <div className="landing-announcement-inner">
          <span className="landing-announcement-label">Launching very soon</span>
          <span className="landing-announcement-divider" aria-hidden>
            ·
          </span>
          <span className="landing-announcement-price">
            Plans from <strong>{formatLandingPrice(currency)}</strong>
          </span>
          <div
            className="landing-currency-toggle"
            role="group"
            aria-label="Pricing currency"
          >
            {["USD", "GBP"].map((code) => (
              <button
                key={code}
                type="button"
                className={`landing-currency-toggle-btn ${
                  currency === code ? "is-active" : ""
                }`}
                onClick={() => selectCurrency(code)}
                aria-pressed={currency === code}
              >
                {code}
              </button>
            ))}
          </div>
        </div>
      </div>

      <header className="landing-header">
        <div className="landing-header-inner">
          <VetraLogo to="/" />
          <nav className="landing-nav">
            <a href="#how-it-works">How it works</a>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a href="#preview">Dashboard</a>
            <a href="#different">Why Vetra</a>
            <a href="#faq">FAQ</a>
          </nav>
          <div className="landing-header-actions">
            <Link to="/contact" className="landing-header-login">
              Contact us
            </Link>
            <Link to="/app" className="landing-header-login">
              Log in
            </Link>
            <a href={`tel:${DEMO_NUMBER.replace(/\s/g, "")}`} className="landing-header-phone">
              <Phone className="landing-header-phone-icon" size={16} strokeWidth={2.4} />
              {DEMO_NUMBER}
            </a>
          </div>
        </div>
      </header>

      <section className="landing-hero">
        <div className="landing-hero-glow landing-hero-glow-1" aria-hidden />
        <div className="landing-hero-glow landing-hero-glow-2" aria-hidden />
        <div className="landing-hero-inner">
          <div className="landing-hero-copy">
            <div className="landing-hero-badge">
              <VetraMark size={20} className="landing-hero-badge-mark" />
              Call handling for modern businesses
            </div>
            <h1 className="landing-hero-title">
              Your virtual receptionist, <span className="landing-hero-title-accent">always on.</span>
            </h1>
            <p className="landing-hero-sub">
              We answer your phone when you can&apos;t — bookings, messages, and follow-ups
              handled for you, day and night. You get a simple dashboard with everything in one place.
            </p>
            <div className="landing-hero-ctas">
              <Link to="/app" className="landing-cta-primary">
                Get started
              </Link>
              <a href={`tel:${DEMO_NUMBER.replace(/\s/g, "")}`} className="landing-cta-secondary">
                Call the demo line
              </a>
              <Link to="/contact" className="landing-cta-secondary">
                Talk to us
              </Link>
            </div>
            <p className="landing-hero-trust">
              <ShieldCheck size={15} strokeWidth={2.2} className="landing-hero-trust-icon" />
              Secure • Written summaries of every call • One dashboard
            </p>
          </div>
          <div className="landing-hero-visual">
            <HeroPhone />
          </div>
        </div>
      </section>

      <section
        id="pricing"
        className="landing-pricing reveal-section"
        ref={(el) => {
          revealRefs.current[9] = el;
        }}
      >
        <div className="landing-pricing-inner">
          <h2 className="landing-pricing-title">Simple, transparent pricing</h2>
          <p className="landing-pricing-sub">
            Pick the plan that fits your business. No setup fees, cancel anytime.
          </p>

          <div className="landing-pricing-controls">
            <div
              className="landing-pricing-billing"
              role="group"
              aria-label="Billing period"
            >
              <button
                type="button"
                className={`landing-pricing-billing-btn ${
                  billing === "monthly" ? "is-active" : ""
                }`}
                onClick={() => setBilling("monthly")}
                aria-pressed={billing === "monthly"}
              >
                Monthly
              </button>
              <button
                type="button"
                className={`landing-pricing-billing-btn ${
                  billing === "annual" ? "is-active" : ""
                }`}
                onClick={() => setBilling("annual")}
                aria-pressed={billing === "annual"}
              >
                Annual
                <span className="landing-pricing-billing-save">
                  Save {ANNUAL_FREE_MONTHS} months
                </span>
              </button>
            </div>

            <div
              className="landing-pricing-currency"
              role="group"
              aria-label="Pricing currency"
            >
              {["USD", "GBP"].map((code) => (
                <button
                  key={code}
                  type="button"
                  className={`landing-pricing-currency-btn ${
                    currency === code ? "is-active" : ""
                  }`}
                  onClick={() => selectCurrency(code)}
                  aria-pressed={currency === code}
                >
                  {CURRENCY_SYMBOLS[code]} {code}
                </button>
              ))}
            </div>
          </div>

          <div className="landing-pricing-stage">
          <div className="landing-pricing-overlay" aria-hidden>
            <div className="landing-pricing-overlay-card">
              <span className="landing-pricing-overlay-dot" />
              <span className="landing-pricing-overlay-title">Coming soon</span>
              <span className="landing-pricing-overlay-text">
                Pricing isn&apos;t live just yet — take a look at what&apos;s coming.
              </span>
            </div>
          </div>
          <div className="landing-pricing-grid">
            {LANDING_PLANS.map((plan) => (
              <div
                key={plan.id}
                className={`landing-pricing-card ${
                  plan.highlighted ? "is-highlighted" : ""
                }`}
              >
                {plan.highlighted && (
                  <span className="landing-pricing-badge">Most popular</span>
                )}
                <h3 className="landing-pricing-card-name">{plan.name}</h3>
                <p className="landing-pricing-card-tagline">{plan.tagline}</p>
                <div className="landing-pricing-card-price">
                  {plan.custom ? (
                    <span className="landing-pricing-card-amount">Custom</span>
                  ) : (
                    <>
                      <span className="landing-pricing-card-amount">
                        {CURRENCY_SYMBOLS[currency]}
                        {getDisplayPrice(plan, currency, billing).perMonth}
                      </span>
                      <span className="landing-pricing-card-period">/mo</span>
                    </>
                  )}
                </div>
                <p className="landing-pricing-card-billnote">
                  {plan.custom
                    ? "tailored to your needs"
                    : billing === "annual"
                    ? `${CURRENCY_SYMBOLS[currency]}${getDisplayPrice(
                        plan,
                        currency,
                        billing
                      ).annualTotal.toLocaleString()} billed yearly`
                    : "billed monthly"}
                </p>
                <ul className="landing-pricing-card-features">
                  {plan.features.map((feature) => (
                    <li key={feature}>
                      <Check
                        size={16}
                        strokeWidth={2.6}
                        className="landing-pricing-card-check"
                      />
                      {feature}
                    </li>
                  ))}
                </ul>
                <Link
                  to={plan.cta === "Talk to us" ? "/contact" : "/app"}
                  className={`landing-pricing-card-cta ${
                    plan.highlighted ? "is-primary" : ""
                  }`}
                >
                  {plan.cta}
                </Link>
              </div>
            ))}
          </div>
          </div>
          <p className="landing-pricing-foot">
            Prices shown in {currency}
            {currency === "GBP" ? " and include VAT" : ", excluding tax"}.
          </p>
        </div>
      </section>

      <section
        id="included"
        className="landing-included reveal-section"
        ref={(el) => {
          revealRefs.current[11] = el;
        }}
      >
        <div className="landing-included-inner">
          <span className="landing-included-eyebrow">Core features</span>
          <h2 className="landing-included-title">Included in every plan</h2>
          <p className="landing-included-sub">
            The essentials your front office needs, no matter your call volume.
          </p>

          <div className="landing-included-grid">
            {CORE_FEATURES.map((feature) => {
              const Icon = feature.icon;
              return (
                <div key={feature.title} className="landing-included-item">
                  <div className="landing-included-icon">
                    <Icon size={22} strokeWidth={2.2} />
                  </div>
                  <div className="landing-included-body">
                    <h3 className="landing-included-item-title">
                      {feature.title}
                    </h3>
                    <p className="landing-included-item-desc">{feature.desc}</p>
                    <p className="landing-included-item-note">{feature.note}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section
        className="landing-cost reveal-section"
        ref={(el) => {
          revealRefs.current[10] = el;
        }}
      >
        <div className="landing-cost-glow" aria-hidden />
        <div className="landing-cost-inner">
          <div className="landing-cost-head">
            <span className="landing-cost-eyebrow">Do the math</span>
            <h2 className="landing-cost-title">
              Full coverage for a fraction of the cost.
            </h2>
            <p className="landing-cost-sub">
              A 24/7 AI receptionist that answers every call for less than the
              cost of a single part-time hire.
            </p>
          </div>

          <div className="landing-cost-panel">
            <div className="landing-cost-rows">
              <div className="landing-cost-row">
                <div className="landing-cost-row-head">
                  <span className="landing-cost-row-label">In-house receptionist</span>
                  <span className="landing-cost-row-amount">
                    {COST_COMPARISON[currency].human.annual}
                    <span className="landing-cost-row-per">/yr</span>
                  </span>
                </div>
                <div className="landing-cost-track">
                  <div
                    className="landing-cost-bar is-human"
                    style={{ width: `${COST_COMPARISON[currency].human.barPct}%` }}
                  >
                    <span className="landing-cost-bar-tag">
                      {COST_COMPARISON[currency].human.monthly}/mo
                    </span>
                  </div>
                </div>
                <span className="landing-cost-row-note">
                  9–5, Mon–Fri only · plus sick days, turnover &amp; training
                </span>
              </div>

              <div className="landing-cost-row">
                <div className="landing-cost-row-head">
                  <span className="landing-cost-row-label is-ai">
                    Vetra AI receptionist
                  </span>
                  <span className="landing-cost-row-amount is-ai">
                    {COST_COMPARISON[currency].ai.annual}
                    <span className="landing-cost-row-per">/yr</span>
                  </span>
                </div>
                <div className="landing-cost-track">
                  <div
                    className="landing-cost-bar is-ai"
                    style={{ width: `${COST_COMPARISON[currency].ai.barPct}%` }}
                  >
                    <span className="landing-cost-bar-tag">
                      {COST_COMPARISON[currency].ai.monthly}/mo
                    </span>
                  </div>
                </div>
                <span className="landing-cost-row-note">
                  24/7/365 · answers every call · zero additional costs
                </span>
              </div>
            </div>

            <div className="landing-cost-savings">
              <TrendingDown
                size={26}
                strokeWidth={2.4}
                className="landing-cost-savings-icon"
              />
              <div className="landing-cost-savings-figure">
                <span className="landing-cost-savings-amount">
                  {COST_COMPARISON[currency].savings}
                </span>
                <span className="landing-cost-savings-label">saved per year</span>
              </div>
              <span className="landing-cost-savings-pct">
                {COST_COMPARISON[currency].savingsPct}% lower cost
              </span>
              <Link to="/app" className="landing-cost-savings-cta">
                Start saving
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section
        id="how-it-works"
        className="landing-how reveal-section"
        ref={(el) => {
          revealRefs.current[0] = el;
        }}
      >
        <div className="landing-how-inner">
          <h2 className="landing-how-title">How it works</h2>
          <p className="landing-how-sub">
            Three simple steps — no technical setup required.
          </p>
          <div className="landing-how-steps">
            <div className="landing-how-step">
              <div className="landing-how-step-icon">
                <Hash size={24} strokeWidth={2} />
              </div>
              <span className="landing-how-step-num">1</span>
              <h3>Get your number</h3>
              <p>
                Sign up and choose a phone number for your business. Set your greeting,
                hours, and when calls should come through to you.
              </p>
            </div>
            <div className="landing-how-step">
              <div className="landing-how-step-icon">
                <PhoneCall size={24} strokeWidth={2} />
              </div>
              <span className="landing-how-step-num">2</span>
              <h3>We answer every call</h3>
              <p>
                When someone rings, Vetra picks up, has a natural conversation, books
                appointments, and takes messages — even after hours.
              </p>
            </div>
            <div className="landing-how-step">
              <div className="landing-how-step-icon">
                <LayoutDashboard size={24} strokeWidth={2} />
              </div>
              <span className="landing-how-step-num">3</span>
              <h3>Everything in one place</h3>
              <p>
                Every call shows up in your dashboard with a summary, bookings, and
                follow-ups — so nothing slips through the cracks.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section
        id="demo"
        className="landing-demo reveal-section"
        ref={(el) => {
          revealRefs.current[1] = el;
        }}
      >
        <div className="landing-demo-inner">
          <h2 className="landing-demo-title">Hear it for yourself</h2>
          <p className="landing-demo-desc">
            Call our demo line — no signup needed. You&apos;ll hear how Vetra answers,
            handles a conversation, and books an appointment.
          </p>
          <a href={`tel:${DEMO_NUMBER.replace(/\s/g, "")}`} className="landing-demo-phone">
            <Phone className="landing-demo-phone-icon" size={24} strokeWidth={2.2} />
            {DEMO_NUMBER}
          </a>
          <p className="landing-demo-or">
            Prefer to talk to us first?{" "}
            <Link to="/contact" className="landing-demo-contact-link">
              Get in touch
            </Link>
          </p>
        </div>
      </section>

      <section
        id="different"
        className="landing-different reveal-section"
        ref={(el) => {
          revealRefs.current[2] = el;
        }}
      >
        <div className="landing-different-inner">
          <h2 className="landing-different-title">Why businesses choose Vetra</h2>
          <p className="landing-different-tagline">
            We don&apos;t just answer calls — we help you stay on top of every enquiry.
          </p>
          <div className="landing-cards">
            <div className="landing-card">
              <div className="landing-card-icon">
                <PhoneCall size={22} strokeWidth={2} />
              </div>
              <h4>Calls answered, instantly</h4>
              <p>
                Every call gets a friendly, professional answer — mornings, evenings,
                weekends, and holidays included.
              </p>
            </div>
            <div className="landing-card">
              <div className="landing-card-icon">
                <CalendarCheck size={22} strokeWidth={2} />
              </div>
              <h4>Bookings &amp; messages handled</h4>
              <p>
                Appointments go straight into your dashboard. Messages are captured with
                the details you need — no sticky notes required.
              </p>
            </div>
            <div className="landing-card">
              <div className="landing-card-icon">
                <ClipboardList size={22} strokeWidth={2} />
              </div>
              <h4>Nothing slips through</h4>
              <p>
                Each call comes with a written summary and any follow-ups flagged for your
                team. We can email you a digest so you stay in the loop.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section
        id="features"
        className="landing-benefits reveal-section"
        ref={(el) => {
          revealRefs.current[3] = el;
        }}
      >
        <div className="landing-benefits-inner">
          <div className="landing-benefit">
            <span className="landing-benefit-icon">
              <FileText size={14} strokeWidth={2.4} />
            </span>
            <span>Written summary of every call</span>
          </div>
          <div className="landing-benefit">
            <span className="landing-benefit-icon">
              <MessageSquareText size={14} strokeWidth={2.4} />
            </span>
            <span>Bookings and messages captured</span>
          </div>
          <div className="landing-benefit">
            <span className="landing-benefit-icon">
              <Clock size={14} strokeWidth={2.4} />
            </span>
            <span>24/7 coverage, one number</span>
          </div>
          <div className="landing-benefit">
            <span className="landing-benefit-icon">
              <Inbox size={14} strokeWidth={2.4} />
            </span>
            <span>Follow-ups organised for you</span>
          </div>
        </div>
      </section>

      <section
        id="preview"
        className="landing-preview reveal-section"
        ref={(el) => {
          revealRefs.current[4] = el;
        }}
      >
        <div className="landing-preview-inner">
          <h2 className="landing-preview-title">One dashboard for every call</h2>
          <p className="landing-preview-sub">
            See what happened on each call, how busy you&apos;ve been, and what needs your attention.
          </p>
          <div className="landing-preview-browser">
            <div className="landing-preview-browser-bar">
              <span className="landing-preview-dot" />
              <span className="landing-preview-dot" />
              <span className="landing-preview-dot" />
              <span className="landing-preview-url">app / analytics</span>
            </div>
            <div className="landing-preview-dashboard">
              <div className="landing-preview-dashboard-header">
                <div>
                  <h3 className="landing-preview-dashboard-title">Call overview</h3>
                  <p className="landing-preview-dashboard-desc">A clear picture of your business calls</p>
                </div>
                <div className="landing-preview-select">Last 3 months</div>
              </div>
              <div className="landing-preview-kpis">
                <div className="landing-preview-kpi"><span className="landing-preview-kpi-num">74</span><span className="landing-preview-kpi-label">Calls handled</span></div>
                <div className="landing-preview-kpi"><span className="landing-preview-kpi-num">19</span><span className="landing-preview-kpi-label">Appointments booked</span></div>
                <div className="landing-preview-kpi"><span className="landing-preview-kpi-num">4</span><span className="landing-preview-kpi-label">Follow-ups needed</span></div>
                <div className="landing-preview-kpi"><span className="landing-preview-kpi-num">26%</span><span className="landing-preview-kpi-label">Calls → bookings</span></div>
              </div>
              <div className="landing-preview-charts">
                <div className="landing-preview-panel">
                  <h4 className="landing-preview-panel-title">Calls last 3 months</h4>
                  <div className="landing-preview-bars">
                    <div className="landing-preview-bar-wrap"><div className="landing-preview-bar" style={{ width: "30%" }} /><span>Jan</span></div>
                    <div className="landing-preview-bar-wrap"><div className="landing-preview-bar" style={{ width: "75%" }} /><span>Feb</span></div>
                    <div className="landing-preview-bar-wrap"><div className="landing-preview-bar" style={{ width: "100%" }} /><span>Mar</span></div>
                  </div>
                </div>
                <div className="landing-preview-panel">
                  <h4 className="landing-preview-panel-title">Call outcomes</h4>
                  <div className="landing-preview-outcome">89% answered / completed</div>
                  <ul className="landing-preview-list">
                    <li><span className="landing-preview-bullet landing-preview-bullet-done" />Completed: 56</li>
                    <li><span className="landing-preview-bullet landing-preview-bullet-xfer" />Transferred: 8</li>
                    <li><span className="landing-preview-bullet landing-preview-bullet-fail" />Failed: 0</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
          <Link to="/app?demo=1" className="landing-preview-cta">
            Try the guided dashboard demo
          </Link>
        </div>
      </section>

      <section
        className="landing-stats reveal-section"
        ref={(el) => {
          revealRefs.current[5] = el;
        }}
      >
        <div className="landing-stats-inner">
          <div className="landing-stat">
            <span className="landing-stat-num">24/7</span>
            <span className="landing-stat-label">Availability</span>
          </div>
          <div className="landing-stat">
            <span className="landing-stat-num">One</span>
            <span className="landing-stat-label">Dashboard for all calls</span>
          </div>
          <div className="landing-stat">
            <span className="landing-stat-num">Zero</span>
            <span className="landing-stat-label">Missed leads</span>
          </div>
        </div>
      </section>

      <section
        className="landing-testimonial reveal-section"
        ref={(el) => {
          revealRefs.current[6] = el;
        }}
      >
        <div className="landing-testimonial-inner">
          <div className="landing-testimonial-card">
            <div className="landing-testimonial-avatar">
              <div className="landing-testimonial-photo">
                <img src="/IMG_7988.png" alt="James T., small business owner" />
              </div>
            </div>
            <div className="landing-testimonial-copy">
              <p className="landing-testimonial-quote">
                &ldquo;Our calls get answered straight away and everything lands in one dashboard.
                It&apos;s been a real help for after-hours and when we&apos;re busy with customers.&rdquo;
              </p>
              <p className="landing-testimonial-author">
                <span className="landing-testimonial-name">James T.</span>
                <span className="landing-testimonial-role">Small business owner</span>
              </p>
            </div>
          </div>
        </div>
      </section>

      <section
        id="faq"
        className="landing-faq reveal-section"
        ref={(el) => {
          revealRefs.current[7] = el;
        }}
      >
        <div className="landing-faq-inner">
          <h2 className="landing-faq-title">Common questions</h2>
          <div className="landing-faq-list">
            <details className="landing-faq-item">
              <summary className="landing-faq-question">How do we connect our phone number?</summary>
              <p className="landing-faq-answer">
                After you sign up, you&apos;ll get a dedicated number for your business or connect an existing one through your phone provider. Set your hours and transfer rules in the dashboard — we&apos;ll walk you through it.
              </p>
            </details>
            <details className="landing-faq-item">
              <summary className="landing-faq-question">Is our call data secure?</summary>
              <p className="landing-faq-answer">
                Yes. Your calls and summaries are stored securely with industry-standard encryption. Only your account can access them. See our privacy policy for details.
              </p>
            </details>
            <details className="landing-faq-item">
              <summary className="landing-faq-question">What if we already have an answering service?</summary>
              <p className="landing-faq-answer">
                Vetra can replace or work alongside your current setup. Many businesses switch for 24/7 coverage and one place to see every call. Try the demo line anytime — no signup needed.
              </p>
            </details>
            <details className="landing-faq-item">
              <summary className="landing-faq-question">Can calls be transferred to a person?</summary>
              <p className="landing-faq-answer">
                Yes. You choose when — for example, during business hours only. When someone needs a live person, Vetra can transfer to your number. Your dashboard shows which calls were handed over.
              </p>
            </details>
            <details className="landing-faq-item">
              <summary className="landing-faq-question">What languages are supported?</summary>
              <p className="landing-faq-answer">
                English, Spanish, French, German, Portuguese, Italian, Dutch, and Polish. Pick your language in the dashboard and your greeting and call handling follow that setting.
              </p>
            </details>
            <details className="landing-faq-item">
              <summary className="landing-faq-question">How quickly can we get started?</summary>
              <p className="landing-faq-answer">
                Most businesses are set up in a few minutes. Add your greeting, hours, and transfer rules, then you&apos;re ready to receive calls. Call the demo line first if you&apos;d like to hear how it works.
              </p>
            </details>
            <details className="landing-faq-item">
              <summary className="landing-faq-question">Can I change or cancel my plan?</summary>
              <p className="landing-faq-answer">
                Yes. You can upgrade, downgrade, or cancel anytime from your dashboard. Changes take effect at the start of your next billing cycle, and there are no long-term contracts.
              </p>
            </details>
            <details className="landing-faq-item">
              <summary className="landing-faq-question">Are there any setup or hidden fees?</summary>
              <p className="landing-faq-answer">
                No. The monthly price is all you pay. There are no setup fees, no per-call charges, and your dedicated phone number is included in every plan.
              </p>
            </details>
            <details className="landing-faq-item">
              <summary className="landing-faq-question">Do you offer annual billing?</summary>
              <p className="landing-faq-answer">
                Yes. Paying annually gives you two months free compared to paying monthly. You can switch between monthly and annual billing on the pricing section above.
              </p>
            </details>
            <details className="landing-faq-item">
              <summary className="landing-faq-question">Which plan is right for my business?</summary>
              <p className="landing-faq-answer">
                Core suits solo operators and small teams that mainly need calls answered and messages taken. Professional adds appointment booking and team transfers for growing businesses. Enterprise is for high volume teams that need integrations, a custom voice, and dedicated support.
              </p>
            </details>
            <details className="landing-faq-item">
              <summary className="landing-faq-question">What currencies can I pay in?</summary>
              <p className="landing-faq-answer">
                Pricing is available in USD and GBP. UK prices include VAT; US prices are shown excluding tax. Use the currency switch in the pricing section to see your local rate.
              </p>
            </details>
          </div>
        </div>
      </section>

      <section
        id="download"
        className="landing-download reveal-section"
        ref={(el) => {
          revealRefs.current[8] = el;
        }}
      >
        <div className="landing-download-inner">
          <h2 className="landing-download-title">Download Vetra for Windows</h2>
          <p className="landing-download-desc">
            Prefer a desktop app? Run the same dashboard from your taskbar.
          </p>
          <a
            href="https://github.com/VetraTD/ai-phone-assistant/releases/download/v0.1.0/vetra-desktop_0.1.0_x64_en-US.msi"
            className="landing-download-button"
          >
            Download for Windows
          </a>
          <p className="landing-download-note">
            Requires Windows 10 or later. Internet connection needed for login and syncing.
          </p>
        </div>
      </section>

      <section className="landing-cta-block">
        <div className="landing-cta-block-glow" aria-hidden />
        <div className="landing-cta-block-inner">
          <VetraMark size={48} className="landing-cta-block-mark" />
          <h2 className="landing-cta-block-title">Ready to never miss a call again?</h2>
          <p className="landing-cta-block-sub">Create an account, call the demo line, or drop us a message — whatever suits you.</p>
          <div className="landing-cta-block-buttons">
            <Link to="/app" className="landing-cta-primary">
              Get started
            </Link>
            <a href={`tel:${DEMO_NUMBER.replace(/\s/g, "")}`} className="landing-cta-secondary">
              Call demo line
            </a>
            <Link to="/contact" className="landing-cta-secondary">
              Contact us
            </Link>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <VetraLogo to="/" className="vetra-logo-footer" />
          <div className="landing-footer-links">
            <Link to="/app">Log in</Link>
            <Link to="/contact">Contact</Link>
            <a href={`${privacyOrigin}/legal`}>Privacy Policy</a>
            <Link to="/legal">Terms</Link>
            <a href={`tel:${DEMO_NUMBER.replace(/\s/g, "")}`}>
              <Phone className="landing-footer-phone-icon" size={14} strokeWidth={2.4} />
              {DEMO_NUMBER}
            </a>
          </div>
          <span className="landing-footer-copy">© {new Date().getFullYear()} Vetra</span>
        </div>
      </footer>

      <button
        type="button"
        className={`landing-scroll-top ${showScrollTop ? "is-visible" : ""}`}
        onClick={scrollToTop}
        aria-label="Back to top"
        tabIndex={showScrollTop ? 0 : -1}
      >
        <ArrowUp size={20} strokeWidth={2.6} />
      </button>
    </div>
  );
}
