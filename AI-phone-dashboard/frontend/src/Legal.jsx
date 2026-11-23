import { Link } from "react-router-dom";
import VetraLogo from "./components/VetraLogo";
import "./Legal.css";
import { MARKETING_URL } from "./siteUrl";

// The single contact and SMS help address, used everywhere on this page.
const CONTACT_EMAIL = "josh.tite@vetratd.com";
// A fixed date, not today's: change it whenever the Privacy Policy or Terms
// change, so "Last updated" means what it says.
const LAST_UPDATED = "23 November 2026";

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
            Last updated: {LAST_UPDATED}. Questions?{" "}
            <Link to="/contact" className="legal-link">Contact us</Link> or email {CONTACT_EMAIL}.
          </p>

          <section className="legal-section" id="privacy">
            <h2 className="legal-section-title">Privacy Policy</h2>

            <h3 className="legal-subtitle">1. Who we are and what this policy covers</h3>
            <p>
              Vetra is an AI receptionist service operated by <strong>VetraTD LLC</strong>, a limited liability company registered in Texas, USA (&ldquo;VetraTD&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;). You can contact us about privacy at <strong>{CONTACT_EMAIL}</strong>.
            </p>
            <p>
              This policy explains what personal information we collect, why, who we share it with, and the choices and rights you have. It applies to:
            </p>
            <ul className="legal-list">
              <li><strong>Visitors</strong> to vetratd.com, including people who send us an enquiry.</li>
              <li><strong>Clients</strong>: the businesses that use Vetra, and the people who manage their accounts.</li>
              <li><strong>Callers and contacts</strong>: people who phone a business that uses Vetra, or whom Vetra calls or texts on that business&apos;s behalf.</li>
            </ul>
            <p><strong>Our two roles</strong></p>
            <ul className="legal-list">
              <li>For our website, our own sales and our clients&apos; accounts, <strong>VetraTD decides how your information is used</strong> (we are the &ldquo;controller&rdquo;).</li>
              <li>When Vetra answers or makes calls and texts for a client business, <strong>that business decides how its callers&apos; information is used</strong> and we process it on its instructions (we are the &ldquo;processor&rdquo;). If you called a business that uses Vetra, that business&apos;s own privacy notice applies too, and it is your first point of contact for requests about your information. We will help them respond.</li>
            </ul>
            <p>
              If you are in the UK or EU, this policy is written to meet the UK GDPR, the EU GDPR and the Data Protection Act 2018. If you are in the US, it also explains your choices under applicable US privacy laws.
            </p>

            <h3 className="legal-subtitle">2. What information we collect</h3>
            <p><strong>If you visit our website or contact us</strong></p>
            <ul className="legal-list">
              <li>Your name, email address and message.</li>
              <li>Your mobile number and whether you agreed to receive texts, with the date and time you agreed.</li>
              <li>Basic technical information when you browse, such as your IP address, browser type and the pages you visit.</li>
            </ul>
            <p><strong>If you are a client</strong></p>
            <ul className="legal-list">
              <li>Account details: your name, business name, email address, phone number, timezone and login details.</li>
              <li>Business set-up: opening hours, services, prices, booking rules and anything else you give us to configure your receptionist.</li>
              <li>Notification settings: where you want call summaries and alerts sent (email, text or app).</li>
              <li>Billing details: your plan and payment history. When card payments are available they will be handled by our payment provider, Stripe; we will not see or store your full card number.</li>
              <li>Support messages and feedback.</li>
            </ul>
            <p><strong>If you call, or are called by, a business that uses Vetra</strong></p>
            <ul className="legal-list">
              <li>Your phone number and the date, time and length of the call.</li>
              <li>What you say on the call, and a written transcript and summary of it.</li>
              <li>A voicemail recording, if you leave one when our assistant is unavailable.</li>
              <li>Details you give, such as your name, email, the reason for your call and any appointment booked.</li>
              <li>Texts sent to or from you about the call, if you agreed to receive them.</li>
            </ul>
            <p>
              We do not ask for sensitive information such as health details. Some businesses that use Vetra, such as clinics, may receive calls where callers mention it. Our assistant is instructed not to ask for it, and the business is responsible for how it handles anything you choose to share.
            </p>

            <h3 className="legal-subtitle">3. How we use it and our legal bases</h3>
            <div className="legal-table-wrap">
              <table className="legal-table">
                <thead>
                  <tr>
                    <th scope="col">What we use it for</th>
                    <th scope="col">Legal basis (UK and EU)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Running Vetra for our clients: answering and making calls, booking appointments, writing summaries and sending alerts</td>
                    <td>Performing our contract with the client; for callers, the client&apos;s legitimate interest in handling its calls</td>
                  </tr>
                  <tr>
                    <td>Setting up and managing client accounts, billing and support</td>
                    <td>Performing our contract</td>
                  </tr>
                  <tr>
                    <td>Replying to enquiries and arranging demos</td>
                    <td>Legitimate interests (responding to people who contact us)</td>
                  </tr>
                  <tr>
                    <td>Sending texts you asked for</td>
                    <td>Your consent, which you can withdraw at any time</td>
                  </tr>
                  <tr>
                    <td>Keeping the service secure, preventing fraud and fixing problems</td>
                    <td>Legitimate interests</td>
                  </tr>
                  <tr>
                    <td>Improving Vetra, using information about how the service performs</td>
                    <td>Legitimate interests</td>
                  </tr>
                  <tr>
                    <td>Keeping tax, accounting and legal records</td>
                    <td>Legal obligation</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              We do not sell your personal information, and we do not use it for third-party advertising.
            </p>
            <p>
              We will only send you marketing emails if you have agreed to them, or if you are a client and we are telling you about similar services. Every marketing email lets you unsubscribe.
            </p>

            <h3 className="legal-subtitle">4. Phone calls, AI and transcripts</h3>
            <p>
              <strong>You are talking to an AI.</strong> Calls are answered or made by an automated AI assistant. It tells you it is an AI at the start of the call, and it will confirm this if you ask. A person from the business can follow up if you prefer.
            </p>
            <p>
              <strong>How the AI works.</strong> As you speak, your voice is converted to text and processed by an AI model so the assistant can understand you and reply. We use Google&apos;s Gemini models through Google Cloud for this. Our providers process call content to deliver the service to us, under business terms that restrict them from using it to train their general AI models. We do not use your calls to train AI models of our own.
            </p>
            <p>
              <strong>Transcripts and summaries.</strong> We create a written transcript and a short summary of each call so the business can see who called and why. These appear in the business&apos;s Vetra dashboard and may be sent to them by email or text.
            </p>
            <p>
              <strong>Recordings.</strong> Vetra does not record the audio of normal calls. Your voice is processed live so the assistant can respond, and we keep only the written transcript and summary described above. If our assistant is unavailable, your call may go to a voicemail, which records the message you leave so the business can listen to it. Voicemails are kept for up to 30 days.
            </p>
            <p>
              <strong>Automated decisions.</strong> The assistant may book an appointment, take a message or pass your details to the business. It does not make decisions that have legal or similarly significant effects on you. You can always ask to speak to, or be called back by, a person.
            </p>

            <h3 className="legal-subtitle" id="sms-privacy">5. Text messaging (SMS)</h3>
            <p>
              If you give us your mobile number and agree to receive text messages, for example by ticking the box on our contact form or by turning on SMS alerts as a client, we use that number only to send the messages you agreed to receive. These include demo confirmations, reminders, replies to your enquiry and, for clients, alerts about calls and bookings.
            </p>
            <p>
              <strong>No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging opt-in data and consent are not shared with any third party.</strong> We share your number only with the telecoms provider that delivers our messages (Twilio), and only for that purpose.
            </p>
            <p>
              Message frequency varies. Message and data rates may apply. Reply <strong>STOP</strong> at any time to stop receiving messages, or <strong>HELP</strong> for help. You can also email {CONTACT_EMAIL}.
            </p>
            <p>
              Texts that a client business sends to its own customers through Vetra are sent on that business&apos;s behalf, under its own consent and opt-out process.
            </p>

            <h3 className="legal-subtitle">6. Who we share it with</h3>
            <p>
              We use trusted service providers to run Vetra. They may only use your information to provide their service to us, under contracts that require them to protect it.
            </p>
            <div className="legal-table-wrap">
              <table className="legal-table">
                <thead>
                  <tr>
                    <th scope="col">Provider</th>
                    <th scope="col">What they do for us</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><strong>Twilio</strong></td>
                    <td>Phone numbers, calls and text messages</td>
                  </tr>
                  <tr>
                    <td><strong>Google Cloud and Firebase</strong> (including Gemini)</td>
                    <td>Hosting our dashboard and services, data storage and the AI that powers the assistant</td>
                  </tr>
                  <tr>
                    <td><strong>Vercel</strong></td>
                    <td>Hosting our website</td>
                  </tr>
                  <tr>
                    <td><strong>Stripe</strong></td>
                    <td>Taking and managing payments, once card payments are available</td>
                  </tr>
                  <tr>
                    <td><strong>Our email service provider</strong></td>
                    <td>Sending account emails, call summaries and enquiry notifications</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>We also share information:</p>
            <ul className="legal-list">
              <li><strong>With the client business</strong> you called or that called you, because the service exists to give them your call details.</li>
              <li><strong>With tools a client connects</strong>, such as their calendar or CRM, when the client asks us to.</li>
              <li><strong>If the law requires it</strong>, or to protect the rights, safety or property of VetraTD, our clients or others.</li>
              <li><strong>If our business is sold or reorganised</strong>, with the new owner, who must keep protecting your information under this policy.</li>
            </ul>

            <h3 className="legal-subtitle">7. International transfers, retention and security</h3>
            <p>
              <strong>Where your information goes.</strong> VetraTD is a US company, and our providers operate in the US, the UK and elsewhere. Where we can, we process UK callers&apos; data in Google Cloud&apos;s London region. When information from the UK or EU is transferred to the US or another country, we rely on recognised safeguards, such as the UK&ndash;US Data Bridge and EU&ndash;US Data Privacy Framework (where the provider is certified) or the UK International Data Transfer Addendum and EU Standard Contractual Clauses.
            </p>
            <p><strong>How long we keep it.</strong></p>
            <div className="legal-table-wrap">
              <table className="legal-table">
                <thead>
                  <tr>
                    <th scope="col">Information</th>
                    <th scope="col">How long</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Transcripts, summaries and booking details</td>
                    <td>While the client has an account, then deleted within 90 days of the account closing</td>
                  </tr>
                  <tr>
                    <td>Website enquiries</td>
                    <td>2 years from your last contact</td>
                  </tr>
                  <tr>
                    <td>Text messaging consent and opt-out records</td>
                    <td>For as long as we text you, then 4 years, so we can prove consent</td>
                  </tr>
                  <tr>
                    <td>Voicemail recordings</td>
                    <td>Up to 30 days</td>
                  </tr>
                  <tr>
                    <td>Client account and billing records</td>
                    <td>For as long as the account is open, then 7 years for tax and legal reasons</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>Clients can ask us to delete their callers&apos; data sooner.</p>
            <p>
              <strong>Keeping it safe.</strong> We use encryption in transit and at rest, access controls, two-factor authentication on our admin accounts, and checks that requests to our systems are genuine. Only people who need access to run the service have it. No system is completely secure, but if a breach affects your information we will tell you and the relevant regulator where the law requires.
            </p>

            <h3 className="legal-subtitle">8. Your rights, children, changes and contact</h3>
            <p>
              <strong>Your rights.</strong> Depending on where you live, you can ask us to:
            </p>
            <ul className="legal-list">
              <li>give you a copy of your information;</li>
              <li>correct it if it is wrong;</li>
              <li>delete it;</li>
              <li>restrict or object to how we use it, including for marketing;</li>
              <li>send it to you or another organisation in a portable format;</li>
              <li>withdraw consent at any time, for example by replying STOP to texts.</li>
            </ul>
            <p>
              Email <strong>{CONTACT_EMAIL}</strong> and we will reply within one month. We may need to confirm your identity first. If your request is about a call to a business that uses Vetra, we will pass it to that business and help them respond. We will not treat you differently for using your rights.
            </p>
            <p>
              <strong>Complaints.</strong> If you are in the UK, you can complain to the Information Commissioner&apos;s Office (ico.org.uk). If you are in the EU, you can complain to your local data protection authority. We would appreciate the chance to sort it out first.
            </p>
            <p>
              <strong>Cookies.</strong> Our website uses cookies that are needed for it to work, such as keeping you logged in to the dashboard. We do not use advertising cookies. If we add analytics or marketing cookies, we will ask for your consent first.
            </p>
            <p>
              <strong>Children.</strong> Vetra is a service for businesses and is not aimed at children. We do not knowingly collect information from anyone under 18 except where they call a business that uses Vetra.
            </p>
            <p>
              <strong>Changes.</strong> We may update this policy. The &ldquo;Last updated&rdquo; date will change, and we will tell clients by email about significant changes.
            </p>
            <p>
              <strong>Contact.</strong> VetraTD LLC, Texas, USA. Email: {CONTACT_EMAIL}.
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
              <a href={`mailto:${CONTACT_EMAIL}`} className="legal-link">{CONTACT_EMAIL}</a>. Carriers are not liable for delayed or undelivered messages. See the Privacy Policy above for how we handle your mobile information.
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
