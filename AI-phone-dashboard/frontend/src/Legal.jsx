import { Link } from "react-router-dom";
import "./Legal.css";

const CONTACT_EMAIL = "support@vetratd.com";

export default function Legal() {
  return (
    <div className="legal-page">
      <header className="legal-header">
        <div className="legal-header-inner">
          <Link to="/" className="legal-logo">
            Vetra<span className="legal-logo-ai">.ai</span>
          </Link>
          <Link to="/" className="legal-back">← Back to home</Link>
        </div>
      </header>

      <main className="legal-main">
        <div className="legal-inner">
          <h1 className="legal-title">Privacy & Terms</h1>
          <p className="legal-intro">
            Last updated: {new Date().toISOString().slice(0, 10)}. If you have questions,{" "}
            <Link to="/contact" className="legal-link">contact us</Link> or email {CONTACT_EMAIL}.
          </p>

          <section className="legal-section" id="privacy">
            <h2 className="legal-section-title">Privacy Policy</h2>
            <p>
              <strong>What we collect.</strong> We collect account information (such as your email address), business details (name, phone number, timezone, notification email and phone), and call-related data (including call metadata, transcripts, summaries, and appointment information) when you use the Vetra AI receptionist service.
            </p>
            <p>
              <strong>Why we use it.</strong> We use this data to provide and operate the AI receptionist, power your dashboard, send appointment and follow-up emails, and improve our product. We do not sell your data to third parties.
            </p>
            <p>
              <strong>Where it’s stored.</strong> Data is stored using secure, industry-standard infrastructure (including Supabase and our hosting providers). We use encryption and access controls to protect your information.
            </p>
            <p>
              <strong>Your rights.</strong> You may request access to, correction of, or deletion of your data by contacting us at {CONTACT_EMAIL}. We will respond in a reasonable time.
            </p>
            <p>
              <strong>Changes.</strong> We may update this policy from time to time. The “Last updated” date at the top of this page will change when we do. Continued use of the service after changes means you accept the updated policy.
            </p>
          </section>

          <section className="legal-section" id="terms">
            <h2 className="legal-section-title">Terms of Service</h2>
            <p>
              <strong>Use of the service.</strong> By using Vetra AI, you agree to use the service only for lawful purposes and in line with these terms. You are responsible for your account and for ensuring that your use (including how you configure the AI and handle call data) complies with applicable laws.
            </p>
            <p>
              <strong>What you’re buying.</strong> When you subscribe (e.g. via Stripe), you are purchasing access to the Vetra AI receptionist and dashboard for the chosen plan and billing period. Fees are as described at the time of purchase.
            </p>
            <p>
              <strong>Cancellation and refunds.</strong> You may cancel your subscription according to the options in your account or billing portal. Refunds, if any, are handled in line with our refund policy at the time of purchase; contact us at {CONTACT_EMAIL} with questions.
            </p>
            <p>
              <strong>Service “as is.”</strong> While we strive to keep the service available and accurate, the service is provided “as is,” especially during beta. We do not guarantee uninterrupted access or that the service will meet every specific need.
            </p>
            <p>
              <strong>Termination.</strong> We may suspend or terminate your access if you breach these terms or for other operational reasons. You may stop using the service at any time.
            </p>
            <p>
              <strong>Contact.</strong> For questions about these terms or the service, contact us at {CONTACT_EMAIL}.
            </p>
          </section>

          <div className="legal-footer-link">
            <Link to="/contact" className="legal-cta legal-cta-secondary">Contact</Link>
            <Link to="/" className="legal-cta">Back to home</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
