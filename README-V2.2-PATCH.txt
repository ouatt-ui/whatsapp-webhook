VisionProspect V2.2 — Patch ciblé du moteur de prospection

Base : index.js V2.1.1 existant.

Le patch :
- impose Côte d’Ivoire uniquement côté serveur ;
- conserve Go Africa Online, S3I et UNGM ;
- retire DGMP, DGMP PPM 2026, Ministère de la Construction et Pages Jaunes ;
- filtre les candidats avant retour/enregistrement ;
- filtre les candidats chargés depuis la base ;
- limite la qualification Gemini aux candidats autorisés ;
- ajoute suppression individuelle des collectes ;
- ajoute nettoyage explicite des anciennes sources ;
- ajoute suppression individuelle des opportunités Web.

Aucune suppression automatique des anciennes données au démarrage.
package.json et assistant.html ne sont pas modifiés par ce patch.
Validation Node.js : OK.
