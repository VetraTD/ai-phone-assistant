import { useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import "./Contact.css";

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
    <div className="contact-page">
      <header className="contact-header">
        <div className="contact-header-inner">
          <Link to="/" className="contact-logo">
            Vetra<span className="contact-logo-ai">.ai</span>
          </Link>
          <Link to="/" className="contact-back">← Back to home</Link>
        </div>
      </header>

      <main className="contact-main">
        <div className="contact-inner">
          <h1 className="contact-title">Contact & support</h1>
          <p className="contact-intro">
            Have a question or need help? Send us a message and we’ll get back to you as soon as we can.
          </p>

          {sent ? (
            <div className="contact-success">
              <p><strong>Thanks for reaching out.</strong> We’ve received your message and will reply to the email you provided.</p>
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

          <p className="contact-fallback">
            You can also email us directly at{" "}
            <a href="mailto:support@vetratd.com" className="contact-link">support@vetratd.com</a>.
          </p>
        </div>
      </main>
    </div>
  );
}
