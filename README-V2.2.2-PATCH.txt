VisionProspect V2.2.2 — Qualification IA asynchrone
Base : index.js V2.2.1 validé en production.

Objectifs :
- conserver intégralement la collecte Web V2.2 (Côte d’Ivoire, sources autorisées, filtres commerciaux);
- ne plus bloquer la requête HTTP pendant les appels Gemini;
- lancer la qualification IA en arrière-plan avec un job_id;
- conserver les candidats en base même si Gemini renvoie 503, quota ou autre indisponibilité temporaire;
- ajouter GET /robot/prospection-qualifier/:jobId pour consulter l'état d'un job;
- conserver les retries Gemini et le modèle de secours;
- changer le fallback par défaut vers gemini-3.7-flash;
- versionner les réponses du moteur en 2.2.2.

Nouveaux comportements :
POST /robot/prospection-qualifier -> HTTP 202 immédiatement avec job_id.
GET /robot/prospection-qualifier/:jobId -> état EN_ATTENTE, EN_COURS, TERMINEE, EN_ATTENTE ou ERREUR.

Aucun schéma MySQL supplémentaire n'est requis pour ce patch.
Les opportunités qualifiées continuent d'être enregistrées dans opportunites_web.
Les candidats collectés ne sont jamais supprimés par un échec Gemini.

Variables recommandées :
GEMINI_MODEL=gemini-3.8-flash
GEMINI_FALLBACK_MODEL=gemini-3.7-flash

Validation : node --check OK.
package.json et assistant.html ne sont pas modifiés.
