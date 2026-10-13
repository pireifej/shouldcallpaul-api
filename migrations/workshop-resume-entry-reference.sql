-- Application-validated reference to the manually maintained resume JSON.
-- Deliberately nullable and non-unique: several CRM deliveries may link
-- to one resume entry. No foreign key or copied resume catalog is created.
ALTER TABLE public.crm_workshops
  ADD COLUMN IF NOT EXISTS resume_entry_id TEXT;
