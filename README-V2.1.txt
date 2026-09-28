VisionProtection V2.1.1 — Moteur de Prospection Web Multi-Sources

OBJECTIF
Collecter des candidats depuis plusieurs sources publiques sans dépendre de Gemini, puis utiliser Gemini uniquement pour qualifier les candidats lorsque le quota est disponible.

NOUVEAUTÉS
- Collecte directe multi-sources via HTTP depuis le serveur Render.
- Sources initiales : DGMP, plans de passation DGMP 2026, Ministère de la Construction, Pages Jaunes promoteurs, Go Africa promoteurs, S3I, UNGM.
- Déduplication par URL.
- Score de pertinence déterministe.
- Stockage des candidats dans prospection_web_collectes.
- Qualification Gemini séparée, limitée à 10 candidats par appel.
- Si Gemini est en quota, la collecte Web continue sans IA.
- Les opportunités qualifiées restent dans opportunites_web et peuvent être ajoutées au CRM avec validation humaine.
- Aucun message WhatsApp automatique.

INSTALLATION RENDER
1. Remplacer index.js.
2. Remplacer public/assistant.html par celui fourni.
3. Vérifier package.json puis Commit/Push.
4. Attendre le redéploiement Render.
5. Ouvrir /assistant puis Ctrl+F5.
6. Dans « Moteur de Prospection Web Multi-Sources — V2.1.1 », cliquer d'abord « Collecter sans Gemini ».
7. Vérifier les candidats et ouvrir les sources.
8. Quand Gemini est disponible, cliquer « Qualifier avec Gemini ».

BASE DE DONNÉES
La table prospection_web_collectes est créée automatiquement. Aucune table existante n'est supprimée.

IMPORTANT
La collecte directe dépend de l'accessibilité des pages publiques au serveur Render et du format HTML des sites. Certaines sources peuvent évoluer ou bloquer les requêtes. Les erreurs par source sont retournées sans bloquer les autres sources.

ARCHITECTURE
Sources publiques -> collecte directe -> dédoublonnage -> candidats -> qualification Gemini facultative -> opportunites_web -> validation humaine -> CRM.


V2.1.1 — Optimisation : les sources sont interrogées en parallèle (4 à la fois), avec timeout 6,5 s par source, limite de contenu 2 Mo et analyse limitée aux liens pertinents. Les résultats sont dédupliqués avant enregistrement. Gemini reste facultatif.
