-- Additive only. Existing links remain in crm_workshops.resume_entry_id.
-- The API reads the union of that legacy link and these additional links.
-- This avoids a production data backfill and preserves older clients.
CREATE TABLE IF NOT EXISTS public.crm_workshop_resume_links (
  workshop_id INTEGER NOT NULL REFERENCES public.crm_workshops(id) ON DELETE CASCADE,
  resume_entry_id TEXT NOT NULL REFERENCES public.resume_workshops(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workshop_id, resume_entry_id)
);
CREATE INDEX IF NOT EXISTS crm_workshop_resume_links_entry_idx
  ON public.crm_workshop_resume_links(resume_entry_id);
