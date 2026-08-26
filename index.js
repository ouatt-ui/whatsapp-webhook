const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

// ===============================
// CONFIGURATION
// ===============================

const PORT = process.env.PORT || 3000;

const VERIFY_TOKEN =
  process.env.META_VERIFY_TOKEN || "visionprotection2024";

const WHATSAPP_TOKEN =
  process.env.WHATSAPP_ACCESS_TOKEN || "";

const PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID || "";

// ===============================
// PAGE D'ACCUEIL
// ===============================

app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "VisionProtection WhatsApp Webhook",
    version: "2.5",
    webhook: "/webhook"
  });
});

// ===============================
// VERIFICATION META WEBHOOK
// ===============================

app.get("/webhook", (req, res) => {

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("Demande de vérification Meta reçue");

  if (
    mode === "subscribe" &&
    token === VERIFY_TOKEN
  ) {
    console.log("Webhook Meta vérifié avec succès");

    return res.status(200).send(challenge);
  }

  console.log("Échec vérification webhook");

  return res.sendStatus(403);
});

// ===============================
// RECEPTION WHATSAPP
// ===============================

app.post("/webhook", async (req, res) => {

  console.log("=================================");
  console.log("MESSAGE WHATSAPP REÇU");
  console.log("=================================");

  console.log(
    JSON.stringify(req.body, null, 2)
  );

  // Réponse immédiate à Meta
  res.sendStatus(200);

  try {

    const entry = req.body.entry;

    if (!entry || !entry.length) {
      return;
    }

    const changes = entry[0].changes;

    if (!changes || !changes.length) {
      return;
    }

    const value = changes[0].value;

    if (!value.messages || !value.messages.length) {
      return;
    }

    const message = value.messages[0];

    let from = message.from;

// Pour le numéro de test Meta :
// le wa_id reçu par le webhook doit être converti
// vers le numéro utilisé par l'API d'envoi.
if (from === "22557948536") {
  from = "2250757948536";
}

    let messageText = "";

    if (
      message.type === "text" &&
      message.text
    ) {
      messageText = message.text.body;
    }

    console.log("Prospect :", from);
    console.log("Message :", messageText);

    // ===============================
    // REPONSE AUTOMATIQUE
    // ===============================

    if (
      WHATSAPP_TOKEN &&
      PHONE_NUMBER_ID &&
      messageText
    ) {

      const response =
        `Bonjour 👋 Bienvenue chez VisionProtection & Informatique.

Merci pour votre message.

Nous proposons notamment :

1️⃣ Vidéosurveillance
2️⃣ Contrôle d'accès
3️⃣ Alarme intrusion
4️⃣ SSI / CMSI
5️⃣ Motorisation de portail
6️⃣ Domotique
7️⃣ Réseau informatique

Répondez simplement avec le numéro correspondant à votre besoin.`;

      await axios.post(
        `https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          type: "text",
          text: {
            body: response
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

      console.log(
        "Réponse WhatsApp envoyée à",
        from
      );
    }

  } catch (error) {

    console.error(
      "Erreur traitement WhatsApp :",
      error.response?.data ||
      error.message
    );
  }
});

// ===============================
// DEMARRAGE SERVEUR
// ===============================

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `VisionProtection WhatsApp Webhook démarré sur le port ${PORT}`
    );

  }
);
