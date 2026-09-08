// Facts the whole public site reads. Change them here, nowhere else.

// The demo line is deliberately off. Set a number (e.g. "+44 20 3xxx xxxx")
// to bring the call links back in the header, mobile menu and footer; while
// null, nothing that depends on it renders.
export const DEMO_NUMBER = null;

export const SUPPORT_EMAIL = "support@vetratd.com";

export const LEGAL_ENTITY = "VetraTD LLC";

// The one sanctioned onboarding claim.
export const GO_LIVE = "live in 3 business days";

export const LANGUAGES = ["English", "Spanish", "French"];

// Where the receptionist's data lives. Stated on the site and in Privacy.
export const HOSTING_REGION = "London (Google Cloud europe-west2)";

export const NAV_ITEMS = [
  { label: "Features", to: "/features" },
  { label: "About", to: "/about", needsAbout: true },
  { label: "Contact", to: "/contact" },
];

export const FOOTER_COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "Features", to: "/features" },
      { label: "Hear a call", to: "/#call" },
      { label: "Questions", to: "/#questions" },
    ],
  },
  {
    heading: "Company",
    links: [
      { label: "About", to: "/about", needsAbout: true },
      { label: "Request access", to: "/contact" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Privacy Policy", to: "/privacy" },
      { label: "Terms of Service", to: "/terms" },
    ],
  },
];
