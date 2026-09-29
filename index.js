const express=require("express");
const axios=require("axios");
const mysql=require("mysql2/promise");
const {GoogleGenAI}=require("@google/genai");
const XLSX=require("xlsx");
const PDFDocument=require("pdfkit");
// ================== APPEL GEMINI ROBUSTE V1.3 ==================

let geminiHealth = {
  available: null,
  lastCheck: null,
  reason: null,
  model: "gemini-3.8-flash"
};

// Etat séparé de la prospection Web/Google Search.
// Il évite de marteler Gemini après un 429 et protège le reste du CRM.
let webSearchHealth = {
  available: null,
  lastCheck: null,
  reason: null,
  lastError: null,
  quotaUntil: null,
  searches: 0,
  lastSearchAt: null,
  model: "gemini-3.8-flash"
};

const WEB_SEARCH_QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function webSearchQuotaActive(){
  return Boolean(webSearchHealth.quotaUntil && Date.now() < new Date(webSearchHealth.quotaUntil).getTime());
}

function webSearchQuotaMessage(){
  if(!webSearchHealth.quotaUntil) return "Quota Google Search/Gemini atteint. Réessayez plus tard.";
  const d=new Date(webSearchHealth.quotaUntil);
  return `Quota Google Search/Gemini temporairement bloqué côté CRM jusqu'à environ ${d.toLocaleString('fr-FR')}. Aucun nouvel appel de recherche ne sera lancé avant cette échéance.`;
}

function classifyGeminiError(error) {
  const message = String(error?.message || "");
  const code = String(error?.code || error?.status || error?.response?.status || "");
  const raw = (message + " " + code).toUpperCase();

  if (
    raw.includes("GENERATEREQUESTSPERDAY") ||
    raw.includes("QUOTAVALUE") ||
    raw.includes("DAILY QUOTA") ||
    raw.includes("RESOURCE_EXHAUSTED") ||
    raw.includes("429")
  ) return "QUOTA";

  if (
    raw.includes("503") ||
    raw.includes("UNAVAILABLE") ||
    raw.includes("HIGH DEMAND") ||
    raw.includes("OVERLOADED")
  ) return "UNAVAILABLE";

  if (raw.includes("401") || raw.includes("403") || raw.includes("API KEY") || raw.includes("PERMISSION")) {
    return "AUTH";
  }

  return "OTHER";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getGeminiModelsV221(){
  const primary=String(process.env.GEMINI_MODEL||'gemini-3.8-flash').trim();
  const fallback=String(process.env.GEMINI_FALLBACK_MODEL||'gemini-2.5-flash').trim();
  return {primary,fallback:fallback && fallback!==primary?fallback:null};
}

async function callGemini(prompt, options = {}) {
  const max503Retries = Number.isInteger(options.max503Retries) ? options.max503Retries : 1;
  const models=getGeminiModelsV221();

  if (!gemini) {
    geminiHealth = {
      ...geminiHealth,
      available: false,
      lastCheck: new Date().toISOString(),
      reason: "CLIENT_NON_INITIALISE"
    };
    throw new Error("Client Gemini non initialisé.");
  }

  const candidates=[models.primary, models.fallback].filter(Boolean);
  let lastError=null;

  for(const model of candidates){
    for (let attempt = 0; attempt <= max503Retries; attempt++) {
      try {
        console.log(`🤖 Appel Gemini V2.2.1 modèle=${model} (tentative ${attempt + 1}/${max503Retries + 1})...`);
        const response = await gemini.models.generateContent({model,contents:prompt});
        geminiHealth = {...geminiHealth,available:true,lastCheck:new Date().toISOString(),reason:null,model};
        console.log(`✅ Gemini a répondu avec ${model}.`);
        return {text: response.text || "",model,ai_available:true,fallback:model!==models.primary};
      } catch (error) {
        lastError=error;
        const type = classifyGeminiError(error);
        const message = error?.message || String(error);
        console.error(`❌ ERREUR GEMINI ${model}:`, message);
        geminiHealth = {...geminiHealth,available:false,lastCheck:new Date().toISOString(),reason:type,model};

        if (type === "QUOTA") {
          throw new Error("QUOTA GEMINI ATTEINT. La qualification IA est temporairement indisponible.");
        }
        if (type === "UNAVAILABLE" && attempt < max503Retries) {
          console.log("⏳ Gemini temporairement indisponible. Nouvelle tentative dans 3 secondes...");
          await sleep(3000);
          continue;
        }
        if (type === "UNAVAILABLE") {
          if(model!==models.primary) break;
          console.log(`⚠️ ${models.primary} indisponible après retries. Tentative du modèle de secours: ${models.fallback||'aucun'}.`);
          break;
        }
        throw error;
      }
    }
  }

  const detail=lastError?.message||String(lastError||'Gemini indisponible');
  const err=new Error(`GEMINI TEMPORAIREMENT INDISPONIBLE. Modèles testés: ${candidates.join(', ')}. ${detail.slice(0,400)}`);
  err.geminiType='UNAVAILABLE';
  throw err;
}

function genererRapportFallback(donnees, cause = "Gemini indisponible") {
  const s = donnees.statistiques || {};
  const services = Array.isArray(donnees.services) ? donnees.services : [];
  const villes = Array.isArray(donnees.villes) ? donnees.villes : [];
  const prospects = Array.isArray(donnees.prospects) ? donnees.prospects : [];
  const relances = Array.isArray(donnees.relances) ? donnees.relances : [];

  const topServices = services.slice(0, 5).map(x => `• ${x.service} : ${x.total}`).join("\n") || "• Aucun service enregistré.";
  const topVilles = villes.slice(0, 5).map(x => `• ${x.ville} : ${x.total}`).join("\n") || "• Aucune zone enregistrée.";

  const candidats = prospects.filter(p => ["Devis", "Qualifié", "En cours", "Nouveau"].includes(p.statut)).slice(0, 5);
  const traitement = candidats.map(p => `• ${p.nom || "Sans nom"} — ${p.service || "Service non défini"} — statut : ${p.statut || "Nouveau"}`).join("\n") || "• Aucun prospect actif à signaler.";

  const relanceTexte = relances.length
    ? `• ${relances.length} prospect(s) sans activité depuis au moins 3 jours sont actuellement détectés.`
    : "• Aucun prospect à relancer n'est actuellement détecté par le moteur CRM.";

  return `RAPPORT COMMERCIAL — MODE SECOURS CRM

⚠️ Gemini n'est pas disponible actuellement.
Cause technique : ${cause}
Les données ci-dessous proviennent directement du CRM et aucune action extérieure n'a été effectuée.

1. 📊 SITUATION COMMERCIALE
• Prospects sur 7 jours : ${s.total || 0}
• Nouveaux : ${s.nouveaux || 0}
• En cours : ${s.en_cours || 0}
• Qualifiés : ${s.qualifies || 0}
• Devis : ${s.devis || 0}
• Clients : ${s.clients || 0}
• Perdus : ${s.perdus || 0}

2. 🔐 SERVICES DEMANDÉS
${topServices}

3. 📍 ZONES INTÉRESSANTES
${topVilles}

4. 🎯 PROSPECTS À TRAITER
${traitement}

5. 📱 RELANCES CONSEILLÉES
${relanceTexte}
• Vérifier la fiche du prospect avant tout envoi.
• Adapter le message au service et au besoin enregistrés.
• Enregistrer les informations commerciales importantes dans les notes CRM.

6. 💡 ACTIONS COMMERCIALES
• Actualiser régulièrement les statuts CRM.
• Préparer les devis pour les prospects au statut « Devis ».
• Utiliser les notes commerciales pour conserver le contexte des échanges.

MODE : CRM-FALLBACK
Gemini sera réutilisé automatiquement lors d'une prochaine analyse lorsque le service redeviendra disponible.`;
}

// ================== FIN APPEL GEMINI ROBUSTE V1.3 ==================

const gemini=process.env.GEMINI_API_KEY
  ? new GoogleGenAI({apiKey:process.env.GEMINI_API_KEY})
  : null;
const app=express(); app.use(express.json());
const PORT=process.env.PORT||3000;
const VERIFY_TOKEN=process.env.META_VERIFY_TOKEN||"visionprotection2024";
const WHATSAPP_TOKEN=process.env.WHATSAPP_ACCESS_TOKEN||"";
const PHONE_NUMBER_ID=process.env.WHATSAPP_PHONE_NUMBER_ID||"";
const GRAPH_VERSION="v26.0";
const WHATSAPP_API_URL=`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;
const sessions=new Map();

const dbConfig={
 host:process.env.DB_HOST||process.env.Host,
 port:Number(process.env.DB_PORT||process.env.Port||3306),
 user:process.env.DB_USER||process.env.User,
 password:process.env.DB_PASSWORD||process.env.Password,
 database:process.env.DB_NAME||process.env.Database||"defaultdb",
 ssl:{minVersion:"TLSv1.2",rejectUnauthorized:true,
   ca:process.env.AIVEN_CA_CERT?process.env.AIVEN_CA_CERT.replace(/\\n/g,"\n"):undefined},
 waitForConnections:true,connectionLimit:5,queueLimit:0,enableKeepAlive:true,keepAliveInitialDelayMs:0
};
let pool=null,dbReady=false,connectionAttempts=0;
async function initDatabase(){
 if(!dbConfig.host||!dbConfig.user||!dbConfig.password){console.log("⚠️ MYSQL : variables DB manquantes. Mode mémoire activé.");return;}
 try{
  connectionAttempts++;
  console.log(`🔗 MYSQL : tentative ${connectionAttempts}/3...`);
  console.log(`   Host: ${dbConfig.host}\n   Port: ${dbConfig.port}\n   User: ${dbConfig.user}\n   Database: ${dbConfig.database}`);
  console.log(`   CA Aiven: ${process.env.AIVEN_CA_CERT?"présent":"absent"}`);
  pool=mysql.createPool(dbConfig); const c=await pool.getConnection(); await c.ping(); c.release();
 await pool.query(`CREATE TABLE IF NOT EXISTS prospects(
   id INT AUTO_INCREMENT PRIMARY KEY,
   whatsapp_id VARCHAR(30) NOT NULL UNIQUE,
   nom VARCHAR(150),
   telephone VARCHAR(30),
   entreprise VARCHAR(150),
   ville VARCHAR(100),
   service VARCHAR(150),
   besoin TEXT,
   statut VARCHAR(50) DEFAULT 'Nouveau',
   etat_conversation VARCHAR(20) DEFAULT 'ACTIF',
   notes TEXT,
   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
   updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);// Migration V2 : séparation du statut commercial et de l'état du chatbot
const [columns] = await pool.query(`
  SELECT COUNT(*) AS total
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'prospects'
    AND COLUMN_NAME = 'etat_conversation'
`);

if (Number(columns[0].total) === 0) {
  await pool.query(`
    ALTER TABLE prospects
    ADD COLUMN etat_conversation VARCHAR(20) DEFAULT 'ACTIF'
  `);

  console.log("✅ MYSQL : colonne etat_conversation ajoutée.");
}

// Migration des anciennes valeurs "Terminé"
// L'ancien système utilisait statut="Terminé" pour indiquer
// que la conversation WhatsApp était terminée.
await pool.query(`
  UPDATE prospects
  SET
    etat_conversation = 'TERMINE',
    statut = 'Nouveau'
  WHERE statut = 'Terminé'
`);
  await pool.query(`CREATE TABLE IF NOT EXISTS messages(
   id BIGINT AUTO_INCREMENT PRIMARY KEY, prospect_id INT NULL, whatsapp_message_id VARCHAR(255) NULL,
   direction ENUM('entrant','sortant') NOT NULL, message TEXT NULL, message_type VARCHAR(50) DEFAULT 'text',
   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX idx_messages_prospect(prospect_id),
   INDEX idx_messages_whatsapp_id(whatsapp_message_id),
   CONSTRAINT fk_messages_prospect FOREIGN KEY(prospect_id) REFERENCES prospects(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS notes_commerciales(
   id INT AUTO_INCREMENT PRIMARY KEY, prospect_id INT NOT NULL, note TEXT NOT NULL,
   auteur VARCHAR(100) DEFAULT 'Commercial', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
   INDEX idx_notes_prospect(prospect_id),
   CONSTRAINT fk_notes_prospect FOREIGN KEY(prospect_id) REFERENCES prospects(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS devis(
   id BIGINT AUTO_INCREMENT PRIMARY KEY,
   prospect_id INT NOT NULL,
   numero_devis VARCHAR(50) NOT NULL UNIQUE,
   date_devis DATE NOT NULL,
   objet VARCHAR(255) NULL,
   total DECIMAL(15,2) NOT NULL DEFAULT 0,
   notes TEXT NULL,
   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
   updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
   INDEX idx_devis_prospect(prospect_id),
   CONSTRAINT fk_devis_prospect FOREIGN KEY(prospect_id) REFERENCES prospects(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await pool.query(`CREATE TABLE IF NOT EXISTS devis_lignes(
   id BIGINT AUTO_INCREMENT PRIMARY KEY,
   devis_id BIGINT NOT NULL,
   designation VARCHAR(255) NOT NULL,
   quantite DECIMAL(12,2) NOT NULL DEFAULT 1,
   prix_unitaire DECIMAL(15,2) NOT NULL DEFAULT 0,
   prix_total DECIMAL(15,2) NOT NULL DEFAULT 0,
   ordre INT NOT NULL DEFAULT 0,
   INDEX idx_devis_lignes_devis(devis_id),
   CONSTRAINT fk_devis_lignes_devis FOREIGN KEY(devis_id) REFERENCES devis(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS opportunites_web(
   id BIGINT AUTO_INCREMENT PRIMARY KEY,
   type_opportunite VARCHAR(50) NOT NULL DEFAULT 'AUTRE',
   titre VARCHAR(500) NOT NULL,
   organisation VARCHAR(255),
   ville VARCHAR(150),
   service VARCHAR(255),
   description TEXT,
   date_publication VARCHAR(50),
   date_limite VARCHAR(100),
   contact VARCHAR(255),
   email VARCHAR(255),
   telephone VARCHAR(100),
   url_source TEXT,
   source_nom VARCHAR(255),
   pertinence INT DEFAULT 0,
   statut VARCHAR(40) NOT NULL DEFAULT 'NOUVELLE',
   resume TEXT,
   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
   updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
   UNIQUE KEY uq_opportunite_url(url_source(500)),
   INDEX idx_opportunite_statut(statut),
   INDEX idx_opportunite_date(date_limite)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.query(`CREATE TABLE IF NOT EXISTS prospection_web_collectes(
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    source_id VARCHAR(80) NOT NULL,
    source_nom VARCHAR(255) NOT NULL,
    url_source TEXT NOT NULL,
    titre VARCHAR(500) NOT NULL,
    url_cible TEXT NOT NULL,
    extrait TEXT,
    pertinence INT DEFAULT 0,
    statut VARCHAR(40) NOT NULL DEFAULT 'COLLECTEE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_collecte_url(url_cible(500)),
    INDEX idx_collecte_source(source_id),
    INDEX idx_collecte_statut(statut)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // ================== SUIVI DEVIS V1.9 ==================
  // Migration non destructive : ajoute les champs de suivi si la table existe déjà.
  const migrationsDevisV19 = [
    `ALTER TABLE devis ADD COLUMN statut_suivi VARCHAR(30) NOT NULL DEFAULT 'Brouillon'`,
    `ALTER TABLE devis ADD COLUMN date_envoi DATE NULL`,
    `ALTER TABLE devis ADD COLUMN date_echeance DATE NULL`,
    `ALTER TABLE devis ADD COLUMN commentaire_suivi TEXT NULL`
  ];
  for (const sql of migrationsDevisV19) {
    try { await pool.query(sql); }
    catch (e) {
      if (!String(e.message || '').includes('Duplicate column name')) {
        console.warn('⚠️ Migration devis V1.9 :', e.message);
      }
    }
  }
  dbReady=true; console.log("✅ MYSQL : connexion Aiven opérationnelle.");
  console.log("✅ MYSQL : tables prospects, messages, notes_commerciales, devis et devis_lignes vérifiées.");
 }catch(e){
  console.error("❌ MYSQL : erreur de connexion :",e.message);
  if(pool){try{await pool.end();}catch(_){} pool=null;}
  if(connectionAttempts<3){const d=Math.pow(2,connectionAttempts)*1000;console.log(`⏳ Nouvelle tentative dans ${d}ms...`);setTimeout(()=>initDatabase().catch(()=>{}),d);}
  else console.log("⚠️ MYSQL : mode mémoire activé.");
 }
}
async function upsertProspect(s){
  if(!dbReady||!pool||!s?.phone)return null;

  try{
    const etatConversation =
      s.state === "DONE"
        ? "TERMINE"
        : "ACTIF";

    await pool.query(
      `INSERT INTO prospects(
        whatsapp_id,
        nom,
        telephone,
        ville,
        service,
        besoin,
        statut,
        etat_conversation
      )
      VALUES(?,?,?,?,?,?,?,?)

      ON DUPLICATE KEY UPDATE
        nom=VALUES(nom),
        telephone=VALUES(telephone),
        ville=VALUES(ville),
        service=VALUES(service),
        besoin=VALUES(besoin),
        etat_conversation=VALUES(etat_conversation),
        updated_at=CURRENT_TIMESTAMP`,
      [
        s.phone,
        s.name||null,
        s.phone,
        s.location||null,
        s.service||null,
        s.project||null,
        "Nouveau",
        etatConversation
      ]
    );

    return await getProspectId(s.phone);

  }catch(e){
    console.error(
      "❌ MYSQL : erreur upsertProspect :",
      e.message
    );
    return null;
  }
}
async function getProspectId(phone){
 if(!dbReady||!pool)return null; try{const[r]=await pool.query("SELECT id FROM prospects WHERE whatsapp_id=? LIMIT 1",[phone]);return r.length?r[0].id:null;}
 catch(e){console.error("❌ MYSQL : erreur getProspectId :",e.message);return null;}
}
async function saveMessage(s,direction,text,waId=null,type="text"){
 if(!dbReady||!pool||!text)return;
 try{const id=await upsertProspect(s);await pool.query(
  "INSERT INTO messages(prospect_id,whatsapp_message_id,direction,message,message_type) VALUES(?,?,?,?,?)",
  [id,waId,direction,text,type]);}catch(e){console.error("❌ MYSQL : erreur saveMessage :",e.message);}
}
async function loadProspect(phone){
 if(!dbReady||!pool)return null;
 try{
  const[p]=await pool.query("SELECT * FROM prospects WHERE whatsapp_id=? LIMIT 1",[phone]); if(!p.length)return null;
  const x=p[0]; const[m]=await pool.query("SELECT direction,message,message_type,created_at FROM messages WHERE prospect_id=? ORDER BY id ASC LIMIT 100",[x.id]);
  return {
  phone:x.whatsapp_id,
  name:x.nom||"",
  state:x.etat_conversation==="TERMINE"?"DONE":"MENU",
  service:x.service||null,
  siteType:null,
  location:x.ville||null,
  project:x.besoin||null,
  quantity:null,
  delay:null,

  commercialStatus:x.statut||"Nouveau",

  history:m.map(v=>({
    direction:v.direction,
    text:v.message,
    type:v.message_type,
    at:v.created_at
  })),

  createdAt:x.created_at,
  updatedAt:x.updated_at
};
 }catch(e){console.error("❌ MYSQL : erreur loadProspect :",e.message);return null;}
}
const SERVICES={"1":"Vidéosurveillance","2":"Contrôle d'accès","3":"Alarme intrusion","4":"SSI / CMSI","5":"Motorisation de portail","6":"Domotique","7":"Réseau informatique","8":"Demande de devis","9":"Conseiller"};
function normalizeForApi(phone){
  let n=String(phone||"").replace(/[^\d]/g,"");
  if(n.startsWith("00")) n=n.slice(2);
  if(n.startsWith("225")) return n;
  if(n.startsWith("0")) return "225"+n.slice(1);
  if(n.length===9) return "225"+n;
  return n;
}
function isConversationStart(text){const n=String(text||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();return n==="menu"||n==="start"||n==="0"||/^(bonjour|bjr|bonsoir|slt|salut)\b/.test(n);}
async function getSession(phone,name=""){
 if(sessions.has(phone)){const s=sessions.get(phone);if(name&&!s.name)s.name=name;return s;}
const stored=await loadProspect(phone);

if(stored){
  if(name&&!stored.name)stored.name=name;

  if(!stored.commercialStatus){
    stored.commercialStatus="Nouveau";
  }

  sessions.set(phone,stored);
  return stored;
}
const s={
  phone,
  name:name||"",
  state:"MENU",
  service:null,
  siteType:null,
  location:null,
  project:null,
  quantity:null,
  delay:null,
  commercialStatus:"Nouveau",
  history:[],
  createdAt:new Date(),
  updatedAt:new Date()
};
 sessions.set(phone,s);await upsertProspect(s);return s;
}
async function addHistory(s,d,text,waId=null,type="text"){
 s.history.push({direction:d,text,at:new Date().toISOString(),type});if(s.history.length>100)s.history=s.history.slice(-100);s.updatedAt=new Date().toISOString();
 await saveMessage(s,d,text,waId,type);await upsertProspect(s);
}
function mainMenu(){return`Bonjour 👋 Bienvenue chez VisionProtection & Informatique.

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

👉 Répondez simplement avec le numéro de votre choix.`;}
function serviceQuestion(s){const q={"Vidéosurveillance":`Très bien 👍\n\nPour quel type de site souhaitez-vous installer la vidéosurveillance ?\n\n1️⃣ Maison\n2️⃣ Bureau\n3️⃣ Commerce\n4️⃣ Hôtel\n5️⃣ Usine\n6️⃣ Autre`,"Contrôle d'accès":`Très bien 👍\n\nQuel type de contrôle d'accès recherchez-vous ?\n\n1️⃣ Une porte\n2️⃣ Plusieurs portes\n3️⃣ Immeuble\n4️⃣ Hôtel\n5️⃣ Entreprise\n6️⃣ Autre`,"Alarme intrusion":`Très bien 👍\n\nPour quel type de site souhaitez-vous l'alarme intrusion ?\n\n1️⃣ Maison\n2️⃣ Bureau\n3️⃣ Commerce\n4️⃣ Hôtel\n5️⃣ Usine\n6️⃣ Autre`,"SSI / CMSI":`Très bien 👍\n\nPour quel type de bâtiment souhaitez-vous le système SSI / CMSI ?\n\n1️⃣ Hôtel\n2️⃣ Immeuble\n3️⃣ Bureau\n4️⃣ Usine\n5️⃣ Commerce\n6️⃣ Établissement public\n7️⃣ Autre`,"Motorisation de portail":`Très bien 👍\n\nQuel type de portail souhaitez-vous motoriser ?\n\n1️⃣ Portail coulissant\n2️⃣ Portail battant\n3️⃣ Portail industriel\n4️⃣ Barrière automatique\n5️⃣ Autre`,"Domotique":`Très bien 👍\n\nQuelle solution domotique vous intéresse ?\n\n1️⃣ Éclairage\n2️⃣ Climatisation\n3️⃣ Sécurité\n4️⃣ Contrôle à distance\n5️⃣ Hôtel / chambre\n6️⃣ Maison intelligente\n7️⃣ Autre`,"Réseau informatique":`Très bien 👍\n\nQuel type de réseau informatique souhaitez-vous ?\n\n1️⃣ Réseau entreprise\n2️⃣ Wi-Fi\n3️⃣ VLAN\n4️⃣ Fibre / liaison\n5️⃣ Baie informatique\n6️⃣ Autre`};return q[s]||null;}
function choiceLabel(c,s){const m={"Vidéosurveillance":["Maison","Bureau","Commerce","Hôtel","Usine","Autre"],"Contrôle d'accès":["Une porte","Plusieurs portes","Immeuble","Hôtel","Entreprise","Autre"],"Alarme intrusion":["Maison","Bureau","Commerce","Hôtel","Usine","Autre"],"SSI / CMSI":["Hôtel","Immeuble","Bureau","Usine","Commerce","Établissement public","Autre"],"Motorisation de portail":["Portail coulissant","Portail battant","Portail industriel","Barrière automatique","Autre"],"Domotique":["Éclairage","Climatisation","Sécurité","Contrôle à distance","Hôtel / chambre","Maison intelligente","Autre"],"Réseau informatique":["Réseau entreprise","Wi-Fi","VLAN","Fibre / liaison","Baie informatique","Autre"]};return m[s]?.[Number(c)-1]||c;}
function quoteRequestMessage(){return`Parfait 👍\n\nPour préparer votre demande de devis, indiquez-moi :\n\n📍 *La localisation du projet*\n📝 *Une courte description du besoin*\n🔢 *La quantité approximative* (caméras, portes, équipements, etc.)\n\nVous pouvez répondre en une seule fois ou étape par étape.`;}
async function processMessage(from,name,text,waId=null,type="text"){
 const s=await getSession(from,name),msg=String(text||"").trim();await addHistory(s,"entrant",msg,waId,type);
 let r;
 if(isConversationStart(msg)){s.state="MENU";s.service=null;r=mainMenu();await addHistory(s,"sortant",r);return r;}
 if(s.state==="MENU"){if(!SERVICES[msg])r=`Je n'ai pas reconnu votre choix.\n\n${mainMenu()}`;else{const svc=SERVICES[msg];s.service=svc;if(svc==="Demande de devis"){s.state="QUOTE";r=quoteRequestMessage();}else if(svc==="Conseiller"){s.state="ADVISOR";r=`Très bien 👍\n\nDécrivez-moi votre besoin ou votre projet. Un conseiller de VisionProtection & Informatique pourra ensuite vous répondre.`;}else{s.state="SITE_TYPE";r=serviceQuestion(svc)||`Très bien 👍\n\nDécrivez-moi votre besoin.`;}}await addHistory(s,"sortant",r);return r;}
 if(s.state==="SITE_TYPE"){s.siteType=choiceLabel(msg,s.service);s.state="LOCATION";r=`Merci 👍\n\n📍 Dans quelle ville ou commune se situe le projet ?`;await addHistory(s,"sortant",r);return r;}
 if(s.state==="LOCATION"){s.location=msg;s.state="PROJECT";r=`Parfait 👍\n\n📝 Décrivez brièvement votre projet ou votre besoin.\n\nExemple :\n« Je souhaite installer 8 caméras extérieures avec enregistrement pendant 30 jours. »`;await addHistory(s,"sortant",r);return r;}
 if(s.state==="PROJECT"){s.project=msg;s.state="QUANTITY";r=`Merci pour ces informations 👍\n\n🔢 Quelle est la quantité approximative souhaitée ?\n\nExemple : 8 caméras, 2 portes, 1 portail, 20 prises réseau, etc.`;await addHistory(s,"sortant",r);return r;}
 if(s.state==="QUANTITY"){s.quantity=msg;s.state="DELAY";r=`Très bien 👍\n\n⏱️ Quel est votre délai souhaité pour la réalisation du projet ?\n\nExemple :\n• Urgent\n• Cette semaine\n• Ce mois-ci\n• Dans 1 à 3 mois\n• Pas encore défini`;await addHistory(s,"sortant",r);return r;}
 if(s.state==="DELAY"){s.delay=msg;s.state="DONE";r=`✅ *Demande enregistrée*\n\nVoici le récapitulatif :\n\n🔐 Service : ${s.service}\n🏢 Type de site : ${s.siteType||"Non précisé"}\n📍 Localisation : ${s.location||"Non précisée"}\n📝 Projet : ${s.project||"Non précisé"}\n🔢 Quantité : ${s.quantity||"Non précisée"}\n⏱️ Délai : ${s.delay||"Non précisé"}\n\nMerci pour votre confiance 🤝\n\nUn conseiller de VisionProtection & Informatique pourra vous contacter pour la suite.\n\nTapez *MENU* pour revenir au menu principal.`;await addHistory(s,"sortant",r);return r;}
 if(s.state==="QUOTE"){s.project=msg;s.state="LOCATION_QUOTE";r=`Merci 👍\n\n📍 Dans quelle ville ou commune se situe le projet ?`;await addHistory(s,"sortant",r);return r;}
 if(s.state==="LOCATION_QUOTE"){s.location=msg;s.state="DONE";r=`✅ *Demande de devis enregistrée*\n\n🔐 Service : Demande de devis\n📍 Localisation : ${s.location}\n📝 Projet : ${s.project||"Non précisé"}\n\nMerci pour votre demande.\n\nNotre équipe pourra revenir vers vous pour obtenir les informations complémentaires et établir votre devis.\n\nTapez *MENU* pour revenir au menu principal.`;await addHistory(s,"sortant",r);return r;}
 if(s.state==="ADVISOR"){s.project=msg;s.state="DONE";r=`✅ Votre demande a bien été transmise.\n\n📝 Besoin :\n${s.project}\n\nUn conseiller de VisionProtection & Informatique pourra vous répondre.\n\nTapez *MENU* pour revenir au menu principal.`;await addHistory(s,"sortant",r);return r;}
 if(s.state==="DONE"){r=`Votre demande est déjà enregistrée. 👍\n\nTapez *MENU* pour recommencer une nouvelle demande ou *8* pour faire une demande de devis.`;await addHistory(s,"sortant",r);return r;}
 s.state="MENU";r=mainMenu();await addHistory(s,"sortant",r);return r;
}
async function sendText(to,body){if(!WHATSAPP_TOKEN||!PHONE_NUMBER_ID)throw new Error("WHATSAPP_ACCESS_TOKEN ou WHATSAPP_PHONE_NUMBER_ID manquant.");return (await axios.post(WHATSAPP_API_URL,{messaging_product:"whatsapp",recipient_type:"individual",to:normalizeForApi(to),type:"text",text:{preview_url:false,body}},{headers:{Authorization:`Bearer ${WHATSAPP_TOKEN}`,"Content-Type":"application/json"},timeout:30000})).data;}
app.get("/webhook",(req,res)=>{if(req.query["hub.mode"]==="subscribe"&&req.query["hub.verify_token"]===VERIFY_TOKEN){console.log("✅ WEBHOOK META VÉRIFIÉ");return res.status(200).send(req.query["hub.challenge"]);}res.sendStatus(403);});
app.post("/webhook",(req,res)=>{console.log("===== WEBHOOK WHATSAPP =====");console.log(JSON.stringify(req.body,null,2));res.sendStatus(200);try{for(const item of req.body?.entry||[])for(const change of item?.changes||[]){const v=change?.value;if(!v)continue;if(!v.messages?.length){if(v.statuses)console.log("STATUS WHATSAPP :",JSON.stringify(v.statuses,null,2));continue;}const contacts=v.contacts||[];for(const m of v.messages){const from=m.from,c=contacts.find(x=>x.wa_id===from)||contacts[0]||{},name=c?.profile?.name||"";let t="",type=m.type||"unknown";if(type==="text")t=m.text?.body||"";else if(type==="interactive"){const i=m.interactive||{};t=i.type==="button_reply"?(i.button_reply?.id||i.button_reply?.title||""):(i.list_reply?.id||i.list_reply?.title||"");}else if(type==="button")t=m.button?.text||m.button?.payload||"";if(!t)continue;processMessage(from,name,t,m.id||null,type).then(r=>sendText(from,r)).then(x=>console.log("✅ REPONSE WHATSAPP ENVOYÉE :",JSON.stringify(x))).catch(e=>console.error("❌ ERREUR TRAITEMENT / ENVOI :",e.response?.data||e.message));}}}catch(e){console.error("❌ ERREUR WEBHOOK :",e);}});
app.get("/crm/prospects",async(req,res)=>{try{if(dbReady){const[r]=await pool.query("SELECT * FROM prospects ORDER BY updated_at DESC");return res.json({success:true,count:r.length,prospects:r,database:"mysql"});}return res.json({success:true,count:sessions.size,prospects:[...sessions.values()],database:"memory-fallback"});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.get("/crm/prospect/:phone",async(req,res)=>{try{const p=dbReady?await loadProspect(req.params.phone):sessions.get(req.params.phone);if(!p)return res.status(404).json({success:false,message:"Prospect introuvable"});res.json({success:true,prospect:p,database:dbReady?"mysql":"memory-fallback"});}catch(e){res.status(500).json({success:false,message:e.message});}});app.put("/crm/prospect/:phone",async(req,res)=>{
  try{
    if(!dbReady){
      return res.status(503).json({
        success:false,
        message:"Base MySQL non disponible."
      });
    }

    const phone=req.params.phone;
    const statut=String(req.body?.statut||"").trim();

    const statutsAutorises=[
      "Nouveau",
      "En cours",
      "Qualifié",
      "Devis",
      "Client",
      "Perdu"
    ];

    if(!statut){
      return res.status(400).json({
        success:false,
        message:"Le statut est obligatoire."
      });
    }

    if(!statutsAutorises.includes(statut)){
      return res.status(400).json({
        success:false,
        message:"Statut commercial invalide."
      });
    }

    const [result]=await pool.query(
      `UPDATE prospects
       SET statut=?, updated_at=CURRENT_TIMESTAMP
       WHERE whatsapp_id=? OR telephone=?`,
      [statut,phone,phone]
    );

    if(result.affectedRows===0){
      return res.status(404).json({
        success:false,
        message:"Prospect introuvable."
      });
    }

    const [rows]=await pool.query(
      `SELECT * FROM prospects
       WHERE whatsapp_id=? OR telephone=?
       LIMIT 1`,
      [phone,phone]
    );

    res.json({
      success:true,
      message:"Statut commercial enregistré.",
      prospect:rows[0],
      database:"mysql"
    });

  }catch(e){
    console.error(
      "❌ MYSQL : erreur mise à jour statut :",
      e.message
    );

    res.status(500).json({
      success:false,
      message:e.message
    });
  }
});
app.get("/crm/messages/:phone",async(req,res)=>{try{if(!dbReady)return res.json({success:true,database:"memory-fallback",messages:[]});const id=await getProspectId(req.params.phone);if(!id)return res.status(404).json({success:false,message:"Prospect introuvable"});const[r]=await pool.query("SELECT * FROM messages WHERE prospect_id=? ORDER BY id ASC",[id]);res.json({success:true,count:r.length,messages:r,database:"mysql"});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.get("/crm/notes/:phone",async(req,res)=>{try{if(!dbReady)return res.json({success:true,database:"memory-fallback",notes:[]});const id=await getProspectId(req.params.phone);if(!id)return res.status(404).json({success:false,message:"Prospect introuvable"});const[r]=await pool.query("SELECT * FROM notes_commerciales WHERE prospect_id=? ORDER BY id DESC",[id]);res.json({success:true,count:r.length,notes:r,database:"mysql"});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.post("/crm/notes/:phone",async(req,res)=>{try{if(!dbReady)return res.status(503).json({success:false,message:"Base MySQL non disponible."});const id=await getProspectId(req.params.phone);if(!id)return res.status(404).json({success:false,message:"Prospect introuvable"});const note=String(req.body?.note||"").trim(),auteur=String(req.body?.auteur||"Commercial").trim()||"Commercial";if(!note)return res.status(400).json({success:false,message:"La note est vide."});const[r]=await pool.query("INSERT INTO notes_commerciales(prospect_id,note,auteur) VALUES(?,?,?)",[id,note,auteur]);res.json({success:true,id:r.insertId});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.get("/crm/stats",async(req,res)=>{try{if(dbReady){const[[t]]=await pool.query(`
  SELECT
    COUNT(*) AS total,
    SUM(etat_conversation='TERMINE') AS done
  FROM prospects
`);const[r]=await pool.query("SELECT COALESCE(service,'Non défini') service,COUNT(*) total FROM prospects GROUP BY service ORDER BY total DESC");const byService={};for(const x of r)byService[x.service]=Number(x.total);return res.json({success:true,totalProspects:Number(t.total||0),activeConversations:Number(t.total||0)-Number(t.done||0),completedConversations:Number(t.done||0),byService,database:"mysql"});}const p=[...sessions.values()];res.json({success:true,totalProspects:p.length,activeConversations:p.filter(x=>x.state!=="DONE").length,completedConversations:p.filter(x=>x.state==="DONE").length,database:"memory-fallback"});}catch(e){res.status(500).json({success:false,message:e.message});}});app.get("/crm", (req, res) => {
  res.sendFile(__dirname + "/public/crm.html");
});

app.get("/assistant", (req, res) => {
  res.sendFile(__dirname + "/public/assistant.html");
});
  // ================== PROSPECTS À RELANCER V1 ==================

app.get("/robot/prospects-relance", async (req, res) => {

  try {

    if (!dbReady || !pool) {
      return res.status(503).json({
        success: false,
        message: "Base MySQL non disponible."
      });
    }

    const [prospects] = await pool.query(`
      SELECT
        p.id,
        p.nom,
        p.telephone,
        p.ville,
        p.service,
        p.besoin,
        p.statut,
        p.etat_conversation,
        p.created_at,
        p.updated_at,

        (
          SELECT MAX(m.created_at)
          FROM messages m
          WHERE m.prospect_id = p.id
        ) AS dernier_message

      FROM prospects p

      WHERE p.statut IN (
        'Nouveau',
        'En cours',
        'Qualifié',
        'Devis'
      )

      AND p.statut NOT IN (
        'Client',
        'Perdu'
      )
AND COALESCE(
  (
    SELECT MAX(m.created_at)
    FROM messages m
    WHERE m.prospect_id = p.id
  ),
  p.updated_at,
  p.created_at
) <= NOW() - INTERVAL 3 DAY
      ORDER BY
        COALESCE(
          (
            SELECT MAX(m.created_at)
            FROM messages m
            WHERE m.prospect_id = p.id
          ),
          p.updated_at
        ) ASC

      LIMIT 100
    `);


    const maintenant = Date.now();

    const relances = prospects.map(p => {

      const derniereActivite =
        p.dernier_message || p.updated_at || p.created_at;

      const dateActivite =
        new Date(derniereActivite);

      const ageJours = Math.floor(
        (maintenant - dateActivite.getTime())
        / (1000 * 60 * 60 * 24)
      );

      let priorite = "NORMALE";

      if (ageJours >= 7) {
        priorite = "HAUTE";
      } else if (ageJours >= 3) {
        priorite = "MOYENNE";
      }

      return {
        id: p.id,
        nom: p.nom || "Sans nom",
        telephone: p.telephone,
        ville: p.ville || "Non définie",
        service: p.service || "Non défini",
        besoin: p.besoin || "",
        statut: p.statut,
        etat_conversation: p.etat_conversation,

        derniere_activite: derniereActivite,

        jours_depuis_activite: ageJours,

        priorite: priorite,

        action: "RELANCE À PRÉPARER"
      };

    });


    res.json({

      success: true,

      robot: "VisionProtection - Prospects à relancer V1",

      total: relances.length,

      priorite_haute:
        relances.filter(x => x.priorite === "HAUTE").length,

      priorite_moyenne:
        relances.filter(x => x.priorite === "MOYENNE").length,

      priorite_normale:
        relances.filter(x => x.priorite === "NORMALE").length,

      prospects: relances,

      generated_at: new Date().toISOString(),

      database: "mysql"

    });


  } catch (error) {

    console.error(
      "❌ ERREUR PROSPECTS À RELANCER :",
      error.message
    );

    res.status(500).json({
      success: false,
      message: error.message
    });

  }

});

// ================== FIN PROSPECTS À RELANCER V1 ==================

// ================== RELANCE PERSONNALISEE GEMINI V1.5 ==================

function genererRelanceFallbackV15(prospect, historique = []) {
  const nom = prospect?.nom && prospect.nom !== "Sans nom" ? prospect.nom : "";
  const service = prospect?.service && prospect.service !== "Non défini" ? prospect.service : "votre projet";
  const besoin = String(prospect?.besoin || "").trim();

  let message = "Bonjour" + (nom ? " " + nom : "") + ",\n\n";
  message += "Nous revenons vers vous concernant " + service + ".\n\n";
  if (besoin) message += "Vous nous aviez indiqué : " + besoin + ".\n\n";
  message += "Nous souhaitons savoir si votre projet est toujours d'actualité et si vous souhaitez que notre équipe vous accompagne pour la prochaine étape.\n\n";
  message += "Nous restons à votre disposition pour toute information complémentaire ou pour préparer votre devis.\n\n";
  message += "Cordialement,\nVisionProtection & Informatique\nEfficacité et professionnalisme";
  return message;
}

app.post("/robot/relance-personnalisee", async (req, res) => {
  try {
    if (!dbReady || !pool) {
      return res.status(503).json({ success:false, message:"Base MySQL non disponible." });
    }

    const phone = String(req.body?.phone || "").trim();
    if (!phone) {
      return res.status(400).json({ success:false, message:"Numéro du prospect obligatoire." });
    }

    const phoneApi = normalizeForApi(phone);
    const [rows] = await pool.query(
      `SELECT id, whatsapp_id, telephone, nom, ville, service, besoin, statut, etat_conversation, created_at, updated_at
       FROM prospects
       WHERE whatsapp_id=? OR telephone=? OR whatsapp_id=? OR telephone=?
       LIMIT 1`,
      [phone, phone, phoneApi, phoneApi]
    );

    if (!rows.length) {
      return res.status(404).json({ success:false, message:"Prospect introuvable." });
    }

    const prospect = rows[0];
    const statutsAutorises = ["Nouveau", "En cours", "Qualifié", "Devis"];
    if (!statutsAutorises.includes(prospect.statut)) {
      return res.status(409).json({
        success:false,
        message:`Génération de relance interdite pour le statut « ${prospect.statut} ».`
      });
    }

    const [messages] = await pool.query(
      `SELECT direction, message, message_type, created_at
       FROM messages
       WHERE prospect_id=?
       ORDER BY created_at DESC
       LIMIT 12`,
      [prospect.id]
    );

    const [notes] = await pool.query(
      `SELECT note, auteur, created_at
       FROM notes_commerciales
       WHERE prospect_id=?
       ORDER BY created_at DESC
       LIMIT 8`,
      [prospect.id]
    );

    const historique = messages.reverse().map(m => ({
      direction: m.direction,
      message: String(m.message || "").slice(0, 1200),
      date: m.created_at
    }));

    const notesCommerciales = notes.map(n => ({
      note: String(n.note || "").slice(0, 800),
      auteur: n.auteur,
      date: n.created_at
    }));

    const donnees = {
      prospect: {
        nom: prospect.nom || "Sans nom",
        telephone: prospect.telephone,
        ville: prospect.ville || "Non définie",
        service: prospect.service || "Non défini",
        besoin: prospect.besoin || "",
        statut: prospect.statut,
        etat_conversation: prospect.etat_conversation,
        derniere_activite: prospect.updated_at || prospect.created_at
      },
      historique,
      notes: notesCommerciales
    };

    const prompt = `
Tu es l'assistant commercial de VisionProtection & Informatique à Abidjan.

Ta mission est de rédiger UNE relance WhatsApp commerciale personnalisée pour le prospect ci-dessous.

DONNEES DU PROSPECT :
${JSON.stringify(donnees, null, 2)}

REGLES :
- Réponds uniquement avec le texte final du message WhatsApp.
- Message court, naturel, professionnel et chaleureux.
- Personnalise avec le nom si disponible.
- Tiens compte du service et du besoin réellement enregistrés.
- Utilise l'historique et les notes uniquement pour mieux contextualiser la relance.
- Ne prétends jamais qu'une action a été réalisée si ce n'est pas indiqué.
- Ne promets aucun prix, délai ou disponibilité qui n'est pas présent dans les données.
- Ne parle pas de Gemini, d'IA, de CRM ou d'analyse interne.
- Ne demande pas inutilement toutes les informations déjà connues.
- Termine par une invitation simple à répondre ou à poursuivre le projet.
- Signature obligatoire :
Cordialement,
VisionProtection & Informatique
Efficacité et professionnalisme
`;

    let message = "";
    let model = "CRM-FALLBACK";
    let fallback = false;
    let fallbackReason = null;

    try {
      const result = await callGemini(prompt, { max503Retries: 1 });
      message = String(result.text || "").trim();
      if (!message) throw new Error("Gemini n'a généré aucun message.");
      model = result.model || "gemini-3.8-flash";
    } catch (aiError) {
      fallback = true;
      fallbackReason = aiError.message;
      message = genererRelanceFallbackV15(prospect, historique);
      console.warn("⚠️ RELANCE PERSONNALISÉE EN MODE SECOURS :", aiError.message);
    }

    res.json({
      success:true,
      generated_at:new Date().toISOString(),
      prospect:{
        id:prospect.id,
        nom:prospect.nom,
        telephone:prospect.telephone,
        service:prospect.service,
        besoin:prospect.besoin,
        statut:prospect.statut
      },
      message,
      model,
      ai_available:!fallback,
      fallback,
      fallback_reason:fallbackReason,
      history_count:historique.length,
      notes_count:notesCommerciales.length,
      sent:false
    });
  } catch (error) {
    console.error("❌ ERREUR RELANCE PERSONNALISÉE V1.5 :", error.response?.data || error.message);
    res.status(500).json({ success:false, message:error.message });
  }
});

// ================== FIN RELANCE PERSONNALISEE GEMINI V1.5 ==================

// ================== HISTORIQUE INTELLIGENT V1.6 ==================

function genererAnalyseFallbackV16(prospect, historique = [], notes = []) {
  const entrants = historique.filter(x => String(x.direction || '').toLowerCase() === 'in').length;
  const sortants = historique.filter(x => String(x.direction || '').toLowerCase() === 'out').length;
  const dernier = historique.length ? historique[historique.length - 1] : null;
  const dernierType = dernier ? (String(dernier.direction).toLowerCase() === 'in' ? 'prospect' : 'commercial') : 'aucun';
  let recommandation = 'Préparer une relance courte et personnalisée.';
  if (dernierType === 'prospect') recommandation = 'Le dernier message vient du prospect : répondre d’abord à sa dernière demande avant toute relance.';
  if (prospect.statut === 'Qualifié') recommandation = 'Le prospect est qualifié : proposer clairement la prochaine étape, par exemple visite technique ou devis.';
  if (prospect.statut === 'Devis') recommandation = 'Le prospect est au stade devis : vérifier s’il a reçu le devis et identifier les éventuels blocages.';
  if (!historique.length) recommandation = 'Aucun historique de message disponible : utiliser uniquement les informations CRM connues.';
  return [
    'ANALYSE CRM DE SECOURS',
    '',
    `• Statut : ${prospect.statut || 'Non défini'}`,
    `• Messages analysés : ${historique.length} (${entrants} entrant(s), ${sortants} sortant(s))`,
    `• Notes commerciales : ${notes.length}`,
    `• Dernière activité : ${prospect.derniere_activite || 'Non connue'}`,
    '',
    `RECOMMANDATION : ${recommandation}`,
    '',
    'Cette analyse est générée sans IA à partir des données actuellement enregistrées dans le CRM.'
  ].join('\n');
}

app.post('/robot/analyser-historique', async (req, res) => {
  try {
    if (!dbReady || !pool) return res.status(503).json({ success:false, message:'Base MySQL non disponible.' });
    const phone = String(req.body?.phone || '').trim();
    if (!phone) return res.status(400).json({ success:false, message:'Numéro du prospect obligatoire.' });

    const phoneApi = normalizeForApi(phone);
    const [rows] = await pool.query(
      `SELECT id, whatsapp_id, telephone, nom, ville, service, besoin, statut, etat_conversation, created_at, updated_at
       FROM prospects WHERE whatsapp_id=? OR telephone=? OR whatsapp_id=? OR telephone=? LIMIT 1`,
      [phone, phone, phoneApi, phoneApi]
    );
    if (!rows.length) return res.status(404).json({ success:false, message:'Prospect introuvable.' });
    const prospect = rows[0];

    const [messages] = await pool.query(
      `SELECT direction, message, message_type, created_at
       FROM messages WHERE prospect_id=? ORDER BY created_at DESC LIMIT 30`,
      [prospect.id]
    );
    const [notes] = await pool.query(
      `SELECT note, auteur, created_at FROM notes_commerciales
       WHERE prospect_id=? ORDER BY created_at DESC LIMIT 12`,
      [prospect.id]
    );

    const historique = messages.reverse().map(m => ({
      direction: m.direction,
      message: String(m.message || '').slice(0, 1600),
      type: m.message_type || 'text',
      date: m.created_at
    }));
    const notesCommerciales = notes.map(n => ({
      note: String(n.note || '').slice(0, 1000),
      auteur: n.auteur,
      date: n.created_at
    }));

    const donnees = {
      prospect: {
        nom: prospect.nom || 'Sans nom',
        telephone: prospect.telephone,
        ville: prospect.ville || 'Non définie',
        service: prospect.service || 'Non défini',
        besoin: prospect.besoin || '',
        statut: prospect.statut,
        etat_conversation: prospect.etat_conversation,
        derniere_activite: prospect.updated_at || prospect.created_at
      },
      historique,
      notes: notesCommerciales
    };

    const prompt = `
Tu es l'assistant commercial de VisionProtection & Informatique à Abidjan.
Analyse uniquement l'historique réel et les informations CRM fournis ci-dessous.

DONNEES :
${JSON.stringify(donnees, null, 2)}

Réponds en français avec exactement ces rubriques :
1. 🧠 COMPRÉHENSION DU BESOIN
2. 💬 DERNIERS ÉCHANGES
3. 🚧 POINTS À SURVEILLER
4. 🎯 PROCHAINE ACTION CONSEILLÉE
5. ✍️ ANGLE DE RELANCE

Règles :
- Ne prétends jamais qu'une action a été réalisée.
- Ne fabrique aucune information absente de l'historique.
- Distingue clairement ce qui est certain de ce qui est une recommandation.
- N'invente ni prix, ni délai, ni disponibilité.
- Ne modifie aucun statut et ne déclenche aucun envoi.
- Reste concret et court.
`;

    let analyse = '';
    let model = 'CRM-FALLBACK';
    let fallback = false;
    let fallbackReason = null;
    try {
      const result = await callGemini(prompt, { max503Retries: 1 });
      analyse = String(result.text || '').trim();
      if (!analyse) throw new Error('Gemini n\'a généré aucune analyse.');
      model = result.model || 'gemini-3.8-flash';
    } catch (aiError) {
      fallback = true;
      fallbackReason = aiError.message;
      analyse = genererAnalyseFallbackV16(prospect, historique, notesCommerciales);
    }

    res.json({
      success:true,
      prospect:{ id:prospect.id, nom:prospect.nom, telephone:prospect.telephone, service:prospect.service, besoin:prospect.besoin, statut:prospect.statut },
      historique,
      notes:notesCommerciales,
      history_count:historique.length,
      notes_count:notesCommerciales.length,
      analyse,
      model,
      ai_available:!fallback,
      fallback,
      fallback_reason:fallbackReason,
      generated_at:new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ ERREUR ANALYSE HISTORIQUE V1.6 :', error.response?.data || error.message);
    res.status(500).json({ success:false, message:error.message });
  }
});

// ================== FIN HISTORIQUE INTELLIGENT V1.6 ==================


// ================== RECOMMANDATION ACTION COMMERCIALE V1.7 ==================
function genererActionFallbackV17(prospect, historique = [], notes = []) {
  const dernier = historique.length ? historique[historique.length - 1] : null;
  const dernierEntrant = dernier && String(dernier.direction || '').toLowerCase() === 'in';
  let action = 'Préparer une relance courte et personnalisée.';
  let moment = 'Dans les prochains jours.';
  let infos = 'Confirmer que le projet est toujours d’actualité et demander l’information manquante la plus importante.';
  let note = `Suivi prospect ${prospect.nom || 'Sans nom'} — service : ${prospect.service || 'Non défini'}.`;
  if (dernierEntrant) {
    action = 'Répondre d’abord au dernier message du prospect avant toute relance.';
    moment = 'Dès que possible.';
  }
  if (prospect.statut === 'Qualifié') {
    action = 'Faire avancer le prospect vers l’étape suivante : visite technique, précision du besoin ou préparation du devis.';
    moment = 'Prochain contact commercial.';
  }
  if (prospect.statut === 'Devis') {
    action = 'Vérifier la réception du devis et identifier les éventuels blocages ou questions.';
    moment = 'Prochaine relance commerciale.';
  }
  if (!historique.length) {
    action = 'Prendre contact avec le prospect en utilisant uniquement les informations déjà enregistrées dans le CRM.';
    infos = 'Demander les informations nécessaires pour qualifier le projet.';
  }
  return {
    action, moment, infos, note,
    message: `Bonjour ${prospect.nom || ''},\n\nNous revenons vers vous concernant ${prospect.service || 'votre demande'}. Votre projet est-il toujours d’actualité ?\n\nCordialement,\nVisionProtection & Informatique\nEfficacité et professionnalisme`
  };
}

app.post('/robot/recommander-action', async (req, res) => {
  try {
    if (!dbReady || !pool) return res.status(503).json({success:false,message:'Base MySQL non disponible.'});
    const phone = String(req.body?.phone || '').trim();
    if (!phone) return res.status(400).json({success:false,message:'Numéro du prospect obligatoire.'});
    const phoneApi = normalizeForApi(phone);
    const [rows] = await pool.query(
      `SELECT id, whatsapp_id, telephone, nom, ville, service, besoin, statut, etat_conversation, created_at, updated_at
       FROM prospects WHERE whatsapp_id=? OR telephone=? OR whatsapp_id=? OR telephone=? LIMIT 1`,
      [phone, phone, phoneApi, phoneApi]
    );
    if (!rows.length) return res.status(404).json({success:false,message:'Prospect introuvable.'});
    const prospect = rows[0];
    const [messages] = await pool.query(
      `SELECT direction, message, message_type, created_at FROM messages WHERE prospect_id=? ORDER BY created_at DESC LIMIT 30`,
      [prospect.id]
    );
    const [notes] = await pool.query(
      `SELECT note, auteur, created_at FROM notes_commerciales WHERE prospect_id=? ORDER BY created_at DESC LIMIT 12`,
      [prospect.id]
    );
    const historique = messages.reverse().map(m => ({direction:m.direction,message:String(m.message||'').slice(0,1600),type:m.message_type||'text',date:m.created_at}));
    const notesCommerciales = notes.map(n => ({note:String(n.note||'').slice(0,1000),auteur:n.auteur,date:n.created_at}));
    const donnees = {prospect:{nom:prospect.nom||'Sans nom',telephone:prospect.telephone,ville:prospect.ville||'Non définie',service:prospect.service||'Non défini',besoin:prospect.besoin||'',statut:prospect.statut,etat_conversation:prospect.etat_conversation,derniere_activite:prospect.updated_at||prospect.created_at},historique,notes:notesCommerciales};
    const prompt = `Tu es l'assistant commercial de VisionProtection & Informatique à Abidjan.\nAnalyse uniquement les données CRM réelles ci-dessous.\n\nDONNEES :\n${JSON.stringify(donnees,null,2)}\n\nRéponds en français avec exactement ces rubriques :\n1. 🎯 ACTION À FAIRE MAINTENANT\n2. ⏰ MOMENT CONSEILLÉ\n3. 📌 INFORMATIONS À DEMANDER\n4. 📝 NOTE COMMERCIALE PROPOSÉE\n5. 💬 MESSAGE WHATSAPP CONSEILLÉ\n\nRègles : ne prétends jamais qu'une action a été réalisée; ne fabrique aucune information; n'invente ni prix, ni délai, ni disponibilité; ne modifie aucun statut; ne déclenche aucun envoi; reste concret et court.`;
    let recommandation, model='CRM-FALLBACK', fallback=false, fallbackReason=null;
    try { const result=await callGemini(prompt,{max503Retries:1}); recommandation=String(result.text||'').trim(); if(!recommandation) throw new Error("Gemini n'a généré aucune recommandation."); model=result.model||'gemini-3.8-flash'; }
    catch(aiError){ fallback=true; fallbackReason=aiError.message; recommandation=genererActionFallbackV17(prospect,historique,notesCommerciales); }
    res.json({success:true,prospect:{id:prospect.id,nom:prospect.nom,telephone:prospect.telephone,service:prospect.service,besoin:prospect.besoin,statut:prospect.statut},recommandation,model,ai_available:!fallback,fallback,fallback_reason:fallbackReason,history_count:historique.length,notes_count:notesCommerciales.length,generated_at:new Date().toISOString()});
  } catch(error){ console.error('❌ ERREUR RECOMMANDATION V1.7 :',error.response?.data||error.message); res.status(500).json({success:false,message:error.message}); }
});

// ================== ENVOI RELANCE WHATSAPP V1.3 ==================

app.post("/robot/relance-whatsapp", async (req, res) => {
  try {
    if (!dbReady || !pool) {
      return res.status(503).json({
        success: false,
        message: "Base MySQL non disponible."
      });
    }

    const phone = String(req.body?.phone || "").trim();
    const message = String(req.body?.message || "").trim();
    const phoneApi = normalizeForApi(phone);

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Numéro WhatsApp obligatoire."
      });
    }

    if (!message) {
      return res.status(400).json({
        success: false,
        message: "Le message de relance est vide."
      });
    }

    const [rows] = await pool.query(
      `SELECT id, whatsapp_id, telephone, nom, statut
       FROM prospects
       WHERE whatsapp_id=? OR telephone=? OR whatsapp_id=? OR telephone=?
       LIMIT 1`,
      [phone, phone, phoneApi, phoneApi]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Prospect introuvable."
      });
    }

    const prospect = rows[0];
    const statutsAutorises = ["Nouveau", "En cours", "Qualifié", "Devis"];

    if (!statutsAutorises.includes(prospect.statut)) {
      return res.status(409).json({
        success: false,
        message: `Envoi de relance interdit pour le statut « ${prospect.statut} ».`
      });
    }

    const destinataire = normalizeForApi(prospect.whatsapp_id || prospect.telephone);

    // Envoi réel via WhatsApp Cloud API.
    const whatsappResult = await sendText(destinataire, message);

    // Journalisation du message sortant dans le CRM.
    await pool.query(
      `INSERT INTO messages(
        prospect_id,
        whatsapp_message_id,
        direction,
        message,
        message_type
      ) VALUES(?,?,?,?,?)`,
      [
        prospect.id,
        whatsappResult?.messages?.[0]?.id || null,
        "sortant",
        message,
        "text"
      ]
    );

    await pool.query(
      `UPDATE prospects
       SET updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [prospect.id]
    );

    res.json({
      success: true,
      message: "Relance WhatsApp envoyée avec succès.",
      prospect: {
        id: prospect.id,
        nom: prospect.nom,
        telephone: prospect.telephone,
        statut: prospect.statut
      },
      whatsapp: whatsappResult,
      database: "mysql"
    });
  } catch (error) {
    console.error(
      "❌ ERREUR ENVOI RELANCE WHATSAPP :",
      error.response?.data || error.message
    );

    res.status(500).json({
      success: false,
      message: error.response?.data?.error?.message || error.message
    });
  }
});

// ================== FIN ENVOI RELANCE WHATSAPP V1.3 ==================

// ================== ROBOT IA COMMERCIAL GEMINI ==================

app.get("/robot/test", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      geminiHealth = { ...geminiHealth, available:false, lastCheck:new Date().toISOString(), reason:"API_KEY_ABSENTE" };
      return res.status(500).json({
        success: false,
        ai_available: false,
        mode: "fallback",
        message: "GEMINI_API_KEY absente dans Render."
      });
    }

    if (!gemini) {
      geminiHealth = { ...geminiHealth, available:false, lastCheck:new Date().toISOString(), reason:"CLIENT_NON_INITIALISE" };
      return res.status(500).json({
        success: false,
        ai_available: false,
        mode: "fallback",
        message: "Client Gemini non initialisé."
      });
    }

    const result = await callGemini("Réponds uniquement : ROBOT OUATT GEMINI OK", { max503Retries: 1 });

    res.json({
      success: true,
      ai_available: true,
      mode: "gemini",
      message: result.text,
      model: result.model,
      checked_at: geminiHealth.lastCheck
    });

  } catch (error) {
    console.error("❌ ERREUR TEST GEMINI :", error.message);
    const status = geminiHealth.reason === "QUOTA" ? 429 : geminiHealth.reason === "UNAVAILABLE" ? 503 : 500;

    res.status(status).json({
      success: false,
      ai_available: false,
      mode: "fallback",
      reason: geminiHealth.reason,
      message: error.message,
      checked_at: geminiHealth.lastCheck
    });
  }
});

app.get("/robot/status", (req, res) => {
  res.json({
    success: true,
    gemini_configured: Boolean(process.env.GEMINI_API_KEY),
    client_initialized: Boolean(gemini),
    model: geminiHealth.model,
    ai_available: geminiHealth.available,
    last_check: geminiHealth.lastCheck,
    reason: geminiHealth.reason,
    fallback_available: true,
    generated_at: new Date().toISOString()
  });
});


// ================== TABLEAU DE BORD IA V1.4 ==================

app.get("/robot/dashboard", async (req, res) => {
  try {
    if (!dbReady || !pool) {
      return res.status(503).json({
        success: false,
        message: "Base MySQL non disponible."
      });
    }

    const [[global]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(etat_conversation='TERMINE') AS done,
        SUM(etat_conversation<>'TERMINE' OR etat_conversation IS NULL) AS active
      FROM prospects
    `);

    const [[seven]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(statut='Nouveau') AS nouveaux,
        SUM(statut='En cours') AS en_cours,
        SUM(statut='Qualifié') AS qualifies,
        SUM(statut='Devis') AS devis,
        SUM(statut='Client') AS clients,
        SUM(statut='Perdu') AS perdus
      FROM prospects
      WHERE created_at >= NOW() - INTERVAL 7 DAY
    `);

    const [relances] = await pool.query(`
      SELECT
        p.id,
        p.nom,
        p.telephone,
        p.entreprise,
        p.ville,
        p.service,
        p.besoin,
        p.statut,
        p.etat_conversation,
        COALESCE((
          SELECT MAX(m.created_at)
          FROM messages m
          WHERE m.prospect_id = p.id
        ), p.updated_at, p.created_at) AS derniere_activite
      FROM prospects p
      WHERE p.statut IN ('Nouveau','En cours','Qualifié','Devis')
        AND COALESCE((
          SELECT MAX(m.created_at)
          FROM messages m
          WHERE m.prospect_id = p.id
        ), p.updated_at, p.created_at) <= NOW() - INTERVAL 3 DAY
      ORDER BY derniere_activite ASC
      LIMIT 20
    `);

    const [devis] = await pool.query(`
      SELECT id, nom, telephone, entreprise, ville, service, besoin, statut, updated_at
      FROM prospects
      WHERE statut='Devis'
      ORDER BY updated_at ASC
      LIMIT 10
    `);

    const [qualifies] = await pool.query(`
      SELECT id, nom, telephone, entreprise, ville, service, besoin, statut, updated_at
      FROM prospects
      WHERE statut='Qualifié'
      ORDER BY updated_at ASC
      LIMIT 10
    `);

    const [services] = await pool.query(`
      SELECT COALESCE(service,'Non défini') AS service, COUNT(*) AS total
      FROM prospects
      WHERE created_at >= NOW() - INTERVAL 7 DAY
      GROUP BY service
      ORDER BY total DESC
      LIMIT 8
    `);

    const [villes] = await pool.query(`
      SELECT COALESCE(ville,'Non définie') AS ville, COUNT(*) AS total
      FROM prospects
      WHERE created_at >= NOW() - INTERVAL 7 DAY
      GROUP BY ville
      ORDER BY total DESC
      LIMIT 8
    `);

    const actions = [];

    if (devis.length) {
      actions.push({
        type: "DEVIS",
        priority: "HAUTE",
        title: `${devis.length} devis à suivre`,
        description: "Vérifier les devis en attente et contacter les prospects concernés.",
        count: devis.length,
        prospect_ids: devis.map(x => x.id)
      });
    }

    if (relances.length) {
      actions.push({
        type: "RELANCE",
        priority: "HAUTE",
        title: `${relances.length} prospect(s) à relancer`,
        description: "Préparer une relance personnalisée selon le service et le besoin.",
        count: relances.length,
        prospect_ids: relances.map(x => x.id)
      });
    }

    if (qualifies.length) {
      actions.push({
        type: "QUALIFICATION",
        priority: "MOYENNE",
        title: `${qualifies.length} prospect(s) qualifié(s) à faire avancer`,
        description: "Vérifier le besoin, préparer la proposition ou planifier une visite technique.",
        count: qualifies.length,
        prospect_ids: qualifies.map(x => x.id)
      });
    }

    if (!actions.length) {
      actions.push({
        type: "SUIVI",
        priority: "NORMALE",
        title: "Aucune action urgente détectée",
        description: "Actualiser les données CRM et continuer le suivi des nouveaux prospects.",
        count: 0,
        prospect_ids: []
      });
    }

    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      database: "mysql",
      gemini: {
        configured: Boolean(process.env.GEMINI_API_KEY),
        available: geminiHealth.available,
        last_check: geminiHealth.lastCheck,
        reason: geminiHealth.reason,
        model: geminiHealth.model,
        fallback_available: true
      },
      crm: {
        total: Number(global.total || 0),
        active: Number(global.active || 0),
        done: Number(global.done || 0)
      },
      seven_days: {
        total: Number(seven.total || 0),
        nouveaux: Number(seven.nouveaux || 0),
        en_cours: Number(seven.en_cours || 0),
        qualifies: Number(seven.qualifies || 0),
        devis: Number(seven.devis || 0),
        clients: Number(seven.clients || 0),
        perdus: Number(seven.perdus || 0)
      },
      actions,
      relances,
      devis,
      qualifies,
      services: services.map(x => ({service:x.service,total:Number(x.total)})),
      villes: villes.map(x => ({ville:x.ville,total:Number(x.total)}))
    });
  } catch (error) {
    console.error("❌ ERREUR TABLEAU DE BORD IA V1.4 :", error.message);
    res.status(500).json({success:false,message:error.message});
  }
});

// ================== FIN TABLEAU DE BORD IA V1.4 ==================

// ================== RAPPORT ROBOT IA ==================

app.get("/robot/run", async (req, res) => {

  try {

    if (!dbReady || !pool) {
      return res.status(503).json({
        success: false,
        message: "Base MySQL non disponible."
      });
    }

    // Le rapport peut fonctionner sans Gemini grâce au mode secours CRM.

    // ==========================================
    // 1. STATISTIQUES COMMERCIALES 7 JOURS
    // ==========================================

    const [[global]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(statut='Nouveau') AS nouveaux,
        SUM(statut='En cours') AS en_cours,
        SUM(statut='Qualifié') AS qualifies,
        SUM(statut='Devis') AS devis,
        SUM(statut='Client') AS clients,
        SUM(statut='Perdu') AS perdus
      FROM prospects
      WHERE created_at >= NOW() - INTERVAL 7 DAY
    `);


    // ==========================================
    // 2. SERVICES LES PLUS DEMANDÉS
    // ==========================================

    const [services] = await pool.query(`
      SELECT
        COALESCE(service,'Non défini') AS service,
        COUNT(*) AS total
      FROM prospects
      WHERE created_at >= NOW() - INTERVAL 7 DAY
      GROUP BY service
      ORDER BY total DESC
      LIMIT 10
    `);


    // ==========================================
    // 3. VILLES / ZONES
    // ==========================================

    const [villes] = await pool.query(`
      SELECT
        COALESCE(ville,'Non définie') AS ville,
        COUNT(*) AS total
      FROM prospects
      WHERE created_at >= NOW() - INTERVAL 7 DAY
      GROUP BY ville
      ORDER BY total DESC
      LIMIT 10
    `);


    // ==========================================
    // 4. PROSPECTS RÉCENTS
    // ==========================================

    const [prospects] = await pool.query(`
      SELECT
        id,
        nom,
        telephone,
        ville,
        service,
        besoin,
        statut,
        etat_conversation,
        created_at,
        updated_at
      FROM prospects
      WHERE created_at >= NOW() - INTERVAL 7 DAY
      ORDER BY created_at DESC
      LIMIT 30
    `);

    const [relances] = await pool.query(`
      SELECT
        p.id, p.nom, p.telephone, p.service, p.statut,
        COALESCE((
          SELECT MAX(m.created_at)
          FROM messages m
          WHERE m.prospect_id = p.id
        ), p.updated_at, p.created_at) AS derniere_activite
      FROM prospects p
      WHERE p.statut IN ('Nouveau','En cours','Qualifié','Devis')
        AND COALESCE((
          SELECT MAX(m.created_at)
          FROM messages m
          WHERE m.prospect_id = p.id
        ), p.updated_at, p.created_at) <= NOW() - INTERVAL 3 DAY
      ORDER BY derniere_activite ASC
      LIMIT 100
    `);


    // ==========================================
    // 5. DONNÉES ENVOYÉES À GEMINI
    // ==========================================

    const donnees = {
      periode: "7 derniers jours",

      statistiques: {
        total: Number(global.total || 0),
        nouveaux: Number(global.nouveaux || 0),
        en_cours: Number(global.en_cours || 0),
        qualifies: Number(global.qualifies || 0),
        devis: Number(global.devis || 0),
        clients: Number(global.clients || 0),
        perdus: Number(global.perdus || 0)
      },

      services: services.map(x => ({
        service: x.service,
        total: Number(x.total)
      })),

      villes: villes.map(x => ({
        ville: x.ville,
        total: Number(x.total)
      })),

      relances: relances.map(x => ({
        id: x.id,
        nom: x.nom || "Sans nom",
        telephone: x.telephone,
        service: x.service || "Non défini",
        statut: x.statut,
        derniere_activite: x.derniere_activite
      })),

      prospects: prospects.map(x => ({
        nom: x.nom,
        telephone: x.telephone,
        ville: x.ville,
        service: x.service,
        besoin: x.besoin,
        statut: x.statut,
        conversation: x.etat_conversation,
        date: x.created_at
      }))
    };


    // ==========================================
    // 6. PROMPT DU ROBOT COMMERCIAL
    // ==========================================

    const prompt = `
Tu es le Robot IA commercial de VisionProtection & Informatique
à Abidjan, Côte d'Ivoire.

Ton rôle est d'aider le commercial à analyser les prospects
et améliorer leur conversion.

Analyse les données CRM ci-dessous.

DONNÉES CRM :
${JSON.stringify(donnees, null, 2)}

Produis un rapport commercial court, clair et concret en français.

Structure obligatoirement ta réponse ainsi :

1. 📊 SITUATION COMMERCIALE
Résume l'activité des 7 derniers jours.

2. 🔐 SERVICES DEMANDÉS
Indique les services qui ressortent le plus.

3. 📍 ZONES INTÉRESSANTES
Indique les villes ou zones qui ressortent.

4. 🎯 PROSPECTS À TRAITER
Indique quels types de prospects doivent être traités en priorité
selon leur statut et leur situation.

5. 📱 RELANCES CONSEILLÉES
Propose jusqu'à 3 actions de relance concrètes.

6. 💡 ACTIONS COMMERCIALES
Donne jusqu'à 3 actions concrètes pour améliorer la conversion.

Ne prétends jamais avoir contacté un prospect.
Ne modifie aucun statut.
Ne supprime aucune donnée.
Ne réalise aucune action extérieure au CRM.
Tu fournis uniquement une analyse et des recommandations.
`;


    // ==========================================
    // 7. APPEL GEMINI
    // ==========================================

let aiResult = null;
let rapport = "";
let modelUtilise = "";
let aiAvailable = false;
let fallback = false;
let fallbackReason = null;

try {
  aiResult = await callGemini(prompt, { max503Retries: 1 });
  rapport = aiResult.text || "Aucun rapport généré.";
  modelUtilise = aiResult.model;
  aiAvailable = true;
} catch (aiError) {
  fallback = true;
  fallbackReason = aiError.message;
  rapport = genererRapportFallback(donnees, aiError.message);
  modelUtilise = "CRM-FALLBACK";
  aiAvailable = false;
  console.warn("⚠️ MODE SECOURS CRM :", aiError.message);
}
    // ==========================================
    // 8. RÉPONSE AU CRM
    // ==========================================

   res.json({
  success: true,

  robot: "VisionProtection Robot IA",

  periode: "7 derniers jours",

  statistiques: donnees.statistiques,

  services: donnees.services,

  villes: donnees.villes,

  rapport_robot: rapport,

  generated_at: new Date().toISOString(),

  database: "mysql",

  model: modelUtilise,

  ai_available: aiAvailable,

  fallback: fallback,

  fallback_reason: fallbackReason
});


 } catch (error) {

  console.error(
    "❌ ERREUR ROBOT IA :",
    error.message
  );

  res.status(500).json({
    success: false,
    message: error.message,
    robot: "VisionProtection Robot IA"
  });
  }
});

// ================== FIN ROBOT IA COMMERCIAL ==================

// ================== PROSPECTION WEB MULTI-SOURCES V2.1.1 ==================
const PROSPECTION_SOURCES_V21 = [
  {id:'GOAFRICA_PROMOTEURS', nom:'Go Africa Online — Promoteurs immobiliers', type:'IMMOBILIER', url:'https://www.goafricaonline.com/ci/annuaire/promoteurs-immobiliers'},
  {id:'S3I', nom:'S3I — Promoteur immobilier et constructeur', type:'IMMOBILIER', url:'https://www.s3i.ci/'},
  {id:'UNGM', nom:'UNGM — United Nations Global Marketplace', type:'PUBLIC', url:'https://www.ungm.org/Public/Notice'}
];

const PROSPECTION_COUNTRY_V22 = "Côte d’Ivoire";
const PROSPECTION_ALLOWED_SOURCE_IDS_V22 = new Set(PROSPECTION_SOURCES_V21.map(x=>x.id));
const PROSPECTION_RETIRED_SOURCE_IDS_V22 = new Set([
  'DGMP','DGMP_PPM_2026','CONSTRUCTION_CI','PJ_PROMOTEURS'
]);
const PROSPECTION_CI_TERMS_V22 = [
  "côte d'ivoire","cote d'ivoire","cote-divoire","ivory coast",
  "abidjan","yamoussoukro","bouaké","bouake","korhogo","san-pédro","san pedro",
  "daloa","man","gagnoa","abengourou","agboville","grand-bassam","grand bassam",
  "bingerville","riviera","yopougon","marcory","treichville","port-bouët","port bouet",
  "koumassi","abobo","adjamé","adjame","plateau","attécoubé","attecoube","anyama",
  "songon","dabou","bassam","côte ivoire"
];

function isCoteIvoireCandidateV22(item){
  const url=String(item?.url_cible||item?.url||item?.url_source||'');
  const body=[
    item?.titre,item?.extrait,item?.organisation,item?.ville,item?.description,
    item?.resume,item?.source_nom,url
  ].filter(Boolean).join(' ');
  if(/\.ci(?:[/:?#]|$)/i.test(url)) return true;
  const hay=normalizeSearchTextV21(body);
  return PROSPECTION_CI_TERMS_V22.some(term=>hay.includes(normalizeSearchTextV21(term)));
}
function isAllowedProspectionSourceV22(item){
  return PROSPECTION_ALLOWED_SOURCE_IDS_V22.has(String(item?.source_id||''));
}
function filterProspectionV22(rows){
  return rows.filter(x=>isAllowedProspectionSourceV22(x)&&isCoteIvoireCandidateV22(x));
}
function isEditorialProspectV221(item){
  const title=normalizeSearchTextV21(item?.titre||'');
  const text=normalizeSearchTextV21([item?.extrait,item?.description,item?.resume].filter(Boolean).join(' '));
  const hay=title+' '+text;
  const editorialTitlePatterns=[
    /^(le|la|les|un|une) marche de l.?immobilier/,
    /^(comment|pourquoi|qu.?est ce que|qu.?est-ce que|guide|actualite|actualites|magazine|article|blog|top)\b/,
    /decouvrez les services go africa/,
    /reseau s\b/,
    /offres? d.?emploi/,
    /meilleurs? et pires? investissements/,
    /tout savoir sur/,
    /qu.?est ce que la promotion immobiliere/
  ];
  if(editorialTitlePatterns.some(re=>re.test(title))) return true;
  const editorialSignals=[
    'magazine','article','blog','actualite','actualites','meilleurs et pires investissements',
    'decouvrez les services','visibilite digitale','messagerie instantanee','campagnes emails et sms',
    'a vendre','prise de rendez-vous en ligne'
  ];
  let signals=0;
  for(const signal of editorialSignals) if(hay.includes(signal)) signals++;
  // Ne retire un candidat que lorsque plusieurs signaux éditoriaux convergent.
  return signals>=3 && !/appel d.?offres|avis de consultation|demande de cotation|prestataire|fournisseur|projet|programme immobilier|construction|promoteur|videosurveillance|controle d.?acces|alarme|incendie|ssi|cmsi|reseau|fibre|wifi|portail|domotique|maintenance/.test(hay);
}
function filterCommercialProspectionV221(rows){
  return rows.filter(x=>!isEditorialProspectV221(x));
}

const PROSPECTION_V21_TIMEOUT_MS = 6500;
const PROSPECTION_V21_MAX_HTML = 2 * 1024 * 1024;
const PROSPECTION_V21_CONCURRENCY = 4;

function getProspectionSourcesV21(){ return PROSPECTION_SOURCES_V21.map(x=>({...x})); }
function stripHtmlV21(html){
  return String(html||'')
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;/gi,"'")
    .replace(/\s+/g,' ').trim();
}
function absUrlV21(base,href){
  try{
    const u=new URL(String(href||''),base);
    if(!/^https?:$/i.test(u.protocol)) return '';
    u.hash='';
    return u.toString();
  }catch(_){return '';}
}
function normalizeSearchTextV21(v){
  return String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}
function scoreCandidateV21(title,url,text,service,type){
  const hay=normalizeSearchTextV21(title+' '+url+' '+text+' '+service+' '+type);
  const words=['appel d’offres','appel d offres','avis d’appel','avis de consultation','demande de cotation','marche','fournisseur','prestataire','consultation','projet','programme immobilier','construction','promoteur','securite','videosurveillance','cctv','controle d’acces','alarme','incendie','ssi','cmsi','reseau','fibre','wifi','portail','domotique','maintenance'];
  let score=0;
  for(const w of words) if(hay.includes(normalizeSearchTextV21(w))) score+=6;
  if(service && service!=='Tous les services VisionProtection' && hay.includes(normalizeSearchTextV21(service))) score+=15;
  if(type && type!=='Tous' && ((type==='Appels d’offres'&&/appel|marche|consultation|cotation/.test(hay)) || (type==='Immobilier'&&/immobili|construction|promoteur|programme/.test(hay)) || (type==='Public'&&/gouv|ministere|mairie|public|administration|un/.test(hay)) || (type==='Privé'&&/entreprise|societe|prive/.test(hay)))) score+=12;
  if(/\.(pdf|docx?|xlsx?)($|\?)/i.test(url)) score+=8;
  return Math.max(0,Math.min(100,score));
}
function classifySourceTypeV21(src,title,text){
  const h=normalizeSearchTextV21(src.type+' '+src.nom+' '+title+' '+text);
  if(/appel|marche|consultation|ppm|ungm/.test(h)) return 'APPEL_OFFRES';
  if(/immobili|construction|promoteur|programme/.test(h)) return 'IMMOBILIER';
  if(/public|gouv|ministere|administration/.test(h)) return 'PUBLIC';
  return src.type||'AUTRE';
}
function extractLinksV21(html,baseUrl){
  const out=[]; const seen=new Set();
  const re=/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while((m=re.exec(String(html||'')))!==null){
    const url=absUrlV21(baseUrl,m[1]);
    if(!url || seen.has(url)) continue;
    const title=stripHtmlV21(m[2]).slice(0,500);
    if(!title) continue;
    seen.add(url); out.push({url,title});
  }
  return out;
}
function excerptAroundV21(bodyText,title){
  const body=String(bodyText||'');
  const cleanTitle=String(title||'').replace(/\s+/g,' ').trim();
  const normalizedBody=normalizeSearchTextV21(body);
  const normalizedTitle=normalizeSearchTextV21(cleanTitle).slice(0,100);
  let pos=normalizedTitle.length>=8 ? normalizedBody.indexOf(normalizedTitle) : -1;
  if(pos<0){
    const keys=['appel d offres','avis de consultation','demande de cotation','programme immobilier','projet','prestataire','fournisseur','videosurveillance','controle d acces','alarme','incendie','construction'];
    for(const k of keys){ const i=normalizedBody.indexOf(k); if(i>=0){pos=i;break;} }
  }
  if(pos<0) return body.slice(0,650);
  return body.slice(Math.max(0,pos-220),Math.min(body.length,pos+950));
}
function buildSourceCandidateV21(src,link,bodyText,service,type){
  const title=link.title||src.nom;
  const excerpt=excerptAroundV21(bodyText,title).slice(0,1200);
  return {
    source_id:src.id, source_nom:src.nom, url_source:src.url,
    titre:title, url_cible:link.url, extrait:excerpt,
    pertinence:scoreCandidateV21(title,link.url,excerpt,service,type),
    type_opportunite:classifySourceTypeV21(src,title,excerpt)
  };
}
async function fetchProspectionSourceV21(src){
  const started=Date.now();
  try{
    const r=await axios.get(src.url,{
      timeout:PROSPECTION_V21_TIMEOUT_MS,
      maxContentLength:PROSPECTION_V21_MAX_HTML,
      maxBodyLength:PROSPECTION_V21_MAX_HTML,
      decompress:true,
      headers:{'User-Agent':'VisionProtection-Prospection/2.1.1','Accept':'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8','Accept-Language':'fr-FR,fr;q=0.9,en;q=0.7'}
    });
    const html=String(r.data||'');
    const text=stripHtmlV21(html).slice(0,90000);
    const links=extractLinksV21(html,src.url);
    return {ok:true,src,html,text,links,duration_ms:Date.now()-started};
  }catch(e){
    return {ok:false,src,error:String(e.message||e).slice(0,250),duration_ms:Date.now()-started};
  }
}
async function mapWithConcurrencyV21(items,limit,worker){
  const out=new Array(items.length); let next=0;
  async function runner(){
    while(true){ const i=next++; if(i>=items.length) return; out[i]=await worker(items[i],i); }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>runner()));
  return out;
}

app.get('/robot/prospection-sources',(req,res)=>res.json({success:true,version:'2.2.1',country_scope:PROSPECTION_COUNTRY_V22,sources:getProspectionSourcesV21(),timeout_ms:PROSPECTION_V21_TIMEOUT_MS,concurrency:PROSPECTION_V21_CONCURRENCY}));

app.post('/robot/prospection-collecte',async(req,res)=>{
  const zone=PROSPECTION_COUNTRY_V22;
  const type=String(req.body?.type||'Tous').trim();
  const service=String(req.body?.service||'Tous les services VisionProtection').trim();
  const max=Math.max(5,Math.min(30,Number(req.body?.max_results||15)));
  const ids=Array.isArray(req.body?.sources)&&req.body.sources.length?req.body.sources.map(String):PROSPECTION_SOURCES_V21.map(x=>x.id);
  const selected=PROSPECTION_SOURCES_V21.filter(x=>ids.includes(x.id));
  const results=[]; const errors=[];
  const fetched=await mapWithConcurrencyV21(selected,PROSPECTION_V21_CONCURRENCY,fetchProspectionSourceV21);
  for(const item of fetched){
    if(!item.ok){ errors.push({source:item.src.nom,message:item.error,duration_ms:item.duration_ms}); continue; }
    const {src,text,links}=item;
    const pageScore=scoreCandidateV21(src.nom,src.url,text,service,type);
    if(pageScore>=10) results.push(buildSourceCandidateV21(src,{url:src.url,title:src.nom},text,service,type));
    // Limiter le nombre de liens analysés par source pour garder une réponse rapide.
    const relevantLinks=links
      .map(link=>({...link,score:scoreCandidateV21(link.title,link.url,text.slice(0,1800),service,type)}))
      .filter(x=>x.score>=12)
      .sort((a,b)=>b.score-a.score)
      .slice(0,35);
    for(const link of relevantLinks) results.push(buildSourceCandidateV21(src,link,text,service,type));
  }
  const unique=new Map();
  for(const x of results){
    const key=x.url_cible.replace(/\/$/,'');
    if(!unique.has(key)||x.pertinence>unique.get(key).pertinence) unique.set(key,x);
  }
  const rows=filterCommercialProspectionV221(filterProspectionV22([...unique.values()])).sort((a,b)=>b.pertinence-a.pertinence).slice(0,max);
  let saved=0;
  if(dbReady&&pool){
    for(const c of rows){
      try{
        const [r]=await pool.query(`INSERT INTO prospection_web_collectes(source_id,source_nom,url_source,titre,url_cible,extrait,pertinence,statut) VALUES(?,?,?,?,?,?,?,'COLLECTEE') ON DUPLICATE KEY UPDATE titre=VALUES(titre),source_nom=VALUES(source_nom),extrait=VALUES(extrait),pertinence=VALUES(pertinence),updated_at=CURRENT_TIMESTAMP`,[c.source_id,c.source_nom,c.url_source,c.titre,c.url_cible,c.extrait,c.pertinence]);
        saved+=Number(r.affectedRows||0)>0?1:0;
      }catch(e){console.warn('⚠️ collecte V2.1.1',e.message);}
    }
  }
  res.json({success:true,version:'2.2.1',country_scope:PROSPECTION_COUNTRY_V22,zone,type,service,sources_testees:selected.length,count:rows.length,saved,errors,candidats:rows.map(x=>({...x,statut:'COLLECTEE'})),performance:{timeout_ms:PROSPECTION_V21_TIMEOUT_MS,concurrency:PROSPECTION_V21_CONCURRENCY,parallel:true},message:`${rows.length} candidat(s) collecté(s) sans utiliser Gemini.`});
});

app.get('/robot/prospection-collectes',async(req,res)=>{
  if(!dbReady||!pool) return res.json({success:true,candidats:[],database:'memory',country_scope:PROSPECTION_COUNTRY_V22});
  const limit=Math.max(1,Math.min(100,Number(req.query.limit||50)));
  const fetchLimit=Math.min(300,Math.max(limit,limit*3));
  const [rawRows]=await pool.query(`SELECT id,source_id,source_nom,url_source,titre,url_cible,extrait,pertinence,statut,created_at FROM prospection_web_collectes ORDER BY pertinence DESC,created_at DESC LIMIT ${fetchLimit}`);
  const rows=filterProspectionV22(rawRows).slice(0,limit);
  res.json({success:true,version:'2.2.1',country_scope:PROSPECTION_COUNTRY_V22,candidats:rows});
});

app.delete('/robot/prospection-collectes/:id',async(req,res)=>{
  if(!dbReady||!pool) return res.status(503).json({success:false,message:'Base de données indisponible.'});
  const id=Number(req.params.id);
  if(!Number.isInteger(id)||id<1) return res.status(400).json({success:false,message:'Identifiant invalide.'});
  const [r]=await pool.query('DELETE FROM prospection_web_collectes WHERE id=?',[id]);
  res.json({success:true,deleted:Number(r.affectedRows||0),id});
});

app.post('/robot/prospection-nettoyer-sources-retirees',async(req,res)=>{
  if(!dbReady||!pool) return res.status(503).json({success:false,message:'Base de données indisponible.'});
  const ids=[...PROSPECTION_RETIRED_SOURCE_IDS_V22];
  const placeholders=ids.map(()=>'?').join(',');
  const [collectes]=await pool.query(`DELETE FROM prospection_web_collectes WHERE source_id IN (${placeholders})`,ids);
  const names=['DGMP','Ministère de la Construction','Pages Jaunes'];
  const [opportunites]=await pool.query(
    `DELETE FROM opportunites_web WHERE source_nom LIKE ? OR source_nom LIKE ? OR source_nom LIKE ?`,
    ['%DGMP%','%Construction%','%Pages Jaunes%']
  );
  res.json({
    success:true,
    version:'2.2.1',
    country_scope:PROSPECTION_COUNTRY_V22,
    collectes_supprimees:Number(collectes.affectedRows||0),
    opportunites_supprimees:Number(opportunites.affectedRows||0),
    sources_retirees:ids
  });
});

app.post('/robot/prospection-qualifier',async(req,res)=>{
  if(!gemini) return res.status(503).json({success:false,code:'GEMINI_NOT_CONFIGURED',message:'GEMINI_API_KEY non configurée.'});
  if(webSearchQuotaActive()) return res.status(429).json({success:false,code:'WEB_SEARCH_QUOTA_COOLDOWN',quota_blocked:true,quota_until:webSearchHealth.quotaUntil,message:webSearchQuotaMessage()});
  const candidates=Array.isArray(req.body?.candidats)?filterCommercialProspectionV221(filterProspectionV22(req.body.candidats)).slice(0,10):[];
  if(!candidates.length) return res.status(400).json({success:false,message:'Aucun candidat à qualifier.'});
  const prompt=`Tu es l’agent de qualification commerciale de VisionProtection & Informatique. Qualifie uniquement les candidats web fournis ci-dessous. Ne fabrique aucune information. Un candidat est une opportunité seulement si la source indique un projet, marché, consultation, besoin de prestataire, programme immobilier ou organisation pertinente. Réponds uniquement en JSON valide sous forme de tableau. Champs: index,qualifie,type_opportunite,titre,organisation,ville,service,description,date_limite,pertinence,resume.\n\nCANDIDATS:\n${JSON.stringify(candidates,null,2)}`;
  try{
    const response=await callGemini(prompt,{max503Retries:1});
    const parsed=extractJsonFromGemini(response.text||'');
    if(!parsed) throw new Error('Réponse Gemini non interprétable.');
    const qualified=Array.isArray(parsed)?parsed:[];
    let saved=0;
    if(dbReady&&pool){
      for(const q of qualified){
        if(!q?.qualifie) continue;
        const idx=Number(q.index); const c=candidates[idx]; if(!c) continue;
        const typeOp=normalizeOpportunityType(q.type_opportunite||c.type_opportunite);
        const [r]=await pool.query(`INSERT INTO opportunites_web(type_opportunite,titre,organisation,ville,service,description,date_publication,date_limite,contact,email,telephone,url_source,source_nom,pertinence,statut,resume) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'NOUVELLE',?) ON DUPLICATE KEY UPDATE titre=VALUES(titre),organisation=VALUES(organisation),ville=VALUES(ville),service=VALUES(service),description=VALUES(description),date_limite=VALUES(date_limite),pertinence=VALUES(pertinence),resume=VALUES(resume),updated_at=CURRENT_TIMESTAMP`,[typeOp,String(q.titre||c.titre).slice(0,500),q.organisation||'',q.ville||'',q.service||'',q.description||c.extrait||'', '', q.date_limite||'', '', '', '', c.url_cible,c.source_nom,Math.max(0,Math.min(100,Number(q.pertinence||c.pertinence)||0)),q.resume||'']);
        saved+=Number(r.affectedRows||0)>0?1:0;
        await pool.query(`UPDATE prospection_web_collectes SET statut='QUALIFIEE' WHERE id=?`,[c.id]).catch(()=>{});
      }
    }
    webSearchHealth={...webSearchHealth,available:true,lastCheck:new Date().toISOString(),lastError:null,reason:null,searches:webSearchHealth.searches+1,lastSearchAt:new Date().toISOString()};
    res.json({success:true,version:'2.2.1',country_scope:PROSPECTION_COUNTRY_V22,qualified,saved,model:response.model,ai_fallback:Boolean(response.fallback),commercial_filter:true});
  }catch(e){
    const msg=String(e.message||e); const isQuota=/429|quota|resource_exhausted|rate.?limit/i.test(msg);
    const isUnavailable=e?.geminiType==='UNAVAILABLE'||/503|unavailable|high demand|overloaded|temporairement indisponible/i.test(msg);
    if(isQuota){const until=new Date(Date.now()+WEB_SEARCH_QUOTA_COOLDOWN_MS).toISOString();webSearchHealth={...webSearchHealth,available:false,quotaUntil:until,reason:'QUOTA',lastError:msg,lastCheck:new Date().toISOString()};return res.status(429).json({success:false,code:'WEB_SEARCH_QUOTA',quota_blocked:true,quota_until:until,message:'⚠️ Gemini est actuellement en quota. La collecte multi-sources reste disponible sans IA.'});}
    if(isUnavailable) return res.status(503).json({success:false,code:'GEMINI_UNAVAILABLE',version:'2.2.1',retryable:true,message:'Gemini est temporairement indisponible après les tentatives et le modèle de secours. Les candidats collectés sont conservés.'});
    res.status(500).json({success:false,message:'Qualification Gemini impossible : '+msg.slice(0,600)});
  }
});

app.delete('/crm/opportunites-web/:id',async(req,res)=>{
  if(!dbReady||!pool) return res.status(503).json({success:false,message:'Base de données indisponible.'});
  const id=Number(req.params.id);
  if(!Number.isInteger(id)||id<1) return res.status(400).json({success:false,message:'Identifiant invalide.'});
  const [r]=await pool.query('DELETE FROM opportunites_web WHERE id=?',[id]);
  res.json({success:true,deleted:Number(r.affectedRows||0),id});
});

// ================== FIN PROSPECTION WEB MULTI-SOURCES V2.2 ==================


// ================== PROSPECTION WEB IA V2.0 ==================
function cleanOpportunityUrl(value){
  const u=String(value||'').trim();
  return /^https?:\/\//i.test(u)?u:'';
}
function normalizeOpportunityType(v){
  const x=String(v||'').toUpperCase();
  if(x.includes('APPEL')||x.includes('OFFRE')||x.includes('MARCHE')) return 'APPEL_OFFRES';
  if(x.includes('IMMOB')) return 'IMMOBILIER';
  if(x.includes('PUBLIC')) return 'PUBLIC';
  if(x.includes('PRIV')) return 'PRIVE';
  return 'AUTRE';
}
function extractJsonFromGemini(text){
  const raw=String(text||'').trim();
  try{return JSON.parse(raw);}catch(_){ }
  const fenced=raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if(fenced){try{return JSON.parse(fenced[1]);}catch(_){ }}
  const start=raw.indexOf('['), end=raw.lastIndexOf(']');
  if(start>=0&&end>start){try{return JSON.parse(raw.slice(start,end+1));}catch(_){ }}
  return null;
}
function normalizeOpportunityRows(payload){
  const rows=Array.isArray(payload)?payload:(Array.isArray(payload?.opportunites)?payload.opportunites:[]);
  return rows.map(x=>({
    type_opportunite:normalizeOpportunityType(x?.type_opportunite||x?.type),
    titre:String(x?.titre||x?.title||'Opportunité sans titre').trim().slice(0,500),
    organisation:String(x?.organisation||x?.entreprise||x?.organization||'').trim().slice(0,255),
    ville:String(x?.ville||x?.city||'').trim().slice(0,150),
    service:String(x?.service||x?.besoin||'').trim().slice(0,255),
    description:String(x?.description||x?.besoin_detail||'').trim(),
    date_publication:String(x?.date_publication||x?.published_at||'').trim().slice(0,50),
    date_limite:String(x?.date_limite||x?.deadline||'').trim().slice(0,100),
    contact:String(x?.contact||'').trim().slice(0,255),
    email:String(x?.email||'').trim().slice(0,255),
    telephone:String(x?.telephone||x?.phone||'').trim().slice(0,100),
    url_source:cleanOpportunityUrl(x?.url_source||x?.url||x?.source_url),
    source_nom:String(x?.source_nom||x?.source||'Google Search').trim().slice(0,255),
    pertinence:Math.max(0,Math.min(100,Number(x?.pertinence??x?.score??0)||0)),
    resume:String(x?.resume||x?.summary||x?.evidence||'').trim()
  })).filter(x=>x.titre&&x.url_source);
}

app.get('/robot/web-search-status', async (req,res)=>{
  const now=new Date().toISOString();
  const quotaActive=webSearchQuotaActive();
  res.json({
    success:true,
    backend_version:'2.0.4',
    configured:Boolean(process.env.GEMINI_API_KEY && gemini),
    model:webSearchHealth.model,
    google_search_grounding:true,
    available:quotaActive?false:webSearchHealth.available,
    quota_blocked:quotaActive,
    quota_until:webSearchHealth.quotaUntil,
    reason:webSearchHealth.reason,
    last_error:webSearchHealth.lastError,
    last_search_at:webSearchHealth.lastSearchAt,
    searches:webSearchHealth.searches,
    checked_at:webSearchHealth.lastCheck,
    server_time:now,
    message:quotaActive?webSearchQuotaMessage():(webSearchHealth.available===true?'Gemini + Google Search disponibles.':webSearchHealth.available===false?'Gemini/Google Search indisponibles. Cliquez sur Vérifier Gemini pour obtenir le diagnostic réel.':'État non encore vérifié.')
  });
});

// Vérification ACTIVE : cet endpoint lance réellement un appel Gemini + Google Search.
app.get('/robot/web-search-verify', async (req,res)=>{
  if(!gemini){
    webSearchHealth={...webSearchHealth,available:false,lastCheck:new Date().toISOString(),reason:'CLIENT_NON_INITIALISE',lastError:'GEMINI_API_KEY non configurée.'};
    return res.status(503).json({success:false,backend_version:'2.0.4',code:'GEMINI_NOT_CONFIGURED',configured:false,available:false,message:'GEMINI_API_KEY non configurée sur Render.'});
  }

  if(webSearchQuotaActive()){
    return res.status(429).json({success:false,backend_version:'2.0.4',code:'WEB_SEARCH_QUOTA_COOLDOWN',quota_blocked:true,quota_until:webSearchHealth.quotaUntil,available:false,message:webSearchQuotaMessage()});
  }

  const checkedAt=new Date().toISOString();
  try{
    console.log('🧪 V2.0.4 — vérification ACTIVE Gemini + Google Search...');
    const response=await gemini.models.generateContent({
      model:'gemini-3.8-flash',
      contents:'Recherche sur le web le site officiel de Google. Réponds uniquement par OK.',
      config:{tools:[{googleSearch:{}}]}
    });

    webSearchHealth={...webSearchHealth,available:true,lastCheck:checkedAt,lastError:null,reason:null,quotaUntil:null,searches:webSearchHealth.searches+1,lastSearchAt:checkedAt};
    return res.json({success:true,backend_version:'2.0.4',configured:true,model:webSearchHealth.model,google_search_grounding:true,available:true,quota_blocked:false,searches:webSearchHealth.searches,checked_at:checkedAt,last_search_at:checkedAt,message:'Gemini + Google Search sont disponibles.',preview:String(response?.text||'OK').slice(0,120)});
  }catch(e){
    const typeError=classifyGeminiError(e);
    const msg=String(e?.message||e);
    console.error('❌ V2.0.4 — vérification Gemini/Google Search :',msg);
    webSearchHealth={...webSearchHealth,available:false,lastCheck:checkedAt,reason:typeError,lastError:msg};
    if(typeError==='QUOTA' || /resource_exhausted|quota|rate.?limit|too many requests/i.test(msg)){
      const until=new Date(Date.now()+WEB_SEARCH_QUOTA_COOLDOWN_MS).toISOString();
      webSearchHealth={...webSearchHealth,quotaUntil:until,reason:'QUOTA'};
      return res.status(429).json({success:false,backend_version:'2.0.4',code:'WEB_SEARCH_QUOTA',quota_blocked:true,quota_until:until,available:false,message:'⚠️ Quota Gemini/Google Search atteint. '+msg.slice(0,500)});
    }
    return res.status(500).json({success:false,backend_version:'2.0.4',code:'WEB_SEARCH_VERIFY_ERROR',available:false,message:'Échec de la vérification Gemini + Google Search : '+msg.slice(0,700)});
  }
});

// Diagnostic serveur très simple, sans appel Gemini.
app.get('/robot/web-search-diagnostic',(req,res)=>res.json({success:true,backend_version:'2.0.4',gemini_configured:Boolean(process.env.GEMINI_API_KEY && gemini),web_search_endpoint:'/robot/web-search-verify',status_endpoint:'/robot/web-search-status'}));

app.post('/robot/opportunites-web', async (req,res)=>{
  const startedAt=new Date();
  try{
    if(!gemini){
      return res.status(503).json({success:false,code:'GEMINI_NOT_CONFIGURED',message:'GEMINI_API_KEY non configurée.'});
    }

    if(webSearchQuotaActive()){
      return res.status(429).json({
        success:false,
        code:'WEB_SEARCH_QUOTA_COOLDOWN',
        quota_blocked:true,
        quota_until:webSearchHealth.quotaUntil,
        message:webSearchQuotaMessage()
      });
    }

    const zone=String(req.body?.zone||'Côte d’Ivoire, principalement Abidjan').trim();
    const type=String(req.body?.type||'Tous').trim();
    const service=String(req.body?.service||'Tous les services VisionProtection').trim();
    const periode=String(req.body?.periode||'30 derniers jours').trim();
    // V2.0.1 : budget local volontairement prudent.
    const max=Math.max(3,Math.min(10,Number(req.body?.max_results||5)));
    const prompt=`Tu es un agent de veille commerciale pour VisionProtection & Informatique, entreprise basée à Abidjan.

OBJECTIF : utiliser Google Search pour trouver des opportunités commerciales publiques sur le web correspondant réellement aux services de VisionProtection.

ZONE : ${zone}
TYPE RECHERCHÉ : ${type}
SERVICES : ${service}
PÉRIODE : ${periode}
NOMBRE MAXIMUM : ${max}

Services VisionProtection : vidéosurveillance/CCTV, contrôle d'accès, alarmes intrusion, SSI/CMSI et sécurité incendie, motorisation de portail, domotique, clôture électrique, réseaux informatiques, fibre/VLAN/Wi-Fi, maintenance et intégration de systèmes de sécurité.

RECHERCHE : appels d'offres, avis de consultation, demandes de cotation, marchés, recherche de prestataires, projets immobiliers nécessitant des équipements ou services, entreprises recherchant un intégrateur/prestataire, organismes publics ou privés publiant un besoin réel.

RÈGLES IMPORTANTES :
- Recherche sur le web avec Google Search et privilégie les pages réellement accessibles.
- Ne transforme pas une simple fiche d'entreprise en opportunité : il faut un besoin, projet, consultation, marché ou recherche de prestataire identifiable.
- Ne fabrique aucune date limite, personne, téléphone, email, prix ou URL.
- Si une information n'est pas trouvée, laisse le champ vide.
- Pour chaque résultat, conserve l'URL exacte de la page source.
- Évite les doublons.
- Classe la pertinence de 0 à 100 selon la correspondance technique avec VisionProtection et le caractère concret du besoin.
- Réponds UNIQUEMENT avec un tableau JSON valide, sans Markdown.

FORMAT EXACT :
[{"type_opportunite":"APPEL_OFFRES|IMMOBILIER|PUBLIC|PRIVE|AUTRE","titre":"","organisation":"","ville":"","service":"","description":"","date_publication":"","date_limite":"","contact":"","email":"","telephone":"","url_source":"https://...","source_nom":"","pertinence":0,"resume":"Pourquoi cette page constitue une opportunité réelle et quel élément le prouve"}]`;

    const response=await gemini.models.generateContent({
      model:'gemini-3.8-flash',
      contents:prompt,
      config:{tools:[{googleSearch:{}}]}
    });

    webSearchHealth={
      ...webSearchHealth,
      available:true,
      lastCheck:new Date().toISOString(),
      lastError:null,
      reason:null,
      quotaUntil:null,
      searches:webSearchHealth.searches+1,
      lastSearchAt:startedAt.toISOString()
    };

    const parsed=extractJsonFromGemini(response.text||'');
    if(!parsed) throw new Error('Gemini a répondu, mais le format des opportunités n’a pas pu être interprété.');
    const rows=normalizeOpportunityRows(parsed).slice(0,max);
    let saved=0;
    if(dbReady&&pool){
      for(const o of rows){
        try{
          const [r]=await pool.query(`INSERT INTO opportunites_web(type_opportunite,titre,organisation,ville,service,description,date_publication,date_limite,contact,email,telephone,url_source,source_nom,pertinence,statut,resume)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'NOUVELLE',?)
          ON DUPLICATE KEY UPDATE titre=VALUES(titre),organisation=VALUES(organisation),ville=VALUES(ville),service=VALUES(service),description=VALUES(description),date_publication=VALUES(date_publication),date_limite=VALUES(date_limite),contact=VALUES(contact),email=VALUES(email),telephone=VALUES(telephone),source_nom=VALUES(source_nom),pertinence=VALUES(pertinence),resume=VALUES(resume),updated_at=CURRENT_TIMESTAMP`,[o.type_opportunite,o.titre,o.organisation,o.ville,o.service,o.description,o.date_publication,o.date_limite,o.contact,o.email,o.telephone,o.url_source,o.source_nom,o.pertinence,o.resume]);
          if(r.affectedRows) saved++;
        }catch(e){console.warn('⚠️ Opportunité non enregistrée :',e.message);}
      }
    }
    res.json({success:true,count:rows.length,saved,opportunites:rows,model:'gemini-3.8-flash',search_grounding:true,generated_at:new Date().toISOString(),searches_used:webSearchHealth.searches});
  }catch(e){
    const typeError=classifyGeminiError(e);
    const msg=String(e?.message||e);
    console.error('❌ PROSPECTION WEB IA :',msg);

    if(typeError==='QUOTA' || /resource_exhausted|quota|rate.?limit|too many requests/i.test(msg)){
      const until=new Date(Date.now()+WEB_SEARCH_QUOTA_COOLDOWN_MS).toISOString();
      webSearchHealth={
        ...webSearchHealth,
        available:false,
        lastCheck:new Date().toISOString(),
        reason:'QUOTA',
        lastError:msg,
        quotaUntil:until
      };
      return res.status(429).json({
        success:false,
        code:'WEB_SEARCH_QUOTA',
        quota_blocked:true,
        quota_until:until,
        message:'⚠️ Quota Gemini atteint pour la prospection Web. Le CRM bloque automatiquement les nouvelles recherches pendant quelques heures afin d’éviter de consommer davantage de quota. Le chatbot, les prospects et les devis continuent de fonctionner.'
      });
    }

    webSearchHealth={...webSearchHealth,available:false,lastCheck:new Date().toISOString(),reason:typeError,lastError:msg};
    res.status(500).json({success:false,code:'WEB_SEARCH_ERROR',message:msg});
  }
});

app.get('/crm/opportunites-web',async(req,res)=>{
  try{
    if(!dbReady||!pool) return res.json({success:true,opportunites:[],database:'memory-fallback'});
    const statut=String(req.query.statut||'').trim();
    const limit=Math.max(1,Math.min(100,Number(req.query.limit||50)));
    const sql=statut?`SELECT * FROM opportunites_web WHERE statut=? ORDER BY pertinence DESC,created_at DESC LIMIT ${limit}`:`SELECT * FROM opportunites_web ORDER BY pertinence DESC,created_at DESC LIMIT ${limit}`;
    const [rows]=await pool.query(sql,statut?[statut]:[]);
    res.json({success:true,count:rows.length,opportunites:rows,database:'mysql'});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.patch('/crm/opportunites-web/:id',async(req,res)=>{
  try{
    if(!dbReady||!pool) return res.status(503).json({success:false,message:'Base MySQL non disponible.'});
    const id=Number(req.params.id);
    const statut=String(req.body?.statut||'').trim();
    if(!id||!['NOUVELLE','A_VERIFIER','AJOUTEE_CRM','IGNOREE','EXPIREE'].includes(statut)) return res.status(400).json({success:false,message:'Identifiant ou statut invalide.'});
    await pool.query('UPDATE opportunites_web SET statut=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',[statut,id]);
    res.json({success:true,message:'Statut de l’opportunité mis à jour.'});
  }catch(e){res.status(500).json({success:false,message:e.message});}
});

app.post('/crm/opportunites-web/:id/ajouter-crm',async(req,res)=>{
  const conn=await pool?.getConnection();
  try{
    if(!dbReady||!pool||!conn) return res.status(503).json({success:false,message:'Base MySQL non disponible.'});
    const id=Number(req.params.id);
    if(!id) return res.status(400).json({success:false,message:'Opportunité invalide.'});
    const [rows]=await conn.query('SELECT * FROM opportunites_web WHERE id=? LIMIT 1',[id]);
    if(!rows.length) return res.status(404).json({success:false,message:'Opportunité introuvable.'});
    const o=rows[0];
    const wa=String(req.body?.telephone||o.telephone||'').replace(/[^\d]/g,'');
    const phone=wa||('WEB-'+id);
    const whatsappId=wa?normalizeForApi(wa):phone;
    const [existing]=await conn.query('SELECT id FROM prospects WHERE whatsapp_id=? LIMIT 1',[whatsappId]);
    let prospectId;
    if(existing.length){
      prospectId=existing[0].id;
      await conn.query(`UPDATE prospects SET nom=COALESCE(NULLIF(?,'') ,nom),entreprise=COALESCE(NULLIF(?,'') ,entreprise),telephone=COALESCE(NULLIF(?,'') ,telephone),ville=COALESCE(NULLIF(?,'') ,ville),service=COALESCE(NULLIF(?,'') ,service),besoin=COALESCE(NULLIF(?,'') ,besoin),updated_at=CURRENT_TIMESTAMP WHERE id=?`,[o.contact||'',o.organisation||'',o.telephone||'',o.ville||'',o.service||'',o.description||o.titre,prospectId]);
    }else{
      const [ins]=await conn.query(`INSERT INTO prospects(whatsapp_id,nom,telephone,entreprise,ville,service,besoin,statut,etat_conversation) VALUES(?,?,?,?,?,?,?,?,?)`,[whatsappId,o.contact||o.organisation||'Opportunité web',o.telephone||null,o.organisation||null,o.ville||null,o.service||null,(o.description||o.titre||'').slice(0,5000),'Nouveau','TERMINE']);
      prospectId=ins.insertId;
    }
    const note=[`🔎 Opportunité trouvée par VisionProspect IA`,o.titre,o.resume?`Résumé : ${o.resume}`:'',o.url_source?`Source : ${o.url_source}`:'',o.date_limite?`Date limite : ${o.date_limite}`:''].filter(Boolean).join('\n');
    await conn.query('INSERT INTO notes_commerciales(prospect_id,note,auteur) VALUES(?,?,?)',[prospectId,note,'VisionProspect IA']);
    await conn.query('UPDATE opportunites_web SET statut=\'AJOUTEE_CRM\',updated_at=CURRENT_TIMESTAMP WHERE id=?',[id]);
    res.json({success:true,prospect_id:prospectId,message:'Opportunité ajoutée au CRM.',telephone:o.telephone||'',whatsapp_id:whatsappId});
  }catch(e){
    console.error('❌ AJOUT OPPORTUNITÉ CRM :',e.message);
    res.status(500).json({success:false,message:e.message});
  }finally{if(conn)conn.release();}
});

app.get('/robot/web-search-diagnostic', (req,res)=>{
  res.json({
    success:true,
    backend_version:'2.0.4',
    web_search_routes:true,
    gemini_configured:Boolean(process.env.GEMINI_API_KEY && gemini),
    database:dbReady?'mysql-connected':'memory-fallback',
    model:webSearchHealth.model,
    quota_blocked:webSearchQuotaActive(),
    quota_until:webSearchHealth.quotaUntil,
    last_error:webSearchHealth.lastError,
    checked_at:new Date().toISOString()
  });
});

app.get("/",(req,res)=>res.json({success:true,application:"VisionProtection WhatsApp CRM",version:"2.0.4",database:dbReady?"mysql-connected":"memory-fallback",graphApi:GRAPH_VERSION,webhook:"/webhook",crm:"/crm/prospects",messages:"/crm/messages/:phone",notes:"/crm/notes/:phone",stats:"/crm/stats",status:"online"}));


// ================== DEVIS V1.8 ==================
function dateDevisDefaut(){
  return new Date().toISOString().slice(0,10);
}
function normaliserLignesDevis(lignes){
  return (Array.isArray(lignes)?lignes:[]).map((l,i)=>{
    const designation=String(l?.designation||'').trim();
    const quantite=Math.max(0,Number(l?.quantite||0));
    const prix_unitaire=Math.max(0,Number(l?.prix_unitaire||0));
    const prix_total=Number((quantite*prix_unitaire).toFixed(2));
    return {designation,quantite,prix_unitaire,prix_total,ordre:i};
  }).filter(l=>l.designation);
}
function calculerTotalDevis(lignes){
  return Number(lignes.reduce((s,l)=>s+l.prix_total,0).toFixed(2));
}
function numeroDevisAuto(id){
  return `DEV-${new Date().getFullYear()}-${String(id).padStart(5,'0')}`;
}
function chargerProspectPourDevis(req,res){
  return null;
}

app.get('/crm/devis/prospect/:prospectId', async (req,res)=>{
  try{
    if(!dbReady||!pool) return res.status(503).json({success:false,message:'Base MySQL non disponible.'});
    const prospectId=Number(req.params.prospectId);
    if(!prospectId) return res.status(400).json({success:false,message:'Prospect invalide.'});
    const [prospectRows]=await pool.query(`SELECT id,nom,telephone,whatsapp_id,entreprise,ville,service,besoin,statut FROM prospects WHERE id=? LIMIT 1`,[prospectId]);
    if(!prospectRows.length) return res.status(404).json({success:false,message:'Prospect introuvable.'});
    const [devisRows]=await pool.query(`SELECT id,prospect_id,numero_devis,date_devis,objet,total,notes,statut_suivi,date_envoi,date_echeance,commentaire_suivi,created_at,updated_at FROM devis WHERE prospect_id=? ORDER BY created_at DESC LIMIT 20`,[prospectId]);
    let devis=[];
    for(const d of devisRows){
      const [lignes]=await pool.query(`SELECT id,designation,quantite,prix_unitaire,prix_total,ordre FROM devis_lignes WHERE devis_id=? ORDER BY ordre,id`,[d.id]);
      devis.push({...d,total:Number(d.total),lignes:lignes.map(l=>({...l,quantite:Number(l.quantite),prix_unitaire:Number(l.prix_unitaire),prix_total:Number(l.prix_total)}))});
    }
    res.json({success:true,prospect:prospectRows[0],devis});
  }catch(error){
    console.error('❌ DEVIS GET :',error.message);
    res.status(500).json({success:false,message:error.message});
  }
});

app.post('/crm/devis', async (req,res)=>{
  let conn=null;
  try{
    if(!dbReady||!pool) return res.status(503).json({success:false,message:'Base MySQL non disponible.'});
    const prospectId=Number(req.body?.prospect_id);
    const lignes=normaliserLignesDevis(req.body?.lignes);
    if(!prospectId) return res.status(400).json({success:false,message:'Prospect obligatoire.'});
    if(!lignes.length) return res.status(400).json({success:false,message:'Ajoutez au moins une ligne au devis.'});
    const [prospectRows]=await pool.query(`SELECT id FROM prospects WHERE id=? LIMIT 1`,[prospectId]);
    if(!prospectRows.length) return res.status(404).json({success:false,message:'Prospect introuvable.'});

    const dateDevis=String(req.body?.date_devis||dateDevisDefaut()).slice(0,10);
    const objet=String(req.body?.objet||'').trim().slice(0,255);
    const notes=String(req.body?.notes||'').trim();
    const total=calculerTotalDevis(lignes);

    const statutsAutorises=['Brouillon','Envoyé','En attente','Accepté','Refusé'];
    const statut_suivi=statutsAutorises.includes(String(req.body?.statut_suivi||'')) ? String(req.body.statut_suivi) : 'Brouillon';
    let date_envoi=req.body?.date_envoi ? String(req.body.date_envoi).slice(0,10) : null;
    const date_echeance=req.body?.date_echeance ? String(req.body.date_echeance).slice(0,10) : null;
    const commentaire_suivi=String(req.body?.commentaire_suivi||'').trim();
    if ((statut_suivi==='Envoyé' || statut_suivi==='En attente') && !date_envoi) {
      date_envoi=new Date().toISOString().slice(0,10);
    }

    conn=await pool.getConnection();
    await conn.beginTransaction();
    const [ins]=await conn.query(
      `INSERT INTO devis(prospect_id,numero_devis,date_devis,objet,total,notes,statut_suivi,date_envoi,date_echeance,commentaire_suivi)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [prospectId,'TEMP-'+Date.now(),dateDevis,objet,total,notes,statut_suivi,date_envoi,date_echeance,commentaire_suivi]
    );
    const devisId=ins.insertId;
    const numero=numeroDevisAuto(devisId);
    await conn.query(`UPDATE devis SET numero_devis=? WHERE id=?`,[numero,devisId]);
    for(const l of lignes){
      await conn.query(
        `INSERT INTO devis_lignes(devis_id,designation,quantite,prix_unitaire,prix_total,ordre) VALUES(?,?,?,?,?,?)`,
        [devisId,l.designation,l.quantite,l.prix_unitaire,l.prix_total,l.ordre]
      );
    }
    await conn.commit(); conn.release(); conn=null;

    res.json({success:true,devis:{
      id:devisId,prospect_id:prospectId,numero_devis:numero,date_devis:dateDevis,
      objet,total,notes,lignes,statut_suivi,date_envoi,date_echeance,commentaire_suivi
    }});
  }catch(error){
    if(conn){try{await conn.rollback();conn.release();}catch(_){}}
    console.error('❌ DEVIS SAVE V1.9 :',error.message);
    res.status(500).json({success:false,message:error.message});
  }
});

// Modification complète d'un devis existant.
app.patch('/crm/devis/:id', async (req,res)=>{
  let conn=null;
  try{
    if(!dbReady||!pool) return res.status(503).json({success:false,message:'Base MySQL non disponible.'});
    const id=Number(req.params.id);
    if(!id) return res.status(400).json({success:false,message:'Devis invalide.'});
    const lignes=normaliserLignesDevis(req.body?.lignes);
    if(!lignes.length) return res.status(400).json({success:false,message:'Ajoutez au moins une ligne au devis.'});

    const [existing]=await pool.query(`SELECT id,prospect_id,numero_devis FROM devis WHERE id=? LIMIT 1`,[id]);
    if(!existing.length) return res.status(404).json({success:false,message:'Devis introuvable.'});

    const dateDevis=String(req.body?.date_devis||dateDevisDefaut()).slice(0,10);
    const objet=String(req.body?.objet||'').trim().slice(0,255);
    const notes=String(req.body?.notes||'').trim();
    const total=calculerTotalDevis(lignes);
    const statutsAutorises=['Brouillon','Envoyé','En attente','Accepté','Refusé'];
    const statut_suivi=statutsAutorises.includes(String(req.body?.statut_suivi||'')) ? String(req.body.statut_suivi) : 'Brouillon';
    let date_envoi=req.body?.date_envoi ? String(req.body.date_envoi).slice(0,10) : null;
    const date_echeance=req.body?.date_echeance ? String(req.body.date_echeance).slice(0,10) : null;
    const commentaire_suivi=String(req.body?.commentaire_suivi||'').trim();
    if ((statut_suivi==='Envoyé' || statut_suivi==='En attente') && !date_envoi) date_envoi=new Date().toISOString().slice(0,10);

    conn=await pool.getConnection();
    await conn.beginTransaction();
    await conn.query(`UPDATE devis SET date_devis=?,objet=?,total=?,notes=?,statut_suivi=?,date_envoi=?,date_echeance=?,commentaire_suivi=?,updated_at=NOW() WHERE id=?`,
      [dateDevis,objet,total,notes,statut_suivi,date_envoi,date_echeance,commentaire_suivi,id]);
    await conn.query(`DELETE FROM devis_lignes WHERE devis_id=?`,[id]);
    for(const l of lignes){
      await conn.query(`INSERT INTO devis_lignes(devis_id,designation,quantite,prix_unitaire,prix_total,ordre) VALUES(?,?,?,?,?,?)`,
        [id,l.designation,l.quantite,l.prix_unitaire,l.prix_total,l.ordre]);
    }
    await conn.commit(); conn.release(); conn=null;
    res.json({success:true,devis:{id,prospect_id:existing[0].prospect_id,numero_devis:existing[0].numero_devis,date_devis:dateDevis,objet,total,notes,lignes,statut_suivi,date_envoi,date_echeance,commentaire_suivi}});
  }catch(error){
    if(conn){try{await conn.rollback();conn.release();}catch(_) {}}
    console.error('❌ DEVIS UPDATE :',error.message);
    res.status(500).json({success:false,message:error.message});
  }
});

// Liste globale des devis pour le tableau de suivi V1.9.
app.get('/crm/devis-suivi', async (req,res)=>{
  try{
    if(!dbReady||!pool) return res.status(503).json({success:false,message:'Base MySQL non disponible.'});
    const [rows]=await pool.query(`
      SELECT
        d.id,d.prospect_id,d.numero_devis,d.date_devis,d.objet,d.total,d.notes,
        COALESCE(d.statut_suivi,'Brouillon') AS statut_suivi,
        d.date_envoi,d.date_echeance,d.commentaire_suivi,d.created_at,d.updated_at,
        p.nom,p.telephone,p.whatsapp_id,p.entreprise,p.ville,p.service,p.besoin,p.statut AS statut_prospect
      FROM devis d
      JOIN prospects p ON p.id=d.prospect_id
      ORDER BY
        CASE COALESCE(d.statut_suivi,'Brouillon')
          WHEN 'En attente' THEN 1
          WHEN 'Envoyé' THEN 2
          WHEN 'Brouillon' THEN 3
          WHEN 'Accepté' THEN 4
          WHEN 'Refusé' THEN 5
          ELSE 6
        END,
        COALESCE(d.date_echeance,'2999-12-31') ASC,
        d.created_at DESC
      LIMIT 200
    `);
    const today=new Date().toISOString().slice(0,10);
    const devis=rows.map(d=>{
      const actif=['Brouillon','Envoyé','En attente'].includes(d.statut_suivi);
      const enRetard=Boolean(d.date_echeance && d.date_echeance < today && actif);
      return {...d,total:Number(d.total),en_retard:enRetard};
    });
    const actif=devis.filter(d=>['Brouillon','Envoyé','En attente'].includes(d.statut_suivi));
    const attente=devis.filter(d=>d.statut_suivi==='En attente');
    const envoyes=devis.filter(d=>d.statut_suivi==='Envoyé');
    const acceptes=devis.filter(d=>d.statut_suivi==='Accepté');
    const refuses=devis.filter(d=>d.statut_suivi==='Refusé');
    const retard=devis.filter(d=>d.en_retard);
    const potentiel=actif.reduce((s,d)=>s+d.total,0);
    const caAccepte=acceptes.reduce((s,d)=>s+d.total,0);
    const caRefuse=refuses.reduce((s,d)=>s+d.total,0);
    res.json({
      success:true,
      generated_at:new Date().toISOString(),
      statistiques:{
        total:devis.length,
        brouillons:devis.filter(d=>d.statut_suivi==='Brouillon').length,
        envoyes:envoyes.length,
        attente:attente.length,
        acceptes:acceptes.length,
        refuses:refuses.length,
        en_retard:retard.length,
        potentiel:Number(potentiel.toFixed(2)),
        ca_accepte:Number(caAccepte.toFixed(2)),
        ca_refuse:Number(caRefuse.toFixed(2))
      },
      devis
    });
  }catch(error){
    console.error('❌ DEVIS SUIVI :',error.message);
    res.status(500).json({success:false,message:error.message});
  }
});

// Mise à jour du suivi d'un devis.
app.patch('/crm/devis/:id/suivi', async (req,res)=>{
  try{
    if(!dbReady||!pool) return res.status(503).json({success:false,message:'Base MySQL non disponible.'});
    const id=Number(req.params.id);
    if(!id) return res.status(400).json({success:false,message:'Devis invalide.'});
    const statutsAutorises=['Brouillon','Envoyé','En attente','Accepté','Refusé'];
    const statut=String(req.body?.statut_suivi||'');
    if(!statutsAutorises.includes(statut)) return res.status(400).json({success:false,message:'Statut de devis invalide.'});

    let dateEnvoi=req.body?.date_envoi ? String(req.body.date_envoi).slice(0,10) : null;
    const dateEcheance=req.body?.date_echeance ? String(req.body.date_echeance).slice(0,10) : null;
    const commentaire=String(req.body?.commentaire_suivi||'').trim();

    if((statut==='Envoyé'||statut==='En attente') && !dateEnvoi){
      dateEnvoi=new Date().toISOString().slice(0,10);
    }

    const [r]=await pool.query(
      `UPDATE devis SET statut_suivi=?,date_envoi=?,date_echeance=?,commentaire_suivi=? WHERE id=?`,
      [statut,dateEnvoi,dateEcheance,commentaire,id]
    );
    if(!r.affectedRows) return res.status(404).json({success:false,message:'Devis introuvable.'});

    const [[d]]=await pool.query(`
      SELECT d.id,d.prospect_id,d.numero_devis,d.total,d.statut_suivi,d.date_envoi,d.date_echeance,d.commentaire_suivi,
             p.nom,p.telephone,p.whatsapp_id,p.service,p.besoin
      FROM devis d JOIN prospects p ON p.id=d.prospect_id WHERE d.id=? LIMIT 1
    `,[id]);

    res.json({success:true,devis:{...d,total:Number(d.total)}});
  }catch(error){
    console.error('❌ DEVIS UPDATE V1.9 :',error.message);
    res.status(500).json({success:false,message:error.message});
  }
});


async function lirePayloadDevis(req,res){
  const prospectId=Number(req.body?.prospect_id);
  if(!prospectId) throw new Error('Prospect obligatoire.');
  const [prospectRows]=await pool.query(`SELECT id,nom,telephone,whatsapp_id,entreprise,ville,service,besoin FROM prospects WHERE id=? LIMIT 1`,[prospectId]);
  if(!prospectRows.length) throw new Error('Prospect introuvable.');
  const prospect=prospectRows[0];
  const lignes=normaliserLignesDevis(req.body?.lignes);
  if(!lignes.length) throw new Error('Ajoutez au moins une ligne au devis.');
  const total=calculerTotalDevis(lignes);
  return {
    prospect,lignes,total,
    date_devis:String(req.body?.date_devis||dateDevisDefaut()).slice(0,10),
    objet:String(req.body?.objet||'').trim(),
    notes:String(req.body?.notes||'').trim(),
    numero_devis:String(req.body?.numero_devis||'').trim(),
    statut_suivi:String(req.body?.statut_suivi||'Brouillon'),
    date_envoi:req.body?.date_envoi?String(req.body.date_envoi).slice(0,10):null,
    date_echeance:req.body?.date_echeance?String(req.body.date_echeance).slice(0,10):null
  };
}

app.post('/crm/devis/export/excel', async (req,res)=>{
  try{
    if(!dbReady||!pool) return res.status(503).json({success:false,message:'Base MySQL non disponible.'});
    const d=await lirePayloadDevis(req,res);
    const rows=[
      ['VISIONPROTECTION & INFORMATIQUE'],
      ['Efficacité et professionnalisme'],
      [],
      ['DEVIS',d.numero_devis||'À attribuer', 'Date', d.date_devis],
      ['Prospect',d.prospect.nom||'', 'Téléphone',d.prospect.telephone||d.prospect.whatsapp_id||''],
      ['Entreprise',d.prospect.entreprise||'', 'Ville',d.prospect.ville||''],
      ['Service',d.prospect.service||'', 'Besoin',d.prospect.besoin||''],
      [],
      ['Désignation','Quantité','Prix unitaire (FCFA)','Prix total (FCFA)']
    ];
    d.lignes.forEach(l=>rows.push([l.designation,l.quantite,l.prix_unitaire,l.prix_total]));
    rows.push([]);
    rows.push(['','','TOTAL GÉNÉRAL (FCFA)',d.total]);
    if(d.objet) rows.push(['Objet',d.objet]);
    if(d.notes) rows.push(['Notes',d.notes]);
    const filenameBase=`${d.numero_devis||'DEVIS'}-${String(d.prospect.nom||'prospect').replace(/[^a-z0-9_-]/gi,'_')}`;

    // Export XLSX principal. On vérifie explicitement la présence de XLSX afin
    // d'éviter un téléchargement vide ou une réponse JSON à la place du fichier.
    if (typeof XLSX !== 'undefined') {
      const ws=XLSX.utils.aoa_to_sheet(rows);
      ws['!cols']=[{wch:42},{wch:14},{wch:22},{wch:22}];
      const wb=XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb,ws,'Devis');
      const buffer=XLSX.write(wb,{type:'buffer',bookType:'xlsx',compression:true});

      if (!buffer || !buffer.length) {
        throw new Error('Le fichier Excel généré est vide.');
      }

      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',`attachment; filename="${filenameBase}.xlsx"`);
      res.setHeader('Content-Length',String(buffer.length));
      return res.end(buffer);
    }

    // Secours Excel compatible : CSV UTF-8 avec BOM, lisible directement dans Excel.
    const csvRows=rows.map(row=>row.map(v=>{
      const value=String(v ?? '');
      return /[\";,\n]/.test(value) ? '"'+value.replace(/"/g,'""')+'"' : value;
    }).join(';'));
    const csv='\uFEFF'+csvRows.join('\r\n');
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="${filenameBase}.csv"`);
    return res.end(csv,'utf8');
  }catch(error){
    console.error('❌ DEVIS EXCEL :',error.stack||error.message);
    res.status(500).json({success:false,message:'Export Excel impossible : '+error.message});
  }
});

app.post('/crm/devis/export/pdf', async (req,res)=>{
  try{
    if(!dbReady||!pool) return res.status(503).json({success:false,message:'Base MySQL non disponible.'});
    const d=await lirePayloadDevis(req,res);
    const doc=new PDFDocument({size:'A4',margin:45});
    const filename=`${d.numero_devis||'DEVIS'}-${String(d.prospect.nom||'prospect').replace(/[^a-z0-9_-]/gi,'_')}.pdf`;
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
    doc.pipe(res);
    doc.fontSize(18).font('Helvetica-Bold').text('VISIONPROTECTION & INFORMATIQUE');
    doc.fontSize(10).font('Helvetica').text('Efficacité et professionnalisme');
    doc.moveDown(0.8);
    doc.fontSize(16).font('Helvetica-Bold').text('DEVIS');
    doc.fontSize(10).font('Helvetica').text(`N° : ${d.numero_devis||'À attribuer'}    Date : ${d.date_devis}`);
    doc.moveDown(0.7);
    doc.font('Helvetica-Bold').text('Informations prospect');
    doc.font('Helvetica').text(`Nom : ${d.prospect.nom||'—'}`);
    doc.text(`Téléphone : ${d.prospect.telephone||d.prospect.whatsapp_id||'—'}`);
    doc.text(`Entreprise : ${d.prospect.entreprise||'—'}`);
    doc.text(`Ville : ${d.prospect.ville||'—'}`);
    doc.text(`Service : ${d.prospect.service||'—'}`);
    doc.text(`Besoin : ${d.prospect.besoin||'—'}`);
    if(d.objet) doc.text(`Objet : ${d.objet}`);
    doc.moveDown(0.8);
    const x=[45,285,355,455], widths=[240,70,100,100];
    let y=doc.y;
    doc.font('Helvetica-Bold').fontSize(9);
    ['Désignation','Quantité','Prix unitaire','Prix total'].forEach((h,i)=>doc.text(h,x[i],y,{width:widths[i]}));
    y+=18; doc.font('Helvetica').fontSize(9);
    d.lignes.forEach(l=>{
      if(y>735){doc.addPage();y=45;}
      doc.text(l.designation,x[0],y,{width:widths[0]});
      doc.text(String(l.quantite),x[1],y,{width:widths[1],align:'right'});
      doc.text(`${l.prix_unitaire.toLocaleString('fr-FR')} FCFA`,x[2],y,{width:widths[2],align:'right'});
      doc.text(`${l.prix_total.toLocaleString('fr-FR')} FCFA`,x[3],y,{width:widths[3],align:'right'});
      y+=18;
    });
    doc.moveTo(45,y+3).lineTo(555,y+3).stroke(); y+=15;
    doc.font('Helvetica-Bold').fontSize(11).text(`TOTAL GÉNÉRAL : ${d.total.toLocaleString('fr-FR')} FCFA`,330,y,{width:225,align:'right'});
    y+=30;
    if(d.notes){doc.font('Helvetica-Bold').fontSize(10).text('Notes');doc.font('Helvetica').fontSize(9).text(d.notes,{width:510});}
    doc.moveDown(2); doc.fontSize(9).text('Document généré par VisionProtection & Informatique.');
    doc.end();
  }catch(error){console.error('❌ DEVIS PDF :',error.message);if(!res.headersSent)res.status(500).json({success:false,message:error.message});}
});

// ================== FIN DEVIS V1.8 ==================

async function start(){await initDatabase();app.listen(PORT,"0.0.0.0",()=>console.log(`VisionProtection WhatsApp CRM v2.5.4 V2.1.1 - port ${PORT} - DB ${dbReady?"MYSQL":"MEMORY"}`));}
start().catch(e=>{console.error("❌ ERREUR DÉMARRAGE :",e.message);process.exit(1);});