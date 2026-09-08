import { HOSTING_REGION, LEGAL_ENTITY, SUPPORT_EMAIL } from "../siteConfig.js";

// The Privacy Policy. Plain English, UK spelling. Every statement here
// describes what the system does today; when the system changes, this file
// changes and `updated` moves. No solicitor has reviewed this text.

export const PRIVACY = {
  id: "privacy",
  title: "Privacy Policy",
  updated: "8 September 2026",
  entity: LEGAL_ENTITY,
  intro: (
    <p>
      This policy explains what {LEGAL_ENTITY}, trading as Vetra, collects, why, where it is kept, and
      what you can do about it. It covers the businesses that use Vetra, the people who work in them, and
      the people who phone a business that uses Vetra.
    </p>
  ),
  sections: [
    {
      id: "who-we-are",
      heading: "Who we are",
      body: (
        <>
          <p>
            Vetra is a telephone receptionist service provided by {LEGAL_ENTITY}, a company in Texas, United
            States. It answers a business&apos;s phone, books appointments in that business&apos;s diary,
            takes messages and writes down what was said.
          </p>
          <p>
            We serve businesses in the United Kingdom first, so UK data protection law (the UK GDPR and the
            Data Protection Act 2018) applies to what we do with information about people in the UK. Laws in
            the United States, including Texas law, also apply to us.
          </p>
          <p>
            Questions about this policy, and any request about your information, go to{" "}
            <a className="site-link" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        </>
      ),
    },
    {
      id: "roles",
      heading: "Customers and callers",
      body: (
        <>
          <p>Two kinds of people are involved, and our role is different for each.</p>
          <p>
            <strong>Customers</strong> are the businesses that use Vetra, and the people in them who use the
            dashboard. For their account and business information we decide how the data is used, so we are
            the controller.
          </p>
          <p>
            <strong>Callers</strong> are the people who phone a customer&apos;s number. We handle their call on
            the customer&apos;s behalf and under the customer&apos;s instructions, so for callers&apos;
            information the customer is the controller and we are the processor. A caller who wants to know
            what a business holds about them, or wants it deleted, can ask the business or ask us and we will
            pass it on and carry out the request.
          </p>
        </>
      ),
    },
    {
      id: "what-we-collect",
      heading: "What we collect",
      body: (
        <>
          <h3>From customers</h3>
          <ul>
            <li>Your name, email address and sign-in details (sign-in is provided by Google Identity Platform).</li>
            <li>
              Your business&apos;s name, phone numbers, opening hours, services, the knowledge base you give
              the receptionist, your after-hours and transfer rules, your chosen voice, and where you want
              alerts sent.
            </li>
            <li>Messages you send us, including through the request-access form on this site.</li>
          </ul>
          <h3>From callers, on behalf of the customer</h3>
          <ul>
            <li>The number the caller rang from and the time of the call.</li>
            <li>A transcript of the call: the words spoken, as text.</li>
            <li>A written summary of the call and its outcome.</li>
            <li>
              Anything the caller gives to be written down: a name, a contact number, an appointment, a
              message, a request for a quote.
            </li>
          </ul>
          <h3>Technical</h3>
          <ul>
            <li>Server logs needed to run and secure the service.</li>
            <li>
              Error reports when something goes wrong, limited to a short list of technical fields. Free text
              from calls is not included on purpose.
            </li>
          </ul>
          <p>
            <strong>Calls are not recorded.</strong> No audio of a conversation is stored. If the receptionist
            is unavailable because of a fault, callers may be offered ordinary voicemail; those messages are
            recorded audio held by our telephony provider until we delete them.
          </p>
        </>
      ),
    },
    {
      id: "why",
      heading: "Why we use it",
      body: (
        <>
          <ul>
            <li>To answer a customer&apos;s calls, book appointments, take messages and transfer calls.</li>
            <li>To show customers their calls, summaries, transcripts and appointments in the dashboard.</li>
            <li>To alert customers that a call happened, by email or SMS, with a link rather than the details.</li>
            <li>To reply to people who contact us.</li>
            <li>To keep the service secure and working, and to fix faults.</li>
            <li>To improve how the receptionist handles calls, by reading transcripts of calls that went wrong.</li>
          </ul>
          <p>
            We do not sell personal information. We do not use call content to train our own models. Our AI
            providers process the words of a call to produce the receptionist&apos;s replies, under their own
            terms, as described below.
          </p>
        </>
      ),
    },
    {
      id: "legal-bases",
      heading: "Our legal bases under UK GDPR",
      body: (
        <>
          <ul>
            <li>
              <strong>Contract</strong>: to provide the service a customer has agreed to.
            </li>
            <li>
              <strong>Legitimate interests</strong>: answering a customer&apos;s calls on their behalf, keeping
              the service secure, and fixing faults. We balance these against callers&apos; interests, and the
              receptionist tells every caller that it is a virtual assistant.
            </li>
            <li>
              <strong>Consent</strong>: where the law requires it, for example before sending a text message to a
              caller. That feature is off unless a business turns it on and consent has been recorded.
            </li>
            <li>
              <strong>Legal obligation</strong>: where we must keep or disclose information by law.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "providers",
      heading: "Who processes it for us",
      body: (
        <>
          <p>We use these providers. Each processes only what its job needs.</p>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>What it does</th>
                <th>Where</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Google Cloud</td>
                <td>Hosting, database, sign-in, logs and backups.</td>
                <td>{HOSTING_REGION}</td>
              </tr>
              <tr>
                <td>Google AI Studio (Gemini)</td>
                <td>The conversation model that understands the caller and produces the receptionist&apos;s replies.</td>
                <td>Google&apos;s infrastructure, which may be outside the UK.</td>
              </tr>
              <tr>
                <td>Twilio</td>
                <td>Carries the phone call, provides the phone number, sends SMS alerts.</td>
                <td>United States and international carrier networks.</td>
              </tr>
              <tr>
                <td>Deepgram</td>
                <td>Turns speech into text on some calls.</td>
                <td>European endpoint where available; otherwise United States.</td>
              </tr>
              <tr>
                <td>ElevenLabs</td>
                <td>Turns the receptionist&apos;s text into speech on some calls.</td>
                <td>United States.</td>
              </tr>
              <tr>
                <td>Microsoft 365</td>
                <td>Sends our email, including alerts and replies to you.</td>
                <td>United Kingdom and European Union.</td>
              </tr>
              <tr>
                <td>Sentry</td>
                <td>Collects error reports, limited to technical fields.</td>
                <td>United States.</td>
              </tr>
            </tbody>
          </table>
          <p>
            Where a provider processes information outside the UK, we rely on that provider&apos;s data
            processing terms and the transfer safeguards it offers, such as the UK Addendum to the standard
            contractual clauses. We will update this list when providers change.
          </p>
        </>
      ),
    },
    {
      id: "retention",
      heading: "How long we keep it",
      body: (
        <>
          <p>
            Call records, transcripts, summaries, messages and appointments are kept for as long as the
            customer&apos;s account is open, or until the customer asks us to delete them. There is no
            automatic expiry today; when we introduce one, this policy will say what it is.
          </p>
          <p>
            Encrypted backups are kept for up to 35 days. Information deleted from the live service can remain
            in a backup for that period and is then gone.
          </p>
          <p>
            Account information is kept while the account is open and deleted when it closes, except where we
            must keep a record by law, for example for tax.
          </p>
          <p>Messages sent to us by email or through this site are kept in our mailbox.</p>
        </>
      ),
    },
    {
      id: "your-rights",
      heading: "Your rights",
      body: (
        <>
          <p>If you are in the UK you have the right to:</p>
          <ul>
            <li>ask for a copy of the information we hold about you;</li>
            <li>have it corrected if it is wrong;</li>
            <li>have it deleted, unless we must keep it;</li>
            <li>restrict or object to how we use it;</li>
            <li>receive it in a portable form;</li>
            <li>
              complain to the Information Commissioner&apos;s Office at ico.org.uk if you think we have handled
              your information badly. We would rather you told us first.
            </li>
          </ul>
          <p>
            Callers can ask for their details to be erased. We erase transcripts and messages outright and
            remove personal details from the call and appointment records. Backups clear within 35 days.
          </p>
          <p>
            People in US states with privacy laws may have similar rights. Whoever you are, write to{" "}
            <a className="site-link" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>{" "}
            and we will respond within one month.
          </p>
        </>
      ),
    },
    {
      id: "cookies",
      heading: "Cookies and tracking",
      body: (
        <>
          <p>
            This website sets no cookies and uses no analytics or advertising trackers. Its fonts are served
            from our own servers rather than a third party.
          </p>
          <p>
            The dashboard stores a sign-in token in your browser so you stay signed in, and signs you out after
            a period of inactivity. That is the only browser storage it uses.
          </p>
        </>
      ),
    },
    {
      id: "children",
      heading: "Children",
      body: (
        <p>
          Vetra is a service for businesses and is not directed at children. A child may of course phone a
          business that uses it; what they say is handled like any other call, on the business&apos;s behalf.
        </p>
      ),
    },
    {
      id: "security",
      heading: "Security",
      body: (
        <>
          <p>
            Information is encrypted in transit and at rest by our hosting provider. Access is limited to the
            people who need it to run the service. Sign-in is handled by Google Identity Platform, and dashboard
            sessions end automatically after inactivity.
          </p>
          <p>
            No system is perfectly secure. If we discover a breach that affects you, we will tell you and any
            regulator we must, as the law requires.
          </p>
        </>
      ),
    },
    {
      id: "changes",
      heading: "Changes to this policy",
      body: (
        <p>
          When this policy changes, the date at the top changes with it. We tell customers about material
          changes by email before they take effect.
        </p>
      ),
    },
    {
      id: "contact",
      heading: "Contact",
      body: (
        <p>
          {LEGAL_ENTITY}, trading as Vetra.{" "}
          <a className="site-link" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      ),
    },
  ],
};
