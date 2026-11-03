CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  url        VARCHAR(2048) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

-- PK starts with event_type so "who subscribes to X?" is an index lookup
CREATE TABLE IF NOT EXISTS endpoint_subscriptions (
  event_type  VARCHAR(64) NOT NULL,
  endpoint_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (event_type, endpoint_id),
  CONSTRAINT fk_sub_endpoint FOREIGN KEY (endpoint_id)
    REFERENCES webhook_endpoints(id) ON DELETE CASCADE
);

-- UNIQUE(event_id) is what actually blocks concurrent duplicates
CREATE TABLE IF NOT EXISTS events (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  event_id   VARCHAR(255) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload    JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_events_event_id (event_id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  event_id         BIGINT UNSIGNED NOT NULL,
  endpoint_id      BIGINT UNSIGNED NOT NULL,
  status           ENUM('pending', 'succeeded', 'failed') NOT NULL DEFAULT 'pending',
  attempts         INT UNSIGNED NOT NULL DEFAULT 0,
  last_status_code INT NULL,
  last_error       VARCHAR(1024) NULL,
  created_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_attempt_at  TIMESTAMP(3) NULL,
  completed_at     TIMESTAMP(3) NULL,
  UNIQUE KEY uq_delivery (event_id, endpoint_id),
  CONSTRAINT fk_del_event FOREIGN KEY (event_id) REFERENCES events(id),
  CONSTRAINT fk_del_endpoint FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id)
);
