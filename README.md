# VisionProtection WhatsApp CRM v2.5.2 + MySQL/Aiven

Conserve le parcours WhatsApp v2.5.2 et ajoute la persistance Aiven MySQL.

Render : `npm install` puis `npm start`.
Variables : META_VERIFY_TOKEN, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, Host, Port, User, Password, Database.

Tables créées automatiquement : `prospects`, `conversation_messages`.

Vérification : `/` ; `/crm/prospects` ; `/crm/stats`. Deux routes de diagnostic MySQL sont aussi disponibles : `/crm/mysql-prospects` et `/crm/mysql-stats`.

Ne jamais publier les secrets Meta ou Aiven dans GitHub.
