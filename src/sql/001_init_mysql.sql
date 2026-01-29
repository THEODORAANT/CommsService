CREATE DATABASE IF NOT EXISTS comms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE comms;

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

INSERT INTO tenants (tenant_id, name)
VALUES ('gwl-cy', 'GWL Cyprus')
ON DUPLICATE KEY UPDATE name=VALUES(name);

CREATE TABLE IF NOT EXISTS members (
  tenant_id VARCHAR(64) NOT NULL,
  memberID BIGINT NOT NULL,
  email VARCHAR(320) NULL,
  first_name VARCHAR(255) NULL,
  last_name VARCHAR(255) NULL,
  phone VARCHAR(64) NULL,
  pharmacy_patient_ref VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (tenant_id, memberID),
  UNIQUE KEY uq_members_email (tenant_id, email),
  CONSTRAINT fk_members_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (
  tenant_id VARCHAR(64) NOT NULL,
  orderID BIGINT NOT NULL,
  memberID BIGINT NOT NULL,
  pharmacy_order_ref VARCHAR(255) NULL,
  status VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (tenant_id, orderID),
  KEY idx_orders_member (tenant_id, memberID),
  CONSTRAINT fk_orders_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
  CONSTRAINT fk_orders_member FOREIGN KEY (tenant_id, memberID)
    REFERENCES members(tenant_id, memberID) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS notes (
  note_id CHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  scope ENUM('patient','order') NOT NULL,
  memberID BIGINT NOT NULL,
  orderID BIGINT NULL,
  note_type ENUM('admin_note','clinical_note') NOT NULL,
  title VARCHAR(255) NULL,
  body TEXT NOT NULL,
  status ENUM('open','resolved','archived') NOT NULL DEFAULT 'open',
  created_by_role ENUM('admin','pharmacist','patient','system') NOT NULL,
  created_by_user_id VARCHAR(255) NULL,
  created_by_display_name VARCHAR(255) NULL,
  external_note_ref VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_notes_member (tenant_id, memberID, created_at),
  KEY idx_notes_order (tenant_id, orderID, created_at),
  CONSTRAINT fk_notes_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
  CONSTRAINT fk_notes_member FOREIGN KEY (tenant_id, memberID)
    REFERENCES members(tenant_id, memberID) ON DELETE CASCADE,
  CONSTRAINT fk_notes_order FOREIGN KEY (tenant_id, orderID)
    REFERENCES orders(tenant_id, orderID) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS note_replies (
  note_reply_id CHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  note_id CHAR(36) NOT NULL,
  body TEXT NOT NULL,
  created_by_role ENUM('admin','pharmacist','patient','system') NOT NULL,
  created_by_user_id VARCHAR(255) NULL,
  created_by_display_name VARCHAR(255) NULL,
  external_reply_ref VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_replies_note (tenant_id, note_id, created_at),
  CONSTRAINT fk_replies_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
  CONSTRAINT fk_replies_note FOREIGN KEY (note_id) REFERENCES notes(note_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS messages (
  message_id CHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  memberID BIGINT NOT NULL,
  channel ENUM('admin_patient','pharmacist_patient') NOT NULL,
  body TEXT NOT NULL,
  sender_role ENUM('admin','pharmacist','patient','system') NOT NULL,
  sender_user_id VARCHAR(255) NULL,
  sender_display_name VARCHAR(255) NULL,
  external_message_ref VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_messages_member (tenant_id, memberID, created_at),
  CONSTRAINT fk_messages_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
  CONSTRAINT fk_messages_member FOREIGN KEY (tenant_id, memberID)
    REFERENCES members(tenant_id, memberID) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id VARCHAR(64) NOT NULL,
  endpoint VARCHAR(128) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response_body JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (tenant_id, endpoint, idempotency_key),
  CONSTRAINT fk_idem_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  subscription_id CHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  subscriber_system ENUM('perch','pharmacy') NOT NULL,
  url VARCHAR(2048) NOT NULL,
  secret VARCHAR(255) NOT NULL,
  event_types JSON NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_webhook_sub (tenant_id, subscriber_system),
  CONSTRAINT fk_webhook_sub_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
) ENGINE=InnoDB;

-- DB-backed queue for webhook delivery (no Redis)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id CHAR(36) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  subscription_id CHAR(36) NOT NULL,
  event_id CHAR(36) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  status ENUM('pending','sent','failed') NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_until DATETIME(3) NULL,
  last_attempt_at DATETIME(3) NULL,
  last_error TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_sub_event (subscription_id, event_id),
  KEY idx_webhook_due (status, next_attempt_at),
  CONSTRAINT fk_webhook_del_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id),
  CONSTRAINT fk_webhook_del_sub FOREIGN KEY (subscription_id)
    REFERENCES webhook_subscriptions(subscription_id) ON DELETE CASCADE
) ENGINE=InnoDB;
