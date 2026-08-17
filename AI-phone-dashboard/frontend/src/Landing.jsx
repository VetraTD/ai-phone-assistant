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
  ShieldCheck,
  Signal,
  Wifi,
  BatteryFull,
  Pause,
  ArrowUp,
  TrendingDown,
  AudioLines,
  Bell,
  Moon,
  Globe,
} from "lucide-react";
import VetraMark from "./components/VetraMark";
import VetraLogo from "./components/VetraLogo";
import {
  COST_COMPARISON,
  detectCurrencyFromLocale,
  getStoredCurrency,
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
            <div className={`hero-call-avatar-circle ${isPlaying ? "is-live" : ""}`}>
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

function parseCountValue(value) {
  const match = String(value).match(/^([^\d]*)([\d,]+)(.*)$/);
  if (!match) return null;
  const [, prefix, numStr, suffix] = match;
  return { prefix, suffix, target: parseInt(numStr.replace(/,/g, ""), 10) };
}

/** Animates a "$40,000+"-style string from zero once it scrolls into view. */
function CountUp({ value, duration = 1100 }) {
  const parsed = parseCountValue(value);
  const ref = useRef(null);
  const startedRef = useRef(false);
  const [display, setDisplay] = useState(
    parsed ? `${parsed.prefix}0${parsed.suffix}` : value
  );

  useEffect(() => {
    if (!parsed) return;
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(value);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !startedRef.current) {
            startedRef.current = true;
            const start = performance.now();
            const tick = (now) => {
              const progress = Math.min((now - start) / duration, 1);
              const eased = 1 - Math.pow(1 - progress, 3);
              const current = Math.round(parsed.target * eased);
              setDisplay(`${parsed.prefix}${current.toLocaleString("en-US")}${parsed.suffix}`);
              if (progress < 1) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            observer.unobserve(el);
          }
        });
      },
      { threshold: 0.4 }
    );
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return <span ref={ref}>{display}</span>;
}

/** Flips true two animation frames after mount. Used to force a genuine
 * enter transition every time a tab panel remounts (key change) — a plain
 * CSS ".reveal-visible" ancestor match resolves synchronously on insert, so
 * there'd be nothing to transition *from* on a tab switch without this. */
function useEnterOnMount() {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) setEntered(true);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
    };
  }, []);
  return entered;
}

/** Shared accessible tab-switcher (WAI-ARIA Tabs pattern: roving tabindex,
 * arrow-key navigation) used by the features, FAQ, and dashboard-preview
 * sections so the interaction and its keyboard/ARIA behavior only need to
 * be built and tested once. */
function SegmentedTabs({ tabs, activeId, onChange, idPrefix, className = "" }) {
  const listRef = useRef(null);

  const handleKeyDown = (e, index) => {
    let nextIndex = null;
    if (e.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = tabs.length - 1;

    if (nextIndex !== null) {
      e.preventDefault();
      onChange(tabs[nextIndex].id);
      const nextBtn = listRef.current?.children[nextIndex];
      nextBtn?.focus();
    }
  };

  return (
    <div className={`landing-segmented-tabs ${className}`} role="tablist" ref={listRef}>
      {tabs.map((tab, i) => {
        const selected = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            className={`landing-segmented-tab ${selected ? "is-active" : ""}`}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, i)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

const FAQ_CATEGORIES = [
  { id: "all", label: "All" },
  { id: "getting-started", label: "Getting started" },
  { id: "how-it-works", label: "How it works" },
  { id: "pricing", label: "Pricing & billing" },
];

const FAQ_ITEMS = [
  {
    category: "getting-started",
    question: "How do we connect our phone number?",
    answer:
      "After you sign up, you'll get a dedicated number for your business or connect an existing one through your phone provider. Set your hours and transfer rules in the dashboard, and we'll walk you through it.",
  },
  {
    category: "how-it-works",
    question: "Is our call data secure?",
    answer:
      "Yes. Your calls and summaries are stored securely with industry-standard encryption. Only your account can access them. See our privacy policy for details.",
  },
  {
    category: "getting-started",
    question: "What if we already have an answering service?",
    answer:
      "Vetra can replace or work alongside your current setup. Many businesses switch for 24/7 coverage and one place to see every call. Try the demo line anytime, no signup needed.",
  },
  {
    category: "how-it-works",
    question: "Can calls be transferred to a person?",
    answer:
      "Yes. You choose when, for example, during business hours only. When someone needs a live person, Vetra can transfer to your number. Your dashboard shows which calls were handed over.",
  },
  {
    category: "how-it-works",
    question: "What languages are supported?",
    answer:
      "English, Spanish, French, German, Portuguese, Italian, Dutch, and Polish. Pick your language in the dashboard and your greeting and call handling follow that setting.",
  },
  {
    category: "getting-started",
    question: "How quickly can we get started?",
    answer:
      "Most businesses are set up in a few minutes. Add your greeting, hours, and transfer rules, then you're ready to receive calls. Call the demo line first if you'd like to hear how it works.",
  },
  {
    category: "pricing",
    question: "Can I change or cancel my plan?",
    answer:
      "Yes. You can upgrade, downgrade, or cancel anytime from your dashboard. Changes take effect at the start of your next billing cycle, and there are no long-term contracts.",
  },
  {
    category: "pricing",
    question: "Are there any setup or hidden fees?",
    answer:
      "No. The monthly price is all you pay. There are no setup fees, no per-call charges, and your dedicated phone number is included in every plan.",
  },
  {
    category: "pricing",
    question: "Do you offer annual billing?",
    answer:
      "Yes. Paying annually gives you two months free compared to paying monthly, just choose annual billing when you sign up.",
  },
  {
    category: "getting-started",
    question: "Which plan is right for my business?",
    answer:
      "Core suits solo operators and small teams that mainly need calls answered and messages taken. Professional adds appointment booking and team transfers for growing businesses. Enterprise is for high volume teams that need integrations, a custom voice, and dedicated support.",
  },
  {
    category: "pricing",
    question: "What currencies can I pay in?",
    answer:
      "Pricing is available in USD and GBP. UK prices include VAT; US prices are shown excluding tax. Get in touch and we'll confirm the right rate for your business.",
  },
];

function FaqCategories({ items }) {
  const [active, setActive] = useState("all");
  const visible = active === "all" ? items : items.filter((item) => item.category === active);

  return (
    <>
      <SegmentedTabs
        tabs={FAQ_CATEGORIES}
        activeId={active}
        onChange={setActive}
        idPrefix="faq"
        className="landing-faq-tabs"
      />
      <TabPanel
        key={active}
        id={`faq-panel-${active}`}
        labelledBy={`faq-tab-${active}`}
        className="landing-faq-list"
      >
        {visible.map((item, i) => (
          <details
            key={item.question}
            className="landing-faq-item stagger-child"
            style={{ transitionDelay: `${Math.min(i, 6) * 40}ms` }}
          >
            <summary className="landing-faq-question">{item.question}</summary>
            <p className="landing-faq-answer">{item.answer}</p>
          </details>
        ))}
      </TabPanel>
    </>
  );
}

const PREVIEW_TABS = [
  { id: "calls", label: "Calls" },
  { id: "bookings", label: "Bookings" },
  { id: "outcomes", label: "Outcomes" },
];

/** Splits the dashboard-preview mockup's existing numbers (no new stats)
 * across three tabs so the section reads as "after the call" rather than
 * one static panel showing everything at once. Each tab lives inside a
 * fresh TabPanel mount, which is what makes both the bar-chart grow-in and
 * the CountUp number animations replay on every switch instead of only
 * once (see .landing-tab-panel.is-entered rules in Landing.css, and
 * CountUp's own one-shot IntersectionObserver guard). */
function PreviewTabs() {
  const [active, setActive] = useState(PREVIEW_TABS[0].id);

  return (
    <>
      <SegmentedTabs
        tabs={PREVIEW_TABS}
        activeId={active}
        onChange={setActive}
        idPrefix="preview"
        className="landing-preview-tabs"
      />
      <TabPanel
        key={active}
        id={`preview-panel-${active}`}
        labelledBy={`preview-tab-${active}`}
        className="landing-preview-tabpanel"
      >
        {active === "calls" && (
          <>
            <div className="landing-preview-kpis landing-preview-kpis-2">
              <div className="landing-preview-kpi stagger-child" style={{ transitionDelay: "0ms" }}>
                <span className="landing-preview-kpi-num">
                  <CountUp value="74" />
                </span>
                <span className="landing-preview-kpi-label">Calls handled</span>
              </div>
              <div className="landing-preview-kpi stagger-child" style={{ transitionDelay: "70ms" }}>
                <span className="landing-preview-kpi-num">
                  <CountUp value="26%" />
                </span>
                <span className="landing-preview-kpi-label">Calls → bookings</span>
              </div>
            </div>
            <div className="landing-preview-panel stagger-child" style={{ transitionDelay: "140ms" }}>
              <h4 className="landing-preview-panel-title">Calls last 3 months</h4>
              <div className="landing-preview-bars">
                <div className="landing-preview-bar-wrap">
                  <div className="landing-preview-bar" style={{ "--bar-w": "30%" }} />
                  <span>Jan</span>
                </div>
                <div className="landing-preview-bar-wrap">
                  <div className="landing-preview-bar" style={{ "--bar-w": "75%" }} />
                  <span>Feb</span>
                </div>
                <div className="landing-preview-bar-wrap">
                  <div className="landing-preview-bar" style={{ "--bar-w": "100%" }} />
                  <span>Mar</span>
                </div>
              </div>
            </div>
          </>
        )}
        {active === "bookings" && (
          <div className="landing-preview-kpis landing-preview-kpis-2">
            <div className="landing-preview-kpi stagger-child" style={{ transitionDelay: "0ms" }}>
              <span className="landing-preview-kpi-num">
                <CountUp value="19" />
              </span>
              <span className="landing-preview-kpi-label">Appointments booked</span>
            </div>
            <div className="landing-preview-kpi stagger-child" style={{ transitionDelay: "70ms" }}>
              <span className="landing-preview-kpi-num">
                <CountUp value="4" />
              </span>
              <span className="landing-preview-kpi-label">Follow-ups needed</span>
            </div>
          </div>
        )}
        {active === "outcomes" && (
          <div className="landing-preview-panel stagger-child" style={{ transitionDelay: "0ms" }}>
            <h4 className="landing-preview-panel-title">Call outcomes</h4>
            <div className="landing-preview-outcome">
              <CountUp value="89%" /> answered / completed
            </div>
            <ul className="landing-preview-list">
              <li>
                <span className="landing-preview-bullet landing-preview-bullet-done" />
                Completed: 56
              </li>
              <li>
                <span className="landing-preview-bullet landing-preview-bullet-xfer" />
                Transferred: 8
              </li>
              <li>
                <span className="landing-preview-bullet landing-preview-bullet-fail" />
                Failed: 0
              </li>
            </ul>
          </div>
        )}
      </TabPanel>
    </>
  );
}

const privacyOrigin =
  (import.meta.env.VITE_SITE_URL && String(import.meta.env.VITE_SITE_URL).replace(/\/$/, "")) ||
  (typeof window !== "undefined" ? window.location.origin : "https://vetratd.com");

function readInitialCurrency() {
  if (typeof window === "undefined") return "USD";
  return getStoredCurrency() || detectCurrencyFromLocale();
}

const FEATURE_CATEGORIES = [
  { id: "answering", label: "Answering every call" },
  { id: "conversations", label: "Natural conversations" },
  { id: "details", label: "Never miss a detail" },
];

const CORE_FEATURES = [
  {
    icon: Phone,
    category: "answering",
    title: "Dedicated phone number",
    desc: "A local or toll-free number that's yours alone.",
    note: "Already have a number? Port it across at no extra charge.",
  },
  {
    icon: Clock,
    category: "answering",
    title: "24/7 call answering",
    desc: "Every call answered, day or night, including weekends and holidays.",
    note: "No voicemail, no hold music, no missed opportunities.",
  },
  {
    icon: Moon,
    category: "answering",
    title: "After-hours handling",
    desc: "Decide what happens outside opening hours, automatically.",
    note: "Take a message, transfer urgent calls, or keep booking 24/7.",
  },
  {
    icon: AudioLines,
    category: "conversations",
    title: "Natural, human-like voice",
    desc: "Callers get a warm, real conversation, not a robotic phone menu.",
    note: "Most callers can't tell they're speaking to an AI.",
  },
  {
    icon: MessageSquareText,
    category: "conversations",
    title: "Answers common questions",
    desc: "Vetra replies to your callers' most-asked questions instantly.",
    note: "Add your own custom Q&A so answers always match your business.",
  },
  {
    icon: Globe,
    category: "conversations",
    title: "Multilingual ready",
    desc: "Handle calls in multiple languages with a single setting.",
    note: "Your greeting and call handling follow the language you choose.",
  },
  {
    icon: FileText,
    category: "details",
    title: "Messages & call summaries",
    desc: "Every call captured with a clear written summary in your dashboard.",
    note: "Includes caller details, intent, and sentiment at a glance.",
  },
  {
    icon: PhoneCall,
    category: "details",
    title: "Smart call transfers",
    desc: "Route callers to the right person or team using your own rules.",
    note: "Set different transfer destinations for different caller types.",
  },
  {
    icon: Bell,
    category: "details",
    title: "Instant notifications",
    desc: "Get alerted the moment a call needs your attention.",
    note: "Summaries delivered straight to your email after every call.",
  },
];

/** Wraps tab-panel content with an `is-entered` flag that's fresh on every
 * mount (see useEnterOnMount) — the parent must give this component a
 * `key` that changes with the active tab so it actually remounts on switch,
 * rather than just re-rendering, or the enter animation won't replay. */
function TabPanel({ id, labelledBy, className = "", children }) {
  const entered = useEnterOnMount();
  return (
    <div
      id={id}
      role="tabpanel"
      aria-labelledby={labelledBy}
      className={`landing-tab-panel ${className} ${entered ? "is-entered" : ""}`}
    >
      {children}
    </div>
  );
}

function FeatureTabs({ features }) {
  const [active, setActive] = useState(FEATURE_CATEGORIES[0].id);
  const visible = features.filter((f) => f.category === active);

  return (
    <>
      <SegmentedTabs
        tabs={FEATURE_CATEGORIES}
        activeId={active}
        onChange={setActive}
        idPrefix="features"
        className="landing-included-tabs"
      />
      <TabPanel
        key={active}
        id={`features-panel-${active}`}
        labelledBy={`features-tab-${active}`}
        className="landing-included-grid"
      >
        {visible.map((feature, i) => {
          const Icon = feature.icon;
          return (
            <div
              key={feature.title}
              className="landing-included-item stagger-child"
              style={{ transitionDelay: `${i * 70}ms` }}
            >
              <div className="landing-included-icon">
                <Icon size={22} strokeWidth={2.2} />
              </div>
              <div className="landing-included-body">
                <h3 className="landing-included-item-title">{feature.title}</h3>
                <p className="landing-included-item-desc">{feature.desc}</p>
                <p className="landing-included-item-note">{feature.note}</p>
              </div>
            </div>
          );
        })}
      </TabPanel>
    </>
  );
}

export default function Landing() {
  const revealRefs = useRef([]);
  const [currency] = useState(readInitialCurrency);

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
  const [scrollProgress, setScrollProgress] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      setShowScrollTop(window.scrollY > window.innerHeight * 1.5);
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      setScrollProgress(scrollable > 0 ? Math.min(100, (window.scrollY / scrollable) * 100) : 0);
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
      <header className="landing-header">
        <div className="landing-scroll-progress" style={{ width: `${scrollProgress}%` }} aria-hidden="true" />
        <div className="landing-header-inner">
          <VetraLogo to="/" />
          <nav className="landing-nav">
            <a href="#features">Features</a>
            <a href="#how-it-works">How it works</a>
            <a href="#cost">Pricing</a>
            <a href="#compare">Why Vetra</a>
            <a href="#faq">FAQ</a>
          </nav>
          <div className="landing-header-actions">
            <Link to="/app" className="landing-header-login">
              Log in
            </Link>
            <span className="landing-header-divider" aria-hidden="true" />
            <a href={`tel:${DEMO_NUMBER.replace(/\s/g, "")}`} className="landing-header-phone">
              <Phone className="landing-header-phone-icon" size={16} strokeWidth={2.4} />
              {DEMO_NUMBER}
            </a>
            <Link to="/app" className="landing-header-cta">
              Get started
            </Link>
          </div>
        </div>
      </header>

      <section className="landing-hero">
        <div className="landing-hero-inner">
          <div className="landing-hero-copy">
            <h1 className="landing-hero-title">
              Your virtual receptionist, <span className="landing-hero-title-accent">always on.</span>
            </h1>
            <p className="landing-hero-sub">
              Every call answered, day or night, automatically.
            </p>
            <div className="landing-hero-ctas">
              <Link to="/app" className="landing-cta-primary landing-hero-cta">
                Get started
              </Link>
            </div>
            <p className="landing-hero-trust">
              <ShieldCheck size={15} strokeWidth={2.2} className="landing-hero-trust-icon" />
              Every call encrypted and logged automatically, nothing to set up, nothing to miss.
            </p>
          </div>
          <div className="landing-hero-visual">
            <HeroPhone />
          </div>
        </div>
      </section>

      <section
        id="demo"
        className="landing-demo reveal-section"
        ref={(el) => {
          revealRefs.current[0] = el;
        }}
      >
        <div className="landing-demo-inner">
          <h2 className="landing-demo-title">Hear it for yourself</h2>
          <p className="landing-demo-desc">
            Call our demo line, no signup needed. You&apos;ll hear how Vetra answers,
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
        id="features"
        className="landing-included reveal-section"
        ref={(el) => {
          revealRefs.current[1] = el;
        }}
      >
        <div className="landing-included-inner">
          <h2 className="landing-included-title">What Vetra does</h2>
          <p className="landing-included-sub">
            The essentials your front office needs, no matter your call volume.
          </p>

          <FeatureTabs features={CORE_FEATURES} />
        </div>
      </section>

      <section
        id="how-it-works"
        className="landing-how reveal-section"
        ref={(el) => {
          revealRefs.current[2] = el;
        }}
      >
        <div className="landing-how-inner">
          <h2 className="landing-how-title">How it works</h2>
          <p className="landing-how-sub">
            Three simple steps, no technical setup required.
          </p>
          <div className="landing-how-steps">
            <div className="landing-how-step stagger-child" style={{ transitionDelay: "0ms" }}>
              <span className="landing-how-step-num">1</span>
              <h3>Get your number</h3>
              <p>
                Sign up and choose a phone number for your business. Set your greeting,
                hours, and when calls should come through to you.
              </p>
            </div>
            <div className="landing-how-step stagger-child" style={{ transitionDelay: "100ms" }}>
              <span className="landing-how-step-num">2</span>
              <h3>We answer every call</h3>
              <p>
                When someone rings, Vetra picks up, has a natural conversation, books
                appointments, and takes messages, even after hours.
              </p>
            </div>
            <div className="landing-how-step stagger-child" style={{ transitionDelay: "200ms" }}>
              <span className="landing-how-step-num">3</span>
              <h3>Everything in one place</h3>
              <p>
                Every call shows up in your dashboard with a summary, bookings, and
                follow-ups, so nothing slips through the cracks.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section
        id="cost"
        className="landing-cost reveal-section"
        ref={(el) => {
          revealRefs.current[3] = el;
        }}
      >
        <div className="landing-cost-inner">
          <div className="landing-cost-head">
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
                  9 to 5, Mon to Fri only · plus sick days, turnover &amp; training
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
                  <CountUp value={COST_COMPARISON[currency].savings} />
                </span>
                <span className="landing-cost-savings-label">saved per year</span>
              </div>
              <span className="landing-cost-savings-pct">
                <CountUp value={`${COST_COMPARISON[currency].savingsPct}%`} /> lower cost
              </span>
              <Link to="/app" className="landing-cta-secondary landing-cost-savings-cta">
                Start saving
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section
        id="compare"
        className="landing-different reveal-section"
        ref={(el) => {
          revealRefs.current[4] = el;
        }}
      >
        <div className="landing-different-inner">
          <h2 className="landing-different-title">Compared to what you're doing now</h2>
          <p className="landing-different-tagline">
            No voicemail. No missed calls. No sticky notes. Just every call answered
            and logged, automatically.
          </p>
          <div className="landing-cards">
            <div className="landing-card stagger-child" style={{ transitionDelay: "0ms" }}>
              <div className="landing-card-icon">
                <PhoneCall size={22} strokeWidth={2} />
              </div>
              <h4>Calls answered, instantly</h4>
              <p>
                Every call gets a friendly, professional answer, mornings, evenings,
                weekends, and holidays included.
              </p>
            </div>
            <div className="landing-card stagger-child" style={{ transitionDelay: "90ms" }}>
              <div className="landing-card-icon">
                <CalendarCheck size={22} strokeWidth={2} />
              </div>
              <h4>Bookings &amp; messages handled</h4>
              <p>
                Appointments go straight into your dashboard. Messages are captured with
                the details you need, no sticky notes required.
              </p>
            </div>
            <div className="landing-card stagger-child" style={{ transitionDelay: "180ms" }}>
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
        id="preview"
        className="landing-preview reveal-section"
        ref={(el) => {
          revealRefs.current[5] = el;
        }}
      >
        <div className="landing-preview-inner">
          <h2 className="landing-preview-title">One dashboard for every call</h2>
          <p className="landing-preview-sub">
            See what happened on each call, how busy you&apos;ve been, and what needs your attention.
          </p>
          <div className="landing-preview-browser">
            <div className="landing-preview-dashboard">
              <div className="landing-preview-dashboard-header">
                <div>
                  <h3 className="landing-preview-dashboard-title">Call overview</h3>
                  <p className="landing-preview-dashboard-desc">A clear picture of your business calls</p>
                </div>
                <div className="landing-preview-select">Last 3 months</div>
              </div>
              <PreviewTabs />
            </div>
          </div>
          <Link to="/app?demo=1" className="landing-cta-secondary landing-preview-cta">
            Try the guided dashboard demo
          </Link>
        </div>
      </section>

      <section
        id="faq"
        className="landing-faq reveal-section"
        ref={(el) => {
          revealRefs.current[6] = el;
        }}
      >
        <div className="landing-faq-inner">
          <h2 className="landing-faq-title">Common questions</h2>
          <FaqCategories items={FAQ_ITEMS} />
        </div>
      </section>

      <section
        className="landing-cta-block reveal-section"
        ref={(el) => {
          revealRefs.current[7] = el;
        }}
      >
        <div className="landing-cta-block-inner">
          <VetraMark size={48} className="landing-cta-block-mark" />
          <h2 className="landing-cta-block-title">Never miss another call.</h2>
          <p className="landing-cta-block-sub">Create an account, call the demo line, or drop us a message, whatever suits you.</p>
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
