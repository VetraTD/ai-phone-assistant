import { Link } from "react-router-dom";
import "./Landing.css";

const DEMO_NUMBER = "+1 (817) 601-1171";

function PhoneIcon({ className }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

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
            <a href="#preview">Dashboard</a>
            <a href="#demo">Try demo</a>
            <a href="#different">Why Vetra</a>
          </nav>
          <div className="landing-header-actions">
            <Link to="/app" className="landing-header-login">
              Log in
            </Link>
            <a href={`tel:${DEMO_NUMBER.replace(/\s/g, "")}`} className="landing-header-phone">
              <PhoneIcon className="landing-header-phone-icon" />
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
          <p className="landing-hero-trust">
            Secure • Full transcripts • One dashboard
          </p>
        </div>
      </section>

      <section id="demo" className="landing-demo">
        <div className="landing-demo-inner">
          <p className="landing-section-label">Try it yourself</p>
          <h2 className="landing-demo-title">Talk to an AI receptionist</h2>
          <p className="landing-demo-desc">
            Call the number below to hear Vetra AI answer, triage, and book an appointment.
            No signup required.
          </p>
          <a href={`tel:${DEMO_NUMBER.replace(/\s/g, "")}`} className="landing-demo-phone">
            <PhoneIcon className="landing-demo-phone-icon" />
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

      <section id="preview" className="landing-preview">
        <div className="landing-preview-inner">
          <p className="landing-section-label">See it in action</p>
          <h2 className="landing-preview-title">One dashboard for every call</h2>
          <p className="landing-preview-sub">
            Trends, outcomes, and sentiment — all in one place.
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
                  <h3 className="landing-preview-dashboard-title">Call analytics</h3>
                  <p className="landing-preview-dashboard-desc">Trends and totals for your receptionist calls</p>
                </div>
                <div className="landing-preview-select">Last 3 months</div>
              </div>
              <div className="landing-preview-kpis">
                <div className="landing-preview-kpi"><span className="landing-preview-kpi-num">74</span><span className="landing-preview-kpi-label">Receptionist calls</span></div>
                <div className="landing-preview-kpi"><span className="landing-preview-kpi-num">19</span><span className="landing-preview-kpi-label">Appointments scheduled</span></div>
                <div className="landing-preview-kpi"><span className="landing-preview-kpi-num">4</span><span className="landing-preview-kpi-label">Follow-ups needed</span></div>
                <div className="landing-preview-kpi"><span className="landing-preview-kpi-num">26%</span><span className="landing-preview-kpi-label">Calls → appointments</span></div>
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
          <Link to="/app" className="landing-preview-cta">
            Open your dashboard
          </Link>
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
            <a href={`tel:${DEMO_NUMBER.replace(/\s/g, "")}`}>
              <PhoneIcon className="landing-footer-phone-icon" />
              {DEMO_NUMBER}
            </a>
          </div>
          <span className="landing-footer-copy">© {new Date().getFullYear()} Vetra AI</span>
        </div>
      </footer>
    </div>
  );
}
