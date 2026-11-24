-- Additive only. Apply explicitly to the existing CRM schema; no runtime auto-migration.
CREATE TABLE IF NOT EXISTS hg_owner (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  subject TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  token_ciphertext TEXT,
  connected BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hg_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_sub TEXT REFERENCES hg_owner(subject),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hg_oauth_states (
  state_hash TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL REFERENCES hg_sessions(token_hash) ON DELETE CASCADE,
  proof_ciphertext TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS hg_preferences (
  owner_sub TEXT NOT NULL REFERENCES hg_owner(subject),
  contact_resource TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_sub, contact_resource)
);
CREATE TABLE IF NOT EXISTS hg_batches (
  id UUID PRIMARY KEY,
  owner_sub TEXT NOT NULL REFERENCES hg_owner(subject),
  version INTEGER NOT NULL DEFAULT 1,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hg_batches_owner_updated_idx ON hg_batches(owner_sub, updated_at DESC);
CREATE TABLE IF NOT EXISTS hg_drafts (
  id UUID PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES hg_batches(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  data JSONB NOT NULL,
  UNIQUE(batch_id, position)
);
