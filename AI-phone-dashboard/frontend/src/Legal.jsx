import { Link } from "react-router-dom";
import VetraLogo from "./components/VetraLogo";
import "./Legal.css";
import { MARKETING_URL } from "./siteUrl";

const CONTACT_EMAIL = "support@vetratd.com";
const SMS_CONTACT_EMAIL = "josh.tite@vetratd.com";

export default function Legal() {
  return (
    <div className="legal-page">
      <header className="legal-header">
        <div className="legal-header-inner">
          <VetraLogo href={MARKETING_URL} />
          <a href={MARKETING_URL} className="legal-back">← Back to vetratd.com</a>
        </div>
      </header>

      <main className="legal-main">
        <div className="legal-inner">
          <h1 className="legal-title">Privacy & Terms</h1>
          <p className="legal-intro">
            Last updated: {new Date().toISOString().slice(0, 10)}. Questions?{" "}
            <Link to="/contact" className="legal-link">Contact us</Link> or email {CONTACT_EMAIL}.
          </p>

          <section className="legal-section" id="privacy">
            <h2 className="legal-section-title">Privacy Policy</h2>
            <p>
              <strong>What we collect.</strong> We collect account information (such as your email address), business details (name, phone number, timezone, notification email and phone), and call-related data (including call details, written summaries, and appointment information) when you use Vetra.
            </p>
            <p>
              <strong>Why we use it.</strong> We use this data to provide and operate the service, power your dashboard, send appointment and follow-up emails, and improve our product. We do not sell your data to third parties.
            </p>
            <p>
              <strong>Where it&apos;s stored.</strong> Data is stored using secure, industry-standard infrastructure with encryption and access controls to protect your information.
            </p>
            <p id="sms-privacy">
              <strong>Text messaging (SMS).</strong> If you give us your mobile number and opt in to text messages (for example, on our contact form), we use that number only to send the messages you agreed to receive. No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging opt-in data and consent are not shared with any third party. Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out at any time, or HELP for help. You can also contact us at{" "}
              <a href={`mailto:${SMS_CONTACT_EMAIL}`} className="legal-link">{SMS_CONTACT_EMAIL}</a>.
            </p>
            <p>
              <strong>Your rights.</strong> You may request access to, correction of, or deletion of your data by contacting us at {CONTACT_EMAIL}. We will respond in a reasonable time.
            </p>
            <p>
              <strong>Changes.</strong> We may update this policy from time to time. The &ldquo;Last updated&rdquo; date at the top of this page will change when we do. Continued use of the service after changes means you accept the updated policy.
            </p>
          </section>

          <section className="legal-section" id="terms">
            <h2 className="legal-section-title">Terms of Service</h2>
            <p>
              <strong>Use of the service.</strong> By using Vetra, you agree to use the service only for lawful purposes and in line with these terms. You are responsible for your account and for ensuring your use complies with applicable laws.
            </p>
            <p>
              <strong>What you&apos;re buying.</strong> When you subscribe, you are purchasing access to the Vetra receptionist service and dashboard for the chosen plan and billing period. Fees are as described at the time of purchase.
            </p>
            <p>
              <strong>Cancellation and refunds.</strong> You may cancel your subscription according to the options in your account or billing portal. Refunds, if any, are handled in line with our refund policy at the time of purchase; contact us at {CONTACT_EMAIL} with questions.
            </p>
            <p>
              <strong>Service &ldquo;as is.&rdquo;</strong> While we strive to keep the service available and accurate, the service is provided &ldquo;as is.&rdquo; We do not guarantee uninterrupted access or that the service will meet every specific need.
            </p>
            <p id="sms-terms">
              <strong>Text messaging (SMS) terms.</strong> Opting in to text messages from VetraTD is optional and is not a condition of purchase. If you opt in, you agree to receive text messages from VetraTD about your enquiry and our service at the mobile number you provide. Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out at any time; you will receive a single message confirming you have been unsubscribed. Reply HELP for help, or contact us at{" "}
              <a href={`mailto:${SMS_CONTACT_EMAIL}`} className="legal-link">{SMS_CONTACT_EMAIL}</a>. Carriers are not liable for delayed or undelivered messages. See the Privacy Policy above for how we handle your mobile information.
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
            <a href={MARKETING_URL} className="legal-cta">Back to vetratd.com</a>
          </div>
        </div>
      </main>
    </div>
  );
}
