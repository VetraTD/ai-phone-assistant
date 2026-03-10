// LanguageSwitcher.jsx
// Drop this file next to App.jsx and import it.
// Usage: <LanguageSwitcher lang={lang} onChange={setLang} />

export const LANGUAGES = [
  { code: "en", label: "EN", flag: "🇬🇧", name: "English" },
  { code: "es", label: "ES", flag: "🇪🇸", name: "Español" },
  { code: "fr", label: "FR", flag: "🇫🇷", name: "Français" },
];

export function LanguageSwitcher({ lang, onChange }) {
  return (
    <div
      style={{
        display: "inline-flex",
        padding: 4,
        borderRadius: 14,
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.08)",
        gap: 4,
      }}
    >
      {LANGUAGES.map((l) => {
        const active = lang === l.code;
        return (
          <button
            key={l.code}
            title={l.name}
            onClick={() => onChange(l.code)}
            style={{
              height: 40,
              padding: "0 12px",
              borderRadius: 10,
              border: active
                ? "1px solid rgba(88,164,255,0.32)"
                : "1px solid transparent",
              background: active ? "rgba(88,164,255,0.16)" : "transparent",
              color: active ? "#bcd3ff" : "#9bacbf",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 6,
              transition: "all 0.15s ease",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ fontSize: 15 }}>{l.flag}</span>
            {l.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Translations ────────────────────────────────────────────────────────────

export const TRANSLATIONS = {
  en: {
    // Topbar
    appTitle: "AI Call Dashboard",
    navDashboard: "Dashboard",
    navSettings: "Settings",
    logout: "Logout",

    // KPIs
    callsToday: "Calls Today",
    appointmentsToday: "Appointments Today",
    followUpsNeeded: "Follow Ups Needed",
    positiveCalls: "Positive Calls",

    // Calls panel
    calls: "Calls",
    filterStatus: "Status",
    filterAll: "All",
    filterCompleted: "Completed",
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
    filterCallerSearch: "Caller search",
    filterCallerPlaceholder: "e.g. +4477 or 938887",
    filterOnlyAppointments: "Only calls with appointments",
    filterNeedsFollowUp: "Needs follow up",
    showingCalls: (n) => `Showing ${n} call${n === 1 ? "" : "s"}`,
    loadingCalls: "Loading calls...",
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
    aiReceptionist: "AI Receptionist",
    caller: "Caller",
    noTranscript: "No transcript was captured for this call.",
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
    generalInfoPlaceholder: "e.g. Excel Cardiac Care is a specialized medical practice.",
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

    aiReceptionistTitle: "AI Receptionist",
    greetingMessage: "Greeting message",
    businessHours: "Business hours",
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

    billingPlan: "Billing & Plan",
    currentPlan: "Current plan",
    billingStatus: "Billing status",
    usageThisMonth: "Usage this month",
    comingSoon: "Coming soon",
    phoneNumber: "Phone number",
    notConnectedYet: "Not connected yet",
    stripeComing:
      "Stripe billing and subscription controls can live here next.",

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

  es: {
    appTitle: "Panel de Llamadas IA",
    navDashboard: "Panel",
    navSettings: "Configuración",
    logout: "Cerrar sesión",

    callsToday: "Llamadas hoy",
    appointmentsToday: "Citas hoy",
    followUpsNeeded: "Seguimientos pendientes",
    positiveCalls: "Llamadas positivas",

    calls: "Llamadas",
    filterStatus: "Estado",
    filterAll: "Todos",
    filterCompleted: "Completadas",
    filterInProgress: "En curso",
    filterFailed: "Fallidas",
    filterNoAnswer: "Sin respuesta",
    filterBusy: "Ocupado",
    filterDateRange: "Rango de fechas",
    filterLast24h: "Últimas 24h",
    filterLast7: "Últimos 7 días",
    filterLast30: "Últimos 30 días",
    filterCustom: "Personalizado",
    filterFrom: "Desde",
    filterTo: "Hasta",
    filterSentiment: "Sentimiento",
    filterPositive: "Positivo",
    filterNeutral: "Neutral",
    filterNegative: "Negativo",
    filterUnknown: "Desconocido",
    filterSummary: "Resumen",
    filterHasSummary: "Con resumen",
    filterNoSummary: "Sin resumen",
    filterCallerSearch: "Buscar llamante",
    filterCallerPlaceholder: "ej. +3477 o 938887",
    filterOnlyAppointments: "Solo llamadas con citas",
    filterNeedsFollowUp: "Necesita seguimiento",
    showingCalls: (n) => `Mostrando ${n} llamada${n === 1 ? "" : "s"}`,
    loadingCalls: "Cargando llamadas...",
    reset: "Restablecer",
    noCallsMatch: "Ninguna llamada coincide con estos filtros.",
    noCallsYet: "Aún no hay llamadas. Cuando tu número reciba llamadas, aparecerán aquí.",

    callDetails: "Detalles de llamada",
    selectCallPrompt:
      "Selecciona una llamada a la izquierda para ver la transcripción, citas y solicitudes.",
    noCallsYetDetails:
      "Aún no hay llamadas. Cuando tu número reciba una llamada, la verás aquí.",
    callInfo: "Info de llamada",
    infoStatus: "Estado",
    infoDuration: "Duración",
    infoStarted: "Iniciada",
    infoSummary: "Resumen",
    infoSentiment: "Sentimiento",
    noSummaryYet: "Sin resumen aún",
    unknownSentiment: "Desconocido",
    sec: "seg",
    transcript: "Transcripción",
    aiReceptionist: "Recepcionista IA",
    caller: "Llamante",
    noTranscript: "No se capturó transcripción para esta llamada.",
    appointments: "Citas",
    scheduled: "Programada",
    status: "Estado",
    notes: "Notas",
    noAppointments: "No hay citas vinculadas a esta llamada.",
    customerRequests: "Solicitudes del cliente",
    unknown: "Desconocido",
    noRequests: "No se capturaron solicitudes para esta llamada.",
    loadingCallDetails: "Cargando detalles…",

    businessSettings: "Configuración del negocio",
    businessName: "Nombre del negocio",
    timezone: "Zona horaria",
    preferredLanguage: "Idioma preferido",
    businessPhone: "Teléfono del negocio",
    setupStatus: "Estado de configuración",
    businessActive: "Negocio activo y teléfono conectado",
    businessNoPhone: "Negocio creado, teléfono no conectado",
    noPhoneConnected: "Sin número de teléfono conectado",

    businessDetailsAddress: "Datos del negocio y dirección",
    generalInfo: "Info general",
    generalInfoPlaceholder: "ej. Excel Cardiac Care es una práctica médica especializada.",
    addressLine1: "Dirección línea 1",
    addressLine1Placeholder: "ej. 4400 Heritage Trace Pkwy, #208",
    addressLine2: "Dirección línea 2",
    addressLine2Placeholder: "Opcional",
    city: "Ciudad",
    cityPlaceholder: "ej. Keller",
    stateRegion: "Estado / Región",
    stateRegionPlaceholder: "ej. Texas",
    postalCode: "Código postal",
    postalCodePlaceholder: "ej. 76244",

    aiReceptionistTitle: "Recepcionista IA",
    greetingMessage: "Mensaje de bienvenida",
    businessHours: "Horario comercial",
    afterHoursBehaviour: "Comportamiento fuera de horario",
    takeMessage: "Tomar un mensaje",
    bookLater: "Reservar más tarde",
    bookAppointment: "Reservar cita",
    allowAppointments: "Permitir reserva de citas",
    allowCallbacks: "Permitir solicitudes de devolución",
    allowMessages: "Permitir tomar mensajes",

    callHandling: "Gestión de llamadas",
    transferPolicy: "Política de transferencia",
    neverTransfer: "Nunca transferir",
    alwaysTransfer: "Siempre transferir",
    businessHoursOnly: "Solo en horario comercial",
    transferPhone: "Número de transferencia",
    emergencyMessage: "Mensaje de emergencia",
    fallbackInstructions: "Instrucciones de respaldo",

    billingPlan: "Facturación y plan",
    currentPlan: "Plan actual",
    billingStatus: "Estado de facturación",
    usageThisMonth: "Uso este mes",
    comingSoon: "Próximamente",
    phoneNumber: "Número de teléfono",
    notConnectedYet: "Aún no conectado",
    stripeComing:
      "Los controles de facturación y suscripción de Stripe irán aquí.",

    notifications: "Notificaciones",
    notificationEmail: "Email de notificación",
    notificationPhone: "Teléfono de notificación",

    saveSettings: "Guardar configuración",
    saving: "Guardando...",
    saveDescription:
      "Guarda el nombre, zona horaria, idioma, saludo, política fuera de horario, transferencia y notificaciones.",

    checkingSession: "Verificando tu sesión",
    checkingSubtitle:
      "Espera mientras restauramos tu acceso al panel de forma segura.",
    loadingDashboard: "Cargando panel",
    loadingSubtitle: "Recopilando tu resumen de negocio, llamadas y análisis.",
    couldntLoad: "No se pudo cargar la cuenta",
    signOut: "Cerrar sesión",

    summaryCheck: "Resumen ✓",
    noSummaryShort: "Sin resumen",
    loadingCallsEllipsis: "Cargando llamadas…",
  },

  fr: {
    appTitle: "Tableau de bord IA",
    navDashboard: "Tableau de bord",
    navSettings: "Paramètres",
    logout: "Déconnexion",

    callsToday: "Appels aujourd'hui",
    appointmentsToday: "Rendez-vous aujourd'hui",
    followUpsNeeded: "Suivis nécessaires",
    positiveCalls: "Appels positifs",

    calls: "Appels",
    filterStatus: "Statut",
    filterAll: "Tous",
    filterCompleted: "Terminés",
    filterInProgress: "En cours",
    filterFailed: "Échoués",
    filterNoAnswer: "Sans réponse",
    filterBusy: "Occupé",
    filterDateRange: "Plage de dates",
    filterLast24h: "Dernières 24h",
    filterLast7: "7 derniers jours",
    filterLast30: "30 derniers jours",
    filterCustom: "Personnalisé",
    filterFrom: "Du",
    filterTo: "Au",
    filterSentiment: "Sentiment",
    filterPositive: "Positif",
    filterNeutral: "Neutre",
    filterNegative: "Négatif",
    filterUnknown: "Inconnu",
    filterSummary: "Résumé",
    filterHasSummary: "Avec résumé",
    filterNoSummary: "Sans résumé",
    filterCallerSearch: "Rechercher un appelant",
    filterCallerPlaceholder: "ex. +3377 ou 938887",
    filterOnlyAppointments: "Appels avec rendez-vous uniquement",
    filterNeedsFollowUp: "Suivi nécessaire",
    showingCalls: (n) => `Affichage de ${n} appel${n === 1 ? "" : "s"}`,
    loadingCalls: "Chargement des appels...",
    reset: "Réinitialiser",
    noCallsMatch: "Aucun appel ne correspond à ces filtres.",
    noCallsYet: "Pas encore d’appels. Quand votre numéro recevra des appels, ils apparaîtront ici.",

    callDetails: "Détails de l'appel",
    selectCallPrompt:
      "Sélectionnez un appel à gauche pour voir la transcription, les rendez-vous et les demandes.",
    noCallsYetDetails:
      "Pas encore d’appels. Quand votre numéro recevra un appel, vous le verrez ici.",
    callInfo: "Infos sur l'appel",
    infoStatus: "Statut",
    infoDuration: "Durée",
    infoStarted: "Démarré",
    infoSummary: "Résumé",
    infoSentiment: "Sentiment",
    noSummaryYet: "Pas encore de résumé",
    unknownSentiment: "Inconnu",
    sec: "sec",
    transcript: "Transcription",
    aiReceptionist: "Réceptionniste IA",
    caller: "Appelant",
    noTranscript: "Aucune transcription capturée pour cet appel.",
    appointments: "Rendez-vous",
    scheduled: "Programmé",
    status: "Statut",
    notes: "Notes",
    noAppointments: "Aucun rendez-vous lié à cet appel.",
    customerRequests: "Demandes client",
    unknown: "Inconnu",
    noRequests: "Aucune demande client capturée pour cet appel.",
    loadingCallDetails: "Chargement des détails…",

    businessSettings: "Paramètres de l'entreprise",
    businessName: "Nom de l'entreprise",
    timezone: "Fuseau horaire",
    preferredLanguage: "Langue préférée",
    businessPhone: "Téléphone professionnel",
    setupStatus: "Statut de configuration",
    businessActive: "Entreprise active et téléphone connecté",
    businessNoPhone: "Entreprise créée, téléphone non connecté",
    noPhoneConnected: "Aucun numéro connecté",

    businessDetailsAddress: "Infos entreprise et adresse",
    generalInfo: "Info générale",
    generalInfoPlaceholder: "ex. Excel Cardiac Care est un cabinet médical spécialisé.",
    addressLine1: "Adresse ligne 1",
    addressLine1Placeholder: "ex. 4400 Heritage Trace Pkwy, #208",
    addressLine2: "Adresse ligne 2",
    addressLine2Placeholder: "Optionnel",
    city: "Ville",
    cityPlaceholder: "ex. Keller",
    stateRegion: "État / Région",
    stateRegionPlaceholder: "ex. Texas",
    postalCode: "Code postal",
    postalCodePlaceholder: "ex. 76244",

    aiReceptionistTitle: "Réceptionniste IA",
    greetingMessage: "Message d'accueil",
    businessHours: "Heures d'ouverture",
    afterHoursBehaviour: "Comportement hors horaires",
    takeMessage: "Prendre un message",
    bookLater: "Réserver plus tard",
    bookAppointment: "Prendre rendez-vous",
    allowAppointments: "Autoriser la prise de rendez-vous",
    allowCallbacks: "Autoriser les demandes de rappel",
    allowMessages: "Autoriser la prise de messages",

    callHandling: "Gestion des appels",
    transferPolicy: "Politique de transfert",
    neverTransfer: "Ne jamais transférer",
    alwaysTransfer: "Toujours transférer",
    businessHoursOnly: "Heures d'ouverture uniquement",
    transferPhone: "Numéro de transfert",
    emergencyMessage: "Message d'urgence",
    fallbackInstructions: "Instructions de repli",

    billingPlan: "Facturation et plan",
    currentPlan: "Plan actuel",
    billingStatus: "Statut de facturation",
    usageThisMonth: "Utilisation ce mois",
    comingSoon: "Bientôt disponible",
    phoneNumber: "Numéro de téléphone",
    notConnectedYet: "Pas encore connecté",
    stripeComing:
      "Les contrôles de facturation Stripe et d'abonnement seront ici.",

    notifications: "Notifications",
    notificationEmail: "E-mail de notification",
    notificationPhone: "Téléphone de notification",

    saveSettings: "Enregistrer les paramètres",
    saving: "Enregistrement...",
    saveDescription:
      "Enregistre le nom, le fuseau horaire, la langue, le message d'accueil, la politique hors horaires, les transferts et les notifications.",

    checkingSession: "Vérification de la session",
    checkingSubtitle:
      "Veuillez patienter pendant que nous restaurons votre accès au tableau de bord.",
    loadingDashboard: "Chargement du tableau de bord",
    loadingSubtitle:
      "Nous rassemblons votre aperçu d'entreprise, vos appels et vos analyses.",
    couldntLoad: "Impossible de charger le compte",
    signOut: "Se déconnecter",

    summaryCheck: "Résumé ✓",
    noSummaryShort: "Sans résumé",
    loadingCallsEllipsis: "Chargement des appels…",
  },
};

export function useTranslations(lang) {
  return TRANSLATIONS[lang] || TRANSLATIONS.en;
}
