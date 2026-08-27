CREATE DATABASE IF NOT EXISTS visionprotection_crm;

USE visionprotection_crm;

CREATE TABLE IF NOT EXISTS prospects (
    id INT AUTO_INCREMENT PRIMARY KEY,
    whatsapp_id VARCHAR(30) NOT NULL UNIQUE,
    nom VARCHAR(150),
    telephone VARCHAR(30),
    entreprise VARCHAR(150),
    ville VARCHAR(100),
    service VARCHAR(150),
    besoin TEXT,
    statut VARCHAR(50) DEFAULT 'Nouveau',
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    prospect_id INT,
    whatsapp_message_id VARCHAR(255),
    direction ENUM('entrant','sortant') NOT NULL,
    message TEXT,
    message_type VARCHAR(50) DEFAULT 'text',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_messages_prospect
        FOREIGN KEY (prospect_id)
        REFERENCES prospects(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS demandes_devis (
    id INT AUTO_INCREMENT PRIMARY KEY,
    prospect_id INT NOT NULL,
    service VARCHAR(150),
    description TEXT,
    quantite VARCHAR(100),
    localisation VARCHAR(200),
    budget VARCHAR(100),
    statut VARCHAR(50) DEFAULT 'À traiter',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_devis_prospect
        FOREIGN KEY (prospect_id)
        REFERENCES prospects(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notes_commerciales (
    id INT AUTO_INCREMENT PRIMARY KEY,
    prospect_id INT NOT NULL,
    note TEXT NOT NULL,
    auteur VARCHAR(100) DEFAULT 'Commercial',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_notes_prospect
        FOREIGN KEY (prospect_id)
        REFERENCES prospects(id)
        ON DELETE CASCADE
);

CREATE INDEX idx_prospects_statut
    ON prospects(statut);

CREATE INDEX idx_prospects_service
    ON prospects(service);

CREATE INDEX idx_messages_prospect
    ON messages(prospect_id);

CREATE INDEX idx_devis_prospect
    ON demandes_devis(prospect_id);
