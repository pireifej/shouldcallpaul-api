-- Additive schema only. Content reconciliation is separate, transactional DML.
ALTER TABLE public.resume_workshops ADD COLUMN IF NOT EXISTS completion_status TEXT NOT NULL DEFAULT 'draft'
  CHECK (completion_status IN ('draft','scheduled','complete','cancelled'));
ALTER TABLE public.resume_workshops ADD COLUMN IF NOT EXISTS catalog_topics_explicit BOOLEAN NOT NULL DEFAULT false;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.resume_workshops'::regclass AND conname='resume_workshops_completion_status_check') THEN
    ALTER TABLE public.resume_workshops ADD CONSTRAINT resume_workshops_completion_status_check
      CHECK (completion_status IN ('draft','scheduled','complete','cancelled'));
  END IF;
END $$;
ALTER TABLE public.speaker_topics ADD COLUMN IF NOT EXISTS catalog_hidden BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.speaker_topics ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.speaker_topics ADD COLUMN IF NOT EXISTS catalog_title_key TEXT UNIQUE;
CREATE TABLE IF NOT EXISTS public.speaker_workshop_topics (
  resume_entry_id TEXT NOT NULL REFERENCES public.resume_workshops(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES public.speaker_topics(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('explicit','automatic')),
  PRIMARY KEY (resume_entry_id, topic_id)
);
CREATE INDEX IF NOT EXISTS speaker_workshop_topics_topic_idx ON public.speaker_workshop_topics(topic_id);
CREATE TABLE IF NOT EXISTS public.speaker_topic_aliases (
  normalized_title TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES public.speaker_topics(id) ON DELETE CASCADE,
  PRIMARY KEY (normalized_title, topic_id)
);
CREATE TABLE IF NOT EXISTS public.speaker_title_mappings (
  normalized_title TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES public.speaker_topics(id) ON DELETE CASCADE,
  PRIMARY KEY (normalized_title, topic_id)
);
