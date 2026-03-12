// LanguageSwitcher.jsx
// Drop this file next to App.jsx and import it.
// Usage: <LanguageSwitcher lang={lang} onChange={setLang} />

import { useEffect, useRef, useState } from "react";

export const LANGUAGES = [
  { code: "en", label: "EN", name: "English" },
  { code: "es", label: "ES", name: "Español" },
  { code: "fr", label: "FR", name: "Français" },
];

export function LanguageSwitcher({ lang, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (!ref.current || ref.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const current = LANGUAGES.find((l) => l.code === lang) || LANGUAGES[0];

  return (
    <div className="lang-switcher" ref={ref}>
      <button
        type="button"
        className="lang-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="lang-toggle-icon">🌐</span>
        <span className="lang-toggle-label">{current.label}</span>
      </button>

      {open && (
        <div className="lang-menu" role="listbox" aria-label="Interface language">
          {LANGUAGES.map((l) => (
            <button
              key={l.code}
              type="button"
              className={`lang-menu-item ${l.code === lang ? "is-active" : ""}`}
              onClick={() => {
                onChange(l.code);
                setOpen(false);
              }}
              role="option"
              aria-selected={l.code === lang}
            >
              <span className="lang-menu-code">{l.label}</span>
              <span className="lang-menu-name">{l.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Translations ────────────────────────────────────────────────────────────

export const TRANSLATIONS = {
  en: {
    // Topbar
    appTitle: "AI Call Dashboard",
    navDashboard: "Dashboard",
    navAnalytics: "Analytics",
    navSettings: "Settings",
    navGuide: "Guide",
    logout: "Logout",

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

    billingPlan: "Billing & Plan",
    currentPlan: "Current plan",
    billingStatus: "Billing status",
    usageThisMonth: "Usage this month",
    comingSoon: "Detailed usage coming soon",
    phoneNumber: "Phone number",
    notConnectedYet: "Not connected yet",
    stripeComing:
      "You're on the Starter beta plan. Paid plans with detailed usage and billing controls are coming soon.",

    securityFooter:
      "Your data is stored securely using Supabase auth and PostgreSQL. Rotate API keys and enable RLS in your Supabase project for best protection.",

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
    navAnalytics: "Analíticas",
    navSettings: "Configuración",
    navGuide: "Guía",
    logout: "Cerrar sesión",

    dataForToday: "Datos de hoy",
    callsToday: "Llamadas hoy",
    appointmentsToday: "Citas hoy",
    followUpsNeeded: "Seguimientos pendientes",
    transferredToHuman: "Transferidos a humano",

    calls: "Llamadas",
    filterStatus: "Estado",
    filterAll: "Todos",
    filterCompleted: "Completadas",
    filterTransferred: "Transferidas",
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
    showingCalls: (n, total) => total != null ? `Mostrando ${n} de ${total} llamadas` : `Mostrando ${n} llamada${n === 1 ? "" : "s"}`,
    loadMore: "Cargar más",
    exportCallsCsv: "Exportar llamadas (CSV)",
    refresh: "Actualizar",
    copied: "¡Copiado!",
    copySummary: "Copiar resumen",
    copyTranscript: "Copiar transcripción",
    unsavedChanges: "Tienes cambios sin guardar. ¿Salir de todos modos?",
    loadingCalls: "Cargando llamadas...",
    loadingAnalytics: "Cargando analíticas…",
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
    businessHoursHint: "Solo lectura; configúralo en tu proveedor de teléfono.",
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
    comingSoon: "Detalles de uso próximamente",
    phoneNumber: "Número de teléfono",
    notConnectedYet: "Aún no conectado",
    stripeComing:
      "Estás en el plan beta Starter. Los planes de pago con uso detallado y controles de facturación llegarán pronto.",

    securityFooter:
      "Tus datos se almacenan de forma segura con Supabase y PostgreSQL. Rota tus claves API y habilita RLS en tu proyecto de Supabase para mayor protección.",

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
    navAnalytics: "Analytiques",
    navSettings: "Paramètres",
    navGuide: "Guide",
    logout: "Déconnexion",

    dataForToday: "Données du jour",
    callsToday: "Appels aujourd'hui",
    appointmentsToday: "Rendez-vous aujourd'hui",
    followUpsNeeded: "Suivis nécessaires",
    transferredToHuman: "Transférés à un humain",

    calls: "Appels",
    filterStatus: "Statut",
    filterAll: "Tous",
    filterCompleted: "Terminés",
    filterTransferred: "Transférés",
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
    showingCalls: (n, total) => total != null ? `Affichage de ${n} sur ${total} appels` : `Affichage de ${n} appel${n === 1 ? "" : "s"}`,
    loadMore: "Charger plus",
    exportCallsCsv: "Exporter les appels (CSV)",
    refresh: "Actualiser",
    copied: "Copié !",
    copySummary: "Copier le résumé",
    copyTranscript: "Copier la transcription",
    unsavedChanges: "Vous avez des modifications non enregistrées. Quitter quand même ?",
    loadingCalls: "Chargement des appels...",
    loadingAnalytics: "Chargement des analytiques…",
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
    businessHoursHint: "Affichage seul; à configurer chez votre opérateur.",
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
    usageThisMonth: "Utilisation ce mois-ci",
    comingSoon: "Détails à venir",
    phoneNumber: "Numéro de téléphone",
    notConnectedYet: "Pas encore connecté",
    stripeComing:
      "Vous êtes sur le plan bêta Starter. Des offres payantes avec utilisation détaillée et contrôles de facturation arrivent bientôt.",

    securityFooter:
      "Vos données sont stockées en toute sécurité avec Supabase et PostgreSQL. Faites tourner vos clés API et activez RLS dans votre projet Supabase pour une meilleure protection.",

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
