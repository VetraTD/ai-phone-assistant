// Landing page copy, keyed by the same language codes as LanguageSwitcher.jsx.
// Kept separate from the dashboard's TRANSLATIONS so marketing copy can change
// without touching the dashboard. Languages without an entry fall back to
// English, matching useTranslations() in LanguageSwitcher.jsx.
//
// Rule for this file: only describe services that are live today. Outbound
// calling and custom voicemails are delivered outside this codebase and were
// confirmed live by the owner; GoHighLevel is offered as a custom connection.
// Don't promise SMS to callers, number porting, emailed call summaries, or a
// cloned voice until they ship.

export const LANDING_TRANSLATIONS = {
  en: {
    navHow: "How it works",
    navFeatures: "Features",
    navPricing: "Pricing",
    navFaq: "FAQ",
    navLogin: "Log in",
    getStarted: "Get started",
    mainNav: "Main",
    skipToContent: "Skip to content",

    heroTitleA: "Every call.",
    heroTitleB: "Answered.",
    heroSub:
      "At lunch, with a customer, after hours, on the weekend. Whenever you can't pick up, Vetra does.",
    heroListen: "Hear a real call",
    heroAudience: "For clinics, salons, trades, agencies, and any business that runs on appointments.",
    notifMissed: "Missed call",
    notifVoicemail: "Voicemail full",
    notifBooking: "Booking lost",
    notifNoAnswer: "No one picked up",
    answeredLabel: "Examples of calls Vetra handles",
    // Hero card rotates through these. Live features only.
    answeredItems: [
      { title: "Answered by Vetra", detail: "Booking taken · Summary in your dashboard", time: "Sat 7:42 PM" },
      { title: "Message taken", detail: "Callback request · Name and number saved", time: "Tue 12:38 PM" },
      { title: "Call transferred", detail: "Caller asked for you · Put straight through", time: "Wed 2:16 PM" },
      { title: "Lead called back", detail: "Outbound call · Qualified and booked for Tuesday", time: "Fri 9:12 AM" },
      { title: "New inquiry qualified", detail: "Needs, budget and contact details noted", time: "Thu 6:51 PM" },
      { title: "Appointment rescheduled", detail: "Moved to Friday, 10:00 AM", time: "Mon 8:05 AM" },
      { title: "Question answered", detail: "Hours and services explained", time: "Sun 11:20 AM" },
    ],

    phoneCalling: "calling…",
    phonePaused: "paused",
    phoneTapToPlay: "Tap to hear a real call",
    phonePlaying: "Playing demo call",
    playDemo: "Play demo call",
    pauseDemo: "Pause demo call",

    gapTitle: "The calls nobody's free to take.",
    gapMoments: [
      { when: "12:30 PM", what: "Everyone's at lunch." },
      { when: "2:15 PM", what: "You're with a customer." },
      { when: "6:40 PM", what: "The doors are closed." },
      { when: "Saturday", what: "It's your day off." },
    ],
    gapClose: "The phone still rings. Now someone answers.",

    howTitle: "Set up in an afternoon.",
    howSteps: [
      {
        title: "Keep your number",
        body: "Forward unanswered calls to Vetra, or pick a new local or toll-free number.",
      },
      {
        title: "Tell Vetra about your business",
        body: "Your greeting, hours, services, and when calls should come through to you.",
      },
      {
        title: "Every call, answered",
        body: "Vetra picks up, books, takes messages, and logs each call with a summary.",
      },
    ],

    featuresTitle: "Everything your front desk does on the phone.",
    features: [
      {
        id: "forward",
        title: "Works with your number.",
        body: "Keep the number your customers already have. Your phone rings first, and if you can't pick up, the call goes straight to Vetra. No new hardware, no app to install.",
      },
      {
        id: "book",
        title: "Answers and books.",
        body: "Vetra answers questions using what you've told it about your business, then books the appointment straight into your dashboard. Callers can cancel or reschedule too.",
      },
      {
        id: "message",
        title: "Takes the message.",
        body: "Messages and callback requests are captured with the caller's name, number, and what they need.",
      },
      {
        id: "transfer",
        title: "Hands off to you.",
        body: "When a caller asks for a person, Vetra transfers them to your number. You decide when: always, never, or only during business hours.",
      },
      {
        id: "dashboard",
        title: "Every call, in one place.",
        body: "A summary, the full transcript, and how the caller felt, for every call. Filter, export, and sync bookings to Google Calendar.",
      },
    ],
    fragBookLabel: "New booking",
    fragBookWhen: "Thu, 10:30 AM",
    fragBookWhat: "First appointment · Booked by Vetra",
    fragMsgLabel: "Callback request",
    fragMsgName: "Sam R.",
    fragMsgBody: "“Can someone call me back about a quote for Friday?”",
    fragXferLabel: "Transfer rule",
    fragXferRule: "Business hours only",
    fragXferTo: "Transferred to your number",
    fragDashLabel: "Call summary",
    fragDashBody: "Caller booked a first appointment for Thursday at 10:30 and asked about parking.",
    fragDashMood: "Positive",
    fragExample: "Example",
    fragFwdLabel: "Your business line",
    fragFwdRang: "Your phone rang · No answer",
    fragFwdPicked: "Answered by Vetra",

    navTailored: "Your setup",
    tailorTitle: "Fully customized to how you work.",
    tailorSub:
      "Every greeting, question and rule is set up around your business, so Vetra sounds like you and sends you exactly what you need.",
    tailorGreeting: "“Hi, this is Sam's assistant. Sam can't get to the phone right now. How can I help?”",
    tailorGreetingNote: "Your greeting, in your name.",
    tailorItems: [
      {
        title: "Finds out why they're calling",
        body: "Every caller is asked the reason for their call, and you get the notes.",
      },
      {
        title: "Qualifies leads on the fly",
        body: "On inbound and outbound calls, Vetra asks your questions in real time: name, number, email, company, what they need, even budget.",
      },
      {
        title: "Books appointments on your behalf",
        body: "Offers a consultation or call and books it for you, only confirming a time once it's actually booked. If nothing fits, it tells them you'll be in touch.",
      },
      {
        title: "Knows who's calling",
        body: "New leads, existing clients, suppliers, personal calls: each one handled your way and passed on to you.",
      },
      {
        title: "Knows your services",
        body: "Explains what you offer, in your words.",
      },
      {
        title: "Sticks to your rules",
        body: "Never quotes prices, promises results, or talks about other clients unless you say so.",
      },
      {
        title: "Custom voicemails",
        body: "Personalized voicemail messages in your words, for every type of call.",
      },
      {
        title: "Transcripts where you work",
        body: "Every call transcribed in your Vetra dashboard, or we can connect Vetra to GoHighLevel (GHL) so calls land straight in your CRM.",
      },
      {
        title: "Outbound calls",
        body: "Vetra calls new leads back, follows up, qualifies them, and books appointments on your behalf."
      },
    ],

    listenTitle: "Don't take our word for it.",
    listenSub: "This is a real call to Vetra. Press play.",
    listenOr: "Or call the demo line yourself:",

    pricingTitle: "Pricing that fits your business.",
    pricingSub:
      "Plans depend on your call volume and how you'd like Vetra set up. Tell us a little about your business and we'll get back to you with a price.",
    pricingCta: "Contact us for pricing",

    faqTitle: "Questions, answered.",
    faq: [
      {
        q: "What kinds of businesses use Vetra?",
        a: "Any business that runs on appointments: clinics, salons, trades, agencies, and more. If missed calls cost you bookings, Vetra is built for you.",
      },
      {
        q: "Do I need a new phone number?",
        a: "No. Keep your existing number and forward unanswered calls to Vetra through your phone provider. Your phone rings first, and Vetra picks up if you can't. We'll help you set it up. Prefer a separate line? Choose a new local or toll-free number when you sign up.",
      },
      {
        q: "Can calls be transferred to me?",
        a: "Yes. When a caller asks for a person, Vetra transfers them to your number. You choose whether that happens always, never, or only during business hours.",
      },
      {
        q: "What happens after hours?",
        a: "You decide. Vetra can take a message for you, or keep booking appointments around the clock.",
      },
      {
        q: "Where do I see my calls?",
        a: "In your dashboard. Every call has a summary and full transcript, alongside any bookings and messages it created.",
      },
      {
        q: "Does it work with my calendar?",
        a: "Bookings can be synced to Google Calendar from your dashboard.",
      },
      {
        q: "Does it work with GoHighLevel?",
        a: "Yes. Transcripts and call details are always in your Vetra dashboard, and we can connect Vetra to GoHighLevel so they go straight into your CRM.",
      },
      {
        q: "Can Vetra make outbound calls?",
        a: "Yes. Vetra can call new leads back, follow up, qualify them, and book appointments on your behalf. Get in touch and we'll set it up around your business.",
      },
      {
        q: "How much does it cost?",
        a: "Pricing depends on your call volume and setup. Get in touch and we'll put together a price for your business.",
      },
      {
        q: "Can I hear it first?",
        a: "Yes. Play the recorded call on this page, or call the demo line. No signup needed.",
      },
    ],

    ctaTitle: "Stop missing calls.",
    ctaSub: "Set up Vetra and let every call get answered.",
    ctaDemo: "Call the demo line",

    footerContact: "Contact",
    footerPrivacy: "Privacy Policy",
    footerTerms: "Terms",
  },

  es: {
    navHow: "Cómo funciona",
    navFeatures: "Funciones",
    navPricing: "Precios",
    navFaq: "Preguntas",
    navLogin: "Iniciar sesión",
    getStarted: "Empezar",
    mainNav: "Principal",
    skipToContent: "Saltar al contenido",

    heroTitleA: "Cada llamada.",
    heroTitleB: "Atendida.",
    heroSub:
      "A la hora de comer, con un cliente, fuera de horario, el fin de semana. Cuando tú no puedes contestar, Vetra sí.",
    heroListen: "Escucha una llamada real",
    heroAudience: "Para clínicas, salones, oficios, agencias y cualquier negocio que funcione con citas.",
    notifMissed: "Llamada perdida",
    notifVoicemail: "Buzón lleno",
    notifBooking: "Reserva perdida",
    notifNoAnswer: "Nadie contestó",
    answeredLabel: "Ejemplos de llamadas que atiende Vetra",
    answeredItems: [
      { title: "Atendida por Vetra", detail: "Reserva hecha · Resumen en tu panel", time: "Sáb 19:42" },
      { title: "Mensaje tomado", detail: "Pide que le llamen · Nombre y número guardados", time: "Mar 12:38" },
      { title: "Llamada transferida", detail: "Preguntó por ti · Pasada directamente", time: "Mié 14:16" },
      { title: "Contacto llamado", detail: "Llamada saliente · Calificado y agendado para el martes", time: "Vie 9:12" },
      { title: "Nuevo contacto calificado", detail: "Necesidades, presupuesto y datos anotados", time: "Jue 18:51" },
      { title: "Cita cambiada", detail: "Movida al viernes a las 10:00", time: "Lun 8:05" },
      { title: "Pregunta respondida", detail: "Horario y servicios explicados", time: "Dom 11:20" },
    ],

    phoneCalling: "llamando…",
    phonePaused: "en pausa",
    phoneTapToPlay: "Toca para escuchar una llamada real",
    phonePlaying: "Reproduciendo llamada demo",
    playDemo: "Reproducir llamada demo",
    pauseDemo: "Pausar llamada demo",

    gapTitle: "Las llamadas que nadie puede atender.",
    gapMoments: [
      { when: "12:30", what: "Todos están comiendo." },
      { when: "14:15", what: "Estás con un cliente." },
      { when: "18:40", what: "Ya has cerrado." },
      { when: "Sábado", what: "Es tu día libre." },
    ],
    gapClose: "El teléfono sigue sonando. Ahora alguien contesta.",

    howTitle: "Listo en una tarde.",
    howSteps: [
      {
        title: "Conserva tu número",
        body: "Desvía a Vetra las llamadas que no contestes, o elige un número local o gratuito nuevo.",
      },
      {
        title: "Cuéntale a Vetra sobre tu negocio",
        body: "Tu saludo, horario, servicios y cuándo deben pasarte las llamadas.",
      },
      {
        title: "Cada llamada, atendida",
        body: "Vetra contesta, reserva, toma mensajes y registra cada llamada con un resumen.",
      },
    ],

    featuresTitle: "Todo lo que hace tu recepción por teléfono.",
    features: [
      {
        id: "forward",
        title: "Funciona con tu número.",
        body: "Conserva el número que ya tienen tus clientes. Tu teléfono suena primero y, si no puedes contestar, la llamada pasa directamente a Vetra. Sin equipos nuevos ni apps que instalar.",
      },
      {
        id: "book",
        title: "Responde y reserva.",
        body: "Vetra responde preguntas con lo que le has contado de tu negocio y reserva la cita directamente en tu panel. Los clientes también pueden cancelar o cambiar su cita.",
      },
      {
        id: "message",
        title: "Toma el mensaje.",
        body: "Los mensajes y las solicitudes de devolución de llamada se guardan con el nombre, el número y lo que necesita la persona.",
      },
      {
        id: "transfer",
        title: "Te pasa la llamada.",
        body: "Si alguien pide hablar con una persona, Vetra transfiere la llamada a tu número. Tú decides cuándo: siempre, nunca o solo en horario comercial.",
      },
      {
        id: "dashboard",
        title: "Todas las llamadas, en un solo lugar.",
        body: "Un resumen, la transcripción completa y el tono del cliente en cada llamada. Filtra, exporta y sincroniza reservas con Google Calendar.",
      },
    ],
    fragBookLabel: "Nueva reserva",
    fragBookWhen: "Jue, 10:30",
    fragBookWhat: "Primera cita · Reservada por Vetra",
    fragMsgLabel: "Solicitud de llamada",
    fragMsgName: "Sam R.",
    fragMsgBody: "“¿Me pueden llamar por un presupuesto para el viernes?”",
    fragXferLabel: "Regla de transferencia",
    fragXferRule: "Solo en horario comercial",
    fragXferTo: "Transferida a tu número",
    fragDashLabel: "Resumen de llamada",
    fragDashBody: "El cliente reservó una primera cita para el jueves a las 10:30 y preguntó por el estacionamiento.",
    fragDashMood: "Positivo",
    fragExample: "Ejemplo",
    fragFwdLabel: "Tu línea del negocio",
    fragFwdRang: "Tu teléfono sonó · Sin respuesta",
    fragFwdPicked: "Atendida por Vetra",

    navTailored: "Tu configuración",
    tailorTitle: "Totalmente personalizado a tu manera.",
    tailorSub:
      "Cada saludo, pregunta y regla se configura según tu negocio, para que Vetra suene como tú y te envíe exactamente lo que necesitas.",
    tailorGreeting: "“Hola, soy la asistente de Sam. Sam no puede atender ahora mismo. ¿En qué puedo ayudarte?”",
    tailorGreetingNote: "Tu saludo, en tu nombre.",
    tailorItems: [
      {
        title: "Averigua por qué llaman",
        body: "A cada persona se le pregunta el motivo de su llamada, y tú recibes las notas.",
      },
      {
        title: "Califica contactos al instante",
        body: "En llamadas entrantes y salientes, Vetra hace tus preguntas en tiempo real: nombre, teléfono, email, empresa, qué necesitan e incluso presupuesto.",
      },
      {
        title: "Agenda citas por ti",
        body: "Ofrece una consulta o llamada y la agenda por ti, confirmando la hora solo cuando la reserva está hecha. Si no encaja ninguna, les dice que te pondrás en contacto.",
      },
      {
        title: "Sabe quién llama",
        body: "Nuevos contactos, clientes actuales, proveedores, llamadas personales: cada una gestionada a tu manera y enviada a ti.",
      },
      {
        title: "Conoce tus servicios",
        body: "Explica lo que ofreces, con tus palabras.",
      },
      {
        title: "Respeta tus reglas",
        body: "Nunca da precios, promete resultados ni habla de otros clientes, salvo que tú lo indiques.",
      },
      {
        title: "Buzones de voz personalizados",
        body: "Mensajes de buzón de voz personalizados con tus palabras, para cada tipo de llamada.",
      },
      {
        title: "Transcripciones donde trabajas",
        body: "Cada llamada transcrita en tu panel de Vetra, o podemos conectar Vetra con GoHighLevel (GHL) para que las llamadas lleguen directamente a tu CRM.",
      },
      {
        title: "Llamadas salientes",
        body: "Vetra devuelve la llamada a nuevos contactos, hace el seguimiento, los califica y agenda citas por ti."
      },
    ],

    listenTitle: "No te fíes solo de nuestra palabra.",
    listenSub: "Esta es una llamada real a Vetra. Pulsa play.",
    listenOr: "O llama tú mismo a la línea demo:",

    pricingTitle: "Precios a la medida de tu negocio.",
    pricingSub:
      "Los planes dependen de tu volumen de llamadas y de cómo quieras configurar Vetra. Cuéntanos un poco sobre tu negocio y te enviaremos un precio.",
    pricingCta: "Contáctanos para precios",

    faqTitle: "Preguntas, respondidas.",
    faq: [
      {
        q: "¿Qué tipo de negocios usan Vetra?",
        a: "Cualquier negocio que funcione con citas: clínicas, salones, oficios, agencias y más. Si las llamadas perdidas te cuestan reservas, Vetra está hecho para ti.",
      },
      {
        q: "¿Necesito un número nuevo?",
        a: "No. Conserva tu número actual y desvía a Vetra las llamadas no contestadas a través de tu proveedor de telefonía. Tu teléfono suena primero y Vetra contesta si tú no puedes. Te ayudamos a configurarlo. ¿Prefieres una línea aparte? Elige un número local o gratuito nuevo al registrarte.",
      },
      {
        q: "¿Me pueden transferir las llamadas?",
        a: "Sí. Si alguien pide hablar con una persona, Vetra transfiere la llamada a tu número. Tú eliges si ocurre siempre, nunca o solo en horario comercial.",
      },
      {
        q: "¿Qué pasa fuera de horario?",
        a: "Tú decides. Vetra puede tomar un mensaje o seguir reservando citas a cualquier hora.",
      },
      {
        q: "¿Dónde veo mis llamadas?",
        a: "En tu panel. Cada llamada tiene un resumen y la transcripción completa, junto con las reservas y mensajes que generó.",
      },
      {
        q: "¿Funciona con mi calendario?",
        a: "Las reservas se pueden sincronizar con Google Calendar desde tu panel.",
      },
      {
        q: "¿Funciona con GoHighLevel?",
        a: "Sí. Las transcripciones y los datos de cada llamada siempre están en tu panel de Vetra, y podemos conectar Vetra con GoHighLevel para que lleguen directamente a tu CRM.",
      },
      {
        q: "¿Vetra puede hacer llamadas salientes?",
        a: "Sí. Vetra puede devolver la llamada a nuevos contactos, hacer el seguimiento, calificarlos y agendar citas por ti. Escríbenos y lo configuramos para tu negocio.",
      },
      {
        q: "¿Cuánto cuesta?",
        a: "El precio depende de tu volumen de llamadas y de la configuración. Escríbenos y prepararemos un precio para tu negocio.",
      },
      {
        q: "¿Puedo escucharlo antes?",
        a: "Sí. Reproduce la llamada grabada en esta página o llama a la línea demo. Sin registro.",
      },
    ],

    ctaTitle: "Deja de perder llamadas.",
    ctaSub: "Configura Vetra y que cada llamada tenga respuesta.",
    ctaDemo: "Llamar a la línea demo",

    footerContact: "Contacto",
    footerPrivacy: "Política de privacidad",
    footerTerms: "Términos",
  },

  fr: {
    navHow: "Fonctionnement",
    navFeatures: "Fonctionnalités",
    navPricing: "Tarifs",
    navFaq: "FAQ",
    navLogin: "Connexion",
    getStarted: "Commencer",
    mainNav: "Principale",
    skipToContent: "Aller au contenu",

    heroTitleA: "Chaque appel.",
    heroTitleB: "Répondu.",
    heroSub:
      "À midi, avec un client, après la fermeture, le week-end. Quand vous ne pouvez pas décrocher, Vetra le fait.",
    heroListen: "Écouter un vrai appel",
    heroAudience: "Pour les cliniques, salons, artisans, agences et toute entreprise qui fonctionne sur rendez-vous.",
    notifMissed: "Appel manqué",
    notifVoicemail: "Messagerie pleine",
    notifBooking: "Rendez-vous perdu",
    notifNoAnswer: "Personne n'a répondu",
    answeredLabel: "Exemples d'appels gérés par Vetra",
    answeredItems: [
      { title: "Répondu par Vetra", detail: "Rendez-vous pris · Résumé dans votre tableau de bord", time: "Sam. 19:42" },
      { title: "Message pris", detail: "Demande de rappel · Nom et numéro enregistrés", time: "Mar. 12:38" },
      { title: "Appel transféré", detail: "L'appelant vous a demandé · Mis en relation", time: "Mer. 14:16" },
      { title: "Prospect rappelé", detail: "Appel sortant · Qualifié et rendez-vous mardi", time: "Ven. 9:12" },
      { title: "Nouveau contact qualifié", detail: "Besoins, budget et coordonnées notés", time: "Jeu. 18:51" },
      { title: "Rendez-vous déplacé", detail: "Déplacé à vendredi, 10:00", time: "Lun. 8:05" },
      { title: "Question répondue", detail: "Horaires et services expliqués", time: "Dim. 11:20" },
    ],

    phoneCalling: "appel en cours…",
    phonePaused: "en pause",
    phoneTapToPlay: "Touchez pour écouter un vrai appel",
    phonePlaying: "Lecture de l'appel démo",
    playDemo: "Lire l'appel démo",
    pauseDemo: "Mettre en pause l'appel démo",

    gapTitle: "Les appels que personne n'a le temps de prendre.",
    gapMoments: [
      { when: "12:30", what: "Tout le monde déjeune." },
      { when: "14:15", what: "Vous êtes avec un client." },
      { when: "18:40", what: "Les portes sont fermées." },
      { when: "Samedi", what: "C'est votre jour de repos." },
    ],
    gapClose: "Le téléphone sonne toujours. Désormais, quelqu'un répond.",

    howTitle: "Prêt en un après-midi.",
    howSteps: [
      {
        title: "Gardez votre numéro",
        body: "Renvoyez les appels sans réponse vers Vetra, ou choisissez un nouveau numéro local ou gratuit.",
      },
      {
        title: "Présentez votre entreprise à Vetra",
        body: "Votre message d'accueil, vos horaires, vos services et quand les appels doivent vous être transférés.",
      },
      {
        title: "Chaque appel, répondu",
        body: "Vetra décroche, prend les rendez-vous et les messages, et consigne chaque appel avec un résumé.",
      },
    ],

    featuresTitle: "Tout ce que fait votre accueil au téléphone.",
    features: [
      {
        id: "forward",
        title: "Fonctionne avec votre numéro.",
        body: "Gardez le numéro que vos clients connaissent déjà. Votre téléphone sonne d'abord et, si vous ne pouvez pas répondre, l'appel bascule directement vers Vetra. Aucun matériel, aucune application à installer.",
      },
      {
        id: "book",
        title: "Répond et réserve.",
        body: "Vetra répond aux questions à partir de ce que vous lui avez appris sur votre entreprise, puis enregistre le rendez-vous directement dans votre tableau de bord. Les clients peuvent aussi annuler ou déplacer leur rendez-vous.",
      },
      {
        id: "message",
        title: "Prend le message.",
        body: "Les messages et demandes de rappel sont enregistrés avec le nom, le numéro et la demande de l'appelant.",
      },
      {
        id: "transfer",
        title: "Vous passe l'appel.",
        body: "Quand un appelant demande à parler à quelqu'un, Vetra le transfère vers votre numéro. Vous choisissez quand : toujours, jamais, ou seulement pendant vos horaires.",
      },
      {
        id: "dashboard",
        title: "Tous les appels, au même endroit.",
        body: "Un résumé, la transcription complète et le ressenti de l'appelant, pour chaque appel. Filtrez, exportez et synchronisez les rendez-vous avec Google Agenda.",
      },
    ],
    fragBookLabel: "Nouveau rendez-vous",
    fragBookWhen: "Jeu. 10:30",
    fragBookWhat: "Premier rendez-vous · Pris par Vetra",
    fragMsgLabel: "Demande de rappel",
    fragMsgName: "Sam R.",
    fragMsgBody: "« Quelqu'un peut-il me rappeler pour un devis vendredi ? »",
    fragXferLabel: "Règle de transfert",
    fragXferRule: "Pendant les horaires seulement",
    fragXferTo: "Transféré vers votre numéro",
    fragDashLabel: "Résumé de l'appel",
    fragDashBody: "L'appelant a pris un premier rendez-vous jeudi à 10:30 et a demandé où se garer.",
    fragDashMood: "Positif",
    fragExample: "Exemple",
    fragFwdLabel: "Votre ligne professionnelle",
    fragFwdRang: "Votre téléphone a sonné · Pas de réponse",
    fragFwdPicked: "Répondu par Vetra",

    navTailored: "Votre configuration",
    tailorTitle: "Entièrement personnalisé selon votre façon de travailler.",
    tailorSub:
      "Chaque message d'accueil, question et règle est configuré selon votre entreprise : Vetra parle comme vous et vous transmet exactement ce dont vous avez besoin.",
    tailorGreeting: "« Bonjour, ici l'assistante de Sam. Sam ne peut pas répondre pour le moment. Comment puis-je vous aider ? »",
    tailorGreetingNote: "Votre message d'accueil, à votre nom.",
    tailorItems: [
      {
        title: "Comprend la raison de l'appel",
        body: "Chaque appelant est interrogé sur le motif de son appel, et vous recevez les notes.",
      },
      {
        title: "Qualifie les prospects en temps réel",
        body: "En appels entrants comme sortants, Vetra pose vos questions en temps réel : nom, numéro, e-mail, entreprise, besoin, et même budget.",
      },
      {
        title: "Prend les rendez-vous pour vous",
        body: "Propose une consultation ou un appel et le réserve pour vous, en ne confirmant un horaire qu'une fois la réservation faite. Si rien ne convient, il indique que vous reprendrez contact.",
      },
      {
        title: "Sait qui appelle",
        body: "Nouveaux contacts, clients existants, fournisseurs, appels personnels : chacun traité à votre façon et transmis.",
      },
      {
        title: "Connaît vos services",
        body: "Explique ce que vous proposez, avec vos mots.",
      },
      {
        title: "Respecte vos règles",
        body: "Ne donne jamais de prix, ne promet pas de résultats et ne parle pas d'autres clients, sauf si vous le souhaitez.",
      },
      {
        title: "Messageries vocales personnalisées",
        body: "Des messages vocaux personnalisés avec vos mots, pour chaque type d'appel.",
      },
      {
        title: "Des transcriptions là où vous travaillez",
        body: "Chaque appel transcrit dans votre tableau de bord Vetra, ou nous pouvons connecter Vetra à GoHighLevel (GHL) pour que les appels arrivent directement dans votre CRM.",
      },
      {
        title: "Appels sortants",
        body: "Vetra rappelle les nouveaux contacts, assure le suivi, les qualifie et prend les rendez-vous pour vous."
      },
    ],

    listenTitle: "Ne nous croyez pas sur parole.",
    listenSub: "Voici un vrai appel à Vetra. Appuyez sur lecture.",
    listenOr: "Ou appelez vous-même la ligne démo :",

    pricingTitle: "Des tarifs adaptés à votre entreprise.",
    pricingSub:
      "Les offres dépendent de votre volume d'appels et de la configuration souhaitée. Parlez-nous un peu de votre entreprise et nous vous enverrons un tarif.",
    pricingCta: "Contactez-nous pour un tarif",

    faqTitle: "Vos questions, nos réponses.",
    faq: [
      {
        q: "Quels types d'entreprises utilisent Vetra ?",
        a: "Toute entreprise qui fonctionne sur rendez-vous : cliniques, salons, artisans, agences, et plus encore. Si les appels manqués vous coûtent des rendez-vous, Vetra est fait pour vous.",
      },
      {
        q: "Ai-je besoin d'un nouveau numéro ?",
        a: "Non. Gardez votre numéro actuel et renvoyez les appels sans réponse vers Vetra via votre opérateur. Votre téléphone sonne d'abord, et Vetra répond si vous ne pouvez pas. Nous vous aidons à le configurer. Vous préférez une ligne séparée ? Choisissez un nouveau numéro local ou gratuit à l'inscription.",
      },
      {
        q: "Les appels peuvent-ils m'être transférés ?",
        a: "Oui. Quand un appelant demande à parler à quelqu'un, Vetra le transfère vers votre numéro. Vous choisissez si cela se fait toujours, jamais, ou seulement pendant vos horaires.",
      },
      {
        q: "Que se passe-t-il en dehors des horaires ?",
        a: "C'est vous qui décidez. Vetra peut prendre un message ou continuer à prendre des rendez-vous à toute heure.",
      },
      {
        q: "Où puis-je voir mes appels ?",
        a: "Dans votre tableau de bord. Chaque appel a un résumé et une transcription complète, avec les rendez-vous et messages associés.",
      },
      {
        q: "Est-ce compatible avec mon agenda ?",
        a: "Les rendez-vous peuvent être synchronisés avec Google Agenda depuis votre tableau de bord.",
      },
      {
        q: "Est-ce compatible avec GoHighLevel ?",
        a: "Oui. Les transcriptions et les détails des appels sont toujours dans votre tableau de bord Vetra, et nous pouvons connecter Vetra à GoHighLevel pour qu'ils arrivent directement dans votre CRM.",
      },
      {
        q: "Vetra peut-il passer des appels sortants ?",
        a: "Oui. Vetra peut rappeler les nouveaux contacts, assurer le suivi, les qualifier et prendre les rendez-vous pour vous. Contactez-nous et nous le configurerons pour votre entreprise.",
      },
      {
        q: "Combien ça coûte ?",
        a: "Le tarif dépend de votre volume d'appels et de votre configuration. Contactez-nous et nous préparerons un tarif pour votre entreprise.",
      },
      {
        q: "Puis-je l'écouter avant ?",
        a: "Oui. Écoutez l'appel enregistré sur cette page ou appelez la ligne démo. Sans inscription.",
      },
    ],

    ctaTitle: "Ne manquez plus d'appels.",
    ctaSub: "Configurez Vetra et que chaque appel obtienne une réponse.",
    ctaDemo: "Appeler la ligne démo",

    footerContact: "Contact",
    footerPrivacy: "Politique de confidentialité",
    footerTerms: "Conditions",
  },
};

export function useLandingTranslations(lang) {
  return LANDING_TRANSLATIONS[lang] || LANDING_TRANSLATIONS.en;
}
