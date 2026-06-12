-- Pipeline de Ventas - Schema MySQL
CREATE DATABASE IF NOT EXISTS pipeline_ventas CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE pipeline_ventas;

CREATE TABLE IF NOT EXISTS leads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(255) NOT NULL,
  empresa VARCHAR(255),
  rubro VARCHAR(255),
  telefono VARCHAR(50),
  email VARCHAR(255),
  ciudad VARCHAR(100),
  direccion TEXT,
  website VARCHAR(255),
  rating DECIMAL(3,1),
  total_reviews INT DEFAULT 0,
  fuente VARCHAR(100) DEFAULT 'google_maps',
  cliente VARCHAR(100) DEFAULT 'Conecta CSur',
  estado ENUM('nuevo','contactado','interesado','propuesta','cerrado','descartado') DEFAULT 'nuevo',
  notas TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contactos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id INT NOT NULL,
  tipo ENUM('email','llamada','whatsapp','reunion','otro') NOT NULL,
  fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  asunto VARCHAR(255),
  contenido TEXT,
  resultado VARCHAR(255),
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS emails_enviados (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id INT NOT NULL,
  email_destino VARCHAR(255) NOT NULL,
  asunto VARCHAR(255) NOT NULL,
  contenido TEXT,
  estado ENUM('enviado','entregado','abierto','rebotado','error') DEFAULT 'enviado',
  resend_id VARCHAR(255),
  enviado_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
);

CREATE INDEX idx_leads_estado ON leads(estado);
CREATE INDEX idx_leads_email ON leads(email);
CREATE INDEX idx_leads_ciudad ON leads(ciudad);
CREATE INDEX idx_leads_cliente ON leads(cliente);
CREATE INDEX idx_contactos_lead ON contactos(lead_id);
CREATE INDEX idx_emails_lead ON emails_enviados(lead_id);

-- Migraciones (ejecutar en DB existente)
-- ALTER TABLE leads ADD COLUMN cliente VARCHAR(100) DEFAULT 'Conecta CSur' AFTER fuente;
-- ALTER TABLE leads ADD INDEX idx_cliente (cliente);
