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
} from "lucide-react";
import VetraMark from "./components/VetraMark";
import VetraLogo from "./components/VetraLogo";
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

export default function Landing() {
  const revealRefs = useRef([]);

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

  return (
    <div className="landing-page">
      <header className="landing-header">
        <div className="landing-header-inner">
          <VetraLogo to="/" />
          <nav className="landing-nav">
            <a href="#how-it-works">How it works</a>
            <a href="#features">Features</a>
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
    </div>
  );
}
