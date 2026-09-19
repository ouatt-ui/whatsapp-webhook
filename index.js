const express=require("express");
const axios=require("axios");
const mysql=require("mysql2/promise");
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
   id INT AUTO_INCREMENT PRIMARY KEY, whatsapp_id VARCHAR(30) NOT NULL UNIQUE, nom VARCHAR(150),
   telephone VARCHAR(30), entreprise VARCHAR(150), ville VARCHAR(100), service VARCHAR(150),
   besoin TEXT, statut VARCHAR(50) DEFAULT 'Nouveau', notes TEXT,
   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
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
  await pool.query(`INSERT INTO prospects(whatsapp_id,nom,telephone,ville,service,besoin,statut)
   VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE nom=VALUES(nom),telephone=VALUES(telephone),
   ville=VALUES(ville),service=VALUES(service),besoin=VALUES(besoin),statut=VALUES(statut),updated_at=CURRENT_TIMESTAMP`,
   [s.phone,s.name||null,s.phone,s.location||null,s.service||null,s.project||null,s.state==="DONE"?"Terminé":"Nouveau"]);
  return await getProspectId(s.phone);
 }catch(e){console.error("❌ MYSQL : erreur upsertProspect :",e.message);return null;}
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
  return {phone:x.whatsapp_id,name:x.nom||"",state:x.statut==="Terminé"?"DONE":"MENU",service:x.service||null,siteType:null,
   location:x.ville||null,project:x.besoin||null,quantity:null,delay:null,
   history:m.map(v=>({direction:v.direction,text:v.message,type:v.message_type,at:v.created_at})),
   createdAt:x.created_at,updatedAt:x.updated_at};
 }catch(e){console.error("❌ MYSQL : erreur loadProspect :",e.message);return null;}
}
const SERVICES={"1":"Vidéosurveillance","2":"Contrôle d'accès","3":"Alarme intrusion","4":"SSI / CMSI","5":"Motorisation de portail","6":"Domotique","7":"Réseau informatique","8":"Demande de devis","9":"Conseiller"};
function normalizeForApi(phone){let n=String(phone).replace(/[^\d]/g,"");if(n==="22557948536")return"2250757948536";return n;}
function isConversationStart(text){const n=String(text||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();return n==="menu"||n==="start"||n==="0"||/^(bonjour|bjr|bonsoir|slt|salut)\b/.test(n);}
async function getSession(phone,name=""){
 if(sessions.has(phone)){const s=sessions.get(phone);if(name&&!s.name)s.name=name;return s;}
 const stored=await loadProspect(phone);if(stored){if(name&&!stored.name)stored.name=name;sessions.set(phone,stored);return stored;}
 const s={phone,name:name||"",state:"MENU",service:null,siteType:null,location:null,project:null,quantity:null,delay:null,history:[],createdAt:new Date(),updatedAt:new Date()};
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
app.get("/crm/prospect/:phone",async(req,res)=>{try{const p=dbReady?await loadProspect(req.params.phone):sessions.get(req.params.phone);if(!p)return res.status(404).json({success:false,message:"Prospect introuvable"});res.json({success:true,prospect:p,database:dbReady?"mysql":"memory-fallback"});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.get("/crm/messages/:phone",async(req,res)=>{try{if(!dbReady)return res.json({success:true,database:"memory-fallback",messages:[]});const id=await getProspectId(req.params.phone);if(!id)return res.status(404).json({success:false,message:"Prospect introuvable"});const[r]=await pool.query("SELECT * FROM messages WHERE prospect_id=? ORDER BY id ASC",[id]);res.json({success:true,count:r.length,messages:r,database:"mysql"});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.get("/crm/notes/:phone",async(req,res)=>{try{if(!dbReady)return res.json({success:true,database:"memory-fallback",notes:[]});const id=await getProspectId(req.params.phone);if(!id)return res.status(404).json({success:false,message:"Prospect introuvable"});const[r]=await pool.query("SELECT * FROM notes_commerciales WHERE prospect_id=? ORDER BY id DESC",[id]);res.json({success:true,count:r.length,notes:r,database:"mysql"});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.post("/crm/notes/:phone",async(req,res)=>{try{if(!dbReady)return res.status(503).json({success:false,message:"Base MySQL non disponible."});const id=await getProspectId(req.params.phone);if(!id)return res.status(404).json({success:false,message:"Prospect introuvable"});const note=String(req.body?.note||"").trim(),auteur=String(req.body?.auteur||"Commercial").trim()||"Commercial";if(!note)return res.status(400).json({success:false,message:"La note est vide."});const[r]=await pool.query("INSERT INTO notes_commerciales(prospect_id,note,auteur) VALUES(?,?,?)",[id,note,auteur]);res.json({success:true,id:r.insertId});}catch(e){res.status(500).json({success:false,message:e.message});}});
app.get("/crm/stats",async(req,res)=>{try{if(dbReady){const[[t]]=await pool.query("SELECT COUNT(*) total, SUM(statut='Terminé') done FROM prospects");const[r]=await pool.query("SELECT COALESCE(service,'Non défini') service,COUNT(*) total FROM prospects GROUP BY service ORDER BY total DESC");const byService={};for(const x of r)byService[x.service]=Number(x.total);return res.json({success:true,totalProspects:Number(t.total||0),activeConversations:Number(t.total||0)-Number(t.done||0),completedConversations:Number(t.done||0),byService,database:"mysql"});}const p=[...sessions.values()];res.json({success:true,totalProspects:p.length,activeConversations:p.filter(x=>x.state!=="DONE").length,completedConversations:p.filter(x=>x.state==="DONE").length,database:"memory-fallback"});}catch(e){res.status(500).json({success:false,message:e.message});}});app.get("/crm", (req, res) => {
  res.sendFile(__dirname + "/public/crm.html");
});

app.get("/assistant", (req, res) => {
  res.sendFile(__dirname + "/public/assistant.html");
});
  


app.get("/",(req,res)=>res.json({success:true,application:"VisionProtection WhatsApp CRM",version:"2.5.3",database:dbReady?"mysql-connected":"memory-fallback",graphApi:GRAPH_VERSION,webhook:"/webhook",crm:"/crm/prospects",messages:"/crm/messages/:phone",notes:"/crm/notes/:phone",stats:"/crm/stats",status:"online"}));
async function start(){await initDatabase();app.listen(PORT,"0.0.0.0",()=>console.log(`VisionProtection WhatsApp CRM v2.5.3 - port ${PORT} - DB ${dbReady?"MYSQL":"MEMORY"}`));}
start().catch(e=>{console.error("❌ ERREUR DÉMARRAGE :",e.message);process.exit(1);});
