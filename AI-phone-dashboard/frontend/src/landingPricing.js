export const LANDING_PRICES = {
  USD: { symbol: "$", amount: 149 },
  GBP: { symbol: "£", amount: 119 },
};

export const CURRENCY_SYMBOLS = {
  USD: "$",
  GBP: "£",
};

export const ANNUAL_FREE_MONTHS = 2;

export function getDisplayPrice(plan, currency, billing) {
  const monthly = plan.price?.[currency];
  if (monthly == null) return null;
  if (billing === "annual") {
    const annualTotal = monthly * (12 - ANNUAL_FREE_MONTHS);
    return {
      perMonth: Math.round(annualTotal / 12),
      annualTotal,
    };
  }
  return { perMonth: monthly, annualTotal: null };
}

export const LANDING_PLANS = [
  {
    id: "starter",
    name: "Core",
    tagline: "For small businesses that can't afford a missed call.",
    price: { USD: 149, GBP: 119 },
    features: [
      "1 business phone number",
      "24/7 AI call answering",
      "Unlimited calls",
      "Natural, human-like voice",
      "Answers common questions (FAQs)",
      "After-hours call handling",
      "Message taking & call summaries",
      "Email notifications",
      "Single dashboard login",
    ],
    cta: "Get started",
    highlighted: false,
  },
  {
    id: "professional",
    name: "Professional",
    tagline: "For growing businesses that take bookings.",
    price: { USD: 299, GBP: 239 },
    features: [
      "Appointment booking",
      "SMS follow-up to callers",
      "Call transfers to your team",
      "SMS + email notifications",
      "Up to 5 dashboard logins",
    ],
    cta: "Get started",
    highlighted: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    tagline: "For high volume teams that need a tailored setup and dedicated support.",
    custom: true,
    features: [
      "Calendar & EHR integrations",
      "Custom cloned voice",
      "Bilingual calls",
      "Custom call handling rules",
      "Priority support",
      "Unlimited dashboard logins",
    ],
    cta: "Talk to us",
    highlighted: false,
  },
];

export const COST_COMPARISON = {
  USD: {
    human: { monthly: "$3,500", annual: "$42,000+", barPct: 100 },
    ai: { monthly: "$149", annual: "$1,788", barPct: 4 },
    savings: "$40,000+",
    savingsPct: 96,
  },
  GBP: {
    human: { monthly: "£2,800", annual: "£33,600+", barPct: 100 },
    ai: { monthly: "£119", annual: "£1,428", barPct: 4 },
    savings: "£32,000+",
    savingsPct: 96,
  },
};

export const COMPARISON_GROUPS = [
  {
    name: "Call handling",
    rows: [
      { label: "24/7 AI call answering", values: { starter: true, professional: true, enterprise: true } },
      { label: "Unlimited calls", values: { starter: true, professional: true, enterprise: true } },
      { label: "Natural, human-like voice", values: { starter: true, professional: true, enterprise: true } },
      { label: "Answers common questions (FAQs)", values: { starter: true, professional: true, enterprise: true } },
      { label: "After-hours call handling", values: { starter: true, professional: true, enterprise: true } },
      { label: "Message taking & call summaries", values: { starter: true, professional: true, enterprise: true } },
      { label: "Call transfers to your team", values: { starter: false, professional: true, enterprise: true } },
    ],
  },
  {
    name: "Bookings & follow-up",
    rows: [
      { label: "Appointment booking", values: { starter: false, professional: true, enterprise: true } },
      { label: "SMS follow-up to callers", values: { starter: false, professional: true, enterprise: true } },
    ],
  },
  {
    name: "Notifications",
    rows: [
      { label: "Email notifications", values: { starter: true, professional: true, enterprise: true } },
      { label: "SMS notifications", values: { starter: false, professional: true, enterprise: true } },
    ],
  },
  {
    name: "Advanced",
    rows: [
      { label: "Calendar & EHR integrations", values: { starter: false, professional: false, enterprise: true } },
      { label: "Custom cloned voice", values: { starter: false, professional: false, enterprise: true } },
      { label: "Bilingual calls", values: { starter: false, professional: false, enterprise: true } },
      { label: "Custom call handling rules", values: { starter: false, professional: false, enterprise: true } },
    ],
  },
  {
    name: "Account & support",
    rows: [
      { label: "Business phone numbers", values: { starter: "1", professional: "1", enterprise: "Multiple" } },
      { label: "Dashboard logins", values: { starter: "1", professional: "Up to 5", enterprise: "Unlimited" } },
      { label: "Priority support", values: { starter: false, professional: false, enterprise: true } },
    ],
  },
];

const STORAGE_KEY = "vetra-landing-currency";

export function detectCurrencyFromLocale() {
  const langs =
    typeof navigator !== "undefined"
      ? [navigator.language, ...(navigator.languages || [])]
      : [];

  for (const lang of langs) {
    const normalized = String(lang || "").toLowerCase();
    if (normalized.endsWith("-gb")) return "GBP";
  }

  return "USD";
}

export function getStoredCurrency() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "USD" || stored === "GBP") return stored;
  } catch {
    // ignore private browsing / blocked storage
  }
  return null;
}

export function storeCurrency(currency) {
  try {
    localStorage.setItem(STORAGE_KEY, currency);
  } catch {
    // ignore
  }
}

export function formatLandingPrice(currency) {
  const price = LANDING_PRICES[currency] || LANDING_PRICES.USD;
  return `${price.symbol}${price.amount}/mo`;
}
