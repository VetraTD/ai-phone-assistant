import { useState } from "react";
import axios from "axios";
import { SUPPORT_EMAIL } from "../content/siteConfig.js";
import "./ContactForm.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:3001";

/**
 * The request-access form. The backend accepts exactly name, email and
 * message (anything else is rejected), so the business name and phone go in
 * the message where the owner reads them anyway.
 */
export default function ContactForm() {
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
      setError(
        err?.response?.data?.error ||
          `The message did not send. Try again, or email ${SUPPORT_EMAIL} directly.`
      );
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <div className="cform__done site-page" role="status">
        <div className="site-row">
          <div className="site-row__margin">Sent</div>
          <div className="site-row__entry">
            <p className="site-p">
              <strong>Thank you.</strong> We have your message and will reply to the address you gave
              within one working day.
            </p>
            <button type="button" className="site-btn site-btn--secondary cform__again" onClick={() => setSent(false)}>
              Send another message
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form className="cform site-page" onSubmit={handleSubmit} noValidate={false}>
      <div className="cform__field">
        <label htmlFor="contact-name" className="cform__label">
          Your name
        </label>
        <input
          id="contact-name"
          className="cform__input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoComplete="name"
          maxLength={120}
        />
      </div>
      <div className="cform__field">
        <label htmlFor="contact-email" className="cform__label">
          Email
        </label>
        <input
          id="contact-email"
          className="cform__input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          inputMode="email"
          maxLength={254}
        />
      </div>
      <div className="cform__field">
        <label htmlFor="contact-message" className="cform__label">
          About your business
        </label>
        <p id="contact-message-help" className="cform__help site-small site-muted">
          The business name, what it does, and a phone number we can call you on. Anything else you want
          us to know.
        </p>
        <textarea
          id="contact-message"
          className="cform__input cform__textarea"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={6}
          required
          maxLength={4000}
          aria-describedby="contact-message-help"
        />
      </div>
      {error ? (
        <p className="cform__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="cform__actions">
        <button type="submit" className="site-btn site-btn--primary" disabled={sending}>
          {sending ? "Sending…" : "Request access"}
        </button>
        <span className="site-small site-muted">
          Or email <a className="site-link" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </span>
      </div>
    </form>
  );
}
