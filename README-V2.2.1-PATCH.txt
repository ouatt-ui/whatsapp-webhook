VisionProspect V2.2.1 — Robustesse Gemini + filtrage commercial

Base : index.js V2.2 production validé.

Objectifs du patch :
- conserver intégralement le moteur de collecte V2.2 Côte d’Ivoire ;
- ajouter une gestion robuste des erreurs Gemini 503/UNAVAILABLE ;
- effectuer 1 retry après 3 secondes sur le modèle principal ;
- basculer ensuite vers un modèle Gemini de secours configurable ;
- modèle principal : GEMINI_MODEL, par défaut gemini-3.8-flash ;
- modèle de secours : GEMINI_FALLBACK_MODEL, par défaut gemini-2.5-flash ;
- utiliser le même mécanisme robuste pour les autres appels Gemini déjà basés sur callGemini ;
- la qualification Web V2.2 utilise désormais callGemini au lieu d’un appel direct ;
- retourner HTTP 503 avec code GEMINI_UNAVAILABLE si les modèles restent indisponibles ;
- ne jamais supprimer les candidats collectés lorsqu’une qualification Gemini échoue ;
- ajouter un filtrage commercial léger avant Gemini et avant sauvegarde de la collecte afin d’écarter les contenus manifestement éditoriaux ;
- conserver les opportunités qui présentent des signaux commerciaux tels que projet, construction, promoteur, prestataire, fournisseur, appel d’offres, etc. ;
- version des endpoints V2.2 mise à jour en 2.2.1.

Important :
- aucune modification du schéma MySQL ;
- aucune suppression automatique des prospects CRM ;
- aucune suppression automatique des candidats existants ;
- le nettoyage des sources retirées reste une action explicite ;
- le patch ne modifie pas assistant.html ni package.json ;
- le fallback Gemini dépend de la disponibilité du modèle configuré dans le compte/API. Les valeurs peuvent être changées dans Render > Environment sans modifier le code.

Variables Render optionnelles :
GEMINI_MODEL=gemini-3.8-flash
GEMINI_FALLBACK_MODEL=gemini-2.5-flash

Validation locale : node --check OK.
