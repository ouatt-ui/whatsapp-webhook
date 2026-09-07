const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "visionprotection2024";
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const GRAPH_VERSION = "v26.0";
const WHATSAPP_API_URL = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

const sessions = new Map();

const SERVICES = {
  "1": "Vidéosurveillance",
  "2": "Contrôle d'accès",
  "3": "Alarme intrusion",
  "4": "SSI / CMSI",
  "5": "Motorisation de portail",
  "6": "Domotique",
  "7": "Réseau informatique",
  "8": "Demande de devis",
  "9": "Conseiller"
};

function normalizeForApi(phone) {
  let number = String(phone).replace(/[^\d]/g, "");

  if (number === "22557948536") {
    return "2250757948536";
  }

  return number;
}

/*
 * Déclencheur amélioré :
 * bonjour, bonjour test, bonjour je veux un devis,
 * salut je veux des caméras, bjr..., bonsoir..., etc.
 *
 * La séquence automatique existante est conservée.
 */
function isConversationStart(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  return (
    normalized === "menu" ||
    normalized === "start" ||
    normalized === "0" ||
    /^(bonjour|bjr|bonsoir|slt|salut)\b/.test(normalized)
  );
}

function getSession(phone, profileName = "") {
  const key = String(phone);

  if (!sessions.has(key)) {
    sessions.set(key, {
      phone: key,
      name: profileName || "",
      state: "MENU",
      service: null,
      siteType: null,
      location: null,
      project: null,
      quantity: null,
      delay: null,
      history: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  const session = sessions.get(key);

  if (profileName && !session.name) {
    session.name = profileName;
  }

  session.updatedAt = new Date().toISOString();
  return session;
}

function addHistory(session, direction, text) {
  session.history.push({
    direction,
    text,
    at: new Date().toISOString()
  });

  if (session.history.length > 100) {
    session.history = session.history.slice(-100);
  }

  session.updatedAt = new Date().toISOString();
}

async function sendText(to, body) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error(
      "WHATSAPP_ACCESS_TOKEN ou WHATSAPP_PHONE_NUMBER_ID manquant."
    );
  }

  const recipient = normalizeForApi(to);

  const response = await axios.post(
    WHATSAPP_API_URL,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "text",
      text: {
        preview_url: false,
        body
      }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  );

  return response.data;
}

function mainMenu() {
  return `Bonjour 👋 Bienvenue chez VisionProtection & Informatique.

Merci pour votre message.

🔐 *Nos solutions*

1️⃣ Vidéosurveillance
2️⃣ Contrôle d'accès
3️⃣ Alarme intrusion
4️⃣ SSI / CMSI
5️⃣ Motorisation de portail
6️⃣ Domotique
7️⃣ Réseau informatique
8️⃣ Demande de devis
9️⃣ Parler à un conseiller

👉 Répondez simplement avec le numéro de votre choix.`;
}

function serviceQuestion(service) {
  switch (service) {
    case "Vidéosurveillance":
      return `Très bien 👍

Pour quel type de site souhaitez-vous installer la vidéosurveillance ?

1️⃣ Maison
2️⃣ Bureau
3️⃣ Commerce
4️⃣ Hôtel
5️⃣ Usine
6️⃣ Autre`;

    case "Contrôle d'accès":
      return `Très bien 👍

Quel type de contrôle d'accès recherchez-vous ?

1️⃣ Une porte
2️⃣ Plusieurs portes
3️⃣ Immeuble
4️⃣ Hôtel
5️⃣ Entreprise
6️⃣ Autre`;

    case "Alarme intrusion":
      return `Très bien 👍

Pour quel type de site souhaitez-vous l'alarme intrusion ?

1️⃣ Maison
2️⃣ Bureau
3️⃣ Commerce
4️⃣ Hôtel
5️⃣ Usine
6️⃣ Autre`;

    case "SSI / CMSI":
      return `Très bien 👍

Pour quel type de bâtiment souhaitez-vous le système SSI / CMSI ?

1️⃣ Hôtel
2️⃣ Immeuble
3️⃣ Bureau
4️⃣ Usine
5️⃣ Commerce
6️⃣ Établissement public
7️⃣ Autre`;

    case "Motorisation de portail":
      return `Très bien 👍

Quel type de portail souhaitez-vous motoriser ?

1️⃣ Portail coulissant
2️⃣ Portail battant
3️⃣ Portail industriel
4️⃣ Barrière automatique
5️⃣ Autre`;

    case "Domotique":
      return `Très bien 👍

Quelle solution domotique vous intéresse ?

1️⃣ Éclairage
2️⃣ Climatisation
3️⃣ Sécurité
4️⃣ Contrôle à distance
5️⃣ Hôtel / chambre
6️⃣ Maison intelligente
7️⃣ Autre`;

    case "Réseau informatique":
      return `Très bien 👍

Quel type de réseau informatique souhaitez-vous ?

1️⃣ Réseau entreprise
2️⃣ Wi-Fi
3️⃣ VLAN
4️⃣ Fibre / liaison
5️⃣ Baie informatique
6️⃣ Autre`;

    default:
      return null;
  }
}

function choiceLabel(choice, service) {
  const maps = {
    "Vidéosurveillance": {
      "1": "Maison", "2": "Bureau", "3": "Commerce",
      "4": "Hôtel", "5": "Usine", "6": "Autre"
    },
    "Contrôle d'accès": {
      "1": "Une porte", "2": "Plusieurs portes", "3": "Immeuble",
      "4": "Hôtel", "5": "Entreprise", "6": "Autre"
    },
    "Alarme intrusion": {
      "1": "Maison", "2": "Bureau", "3": "Commerce",
      "4": "Hôtel", "5": "Usine", "6": "Autre"
    },
    "SSI / CMSI": {
      "1": "Hôtel", "2": "Immeuble", "3": "Bureau", "4": "Usine",
      "5": "Commerce", "6": "Établissement public", "7": "Autre"
    },
    "Motorisation de portail": {
      "1": "Portail coulissant", "2": "Portail battant",
      "3": "Portail industriel", "4": "Barrière automatique", "5": "Autre"
    },
    "Domotique": {
      "1": "Éclairage", "2": "Climatisation", "3": "Sécurité",
      "4": "Contrôle à distance", "5": "Hôtel / chambre",
      "6": "Maison intelligente", "7": "Autre"
    },
    "Réseau informatique": {
      "1": "Réseau entreprise", "2": "Wi-Fi", "3": "VLAN",
      "4": "Fibre / liaison", "5": "Baie informatique", "6": "Autre"
    }
  };

  return maps[service]?.[choice] || choice;
}

function quoteRequestMessage(session) {
  return `Parfait 👍

Pour préparer votre demande de devis, indiquez-moi :

📍 *La localisation du projet*
📝 *Une courte description du besoin*
🔢 *La quantité approximative* (caméras, portes, équipements, etc.)

Vous pouvez répondre en une seule fois ou étape par étape.`;
}

async function processMessage(from, profileName, text) {
  const session = getSession(from, profileName);
  const message = String(text || "").trim();

  addHistory(session, "in", message);

  // Déclenchement initial amélioré — le reste du parcours est conservé.
  if (isConversationStart(message)) {
    session.state = "MENU";
    session.service = null;

    const response = mainMenu();
    addHistory(session, "out", response);
    return response;
  }

  if (session.state === "MENU") {
    if (!SERVICES[message]) {
      const response = `Je n'ai pas reconnu votre choix.

${mainMenu()}`;

      addHistory(session, "out", response);
      return response;
    }

    const service = SERVICES[message];
    session.service = service;

    if (service === "Demande de devis") {
      session.state = "QUOTE";

      const response = quoteRequestMessage(session);
      addHistory(session, "out", response);
      return response;
    }

    if (service === "Conseiller") {
      session.state = "ADVISOR";

      const response = `Très bien 👍

Décrivez-moi votre besoin ou votre projet. Un conseiller de VisionProtection & Informatique pourra ensuite vous répondre.`;

      addHistory(session, "out", response);
      return response;
    }

    session.state = "SITE_TYPE";

    const response = serviceQuestion(service) ||
      `Très bien 👍

Décrivez-moi votre besoin.`;

    addHistory(session, "out", response);
    return response;
  }

  if (session.state === "SITE_TYPE") {
    session.siteType = choiceLabel(message, session.service);
    session.state = "LOCATION";

    const response = `Merci 👍

📍 Dans quelle ville ou commune se situe le projet ?`;

    addHistory(session, "out", response);
    return response;
  }

  if (session.state === "LOCATION") {
    session.location = message;
    session.state = "PROJECT";

    const response = `Parfait 👍

📝 Décrivez brièvement votre projet ou votre besoin.

Exemple :
« Je souhaite installer 8 caméras extérieures avec enregistrement pendant 30 jours. »`;

    addHistory(session, "out", response);
    return response;
  }

  if (session.state === "PROJECT") {
    session.project = message;
    session.state = "QUANTITY";

    const response = `Merci pour ces informations 👍

🔢 Quelle est la quantité approximative souhaitée ?

Exemple : 8 caméras, 2 portes, 1 portail, 20 prises réseau, etc.`;

    addHistory(session, "out", response);
    return response;
  }

  if (session.state === "QUANTITY") {
    session.quantity = message;
    session.state = "DELAY";

    const response = `Très bien 👍

⏱️ Quel est votre délai souhaité pour la réalisation du projet ?

Exemple :
• Urgent
• Cette semaine
• Ce mois-ci
• Dans 1 à 3 mois
• Pas encore défini`;

    addHistory(session, "out", response);
    return response;
  }

  if (session.state === "DELAY") {
    session.delay = message;
    session.state = "DONE";

    const response = `✅ *Demande enregistrée*

Voici le récapitulatif :

🔐 Service : ${session.service}
🏢 Type de site : ${session.siteType || "Non précisé"}
📍 Localisation : ${session.location || "Non précisée"}
📝 Projet : ${session.project || "Non précisé"}
🔢 Quantité : ${session.quantity || "Non précisée"}
⏱️ Délai : ${session.delay || "Non précisé"}

Merci pour votre confiance 🤝

Un conseiller de VisionProtection & Informatique pourra vous contacter pour la suite.

Tapez *MENU* pour revenir au menu principal.`;

    addHistory(session, "out", response);
    return response;
  }

  if (session.state === "QUOTE") {
    session.project = message;
    session.state = "LOCATION_QUOTE";

    const response = `Merci 👍

📍 Dans quelle ville ou commune se situe le projet ?`;

    addHistory(session, "out", response);
    return response;
  }

  if (session.state === "LOCATION_QUOTE") {
    session.location = message;
    session.state = "DONE";

    const response = `✅ *Demande de devis enregistrée*

🔐 Service : Demande de devis
📍 Localisation : ${session.location}
📝 Projet : ${session.project || "Non précisé"}

Merci pour votre demande.

Notre équipe pourra revenir vers vous pour obtenir les informations complémentaires et établir votre devis.

Tapez *MENU* pour revenir au menu principal.`;

    addHistory(session, "out", response);
    return response;
  }

  if (session.state === "ADVISOR") {
    session.project = message;
    session.state = "DONE";

    const response = `✅ Votre demande a bien été transmise.

📝 Besoin :
${session.project}

Un conseiller de VisionProtection & Informatique pourra vous répondre.

Tapez *MENU* pour revenir au menu principal.`;

    addHistory(session, "out", response);
    return response;
  }

  if (session.state === "DONE") {
    const response = `Votre demande est déjà enregistrée. 👍

Tapez *MENU* pour recommencer une nouvelle demande ou *8* pour faire une demande de devis.`;

    addHistory(session, "out", response);
    return response;
  }

  session.state = "MENU";

  const response = mainMenu();
  addHistory(session, "out", response);
  return response;
}

/* =========================
   WEBHOOK META - VERIFICATION
   ========================= */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("WEBHOOK META VERIFIE");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

/* =========================
   WEBHOOK META - MESSAGES
   ========================= */
app.post("/webhook", (req, res) => {
  console.log("\n===== WEBHOOK WHATSAPP =====");
  console.log(JSON.stringify(req.body, null, 2));

  // Réponse immédiate à Meta.
  res.sendStatus(200);

  try {
    const entry = req.body?.entry || [];

    for (const item of entry) {
      const changes = item?.changes || [];

      for (const change of changes) {
        const value = change?.value;

        if (!value) continue;

        // Les statuses sent/delivered/read ne sont pas des messages entrants.
        if (!value.messages || !Array.isArray(value.messages) || value.messages.length === 0) {
          if (value.statuses) {
            console.log(
              "STATUS WHATSAPP :",
              JSON.stringify(value.statuses, null, 2)
            );
          }
          continue;
        }

        const contacts = value.contacts || [];

        for (const message of value.messages) {
          const from = message.from;
          const contact =
            contacts.find((c) => c.wa_id === from) ||
            contacts[0] ||
            {};

          const profileName = contact?.profile?.name || "";
          let incomingText = "";

          if (message.type === "text") {
            incomingText = message.text?.body || "";
          } else if (message.type === "interactive") {
            const interactive = message.interactive || {};

            if (interactive.type === "button_reply") {
              incomingText =
                interactive.button_reply?.id ||
                interactive.button_reply?.title ||
                "";
            } else if (interactive.type === "list_reply") {
              incomingText =
                interactive.list_reply?.id ||
                interactive.list_reply?.title ||
                "";
            }
          } else if (message.type === "button") {
            incomingText =
              message.button?.text ||
              message.button?.payload ||
              "";
          }

          if (!incomingText) {
            console.log("Message non textuel non traité :", message.type);
            continue;
          }

          processMessage(from, profileName, incomingText)
            .then((response) => sendText(from, response))
            .then((result) => {
              console.log(
                "REPONSE WHATSAPP ENVOYEE :",
                JSON.stringify(result, null, 2)
              );
            })
            .catch((error) => {
              console.error(
                "ERREUR TRAITEMENT / ENVOI WHATSAPP :",
                error.response?.data || error.message
              );
            });
        }
      }
    }
  } catch (error) {
    console.error("ERREUR WEBHOOK :", error);
  }
});

/* =========================
   CRM
   ========================= */
app.get("/crm/prospects", (req, res) => {
  const prospects = Array.from(sessions.values()).map((session) => ({
    ...session
  }));

  res.json({
    success: true,
    count: prospects.length,
    prospects
  });
});

app.get("/crm/prospect/:phone", (req, res) => {
  const phone = req.params.phone;
  const session = sessions.get(phone);

  if (!session) {
    return res.status(404).json({
      success: false,
      message: "Prospect introuvable"
    });
  }

  return res.json({
    success: true,
    prospect: session
  });
});

app.get("/crm/stats", (req, res) => {
  const prospects = Array.from(sessions.values());
  const byService = {};

  for (const session of prospects) {
    const service = session.service || "Non défini";
    byService[service] = (byService[service] || 0) + 1;
  }

  res.json({
    success: true,
    totalProspects: prospects.length,
    activeConversations: prospects.filter(
      (p) => p.state !== "DONE"
    ).length,
    completedConversations: prospects.filter(
      (p) => p.state === "DONE"
    ).length,
    byService
  });
});

/* =========================
   HEALTH CHECK
   ========================= */
app.get("/", (req, res) => {
  res.json({
    success: true,
    application: "VisionProtection WhatsApp CRM",
    version: "2.5.2",
    graphApi: GRAPH_VERSION,
    webhook: "/webhook",
    crm: "/crm/prospects",
    stats: "/crm/stats",
    status: "online"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("VisionProtection WhatsApp CRM");
  console.log("Version : 2.5.2");
  console.log(`Serveur démarré sur le port ${PORT}`);
  console.log(`Graph API : ${GRAPH_VERSION}`);
  console.log("Webhook : /webhook");
  console.log("CRM : /crm/prospects");
  console.log("Stats : /crm/stats");
});
