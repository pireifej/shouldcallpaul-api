CREATE TABLE IF NOT EXISTS public.crm_workshop_engagement_dates (
  id TEXT PRIMARY KEY,
  workshop_id INTEGER NOT NULL REFERENCES public.crm_workshops(id) ON DELETE CASCADE,
  engagement_date DATE NOT NULL CHECK (engagement_date BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
  legacy_slot BOOLEAN NOT NULL DEFAULT false,
  additional BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (workshop_id, engagement_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_workshop_engagement_dates_legacy_idx
  ON public.crm_workshop_engagement_dates(workshop_id) WHERE legacy_slot;
