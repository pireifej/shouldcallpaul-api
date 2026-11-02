CREATE TABLE IF NOT EXISTS public.portfolio_migrations (
  name TEXT PRIMARY KEY,
  imported_counts JSONB NOT NULL DEFAULT '{}',
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.crm_organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  website TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.crm_events (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER REFERENCES public.crm_organizations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  event_date DATE,
  venue_name TEXT,
  venue_address TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.crm_workshops
  ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES public.crm_organizations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES public.crm_events(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS crm_workshops_organization_idx ON public.crm_workshops(organization_id);
CREATE INDEX IF NOT EXISTS crm_workshops_event_idx ON public.crm_workshops(event_id);

-- Exact-name grouping only; do not infer organizations from titles or descriptions.
INSERT INTO public.crm_organizations (name)
SELECT DISTINCT organization_name FROM public.crm_workshops
WHERE organization_name IS NOT NULL AND length(trim(organization_name)) > 0
ON CONFLICT (name) DO NOTHING;
UPDATE public.crm_workshops w SET organization_id = o.id
FROM public.crm_organizations o
WHERE w.organization_id IS NULL AND w.organization_name = o.name;

CREATE TABLE IF NOT EXISTS public.crm_organization_contacts (
  organization_id INTEGER NOT NULL REFERENCES public.crm_organizations(id) ON DELETE RESTRICT,
  contact_id INTEGER NOT NULL REFERENCES public.crm_contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (organization_id, contact_id)
);

CREATE TABLE IF NOT EXISTS public.crm_workshop_sessions (
  id SERIAL PRIMARY KEY,
  workshop_id INTEGER NOT NULL REFERENCES public.crm_workshops(id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ,
  time_zone TEXT NOT NULL DEFAULT 'America/New_York',
  duration_minutes INTEGER CHECK (duration_minutes >= 0),
  attendees INTEGER CHECK (attendees >= 0),
  venue_name TEXT,
  venue_address TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS crm_workshop_sessions_workshop_idx ON public.crm_workshop_sessions(workshop_id);

ALTER TABLE public.crm_activity_logs
  ADD COLUMN IF NOT EXISTS workshop_id INTEGER REFERENCES public.crm_workshops(id) ON DELETE RESTRICT;
UPDATE public.crm_activity_logs a SET workshop_id = w.id
FROM public.crm_workshops w
WHERE a.entity_type = 'workshop' AND a.entity_id = w.id AND a.workshop_id IS NULL;
CREATE INDEX IF NOT EXISTS crm_activity_logs_workshop_idx ON public.crm_activity_logs(workshop_id);

-- Preserve historical orphan logs, but enforce real workshop references for all new logs.
CREATE OR REPLACE FUNCTION public.portfolio_activity_workshop_reference() RETURNS trigger AS $$
BEGIN
  IF NEW.entity_type = 'workshop' THEN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.entity_type = OLD.entity_type AND NEW.entity_id = OLD.entity_id
         AND NEW.workshop_id IS NOT DISTINCT FROM OLD.workshop_id THEN
        RETURN NEW;
      END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.crm_workshops WHERE id = NEW.entity_id) THEN
      RAISE EXCEPTION 'Workshop not found' USING ERRCODE = '23503';
    END IF;
    IF NEW.workshop_id IS NOT NULL AND NEW.workshop_id <> NEW.entity_id THEN
      RAISE EXCEPTION 'workshop_id must match entity_id' USING ERRCODE = '23514';
    END IF;
    NEW.workshop_id := NEW.entity_id;
  ELSIF NEW.workshop_id IS NOT NULL THEN
    RAISE EXCEPTION 'workshop_id requires entity_type workshop' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS portfolio_activity_reference ON public.crm_activity_logs;
CREATE TRIGGER portfolio_activity_reference BEFORE INSERT OR UPDATE ON public.crm_activity_logs
FOR EACH ROW EXECUTE FUNCTION public.portfolio_activity_workshop_reference();

-- Old clients may keep sending organization_name; new clients send organization_id.
CREATE OR REPLACE FUNCTION public.portfolio_workshop_organization() RETURNS trigger AS $$
DECLARE resolved_name TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
       AND NEW.organization_name IS DISTINCT FROM OLD.organization_name THEN
      NEW.organization_id := NULL;
    END IF;
  END IF;
  IF NEW.organization_id IS NULL THEN
    IF NEW.organization_name IS NULL OR length(trim(NEW.organization_name)) = 0 THEN
      RAISE EXCEPTION 'organization_id or organization_name is required' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.crm_organizations(name) VALUES (NEW.organization_name)
      ON CONFLICT (name) DO NOTHING;
    SELECT id INTO NEW.organization_id FROM public.crm_organizations WHERE name = NEW.organization_name;
  ELSE
    SELECT name INTO resolved_name FROM public.crm_organizations WHERE id = NEW.organization_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Organization not found' USING ERRCODE = '23503'; END IF;
    NEW.organization_name := resolved_name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS portfolio_workshop_org ON public.crm_workshops;
CREATE TRIGGER portfolio_workshop_org BEFORE INSERT OR UPDATE ON public.crm_workshops
FOR EACH ROW EXECUTE FUNCTION public.portfolio_workshop_organization();

CREATE OR REPLACE FUNCTION public.portfolio_organization_rename() RETURNS trigger AS $$
BEGIN
  UPDATE public.crm_workshops SET organization_name = NEW.name, updated_at = NOW()
    WHERE organization_id = NEW.id AND organization_name IS DISTINCT FROM NEW.name;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS portfolio_org_rename ON public.crm_organizations;
CREATE TRIGGER portfolio_org_rename AFTER UPDATE OF name ON public.crm_organizations
FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
EXECUTE FUNCTION public.portfolio_organization_rename();

CREATE TABLE IF NOT EXISTS public.portfolio_change_history (
  id BIGSERIAL PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  workshop_id INTEGER,
  operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  before_data JSONB,
  after_data JSONB,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS portfolio_history_resource_idx
  ON public.portfolio_change_history(resource_type, resource_id, id);
CREATE INDEX IF NOT EXISTS portfolio_history_workshop_idx
  ON public.portfolio_change_history(workshop_id, id);

CREATE OR REPLACE FUNCTION public.portfolio_capture_change() RETURNS trigger AS $$
DECLARE before_row JSONB; after_row JSONB; row_data JSONB; workshop INTEGER;
BEGIN
  IF TG_OP <> 'INSERT' THEN before_row := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN after_row := to_jsonb(NEW); END IF;
  IF before_row IS NOT DISTINCT FROM after_row THEN RETURN NULL; END IF;
  row_data := COALESCE(after_row, before_row);
  IF TG_TABLE_NAME = 'crm_workshops' THEN workshop := (row_data->>'id')::integer;
  ELSIF TG_TABLE_NAME IN ('crm_workshop_sessions', 'crm_activity_logs', 'crm_workshop_contacts') THEN
    workshop := (row_data->>'workshop_id')::integer;
  END IF;
  INSERT INTO public.portfolio_change_history
    (resource_type, resource_id, workshop_id, operation, before_data, after_data)
  VALUES (TG_TABLE_NAME,
    COALESCE(row_data->>'id', (row_data->>'workshop_id') || ':' || (row_data->>'contact_id'),
      (row_data->>'organization_id') || ':' || (row_data->>'contact_id')),
    workshop, TG_OP, before_row, after_row);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
