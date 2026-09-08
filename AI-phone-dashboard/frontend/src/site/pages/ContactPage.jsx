import { usePageMeta } from "../usePageMeta.js";
import { GO_LIVE } from "../content/siteConfig.js";
import PageHero from "../components/PageHero.jsx";
import ContactForm from "../components/ContactForm.jsx";
import "./ContactPage.css";

export default function ContactPage() {
  usePageMeta({
    title: "Request access",
    description: "Tell us about your business and we will set Vetra up with you.",
    path: "/contact",
  });

  return (
    <>
      <PageHero
        title="Request access"
        lead={`Tell us about your business. We reply within one working day, set everything up with you by hand, and you are ${GO_LIVE}.`}
      />
      <section className="site-section contact">
        <div className="site-container contact__grid">
          <ContactForm />
          <aside className="contact__aside">
            <h2 className="site-h3">What happens next</h2>
            <ol className="contact__steps">
              <li>We reply and arrange a short call about your business, your hours and how you take bookings.</li>
              <li>We set up your number, greeting, after-hours rules, transfer rules and knowledge base with you, and test it together.</li>
              <li>You go live. Every call is summarised in your dashboard, and you can change the set-up at any time.</li>
            </ol>
          </aside>
        </div>
      </section>
    </>
  );
}
