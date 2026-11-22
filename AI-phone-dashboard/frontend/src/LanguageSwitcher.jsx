// LanguageSwitcher.jsx
// The dashboard interface is English only until it is fully translated (owner,
// 2026-11-22). The language picker and the partial Spanish/French/other
// dictionaries were removed; useTranslations() still returns the English
// strings so App.jsx keeps working until the new shell replaces it.

export const TRANSLATIONS = {
  en: {
    // Topbar
    appTitle: "Vetra Dashboard",
    dashboardOverview: "Your calls at a glance for today",
    navDashboard: "Dashboard",
    navAnalytics: "Analytics",
    navAppointments: "Appointments",
    navSettings: "Settings",
    navGuide: "Guide",
    logout: "Logout",

    appointmentsPageTitle: "Appointments",
    appointmentsRangeToday: "Today",
    appointmentsRange7Days: "Next 7 days",
    appointmentsRangeUpcoming: "Upcoming",
    viewCall: "View call",
    noAppointmentsInRange: "No appointments in this range.",

    // KPIs
    dataForToday: "Data for today",
    callsToday: "Calls Today",
    appointmentsToday: "Appointments Today",
    followUpsNeeded: "Follow Ups Needed",
    transferredToHuman: "Transferred to Human",

    // Calls panel
    calls: "Calls",
    filterStatus: "Status",
    filterAll: "All",
    filterCompleted: "Completed",
    filterTransferred: "Transferred",
    filterInProgress: "In progress",
    filterFailed: "Failed",
    filterNoAnswer: "No answer",
    filterBusy: "Busy",
    filterDateRange: "Date Range",
    filterLast24h: "Last 24h",
    filterLast7: "Last 7 days",
    filterLast30: "Last 30 days",
    filterCustom: "Custom",
    filterFrom: "From",
    filterTo: "To",
    filterSentiment: "Sentiment",
    filterPositive: "Positive",
    filterNeutral: "Neutral",
    filterNegative: "Negative",
    filterUnknown: "Unknown",
    filterSummary: "Summary",
    filterHasSummary: "Has summary",
    filterNoSummary: "No summary",
    filterDirection: "Direction",
    filterInbound: "Inbound",
    filterOutbound: "Outbound",
    directionInbound: "Inbound",
    directionOutbound: "Outbound",
    infoDirection: "Direction",
    outcomeAnswersTitle: "Outcome & answers",
    outcomeLabel: "Outcome",
    outcomeNoteLabel: "Note",
    filterCallerSearch: "Caller search",
    filterCallerPlaceholder: "e.g. +4477 or 938887",
    filterOnlyAppointments: "Only calls with appointments",
    filterNeedsFollowUp: "Needs follow up",
    showingCalls: (n, total) => total != null ? `Showing ${n} of ${total} calls` : `Showing ${n} call${n === 1 ? "" : "s"}`,
    loadMore: "Load more",
    exportCallsCsv: "Export calls (CSV)",
    refresh: "Refresh",
    copied: "Copied!",
    copySummary: "Copy summary",
    copyTranscript: "Copy transcript",
    unsavedChanges: "You have unsaved changes. Leave anyway?",
    loadingCalls: "Loading calls...",
    loadingAnalytics: "Loading analytics…",
    reset: "Reset",
    noCallsMatch: "No calls match these filters.",
    noCallsYet: "No calls yet. Once your number receives calls, they’ll show up here.",

    // Call details
    callDetails: "Call Details",
    selectCallPrompt:
      "Select a call on the left to view transcript, appointments, and customer requests.",
    noCallsYetDetails:
      "No calls yet. When your phone number receives a call, you’ll see it here.",
    callInfo: "Call Info",
    infoStatus: "Status",
    infoDuration: "Duration",
    infoStarted: "Started",
    infoSummary: "Summary",
    infoSentiment: "Sentiment",
    noSummaryYet: "No summary yet",
    unknownSentiment: "Unknown",
    sec: "sec",
    transcript: "Transcript",
    aiReceptionist: "Vetra",
    caller: "Caller",
    // Reads as a fault otherwise, and for every call taken before transcripts
    // were switched on it would keep reading as one forever. Says what is
    // true without implying something broke.
    noTranscript: "No transcript for this call. Calls answered before transcripts were switched on don't have one.",
    appointments: "Appointments",
    scheduled: "Scheduled",
    status: "Status",
    notes: "Notes",
    noAppointments: "No appointments were linked to this call.",
    customerRequests: "Customer Requests",
    unknown: "Unknown",
    noRequests: "No customer requests were captured for this call.",
    loadingCallDetails: "Loading call details…",

    // Settings
    businessSettings: "Business Settings",
    businessName: "Business name",
    timezone: "Timezone",
    preferredLanguage: "Preferred language",
    businessPhone: "Business phone",
    setupStatus: "Setup status",
    businessActive: "Business active and phone connected",
    businessNoPhone: "Business created, phone not connected",
    noPhoneConnected: "No phone number connected yet",

    businessDetailsAddress: "Business details & address",
    generalInfo: "General info",
    generalInfoPlaceholder: "e.g. Sunrise Home Services — we handle repairs and maintenance across the metro area.",
    addressLine1: "Address line 1",
    addressLine1Placeholder: "e.g. 4400 Heritage Trace Pkwy, #208",
    addressLine2: "Address line 2",
    addressLine2Placeholder: "Optional",
    city: "City",
    cityPlaceholder: "e.g. Keller",
    stateRegion: "State / Region",
    stateRegionPlaceholder: "e.g. Texas",
    postalCode: "Postal code",
    postalCodePlaceholder: "e.g. 76244",

    aiReceptionistTitle: "Greeting & calls",
    greetingMessage: "Greeting message",
    businessHours: "Business hours",
    businessHoursHint: "Display only; set in your phone provider.",
    afterHoursBehaviour: "After-hours behaviour",
    takeMessage: "Take a message",
    bookLater: "Book later",
    bookAppointment: "Book appointment",
    allowAppointments: "Allow appointment booking",
    allowCallbacks: "Allow callback requests",
    allowMessages: "Allow message taking",

    callHandling: "Call Handling",
    transferPolicy: "Transfer policy",
    neverTransfer: "Never transfer",
    alwaysTransfer: "Always transfer",
    businessHoursOnly: "Business hours only",
    transferPhone: "Transfer phone number",
    emergencyMessage: "Emergency message",
    fallbackInstructions: "Fallback instructions",

    securityFooter:
      "Your data is encrypted and stored on industry-standard infrastructure. Only your account can access your calls and business details.",

    notifications: "Notifications",
    notificationEmail: "Notification email",
    notificationPhone: "Notification phone",

    saveSettings: "Save Settings",
    saving: "Saving...",
    saveDescription:
      "This saves your business name, timezone, preferred language, greeting, after-hours policy, transfer settings, and notifications to the database.",


    // Auth / loading
    checkingSession: "Checking your session",
    checkingSubtitle:
      "Please wait while we securely restore your dashboard access.",
    loadingDashboard: "Loading dashboard",
    loadingSubtitle:
      "We're gathering your business overview, calls, and analytics.",
    couldntLoad: "Couldn't load account",
    signOut: "Sign out",

    summaryCheck: "Summary ✓",
    noSummaryShort: "No summary",
    loadingCallsEllipsis: "Loading calls…",
  },
};

export function useTranslations() {
  return TRANSLATIONS.en;
}
