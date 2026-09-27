const express=require("express");
const axios=require("axios");
const mysql=require("mysql2/promise");
const {GoogleGenAI}=require("@google/genai");
// ================== APPEL GEMINI ROBUSTE V1.3 ==================

let geminiHealth = {
  available: null,
  lastCheck: null,
  reason: null,
  model: "gemini-3.8-flash"
};

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

async function callGemini(prompt, options = {}) {
  const max503Retries = Number.isInteger(options.max503Retries) ? options.max503Retries : 1;

  if (!gemini) {
    geminiHealth = {
      ...geminiHealth,
      available: false,
      lastCheck: new Date().toISOString(),
      reason: "CLIENT_NON_INITIALISE"
    };
    throw new Error("Client Gemini non initialisé.");
  }

  for (let attempt = 0; attempt <= max503Retries; attempt++) {
    try {
      console.log(`🤖 Appel Gemini V1.3 (tentative ${attempt + 1}/${max503Retries + 1})...`);

      const response = await gemini.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt
      });

      geminiHealth = {
        ...geminiHealth,
        available: true,
        lastCheck: new Date().toISOString(),
        reason: null
      };

      console.log("✅ Gemini a répondu.");

      return {
        text: response.text || "",
        model: "gemini-3.8-flash",
        ai_available: true,
        fallback: false
      };

    } catch (error) {
      const type = classifyGeminiError(error);
      const message = error?.message || String(error);

      console.error("❌ ERREUR GEMINI :", message);

      geminiHealth = {
        ...geminiHealth,
        available: false,
        lastCheck: new Date().toISOString(),
        reason: type
      };

      if (type === "QUOTA") {
        throw new Error(
          "QUOTA GEMINI ATTEINT. Le Robot IA repassera automatiquement en mode secours jusqu'à la réinitialisation du quota."
        );
      }

      if (type === "UNAVAILABLE" && attempt < max503Retries) {
        console.log("⏳ Gemini temporairement indisponible. Nouvelle tentative dans 3 secondes...");
        await sleep(3000);
        continue;
      }

      if (type === "UNAVAILABLE") {
        throw new Error(
          "GEMINI TEMPORAIREMENT INDISPONIBLE. Le Robot IA passe en mode secours CRM."
        );
      }

      throw error;
    }
  }
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
  dbReady=true; console.log("✅ MYSQL : connexion Aiven opérationnelle.");
  console.log("✅ MYSQL : tables prospects, messages et notes_commerciales vérifiées.");
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

// ================== ASSISTANT D'ACTION COMMERCIALE V1.7 ==================

function genererRecommandationFallbackV17(prospect, historique = [], notes = []) {
  const last = historique.length ? historique[historique.length - 1] : null;
  const lastIsIn = last && String(last.direction || '').toLowerCase() === 'in';
  let action = 'Préparer une relance courte et personnalisée.';
  let moment = 'Prochaine plage commerciale disponible.';
  let questions = 'Confirmer que le projet est toujours d’actualité et demander la prochaine étape souhaitée.';

  if (lastIsIn) {
    action = 'Répondre d’abord au dernier message du prospect et traiter précisément sa demande.';
    moment = 'Dès que possible, puisque le dernier échange vient du prospect.';
    questions = 'Répondre à la demande formulée dans le dernier message et demander uniquement l’information manquante.';
  } else if (prospect.statut === 'Qualifié') {
    action = 'Faire avancer le prospect qualifié vers une prochaine étape concrète : visite technique, collecte des éléments du devis ou rendez-vous.';
    moment = 'Dans les 24 à 48 heures si aucune action récente n’est enregistrée.';
    questions = 'Quel est le site du projet, la quantité approximative et le délai souhaité ?';
  } else if (prospect.statut === 'Devis') {
    action = 'Vérifier la réception du devis et identifier le point qui bloque la décision.';
    moment = 'Relance commerciale courte, sans pression.';
    questions = 'Le devis a-t-il bien été reçu et y a-t-il un point à clarifier ?';
  } else if (prospect.statut === 'Nouveau') {
    action = 'Qualifier le besoin avec quelques questions simples avant de proposer une solution.';
    moment = 'Après le premier échange ou dès qu’une réponse est attendue.';
    questions = 'Type de site, localisation, besoin exact, quantité et délai du projet.';
  }

  const service = prospect.service || 'votre projet';
  const nom = prospect.nom && prospect.nom !== 'Sans nom' ? prospect.nom : '';
  const message = `Bonjour${nom ? ' ' + nom : ''},\n\nNous revenons vers vous concernant ${service}. Nous souhaitons savoir si votre projet est toujours d’actualité et si vous avez un point particulier à préciser pour la suite.\n\nCordialement,\nVisionProtection & Informatique\nEfficacité et professionnalisme`;
  const note = `V1.7 — Prochaine action : ${action} Statut actuel : ${prospect.statut || 'Non défini'}. Historique analysé : ${historique.length} échange(s), ${notes.length} note(s).`;

  return { action, moment, questions, note_suggeree: note, message_suggere: message };
}

app.post('/robot/recommandation-action', async (req, res) => {
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
    prospect.derniere_activite = prospect.updated_at || prospect.created_at;

    const [messages] = await pool.query(
      `SELECT direction, message, message_type, created_at FROM messages
       WHERE prospect_id=? ORDER BY created_at DESC LIMIT 30`,
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
        nom: prospect.nom || 'Sans nom', telephone: prospect.telephone,
        ville: prospect.ville || 'Non définie', service: prospect.service || 'Non défini',
        besoin: prospect.besoin || '', statut: prospect.statut || 'Non défini',
        etat_conversation: prospect.etat_conversation, derniere_activite: prospect.derniere_activite
      },
      historique,
      notes: notesCommerciales
    };

    const prompt = `
Tu es l'assistant commercial de VisionProtection & Informatique à Abidjan.
Analyse uniquement les données CRM réelles ci-dessous et recommande la prochaine action humaine.
Ne réalise aucune action et n'envoie aucun message.

DONNEES CRM :
${JSON.stringify(donnees, null, 2)}

Retourne UNIQUEMENT un JSON valide avec exactement ces champs :
{
  "action": "action concrète à faire maintenant",
  "moment": "moment ou fenêtre de contact conseillée, sans inventer de rendez-vous",
  "questions": "informations à demander au prospect",
  "note_suggeree": "note commerciale courte à enregistrer après validation humaine",
  "message_suggere": "message WhatsApp court et professionnel, à valider avant envoi"
}

Règles :
- N'invente aucun fait, prix, délai, disponibilité ou rendez-vous.
- Utilise le statut, le dernier échange et les notes réellement présents.
- Si le dernier message vient du prospect, recommande d'abord une réponse à sa demande.
- Ne change pas le statut du prospect.
- Ne prétends jamais avoir contacté le prospect.
- Le message doit être directement modifiable par le commercial.
`;

    let resultData;
    let model = 'CRM-FALLBACK';
    let fallback = false;
    let fallbackReason = null;

    try {
      const result = await callGemini(prompt, { max503Retries: 1 });
      let raw = String(result.text || '').trim();
      raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
      resultData = JSON.parse(raw);
      model = result.model || 'gemini-3.8-flash';
    } catch (aiError) {
      fallback = true;
      fallbackReason = aiError.message;
      resultData = genererRecommandationFallbackV17(prospect, historique, notesCommerciales);
    }

    const required = ['action','moment','questions','note_suggeree','message_suggere'];
    for (const key of required) {
      if (!resultData[key]) resultData[key] = genererRecommandationFallbackV17(prospect, historique, notesCommerciales)[key];
    }

    res.json({
      success:true,
      prospect:{ id:prospect.id, nom:prospect.nom, telephone:prospect.telephone, service:prospect.service, besoin:prospect.besoin, statut:prospect.statut },
      ...resultData,
      model,
      ai_available:!fallback,
      fallback,
      fallback_reason:fallbackReason,
      history_count:historique.length,
      notes_count:notesCommerciales.length,
      generated_at:new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ ERREUR ASSISTANT ACTION V1.7 :', error.response?.data || error.message);
    res.status(500).json({ success:false, message:error.message });
  }
});

// ================== FIN ASSISTANT D'ACTION COMMERCIALE V1.7 ==================


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
    `);

    const [[activite7j]] = await pool.query(`
      SELECT
        COUNT(*) AS nouveaux_prospects,
        SUM(statut='Devis') AS nouveaux_devis,
        SUM(statut='Client') AS nouveaux_clients
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
      GROUP BY service
      ORDER BY total DESC
      LIMIT 10
    `);

    const [services7j] = await pool.query(`
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
      GROUP BY ville
      ORDER BY total DESC
      LIMIT 10
    `);

    const [villes7j] = await pool.query(`
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

      activite_7j: {
        nouveaux_prospects: Number(activite7j.nouveaux_prospects || 0),
        nouveaux_devis: Number(activite7j.nouveaux_devis || 0),
        nouveaux_clients: Number(activite7j.nouveaux_clients || 0)
      },

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

      services_7j: services7j.map(x => ({
        service: x.service,
        total: Number(x.total)
      })),

      villes: villes.map(x => ({
        ville: x.ville,
        total: Number(x.total)
      })),

      villes_7j: villes7j.map(x => ({
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
Distingue clairement la situation globale du CRM et l'activité des 7 derniers jours. Ne dis jamais que le pipeline est vide simplement parce qu'aucun prospect n'a été créé dans les 7 derniers jours.

2. 🔐 SERVICES DEMANDÉS
Distingue les services présents dans le CRM des nouveaux services des 7 derniers jours.

3. 📍 ZONES INTÉRESSANTES
Distingue les zones présentes dans le CRM des nouvelles zones des 7 derniers jours.

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
app.get("/",(req,res)=>res.json({success:true,application:"VisionProtection WhatsApp CRM",version:"2.5.4-v1.7",database:dbReady?"mysql-connected":"memory-fallback",graphApi:GRAPH_VERSION,webhook:"/webhook",crm:"/crm/prospects",messages:"/crm/messages/:phone",notes:"/crm/notes/:phone",stats:"/crm/stats",status:"online"}));
async function start(){await initDatabase();app.listen(PORT,"0.0.0.0",()=>console.log(`VisionProtection WhatsApp CRM v2.5.4 V1.7 - port ${PORT} - DB ${dbReady?"MYSQL":"MEMORY"}`));}
start().catch(e=>{console.error("❌ ERREUR DÉMARRAGE :",e.message);process.exit(1);});
