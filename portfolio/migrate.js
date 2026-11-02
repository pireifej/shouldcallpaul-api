'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { categories, quote, validateEntry } = require('./catalog');
const { transaction, saveEntry, readFeed, readSpeakerMenu } = require('./store');

const IMPORT_NAME = 'resume-json-to-relational-database';
const base = path.join(__dirname, '..');

async function createWorkshopResumeLinks(db) {
  await db.query(fs.readFileSync(path.join(base, 'migrations/workshop-resume-links.sql'), 'utf8'));
}

async function createSchema(db) {
  await db.query(fs.readFileSync(path.join(base, 'migrations/portfolio-relations.sql'), 'utf8'));
  for (const config of Object.values(categories)) {
    await db.query(`CREATE TABLE IF NOT EXISTS public.${config.table} (
      id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
      published BOOLEAN NOT NULL DEFAULT false,
      sort_order INTEGER NOT NULL DEFAULT 0,
      organization_id INTEGER REFERENCES public.crm_organizations(id) ON DELETE RESTRICT,
      field_names TEXT[] NOT NULL,
      ${Object.entries(config.fields).map(([key, type]) => `${quote(key)} ${type}`).join(',\n')},
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  }
  await db.query(`CREATE TABLE IF NOT EXISTS public.resume_workshop_sessions (
    id BIGSERIAL PRIMARY KEY,
    resume_entry_id TEXT NOT NULL REFERENCES public.resume_workshops(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL,
    time TIME,
    time_zone TEXT,
    duration_minutes INTEGER CHECK (duration_minutes >= 0),
    attendees INTEGER CHECK (attendees >= 0),
    content JSONB NOT NULL
  );
  CREATE INDEX IF NOT EXISTS resume_workshop_sessions_entry_idx
    ON public.resume_workshop_sessions(resume_entry_id);
  CREATE TABLE IF NOT EXISTS public.speaker_menu (
    id INTEGER PRIMARY KEY CHECK (id = 1), title TEXT NOT NULL, subtitle TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS public.speaker_categories (
    id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL DEFAULT 0,
    published BOOLEAN NOT NULL DEFAULT true, content JSONB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS public.speaker_topics (
    id TEXT PRIMARY KEY,
    category_id TEXT NOT NULL REFERENCES public.speaker_categories(id) ON DELETE RESTRICT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    published BOOLEAN NOT NULL DEFAULT true, content JSONB NOT NULL
  )`);
}

async function importLegacy(db) {
  const counts = {};
  for (const [category, config] of Object.entries(categories)) {
    const original = JSON.parse(fs.readFileSync(path.join(base, 'resume_data', `${category}.json`), 'utf8'));
    if (Object.keys(original).length !== 1 || !Array.isArray(original[config.root])) {
      throw new Error(`Unexpected legacy feed shape: ${category}; import aborted`);
    }
    for (const [index, entry] of original[config.root].entries()) {
      const error = validateEntry(category, entry);
      if (error) throw new Error(`${category} entry ${index}: ${error}`);
      await saveEntry(db, category, { entry, published: true, sort_order: index }, null, { imported: true });
    }
    // Verify actual rendered output, not just row counts, before switching feeds.
    assert.deepEqual(await readFeed(db, category), original, `${category} import must be lossless`);
    counts[category] = original[config.root].length;
  }
  const menu = JSON.parse(fs.readFileSync(path.join(base, 'speaker_data/speaker_menu.json'), 'utf8'));
  await db.query('INSERT INTO public.speaker_menu (id, title, subtitle) VALUES (1,$1,$2)', [menu.title, menu.subtitle]);
  for (const [index, category] of menu.categories.entries()) {
    const { items, ...content } = category;
    await db.query(`INSERT INTO public.speaker_categories(id, sort_order, content) VALUES ($1,$2,$3)`,
      [category.id, index, JSON.stringify(content)]);
    for (const [order, topic] of items.entries()) {
      await db.query(`INSERT INTO public.speaker_topics(id, category_id, sort_order, content) VALUES ($1,$2,$3,$4)`,
        [topic.id, category.id, order, JSON.stringify(topic)]);
    }
  }
  assert.deepEqual(await readSpeakerMenu(db), menu, 'Speaker menu import must be lossless');
  counts.speaker_categories = menu.categories.length;
  counts.speaker_topics = menu.categories.reduce((sum, c) => sum + c.items.length, 0);
  const orphans = await db.query(`SELECT count(*)::integer AS count FROM public.crm_activity_logs
    WHERE entity_type = 'workshop' AND workshop_id IS NULL`);
  counts.preserved_orphan_activity_logs = orphans.rows[0].count;
  return counts;
}

async function installConstraintsAndHistory(db) {
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.crm_workshops'::regclass
      AND conname = 'crm_workshops_resume_entry_fk') THEN
      ALTER TABLE public.crm_workshops ADD CONSTRAINT crm_workshops_resume_entry_fk
        FOREIGN KEY (resume_entry_id) REFERENCES public.resume_workshops(id) ON DELETE RESTRICT;
    END IF;
  END $$`);
  const tables = [...Object.values(categories).map(c => c.table),
    'crm_workshops', 'crm_workshop_sessions', 'crm_workshop_contacts', 'crm_organizations',
    'crm_events', 'crm_organization_contacts', 'crm_activity_logs', 'resume_workshop_sessions',
    'speaker_menu', 'speaker_categories', 'speaker_topics'];
  for (const table of tables) {
    await db.query(`DROP TRIGGER IF EXISTS portfolio_history ON public.${table};
      CREATE TRIGGER portfolio_history AFTER INSERT OR UPDATE OR DELETE ON public.${table}
      FOR EACH ROW EXECUTE FUNCTION public.portfolio_capture_change()`);
  }
}

async function migratePortfolio(pool) {
  return transaction(pool, async db => {
    // Shared across instances; deploys/restarts cannot import twice or overwrite edits.
    await db.query("SELECT pg_advisory_xact_lock(hashtext('portfolio-database-migration'))");
    const exists = await db.query("SELECT to_regclass('public.portfolio_migrations') AS relation");
    if (exists.rows[0].relation) {
      const done = await db.query('SELECT imported_counts FROM public.portfolio_migrations WHERE name = $1', [IMPORT_NAME]);
      if (done.rows.length) {
        await createWorkshopResumeLinks(db);
        return { alreadyImported: true, counts: done.rows[0].imported_counts };
      }
    }
    await createSchema(db);
    const counts = await importLegacy(db);
    await installConstraintsAndHistory(db);
    await createWorkshopResumeLinks(db);
    await db.query('INSERT INTO public.portfolio_migrations(name, imported_counts) VALUES ($1,$2)',
      [IMPORT_NAME, JSON.stringify(counts)]);
    return { alreadyImported: false, counts };
  });
}

// Runtime must never create the managed production schema. Publish owns that
// schema; its source of truth is the development database prepared by the CLI.
async function verifyPortfolioReady(pool) {
  const tables = [...Object.values(categories).map(config => config.table),
    'portfolio_migrations', 'portfolio_change_history', 'crm_organizations',
    'crm_events', 'crm_organization_contacts', 'crm_workshop_sessions',
    'resume_workshop_sessions', 'speaker_menu', 'speaker_categories', 'speaker_topics'];
  const result = await pool.query(`SELECT ${tables.map(table =>
    `to_regclass('public.${table}') IS NOT NULL AS "${table}"`).join(', ')}`);
  if (tables.some(table => !result.rows[0][table])) {
    throw new Error('Portfolio schema is not ready. Prepare the development schema and review the Publish migration; do not recreate production tables at startup.');
  }
  const marker = await pool.query('SELECT imported_counts FROM public.portfolio_migrations WHERE name = $1', [IMPORT_NAME]);
  if (!marker.rows.length) {
    throw new Error('Portfolio data import is not complete. Stop and review database initialization before publishing; runtime will not overwrite or re-import content.');
  }
  return { alreadyImported: true, counts: marker.rows[0].imported_counts };
}

module.exports = { migratePortfolio, verifyPortfolioReady, createSchema, importLegacy, installConstraintsAndHistory, IMPORT_NAME };
