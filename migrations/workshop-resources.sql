-- Private CRM shortcuts only. No résumé or Pray Over Us records are changed.
CREATE TABLE IF NOT EXISTS public.crm_workshop_resources (
  id TEXT PRIMARY KEY,
  workshop_id INTEGER NOT NULL REFERENCES public.crm_workshops(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 200),
  url TEXT NOT NULL CHECK (length(url) <= 4096 AND url ~* '^https?://'),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS crm_workshop_resources_order_idx
  ON public.crm_workshop_resources(workshop_id, sort_order, id);
