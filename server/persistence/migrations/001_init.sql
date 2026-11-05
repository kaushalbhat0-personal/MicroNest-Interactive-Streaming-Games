-- T4F-C2.7-D1-C migration 001 — durable authority persistence (Neon Postgres).
--
-- Minimal tables only. No Google tokens in plaintext columns, no encryption
-- keys in the database, no short-lived OAuth values in plaintext beyond the
-- existing SHA-256-hash-only representation.
--
--   world_state           singleton validated world payload (id = 1)
--   authority_credentials encrypted AES-256-GCM envelopes only (JSONB)
--   authority_metadata    allowlisted operational cursors / pending meta (JSONB)
--   oauth_state           hash-only single-use nonces with TTL + atomic consume
--   schema_migrations     version ledger (this file = version 1)

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS world_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  payload JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS authority_credentials (
  id TEXT PRIMARY KEY,
  envelope JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS authority_metadata (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_state (
  h TEXT PRIMARY KEY CHECK (h ~ '^[0-9a-f]{64}$'),
  created_at BIGINT NOT NULL CHECK (created_at > 0),
  consumed BOOLEAN NOT NULL DEFAULT false,
  data TEXT NULL CHECK (data IS NULL OR char_length(data) <= 256)
);

INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT (version) DO NOTHING;
