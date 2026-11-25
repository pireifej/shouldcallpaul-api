-- Additive, development schema preparation only. Managed Publish owns production DDL.
-- No approval records are seeded. No runtime/startup migration or customer reset.
BEGIN;
-- The legacy account schema has no user_id key. A non-partial unique index is
-- required for the FK below. Conflicts abort explicitly; never deduplicate IDs.
CREATE UNIQUE INDEX IF NOT EXISTS user_subscription_reconciliation_user_id_idx
  ON public."user"(user_id);
CREATE TABLE IF NOT EXISTS public.subscription_identity_reconciliations (
  id UUID PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public."user"(user_id),
  project_id TEXT NOT NULL CHECK (length(btrim(project_id)) BETWEEN 1 AND 255),
  from_customer_id TEXT NOT NULL CHECK (
    length(btrim(from_customer_id)) BETWEEN 1 AND 255
    AND from_customer_id = btrim(from_customer_id)
    AND from_customer_id NOT LIKE '$RCAnonymousID:%'
    AND left(from_customer_id, 7) <> 'pou_v1_'
  ),
  to_customer_id TEXT NOT NULL CHECK (to_customer_id ~ '^pou_v1_[A-Za-z0-9_-]{43}$'),
  original_customer_id TEXT NOT NULL CHECK (
    original_customer_id LIKE '$RCAnonymousID:%'
    AND length(original_customer_id) BETWEEN 16 AND 255
    AND original_customer_id = btrim(original_customer_id)
  ),
  approved_at TIMESTAMPTZ NOT NULL,
  approved_by TEXT NOT NULL CHECK (length(btrim(approved_by)) BETWEEN 1 AND 200),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  evidence_reference TEXT NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 1 AND 200),
  UNIQUE (project_id, user_id),
  UNIQUE (project_id, from_customer_id),
  UNIQUE (project_id, to_customer_id),
  UNIQUE (project_id, original_customer_id),
  CHECK (expires_at > approved_at),
  CHECK (completed_at IS NULL OR (completed_at >= approved_at AND completed_at <= expires_at))
);
COMMIT;
