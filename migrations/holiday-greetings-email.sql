-- Additive only. Apply to development; managed production receives it through Publish.
-- Existing SMS drafts/preferences remain unchanged.
CREATE TABLE IF NOT EXISTS hg_email_attempts (
  id UUID PRIMARY KEY,
  owner_sub TEXT NOT NULL REFERENCES hg_owner(subject),
  batch_id UUID NOT NULL REFERENCES hg_batches(id),
  draft_id UUID NOT NULL REFERENCES hg_drafts(id),
  state TEXT NOT NULL CHECK (state IN ('sending', 'accepted', 'rejected', 'unknown')),
  gmail_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hg_email_attempts_unresolved_draft_idx
  ON hg_email_attempts(draft_id) WHERE state <> 'rejected';
