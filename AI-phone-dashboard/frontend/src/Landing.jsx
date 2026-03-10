import { Link } from "react-router-dom";
import "./Landing.css";

const DEMO_NUMBER = "+1 (817) 601-1171";

export default function Landing() {
  return (
    <div className="landing-page">
      <header className="landing-header">
        <div className="landing-header-inner">
          <Link to="/" className="landing-logo">
            Vetra<span className="landing-logo-ai">.ai</span>
          </Link>
          <nav className="landing-nav">
            <a href="#features">Features</a>
            <a href="#demo">Try demo</a>
            <a href="#different">Why Vetra</a>
          </nav>
          <div className="landing-header-actions">
            <Link to="/app" className="landing-header-login">
              Log in
            </Link>
            <a href={`tel:${DEMO_NUMBER.replace(/\s/g, "")}`} className="landing-header-phone">
              {DEMO_NUMBER}
            </a>
          </div>
        </div>
      </header>

      <section className="landing-hero">
        <div className="landing-hero-inner">
          <h1 className="landing-hero-title">
            Your AI receptionist for the front office. Fully staffed, 24/7.
          </h1>
          <p className="landing-hero-sub">
            Clinical-grade call handling: Vetra AI answers, qualifies, schedules, and captures
            every call — then delivers clear summaries and appointments to your team.
          </p>
          <div className="landing-hero-ctas">
            <Link to="/app" className="landing-cta-primary">
              Get started
            </Link>
            <span className="landing-hero-or">or</span>
            <a href="#demo" className="landing-cta-secondary">
              Try the demo line
            </a>
          </div>
        </div>
      </section>

      <section id="demo" className="landing-demo">
        <div className="landing-demo-inner">
          <h2 className="landing-section-label">Try it yourself</h2>
          <h3 className="landing-demo-title">Talk to an AI receptionist</h3>
          <p className="landing-demo-desc">
            Call the number below to hear Vetra AI answer, triage, and book an appointment.
            No signup required.
          </p>
          <a href={`tel:${DEMO_NUMBER.replace(/\s/g, "")}`} className="landing-demo-phone">
            <span className="landing-demo-phone-icon" aria-hidden>📞</span>
            {DEMO_NUMBER}
          </a>
        </div>
      </section>

      <section id="different" className="landing-different">
        <div className="landing-different-inner">
          <p className="landing-section-label">How we&apos;re different</p>
          <h2 className="landing-different-title">Why practices choose Vetra AI</h2>
          <p className="landing-different-tagline">
            We don&apos;t just answer calls. We deliver structured outcomes.
          </p>
          <div className="landing-cards">
            <div className="landing-card">
              <div className="landing-card-icon">◆</div>
              <h4>Clinical-grade call handling</h4>
              <p>
                Vetra AI handles intake with clear protocols, captures appointments and
                follow-up requests, and escalates appropriately — with full transcripts
                and summaries for your team.
              </p>
            </div>
            <div className="landing-card">
              <div className="landing-card-icon">◇</div>
              <h4>Configured to your practice</h4>
              <p>
                Set your greeting, business hours, transfer rules, and notification
                preferences. One dashboard for calls, appointments, and follow-ups.
              </p>
            </div>
            <div className="landing-card">
              <div className="landing-card-icon">▣</div>
              <h4>Transparent oversight</h4>
              <p>
                Every call is logged with transcript, summary, and sentiment. Email
                digests of upcoming appointments and follow-ups keep your team in sync.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="features" className="landing-benefits">
        <div className="landing-benefits-inner">
          <div className="landing-benefit">
            <span className="landing-benefit-icon">✓</span>
            <span>Structured transcripts and summaries</span>
          </div>
          <div className="landing-benefit">
            <span className="landing-benefit-icon">✓</span>
            <span>Appointment capture and email digests</span>
          </div>
          <div className="landing-benefit">
            <span className="landing-benefit-icon">✓</span>
            <span>24/7 coverage, one number</span>
          </div>
          <div className="landing-benefit">
            <span className="landing-benefit-icon">✓</span>
            <span>Follow-up tracking and analytics</span>
          </div>
        </div>
      </section>

      <section className="landing-stats">
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

      <section className="landing-cta-block">
        <div className="landing-cta-block-inner">
          <h2 className="landing-cta-block-title">Ready to run your calls with clarity?</h2>
          <p className="landing-cta-block-sub">Sign in to your dashboard or create an account.</p>
          <div className="landing-cta-block-buttons">
            <Link to="/app" className="landing-cta-primary">
              Sign in to dashboard
            </Link>
            <Link to="/app" className="landing-cta-secondary">
              Create account
            </Link>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <Link to="/" className="landing-logo landing-logo-footer">
            Vetra<span className="landing-logo-ai">.ai</span>
          </Link>
          <div className="landing-footer-links">
            <Link to="/app">Log in</Link>
            <a href={`tel:${DEMO_NUMBER.replace(/\s/g, "")}`}>{DEMO_NUMBER}</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
