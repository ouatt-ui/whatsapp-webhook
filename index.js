  const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

// ======================================================
// VISIONPROTECTION WHATSAPP CRM
// VERSION 2.5.1
// ======================================================

const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN =
  process.env.META_VERIFY_TOKEN || "visionprotection2024";

const WHATSAPP_TOKEN =
  process.env.WHATSAPP_ACCESS_TOKEN || "";

const PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID || "";

const GRAPH_VERSION = "v26.0";

const WHATSAPP_API_URL =
  `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

// ======================================================
// STOCKAGE TEMPORAIRE DES SESSIONS
// ======================================================

const sessions = new Map();

// ======================================================
// SERVICES
// ======================================================

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

// ======================================================
// NORMALISATION DU NUMERO
// ======================================================

function normalizeForApi(phone) {

  let number = String(phone).replace(/[^\d]/g, "");

  /*
   * Compatibilité avec le numéro de test Meta.
   *
   * Meta peut envoyer :
   *
   * 22557948536
   *
   * alors que l'API de test attend :
   *
   * 2250757948536
   */

  if (number === "22557948536") {
    return "2250757948536";
  }

  return number;
}

// ======================================================
// CREATION / RECUPERATION SESSION
// ======================================================

function getSession(phone, profileName = "") {

  const key = normalizeForApi(phone);

  if (!sessions.has(key)) {

    sessions.set(key, {

      phone: key,

      name:
        profileName ||
        "Prospect",

      state:
        "MENU",

      service:
        null,

      siteType:
        null,

      location:
        null,

      project:
        null,

      quantity:
        null,

      delay:
        null,

      history:
        [],

      createdAt:
        new Date().toISOString(),

      updatedAt:
        new Date().toISOString()

    });

  }

  const session =
    sessions.get(key);

  if (profileName) {

    session.name =
      profileName;

  }

  session.updatedAt =
    new Date().toISOString();

  return session;
}

// ======================================================
// HISTORIQUE
// ======================================================

function addHistory(
  session,
  direction,
  text
) {

  session.history.push({

    direction,

    text,

    timestamp:
      new Date().toISOString()

  });

  if (
    session.history.length >
    100
  ) {

    session.history =
      session.history.slice(-100);

  }
}

// ======================================================
// ENVOI MESSAGE WHATSAPP
// ======================================================

async function sendText(
  to,
  body
) {

  if (
    !WHATSAPP_TOKEN ||
    !PHONE_NUMBER_ID
  ) {

    throw new Error(
      "WHATSAPP_ACCESS_TOKEN ou WHATSAPP_PHONE_NUMBER_ID manquant dans Render"
    );

  }

  const recipient =
    normalizeForApi(to);

  const response =
    await axios.post(

      WHATSAPP_API_URL,

      {

        messaging_product:
          "whatsapp",

        to:
          recipient,

        type:
          "text",

        text: {

          body:
            body

        }

      },

      {

        headers: {

          Authorization:
            `Bearer ${WHATSAPP_TOKEN}`,

          "Content-Type":
            "application/json"

        }

      }

    );

  return response.data;
}

// ======================================================
// MENU PRINCIPAL
// ======================================================

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

// ======================================================
// QUESTIONS SERVICES
// ======================================================

function serviceQuestion(service) {

  const questions = {

    "Vidéosurveillance":

`📹 *VIDÉOSURVEILLANCE*

Quel type de site souhaitez-vous équiper ?

1️⃣ Maison
2️⃣ Bureau
3️⃣ Commerce
4️⃣ Hôtel
5️⃣ Usine
6️⃣ Autre

Répondez avec le numéro correspondant.`,

    "Contrôle d'accès":

`🔐 *CONTRÔLE D'ACCÈS*

Quel type d'installation recherchez-vous ?

1️⃣ Porte
2️⃣ Plusieurs portes
3️⃣ Immeuble
4️⃣ Hôtel
5️⃣ Entreprise
6️⃣ Autre

Répondez avec le numéro correspondant.`,

    "Alarme intrusion":

`🚨 *ALARME INTRUSION*

Quel type de site souhaitez-vous protéger ?

1️⃣ Maison
2️⃣ Bureau
3️⃣ Commerce
4️⃣ Hôtel
5️⃣ Usine
6️⃣ Autre

Répondez avec le numéro correspondant.`,

    "SSI / CMSI":

`🔥 *SSI / CMSI*

Quel type de bâtiment souhaitez-vous sécuriser ?

1️⃣ Hôtel
2️⃣ Immeuble
3️⃣ Bureau
4️⃣ Usine
5️⃣ Commerce
6️⃣ Établissement public
7️⃣ Autre

Répondez avec le numéro correspondant.`,

    "Motorisation de portail":

`🚪 *MOTORISATION DE PORTAIL*

Quel équipement souhaitez-vous automatiser ?

1️⃣ Portail coulissant
2️⃣ Portail battant
3️⃣ Portail industriel
4️⃣ Barrière automatique
5️⃣ Autre

Répondez avec le numéro correspondant.`,

    "Domotique":

`🏠 *DOMOTIQUE*

Quel besoin vous intéresse ?

1️⃣ Éclairage
2️⃣ Climatisation
3️⃣ Sécurité
4️⃣ Contrôle à distance
5️⃣ Hôtel / chambre
6️⃣ Maison intelligente
7️⃣ Autre

Répondez avec le numéro correspondant.`,

    "Réseau informatique":

`🌐 *RÉSEAU INFORMATIQUE*

Quel type de réseau souhaitez-vous ?

1️⃣ Réseau entreprise
2️⃣ Wi-Fi
3️⃣ VLAN
4️⃣ Fibre / liaison
5️⃣ Baie informatique
6️⃣ Autre

Répondez avec le numéro correspondant.`

  };

  return questions[service] || null;
}

// ======================================================
// INTERPRETATION DES CHOIX
// ======================================================

function choiceLabel(
  choice,
  service
) {

  if (
    service ===
    "SSI / CMSI"
  ) {

    return {

      "1":
        "Hôtel",

      "2":
        "Immeuble",

      "3":
        "Bureau",

      "4":
        "Usine",

      "5":
        "Commerce",

      "6":
        "Établissement public",

      "7":
        "Autre"

    }[choice] || choice;

  }

  if (
    service ===
    "Motorisation de portail"
  ) {

    return {

      "1":
        "Portail coulissant",

      "2":
        "Portail battant",

      "3":
        "Portail industriel",

      "4":
        "Barrière automatique",

      "5":
        "Autre"

    }[choice] || choice;

  }

  if (
    service ===
    "Domotique"
  ) {

    return {

      "1":
        "Éclairage",

      "2":
        "Climatisation",

      "3":
        "Sécurité",

      "4":
        "Contrôle à distance",

      "5":
        "Hôtel / chambre",

      "6":
        "Maison intelligente",

      "7":
        "Autre"

    }[choice] || choice;

  }

  if (
    service ===
    "Réseau informatique"
  ) {

    return {

      "1":
        "Réseau entreprise",

      "2":
        "Wi-Fi",

      "3":
        "VLAN",

      "4":
        "Fibre / liaison",

      "5":
        "Baie informatique",

      "6":
        "Autre"

    }[choice] || choice;

  }

  return {

    "1":
      "Maison",

    "2":
      "Bureau",

    "3":
      "Commerce",

    "4":
      "Hôtel",

    "5":
      "Usine",

    "6":
      "Autre"

  }[choice] || choice;

}

// ======================================================
// DEMANDE DEVIS
// ======================================================

function quoteRequestMessage(
  session
) {

  return `📋 *DEMANDE DE DEVIS*

Merci ${session.name}.

Pour préparer votre devis, envoyez-nous :

1️⃣ La localisation du site
2️⃣ Une description du besoin
3️⃣ La quantité approximative d'équipements si vous la connaissez

Exemple :

"Cocody, 12 caméras IP, NVR et installation complète"

Un conseiller VisionProtection vous recontactera ensuite.`;

}

// ======================================================
// TRAITEMENT DU MESSAGE
// ======================================================

async function processMessage(
  from,
  profileName,
  text
) {

  const session =
    getSession(
      from,
      profileName
    );

  const message =
    text.trim();

  const lower =
    message.toLowerCase();

  addHistory(
    session,
    "in",
    message
  );

  // ====================================================
  // RETOUR MENU
  // ====================================================

  if (

    lower ===
      "bonjour" ||

    lower ===
      "bjr" ||

    lower ===
      "bonsoir" ||

    lower ===
      "slt" ||

    lower ===
      "salut" ||

    lower ===
      "menu" ||

    lower ===
      "start" ||

    lower ===
      "0"

  ) {

    session.state =
      "MENU";

    session.service =
      null;

    const response =
      mainMenu();

    addHistory(
      session,
      "out",
      response
    );

    return response;
  }

  // ====================================================
  // MENU
  // ====================================================

  if (
    session.state ===
    "MENU"
  ) {

    if (
      !SERVICES[message]
    ) {

      const response =
        `Je n'ai pas reconnu votre choix.

${mainMenu()}`;

      addHistory(
        session,
        "out",
        response
      );

      return response;
    }

    session.service =
      SERVICES[message];

    // ==================================================
    // DEMANDE DEVIS
    // ==================================================

    if (
      message ===
      "8"
    ) {

      session.state =
        "QUOTE";

      const response =
        quoteRequestMessage(
          session
        );

      addHistory(
        session,
        "out",
        response
      );

      return response;
    }

    // ==================================================
    // CONSEILLER
    // ==================================================

    if (
      message ===
      "9"
    ) {

      session.state =
        "ADVISOR";

      const response =
`👨‍💼 *CONSEILLER VISIONPROTECTION*

Votre demande a été enregistrée.

Merci d'envoyer :

• Votre nom
• La localisation du site
• Votre besoin

Un conseiller VisionProtection pourra ensuite vous recontacter.`;

      addHistory(
        session,
        "out",
        response
      );

      return response;
    }

    // ==================================================
    // SERVICE NORMAL
    // ==================================================

    session.state =
      "SITE_TYPE";

    const response =
      serviceQuestion(
        session.service
      ) ||
`Merci.

Votre besoin concerne :
*${session.service}*

Pouvez-vous décrire votre projet ?`;

    addHistory(
      session,
      "out",
      response
    );

    return response;
  }

  // ====================================================
  // TYPE DE SITE
  // ====================================================

  if (
    session.state ===
    "SITE_TYPE"
  ) {

    session.siteType =
      choiceLabel(
        message,
        session.service
      );

    session.state =
      "LOCATION";

    const response =
`Merci. 👍

🏢 Type de site :
*${session.siteType}*

🔧 Service :
*${session.service}*

📍 Dans quelle ville ou commune se trouve le projet ?`;

    addHistory(
      session,
      "out",
      response
    );

    return response;
  }

  // ====================================================
  // LOCALISATION
  // ====================================================

  if (
    session.state ===
    "LOCATION"
  ) {

    session.location =
      message;

    session.state =
      "PROJECT";

    const response =
`Très bien. 📍

Localisation :
*${session.location}*

Décrivez brièvement votre besoin ou votre projet.

Exemple :

"Je souhaite installer 12 caméras IP avec NVR et installation complète."`;

    addHistory(
      session,
      "out",
      response
    );

    return response;
  }

  // ====================================================
  // DESCRIPTION PROJET
  // ====================================================

  if (
    session.state ===
    "PROJECT"
  ) {

    session.project =
      message;

    session.state =
      "QUANTITY";

    const response =
`Merci pour ces informations. 👍

Quelle est la quantité approximative d'équipements souhaitée ?

Si vous ne connaissez pas encore la quantité, répondez :

*Je ne sais pas*`;

    addHistory(
      session,
      "out",
      response
    );

    return response;
  }

  // ====================================================
  // QUANTITE
  // ====================================================

  if (
    session.state ===
    "QUANTITY"
  ) {

    session.quantity =
      message;

    session.state =
      "DELAY";

    const response =
`Parfait.

⏱️ Quel est votre délai souhaité ?

1️⃣ Urgent
2️⃣ Cette semaine
3️⃣ Ce mois-ci
4️⃣ Plus tard
5️⃣ Je ne sais pas`;

    addHistory(
      session,
      "out",
      response
    );

    return response;
  }

  // ====================================================
  // DELAI
  // ====================================================

  if (
    session.state ===
    "DELAY"
  ) {

    const delays = {

      "1":
        "Urgent",

      "2":
        "Cette semaine",

      "3":
        "Ce mois-ci",

      "4":
        "Plus tard",

      "5":
        "À définir"

    };

    session.delay =
      delays[message] ||
      message;

    session.state =
      "DONE";

    const response =
`✅ *DEMANDE ENREGISTRÉE*

👤 Prospect :
${session.name}

📱 Téléphone :
${session.phone}

🔧 Service :
${session.service}

🏢 Type de site :
${session.siteType}

📍 Localisation :
${session.location}

📝 Projet :
${session.project}

📦 Quantité :
${session.quantity}

⏱️ Délai :
${session.delay}

Merci pour votre confiance.

Un conseiller de *VisionProtection & Informatique* vous recontactera pour finaliser votre demande.

Tapez *MENU* pour revenir au menu principal.`;

    addHistory(
      session,
      "out",
      response
    );

    return response;
  }

  // ====================================================
  // DEMANDE DEVIS
  // ====================================================

  if (
    session.state ===
    "QUOTE"
  ) {

    session.project =
      message;

    session.state =
      "LOCATION_QUOTE";

    const response =
`Merci pour votre demande de devis. 📋

Dans quelle ville ou commune se trouve le projet ?`;

    addHistory(
      session,
      "out",
      response
    );

    return response;
  }

  // ====================================================
  // LOCALISATION DEVIS
  // ====================================================

  if (
    session.state ===
    "LOCATION_QUOTE"
  ) {

    session.location =
      message;

    session.state =
      "DONE";

    const response =
`✅ *DEMANDE DE DEVIS ENREGISTRÉE*

👤 ${session.name}

📱 ${session.phone}

📍 ${session.location}

📝 ${session.project}

Un conseiller VisionProtection vous recontactera pour préparer votre devis.

Tapez *MENU* pour voir nos autres services.`;

    addHistory(
      session,
      "out",
      response
    );

    return response;
  }

  // ====================================================
  // CONSEILLER
  // ====================================================

  if (
    session.state ===
    "ADVISOR"
  ) {

    session.project =
      message;

    session.state =
      "DONE";

    const response =
`Merci.

Votre demande a été enregistrée pour le parcours conseiller. 👨‍💼

📱 Téléphone :
${session.phone}

📝 Besoin :
${session.project}

Un conseiller VisionProtection vous recontactera.`;

    addHistory(
      session,
      "out",
      response
    );

    return response;
  }

  // ====================================================
  // DEMANDE DEJA TERMINEE
  // ====================================================

  if (
    session.state ===
    "DONE"
  ) {

    const response =
`Votre demande est déjà enregistrée. ✅

Tapez :

*MENU*

pour choisir un autre service.

Ou :

*8*

pour une nouvelle demande de devis.`;

    addHistory(
      session,
      "out",
      response
    );

    return response;
  }

  // ====================================================
  // SECURITE
  // ====================================================

  session.state =
    "MENU";

  const response =
    mainMenu();

  addHistory(
    session,
    "out",
    response
  );

  return response;
}

// ======================================================
// PAGE ACCUEIL
// ======================================================

app.get(
  "/",
  (req, res) => {

    res.json({

      status:
        "OK",

      service:
        "VisionProtection WhatsApp Webhook",

      version:
        "2.5.1",

      api:
        GRAPH_VERSION,

      webhook:
        "/webhook",

      crm:
        "session-memory"

    });

  }
);

// ======================================================
// VERIFICATION META
// ======================================================

app.get(
  "/webhook",
  (req, res) => {

    const mode =
      req.query["hub.mode"];

    const token =
      req.query["hub.verify_token"];

    const challenge =
      req.query["hub.challenge"];

    console.log(
      "Demande de vérification Meta reçue"
    );

    if (

      mode ===
        "subscribe" &&

      token ===
        VERIFY_TOKEN

    ) {

      console.log(
        "Webhook Meta vérifié avec succès"
      );

      return res
        .status(200)
        .send(challenge);
    }

    console.log(
      "Échec vérification webhook"
    );

    return res.sendStatus(
      403
    );

  }
);

// ======================================================
// RECEPTION WHATSAPP
// ======================================================

app.post(
  "/webhook",
  async (req, res) => {

    console.log(
      "================================="
    );

    console.log(
      "MESSAGE WHATSAPP REÇU"
    );

    console.log(
      "================================="
    );

    console.log(
      JSON.stringify(
        req.body,
        null,
        2
      )
    );

    /*
     * IMPORTANT :
     * Meta doit recevoir HTTP 200 rapidement.
     */

    res.sendStatus(
      200
    );

    try {

      const entry =
        req.body?.entry;

      if (
        !entry?.length
      ) {

        return;
      }

      const changes =
        entry[0]?.changes;

      if (
        !changes?.length
      ) {

        return;
      }

      const value =
        changes[0]?.value;

      // ==================================================
      // STATUTS
      // ==================================================

      if (
        !value?.messages?.length
      ) {

        if (
          value?.statuses?.length
        ) {

          console.log(
            "Statut WhatsApp :",
            value.statuses.map(
              status => ({

                id:
                  status.id,

                status:
                  status.status,

                recipient:
                  status.recipient_id

              })
            )
          );

        }

        return;
      }

      // ==================================================
      // MESSAGE
      // ==================================================

      const message =
        value.messages[0];

      const from =
        message.from;

      const profileName =
        value.contacts?.[0]
          ?.profile?.name ||
        "Prospect";

      let messageText =
        "";

      // ==================================================
      // MESSAGE TEXTE
      // ==================================================

      if (

        message.type ===
          "text" &&

        message.text

      ) {

        messageText =
          message.text.body ||
          "";

      }

      // ==================================================
      // MESSAGE INTERACTIF
      // ==================================================

      else if (
        message.type ===
        "interactive"
      ) {

        const interactive =
          message.interactive;

        if (
          interactive
            ?.button_reply
            ?.id
        ) {

          messageText =
            interactive
              .button_reply
              .id;

        }

        else if (
          interactive
            ?.list_reply
            ?.id
        ) {

          messageText =
            interactive
              .list_reply
              .id;

        }

      }

      // ==================================================
      // MESSAGE NON PRIS EN CHARGE
      // ==================================================

      if (
        !messageText
      ) {

        console.log(
          "Message non textuel reçu :",
          message.type
        );

        return;
      }

      console.log(
        "Prospect :",
        normalizeForApi(from)
      );

      console.log(
        "Message :",
        messageText
      );

      // ==================================================
      // TRAITEMENT
      // ==================================================

      const responseText =
        await processMessage(
          from,
          profileName,
          messageText
        );

      if (
        !responseText
      ) {

        return;
      }

      // ==================================================
      // REPONSE WHATSAPP
      // ==================================================

      const result =
        await sendText(
          from,
          responseText
        );

      console.log(
        "Réponse WhatsApp envoyée à",
        normalizeForApi(from)
      );

      console.log(
        "Meta message result :",
        JSON.stringify(
          result,
          null,
          2
        )
      );

    }

    catch (
      error
    ) {

      console.error(
        "Erreur traitement WhatsApp :",

        error.response?.data ||
        error.message
      );

    }

  }
);

// ======================================================
// CRM - LISTE PROSPECTS
// ======================================================

app.get(
  "/crm/prospects",
  (req, res) => {

    const prospects =
      Array.from(
        sessions.values()
      ).map(
        session => ({

          phone:
            session.phone,

          name:
            session.name,

          service:
            session.service,

          siteType:
            session.siteType,

          location:
            session.location,

          project:
            session.project,

          quantity:
            session.quantity,

          delay:
            session.delay,

          state:
            session.state,

          createdAt:
            session.createdAt,

          updatedAt:
            session.updatedAt

        })
      );

    res.json({

      version:
        "2.5.1",

      count:
        prospects.length,

      prospects:
        prospects

    });

  }
);

// ======================================================
// CRM - PROSPECT PAR NUMERO
// ======================================================

app.get(
  "/crm/prospect/:phone",
  (req, res) => {

    const phone =
      normalizeForApi(
        req.params.phone
      );

    const session =
      sessions.get(
        phone
      );

    if (
      !session
    ) {

      return res
        .status(404)
        .json({

          error:
            "Prospect introuvable"

        });

    }

    res.json(
      session
    );

  }
);

// ======================================================
// CRM - STATISTIQUES
// ======================================================

app.get(
  "/crm/stats",
  (req, res) => {

    const all =
      Array.from(
        sessions.values()
      );

    const services =
      {};

    for (
      const session
      of all
    ) {

      const service =
        session.service ||
        "Non défini";

      services[service] =
        (
          services[service] ||
          0
        ) + 1;

    }

    const states =
      all.reduce(
        (
          result,
          session
        ) => {

          result[
            session.state
          ] =
            (
              result[
                session.state
              ] ||
              0
            ) + 1;

          return result;

        },
        {}
      );

    res.json({

      version:
        "2.5.1",

      totalProspects:
        all.length,

      services:
        services,

      states:
        states

    });

  }
);

// ======================================================
// DEMARRAGE SERVEUR
// ======================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "================================="
    );

    console.log(
      "VisionProtection WhatsApp CRM"
    );

    console.log(
      "Version : 2.5.1"
    );

    console.log(
      "================================="
    );

    console.log(
      `Serveur démarré sur le port ${PORT}`
    );

    console.log(
      `Graph API : ${GRAPH_VERSION}`
    );

    console.log(
      "Webhook : /webhook"
    );

    console.log(
      "CRM : /crm/prospects"
    );

    console.log(
      "Stats : /crm/stats"
    );

    console.log(
      "================================="
    );

  }
);
