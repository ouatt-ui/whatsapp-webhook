const express = require("express");
const axios = require("axios");
const mysql = require("mysql2/promise");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "visionprotection2024";
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const GRAPH_VERSION = "v26.0";
const WHATSAPP_API_URL = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

const sessions = new Map();

// MYSQL / AIVEN
const dbConfig = {
  host: process.env.Host || process.env.DB_HOST,
  port: Number(process.env.Port || process.env.DB_PORT || 3306),
  user: process.env.User || process.env.DB_USER,
  password: process.env.Password || process.env.DB_PASSWORD,
  database: process.env.Database || process.env.DB_NAME || "defaultdb",
  ssl: { minVersion: "TLSv1.2" },
  waitForConnections: true, connectionLimit: 5, queueLimit: 0
};
let pool = null;
let dbReady = false;

async function initDatabase() {
  if (!dbConfig.host || !dbConfig.user || !dbConfig.password) { console.log("MYSQL : variables absentes. Mode mémoire."); return; }
  try {
    pool = mysql.createPool(dbConfig);
    await pool.query(`CREATE TABLE IF NOT EXISTS prospects (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, phone VARCHAR(30) NOT NULL, name VARCHAR(255) NULL,
      state VARCHAR(50) NULL, service VARCHAR(255) NULL, site_type VARCHAR(255) NULL, location VARCHAR(255) NULL,
      project TEXT NULL, quantity VARCHAR(100) NULL, delay VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id), UNIQUE KEY uq_prospects_phone (phone)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await pool.query(`CREATE TABLE IF NOT EXISTS conversation_messages (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, prospect_id BIGINT UNSIGNED NOT NULL, phone VARCHAR(30) NOT NULL,
      direction ENUM('in','out') NOT NULL, message TEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id), KEY idx_messages_phone (phone), KEY idx_messages_prospect (prospect_id),
      CONSTRAINT fk_messages_prospect FOREIGN KEY (prospect_id) REFERENCES prospects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await pool.query("SELECT 1"); dbReady = true;
    console.log("MYSQL : connexion Aiven opérationnelle.");
    console.log("MYSQL : tables prospects et conversation_messages vérifiées.");
  } catch (e) { dbReady=false; console.error("MYSQL : connexion impossible :", e.message); console.log("MYSQL : le CRM continue en mode mémoire."); }
}

async function saveProspect(session) {
  if (!dbReady || !pool) return;
  await pool.query(`INSERT INTO prospects (phone,name,state,service,site_type,location,project,quantity,delay)
    VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),state=VALUES(state),service=VALUES(service),
    site_type=VALUES(site_type),location=VALUES(location),project=VALUES(project),quantity=VALUES(quantity),delay=VALUES(delay),updated_at=CURRENT_TIMESTAMP`,
    [session.phone,session.name||null,session.state||null,session.service||null,session.siteType||null,session.location||null,session.project||null,session.quantity||null,session.delay||null]);
}
async function getProspectId(phone) {
  if (!dbReady || !pool) return null; const [r]=await pool.query("SELECT id FROM prospects WHERE phone=? LIMIT 1",[phone]); return r.length?r[0].id:null;
}
async function saveMessage(session,direction,text) {
  if (!dbReady || !pool || !text) return;
  try { await saveProspect(session); const id=await getProspectId(session.phone); if(id) await pool.query("INSERT INTO conversation_messages (prospect_id,phone,direction,message) VALUES (?,?,?,?)",[id,session.phone,direction,text]); }
  catch(e){ console.error("MYSQL : erreur sauvegarde message :",e.message); }
}
async function loadProspect(phone) {
  if (!dbReady || !pool) return null;
  try {
    const [r]=await pool.query("SELECT * FROM prospects WHERE phone=? LIMIT 1",[phone]); if(!r.length) return null; const p=r[0];
    const [m]=await pool.query("SELECT direction,message,created_at FROM conversation_messages WHERE phone=? ORDER BY id DESC LIMIT 100",[phone]);
    return {phone:p.phone,name:p.name||"",state:p.state||"MENU",service:p.service||null,siteType:p.site_type||null,location:p.location||null,project:p.project||null,quantity:p.quantity||null,delay:p.delay||null,history:m.reverse().map(x=>({direction:x.direction,text:x.message,at:x.created_at})),createdAt:p.created_at,updatedAt:p.updated_at};
  } catch(e){ console.error("MYSQL : erreur chargement :",e.message); return null; }
}


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

async function getSession(phone, profileName = "") {
  if (sessions.has(phone)) { const s=sessions.get(phone); if(profileName&&!s.name)s.name=profileName; return s; }
  const stored=await loadProspect(phone);
  if(stored){ if(profileName&&!stored.name)stored.name=profileName; sessions.set(phone,stored); return stored; }
  const session={phone,name:profileName||"",state:"MENU",service:null,siteType:null,location:null,project:null,quantity:null,delay:null,history:[],createdAt:new Date(),updatedAt:new Date()};
  sessions.set(phone,session); await saveProspect(session); return session;
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
  const session = await getSession(from, profileName);
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
app.get("/crm/prospects", async (req, res) => {
  try {
    if (dbReady && pool) {
      const [rows] = await pool.query(
        "SELECT id, phone, name, state, service, site_type, location, project, quantity, delay, created_at, updated_at FROM prospects ORDER BY updated_at DESC"
      );
      return res.json({ success: true, count: rows.length, prospects: rows, database: "mysql" });
    }

    const prospects = Array.from(sessions.values()).map((session) => ({ ...session }));
    return res.json({ success: true, count: prospects.length, prospects, database: "memory-fallback" });
  } catch (e) {
    console.error("CRM MYSQL /prospects :", e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/crm/prospect/:phone", async (req, res) => {
  const phone = req.params.phone;

  try {
    if (dbReady && pool) {
      const prospect = await loadProspect(phone);
      if (!prospect) {
        return res.status(404).json({ success: false, message: "Prospect introuvable" });
      }
      return res.json({ success: true, prospect, database: "mysql" });
    }

    const session = sessions.get(phone);
    if (!session) {
      return res.status(404).json({ success: false, message: "Prospect introuvable" });
    }

    return res.json({ success: true, prospect: session, database: "memory-fallback" });
  } catch (e) {
    console.error("CRM MYSQL /prospect :", e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/crm/stats", async (req, res) => {
  try {
    if (dbReady && pool) {
      const [[t]] = await pool.query(`
        SELECT
          COUNT(*) AS totalProspects,
          SUM(state <> 'DONE' OR state IS NULL) AS activeConversations,
          SUM(state = 'DONE') AS completedConversations
        FROM prospects
      `);
      const [services] = await pool.query(`
        SELECT COALESCE(service, 'Non défini') AS service, COUNT(*) AS total
        FROM prospects
        GROUP BY service
        ORDER BY total DESC
      `);

      const byService = {};
      for (const row of services) byService[row.service] = Number(row.total);

      return res.json({
        success: true,
        totalProspects: Number(t.totalProspects || 0),
        activeConversations: Number(t.activeConversations || 0),
        completedConversations: Number(t.completedConversations || 0),
        byService,
        database: "mysql"
      });
    }

    const prospects = Array.from(sessions.values());
    const byService = {};
    for (const session of prospects) {
      const service = session.service || "Non défini";
      byService[service] = (byService[service] || 0) + 1;
    }

    return res.json({
      success: true,
      totalProspects: prospects.length,
      activeConversations: prospects.filter((p) => p.state !== "DONE").length,
      completedConversations: prospects.filter((p) => p.state === "DONE").length,
      byService,
      database: "memory-fallback"
    });
  } catch (e) {
    console.error("CRM MYSQL /stats :", e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
});

/* =========================
   HEALTH CHECK
   ========================= */
app.get("/", (req, res) => {
  res.json({
    success: true,
    application: "VisionProtection WhatsApp CRM",
    version: "2.5.2-mysql",
    database: dbReady ? "mysql-connected" : "memory-fallback",
    graphApi: GRAPH_VERSION,
    webhook: "/webhook",
    crm: "/crm/prospects",
    stats: "/crm/stats",
    status: "online"
  });
});

app.get("/crm/mysql-prospects", async (req,res)=>{ if(!dbReady||!pool)return res.json({database:"memory-fallback"}); const [rows]=await pool.query("SELECT * FROM prospects ORDER BY updated_at DESC"); res.json({database:"mysql",count:rows.length,prospects:rows}); });
app.get("/crm/mysql-stats", async (req,res)=>{ if(!dbReady||!pool)return res.json({database:"memory-fallback"}); const [[t]]=await pool.query("SELECT COUNT(*) total_prospects, SUM(state='DONE') demandes_terminees FROM prospects"); const [services]=await pool.query("SELECT service,COUNT(*) total FROM prospects WHERE service IS NOT NULL GROUP BY service ORDER BY total DESC"); res.json({database:"mysql",total_prospects:Number(t.total_prospects||0),demandes_terminees:Number(t.demandes_terminees||0),par_service:services}); });

initDatabase()
  .catch((error) => {
    console.error("MYSQL : erreur initialisation :", error.message);
  })
  .finally(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log("VisionProtection WhatsApp CRM");
      console.log("Version : 2.5.2");
      console.log(`Serveur démarré sur le port ${PORT}`);
      console.log(`Graph API : ${GRAPH_VERSION}`);
      console.log("Webhook : /webhook");
      console.log("CRM : /crm/prospects");
      console.log("Stats : /crm/stats");
    });
  });
