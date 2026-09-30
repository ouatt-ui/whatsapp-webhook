VisionProspect V2.2.3 — Patch qualification Gemini
Base : V2.2.2 Gemini asynchrone.

Correction ciblée :
- conserve Gemini 3.5 Flash / fallback 3.5 Flash Lite via les variables Render ;
- accepte une réponse Gemini JSON sous forme de tableau OU encapsulée dans qualifications, qualified, opportunites, results ou candidats ;
- accepte les valeurs qualifie true/1/oui/yes/qualifié(e)/opportunité ;
- ajoute un log serveur indiquant le format et le nombre d'éléments reçus ;
- évite le cas V2.2.2 où un objet JSON valide était silencieusement transformé en tableau vide ;
- aucune modification de package.json ou assistant.html ;
- aucune suppression automatique des candidats ;
- aucun changement aux sources Côte d’Ivoire / nettoyage V2.2.

Validation : node --check index.js OK.
