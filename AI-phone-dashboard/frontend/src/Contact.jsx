import { useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import VetraLogo from "./components/VetraLogo";
// The landing page's nav, button and footer styles, reused as-is so this page
// matches it exactly. Everything in it is scoped to .lp / .lp-*.
import "./Landing.css";
import "./Contact.css";
import { MARKETING_URL, APP_URL } from "./siteUrl";

const DEMO_NUMBER = "+1 (817) 601-1171";
const DEMO_TEL = `tel:${DEMO_NUMBER.replace(/[^\d+]/g, "")}`;

const API = import.meta.env.VITE_API_URL || "http://localhost:3001";

export default function Contact() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setSending(true);
    try {
      await axios.post(`${API}/api/contact`, { name, email, message });
      setSent(true);
      setName("");
      setEmail("");
      setMessage("");
    } catch (err) {
      setError(err?.response?.data?.error || "Something went wrong. Please try again or email us directly.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="lp lp-dark contact-page">
      <title>Contact | VetraTD</title>
      {/* Same nav as the landing page. Links are absolute because this page
          is also served on app.vetratd.com, where "/" is the dashboard. */}
      <header className="lp-header lp-dark">
        <div className="lp-header-inner">
          <VetraLogo href={MARKETING_URL} name="VetraTD" className="lp-logo" />
          <nav className="lp-nav" aria-label="Main">
            <a href={`${MARKETING_URL}/#how-it-works`}>How it works</a>
            <a href={`${MARKETING_URL}/#features`}>Features</a>
            <a href={`${MARKETING_URL}/#tailored`}>Your setup</a>
            <a href={`${MARKETING_URL}/#pricing`}>Pricing</a>
            <a href={`${MARKETING_URL}/#faq`}>FAQ</a>
          </nav>
          <div className="lp-header-actions">
            <a href={`${APP_URL}/login`} className="lp-header-login">
              Log in
            </a>
          </div>
        </div>
      </header>

      <main className="contact-main">
        <div className="lp-container contact-grid">
          <div className="contact-intro-col">
            <h1 className="contact-title">We&apos;d love to hear from you</h1>
            <p className="contact-intro">
              Questions about Vetra, need help getting set up, or want to see if we&apos;re a good fit?
              Send us a message and we&apos;ll get back to you as soon as we can. You can also email us at{" "}
              <a href="mailto:josh.tite@vetratd.com" className="contact-link">
                josh.tite@vetratd.com
              </a>
              .
            </p>
          </div>

          <div className="contact-card-col">
          {sent ? (
            <div className="contact-success">
              <p><strong>Thanks for reaching out.</strong> We&apos;ve received your message and will reply to the email you provided.</p>
              <button type="button" className="contact-cta" onClick={() => setSent(false)}>Send another message</button>
            </div>
          ) : (
            <form className="contact-form" onSubmit={handleSubmit}>
              <div className="contact-field">
                <label htmlFor="contact-name">Name</label>
                <input
                  id="contact-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  required
                  autoComplete="name"
                />
              </div>
              <div className="contact-field">
                <label htmlFor="contact-email">Email</label>
                <input
                  id="contact-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  autoComplete="email"
                />
              </div>
              <div className="contact-field">
                <label htmlFor="contact-message">Message</label>
                <textarea
                  id="contact-message"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="How can we help?"
                  rows={5}
                  required
                />
              </div>
              {error && <p className="contact-error">{error}</p>}
              <button type="submit" className="contact-submit" disabled={sending}>
                {sending ? "Sending…" : "Send message"}
              </button>
            </form>
          )}
          </div>
        </div>
      </main>

      {/* Same footer as the landing page. */}
      <footer className="lp-footer lp-dark">
        <div className="lp-footer-inner">
          <VetraLogo href={MARKETING_URL} name="VetraTD" className="lp-logo vetra-logo-footer" />
          <nav className="lp-footer-links" aria-label="Footer">
            <a href={`${APP_URL}/login`}>Log in</a>
            <Link to="/contact">Contact</Link>
            <Link to="/legal">Privacy Policy</Link>
            <Link to="/legal">Terms</Link>
            <a href={DEMO_TEL}>{DEMO_NUMBER}</a>
          </nav>
          <span className="lp-footer-copy">© {new Date().getFullYear()} VetraTD</span>
        </div>
      </footer>
    </div>
  );
}
