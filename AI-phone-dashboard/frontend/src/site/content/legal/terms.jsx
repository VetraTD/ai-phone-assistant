import { LEGAL_ENTITY, SUPPORT_EMAIL } from "../siteConfig.js";

// The Terms of Service. Governed by Texas law, as the owner decided. Plain
// English, UK spelling. No solicitor has reviewed this text.

export const TERMS = {
  id: "terms",
  title: "Terms of Service",
  updated: "8 September 2026",
  entity: LEGAL_ENTITY,
  intro: (
    <p>
      These are the terms on which {LEGAL_ENTITY}, trading as Vetra, provides its telephone receptionist
      service and dashboard to your business. By requesting access, signing an order with us, or using the
      service, you agree to them on behalf of your business.
    </p>
  ),
  sections: [
    {
      id: "parties",
      heading: "Who these terms are between",
      body: (
        <>
          <p>
            &ldquo;We&rdquo; and &ldquo;us&rdquo; means {LEGAL_ENTITY}, a company in Texas, United States,
            trading as Vetra. &ldquo;You&rdquo; means the business that has agreed to use the service and the
            people you allow to use it.
          </p>
          <p>
            If you are agreeing on behalf of a business, you confirm you have the authority to do so. The
            service is for businesses; it is not offered to consumers.
          </p>
        </>
      ),
    },
    {
      id: "service",
      heading: "The service",
      body: (
        <>
          <p>
            Vetra answers calls to a phone number we provide, in your business&apos;s name. On a call it can
            book, move and cancel appointments in the diary we set up with you, take messages and callback
            requests, answer questions from a knowledge base you control, take the details of a quote request
            without quoting a price, and transfer the call to a person when your rules allow. After each call
            it writes a summary and outcome, keeps a transcript, and alerts you.
          </p>
          <p>
            The receptionist is an automated assistant. It tells callers it is a virtual assistant. Like any
            listener it can mishear or misunderstand, and it works from the information you give it. You are
            responsible for reviewing what it books and records.
          </p>
          <p>
            Calls are not recorded. If the service is unavailable because of a fault, callers may be offered
            ordinary voicemail.
          </p>
          <p>
            The service is not an emergency line and you must not present it as one. Your knowledge base and
            greeting should tell callers how to reach emergency services where that is relevant to your
            business.
          </p>
        </>
      ),
    },
    {
      id: "accounts",
      heading: "Accounts and set-up",
      body: (
        <>
          <p>
            There is no self-serve sign-up. We set your account up with you: number, greeting, opening hours,
            after-hours rules, transfer rules, knowledge base and voice. You can change these in the dashboard
            afterwards.
          </p>
          <p>
            Keep your sign-in details confidential. You are responsible for what is done under your account,
            including by the people you give access to. Tell us straight away if you think an account has been
            compromised.
          </p>
        </>
      ),
    },
    {
      id: "your-responsibilities",
      heading: "Your responsibilities",
      body: (
        <>
          <ul>
            <li>Give us accurate information about your business and keep your knowledge base up to date.</li>
            <li>
              Comply with the laws that apply to your business and its calls, including telephone, consumer and
              data protection law, and any duty to tell callers how their call is handled.
            </li>
            <li>
              For information about callers, you are the controller and we act on your instructions. You must
              have the right to have that information handled as the service handles it, and you must handle
              any caller requests you receive about it.
            </li>
            <li>Do not use the service to collect information you are not entitled to collect.</li>
            <li>Use the dashboard only for your own business.</li>
          </ul>
        </>
      ),
    },
    {
      id: "acceptable-use",
      heading: "Acceptable use",
      body: (
        <>
          <p>You must not, and must not allow anyone else to:</p>
          <ul>
            <li>use the service for anything unlawful, harmful, deceptive or abusive;</li>
            <li>use it to impersonate another business or person;</li>
            <li>try to break, bypass or test its security without our written agreement;</li>
            <li>copy, resell or make the service available to a third party without our written agreement;</li>
            <li>interfere with other customers&apos; use of it.</li>
          </ul>
          <p>We may suspend the service while we investigate a suspected breach of this section.</p>
        </>
      ),
    },
    {
      id: "fees",
      heading: "Fees and payment",
      body: (
        <>
          <p>
            Fees are agreed with you in writing before you go live and set out in your order. We invoice as the
            order says, and payment is due as the order says. Fees exclude taxes unless the order states
            otherwise.
          </p>
          <p>
            If an invoice is not paid when due, we may suspend the service after telling you, and restore it when
            the account is settled. We may change fees at the end of a term by giving you at least 30 days&apos;
            notice in writing.
          </p>
        </>
      ),
    },
    {
      id: "data",
      heading: "Data and privacy",
      body: (
        <p>
          Our <a className="site-link" href="/privacy">Privacy Policy</a> explains what we collect, why and
          for how long, and who processes it for us. It forms part of these terms. Where the law requires a
          written data processing agreement between us, we will enter into one with you.
        </p>
      ),
    },
    {
      id: "ip",
      heading: "Intellectual property",
      body: (
        <>
          <p>
            We own the service, its software and its design. You may use it only as these terms allow. You own
            your business information, your knowledge base and the records of your calls. You give us the right
            to use them to provide the service to you and to fix and improve it.
          </p>
          <p>We may use your business&apos;s name to identify you as a customer only with your permission.</p>
        </>
      ),
    },
    {
      id: "availability",
      heading: "Availability and support",
      body: (
        <>
          <p>
            We work to keep the service available at all times, but we do not promise that it will be
            uninterrupted or error-free, and we do not offer a service-level commitment unless one is written
            into your order. We may take the service down for maintenance and will give notice where we can.
          </p>
          <p>
            Support is by email at{" "}
            <a className="site-link" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
            . We aim to reply within one working day.
          </p>
        </>
      ),
    },
    {
      id: "disclaimers",
      heading: "Disclaimers",
      body: (
        <p>
          To the extent the law allows, the service is provided as it is and as available. We do not warrant
          that transcripts, summaries or bookings will be complete or accurate in every case. The receptionist
          is not a substitute for a person where a person is required, and nothing it says is legal, medical
          or professional advice.
        </p>
      ),
    },
    {
      id: "liability",
      heading: "Limitation of liability",
      body: (
        <>
          <p>
            To the extent the law allows, we are not liable for loss of profit, revenue, business or goodwill,
            or for indirect or consequential loss, arising from the service or these terms.
          </p>
          <p>
            Our total liability to you for all claims in any twelve-month period is limited to the fees you paid
            us for the service in that period.
          </p>
          <p>
            Nothing in these terms limits liability that cannot be limited by law, including for fraud or for
            death or personal injury caused by negligence.
          </p>
        </>
      ),
    },
    {
      id: "termination",
      heading: "Ending the agreement",
      body: (
        <>
          <p>
            Either of us may end the agreement by giving the other at least 30 days&apos; notice in writing, or
            immediately if the other materially breaches these terms and does not put it right within 14 days
            of being asked.
          </p>
          <p>
            When the agreement ends we stop answering your calls and release your number. On request within 30
            days we will give you an export of your call records and appointments, and then delete them, subject
            to the retention described in the Privacy Policy.
          </p>
        </>
      ),
    },
    {
      id: "changes",
      heading: "Changes to these terms",
      body: (
        <p>
          We may change these terms by giving you at least 30 days&apos; notice by email. If you do not accept a
          change you may end the agreement before it takes effect. Using the service after that date means you
          accept the change.
        </p>
      ),
    },
    {
      id: "law",
      heading: "Governing law",
      body: (
        <>
          <p>
            These terms are governed by the laws of the State of Texas, United States, and any dispute will be
            brought in the state or federal courts located in Texas. Each of us submits to that jurisdiction.
          </p>
          <p>Nothing in these terms affects rights you have under law that cannot be excluded by agreement.</p>
        </>
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
