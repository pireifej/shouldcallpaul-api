'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const express = require('express');
const { categories } = require('../portfolio/catalog');
const { migratePortfolio, verifyPortfolioReady } = require('../portfolio/migrate');
const portfolioRoutes = require('../routes/portfolio');
const crmRoutes = require('../routes/crm');
const speakerRoutes = require('../routes/speaker');
const { importTestimonials } = require('../portfolio/testimonial-import');

test('relational portfolio migration and authenticated APIs (isolated PostgreSQL)', {
  skip: !process.env.DATABASE_URL && 'DATABASE_URL is required for isolated PostgreSQL tests'
}, async t => {
  const client = new Client({ connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  const schema = `portfolio_test_${randomUUID().replaceAll('-', '')}`;
  const rewrite = sql => sql.replaceAll('public.', `${schema}.`);
  let server;
  await client.connect();
  await client.query('BEGIN');
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    await client.query(`CREATE TABLE crm_contacts (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, title TEXT, organization TEXT, email TEXT,
      phone TEXT, linkedin_url TEXT, last_contact_date TIMESTAMP
    );
    CREATE TABLE crm_workshops (
      id SERIAL PRIMARY KEY, organization_name TEXT NOT NULL, contact_id INTEGER REFERENCES crm_contacts(id),
      status TEXT DEFAULT 'Active', workshop_title TEXT, historical_date TIMESTAMP,
      venue_name TEXT, venue_address TEXT, fee_amount NUMERIC, fee_type TEXT, cost_basis TEXT,
      notes TEXT, resume_entry_id TEXT, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE crm_activity_logs (
      id SERIAL PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
      contact_id INTEGER REFERENCES crm_contacts(id), log_text TEXT NOT NULL, log_date TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE crm_workshop_contacts (
      workshop_id INTEGER REFERENCES crm_workshops(id), contact_id INTEGER REFERENCES crm_contacts(id),
      created_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY(workshop_id,contact_id)
    );
    INSERT INTO crm_contacts (name) VALUES ('Original Contact');
    INSERT INTO crm_workshops (organization_name,status,notes,fee_amount,fee_type,cost_basis,contact_id)
      VALUES ('Repeat Organization','Complete','Private original notes',75,'flat','$75',1),
        ('Repeat Organization','Active','Another delivery',NULL,NULL,NULL,NULL);
    INSERT INTO crm_activity_logs (entity_type,entity_id,contact_id,log_text)
      VALUES ('workshop',1,1,'Original email history'),('workshop',999,NULL,'Preserved orphan history');
    INSERT INTO crm_workshop_contacts(workshop_id,contact_id) VALUES (1,1)`);
    let queryQueue = Promise.resolve();
    let statementNumber = 0;
    const pool = {
      query(sql, params) {
        // Expected constraint failures must not abort the outer isolation transaction.
        const run = queryQueue.then(async () => {
          const savepoint = `statement_${++statementNumber}`;
          await client.query(`SAVEPOINT ${savepoint}`);
          try {
            const result = await client.query(rewrite(sql), params);
            await client.query(`RELEASE SAVEPOINT ${savepoint}`);
            return result;
          } catch (e) {
            await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            await client.query(`RELEASE SAVEPOINT ${savepoint}`);
            throw e;
          }
        });
        queryQueue = run.catch(() => {});
        return run;
      },
      async connect() {
        return {
          query(sql, params) {
            if (sql === 'BEGIN') return client.query('SAVEPOINT api_transaction');
            if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT api_transaction');
            if (sql === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT api_transaction');
            return pool.query(sql, params);
          },
          release() {}
        };
      }
    };
    await t.test('failed imports roll back schema and records instead of partially switching', async () => {
      const faultPool = { ...pool, async connect() {
        const db = await pool.connect();
        return { ...db, query(sql, params) {
          if (sql.includes('INSERT INTO public.speaker_topics')) throw new Error('Simulated import failure');
          return db.query(sql, params);
        } };
      } };
      await assert.rejects(migratePortfolio(faultPool), /Simulated import failure/);
      assert.equal((await pool.query("SELECT to_regclass('public.resume_speeches') AS relation")).rows[0].relation, null);
      assert.equal((await pool.query('SELECT notes FROM public.crm_workshops WHERE id = 1')).rows[0].notes, 'Private original notes');
    });
    const migration = await migratePortfolio(pool);
    await t.test('runtime verifies readiness using SELECT only, never creating or importing production data', async () => {
      const queries = [];
      const readOnlyPool = { query(sql, params) {
        queries.push(sql);
        assert.match(sql.trim(), /^SELECT\b/);
        return pool.query(sql, params);
      } };
      const ready = await verifyPortfolioReady(readOnlyPool);
      assert.equal(ready.alreadyImported, true);
      assert.deepEqual(ready.counts, migration.counts);
      assert.equal(queries.length, 2);
      await assert.rejects(verifyPortfolioReady({ query: async () => ({ rows: [{}] }) }), /schema is not ready/);
      let calls = 0;
      await assert.rejects(verifyPortfolioReady({ query: async () => ++calls === 1
        ? { rows: [Object.fromEntries(Object.values(categories).map(c => [c.table, true]).concat(
          ['portfolio_migrations', 'portfolio_change_history', 'crm_organizations', 'crm_events',
            'crm_organization_contacts', 'crm_workshop_sessions', 'resume_workshop_sessions',
            'speaker_menu', 'speaker_categories', 'speaker_topics'].map(table => [table, true])))] }
        : { rows: [] } }), /data import is not complete/);
    });
    await t.test('all ten feeds and speaker menu import losslessly, with stable workshop IDs', async () => {
      assert.equal(migration.alreadyImported, false);
      assert.equal(migration.counts.preserved_orphan_activity_logs, 1);
      for (const [category, config] of Object.entries(categories)) {
        const original = JSON.parse(fs.readFileSync(path.join(__dirname, '../resume_data', `${category}.json`)));
        assert.equal(migration.counts[category], original[config.root].length);
      }
      const orgs = await pool.query('SELECT * FROM public.crm_organizations');
      assert.equal(orgs.rows.length, 1);
      assert.equal((await pool.query('SELECT count(DISTINCT organization_id)::int AS count FROM public.crm_workshops')).rows[0].count, 1);
      const logs = (await pool.query('SELECT * FROM public.crm_activity_logs ORDER BY id')).rows;
      assert.equal(logs[0].workshop_id, 1);
      assert.equal(logs[0].log_text, 'Original email history');
      assert.equal(logs[1].workshop_id, null);
    });
    const app = express();
    app.use(express.json());
    const authenticate = (req, res, next) => req.headers.authorization === 'Bearer test'
      ? next() : res.status(401).json({ error: 'Authentication required' });
    app.use(portfolioRoutes({ auditPool: pool, authenticate }));
    app.use(crmRoutes({ auditPool: pool, authenticate, openai: {} }));
    app.use(speakerRoutes({ auditPool: pool }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (url, method = 'GET', body, auth = true) => {
      const response = await fetch(base + url, { method, headers: {
        ...(auth ? { authorization: 'Bearer test' } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {})
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    const api = async (...args) => {
      const response = await request(...args);
      assert.equal(response.status, 200, JSON.stringify(response));
      return response.body.data;
    };
    await t.test('legacy public URLs preserve every wrapper, field, null, ordering and session', async () => {
      for (const category of Object.keys(categories)) {
        const original = JSON.parse(fs.readFileSync(path.join(__dirname, '../resume_data', `${category}.json`)));
        for (const url of [`/resume/${category}`, `/resume/${category}.json`, `/resume_data/${category}.json`]) {
          const response = await request(url, 'GET', undefined, false);
          assert.equal(response.status, 200);
          assert.deepEqual(response.body, original);
        }
      }
      assert.deepEqual((await request('/speaker_data/speaker_menu.json')).body,
        JSON.parse(fs.readFileSync(path.join(__dirname, '../speaker_data/speaker_menu.json'))));
      for (const url of ['/speaker/speaker_menu', '/speaker/speaker_menu.json']) {
        assert.deepEqual((await request(url)).body,
          JSON.parse(fs.readFileSync(path.join(__dirname, '../speaker_data/speaker_menu.json'))));
      }
      assert.equal((await request('/resume/no-such-category')).status, 404);
      assert.equal((await request('/api/resume/toString')).status, 404);
    });
    await t.test('all management routes require authentication', async () => {
      const paths = ['/api/resume/categories', '/api/resume/speech', '/api/organizations', '/api/events',
        '/api/workshops/1/sessions', '/api/workshops/1/activity-logs', '/api/workshops/1/history',
        '/api/portfolio/history', '/api/speaker-menu'];
      for (const url of paths) assert.equal((await request(url, 'GET', undefined, false)).status, 401);
      for (const url of ['/api/resume/speech', '/api/organizations', '/api/events',
        '/api/workshops/1/sessions', '/api/workshops/1/activity-logs', '/api/speaker-menu/topics']) {
        assert.equal((await request(url, 'POST', {}, false)).status, 401);
      }
      assert.equal((await request('/api/resume/speech/id', 'PATCH', {}, false)).status, 401);
      assert.equal((await request('/api/resume/speech/id', 'DELETE', undefined, false)).status, 401);
    });
    await t.test('each category supports create, edit, publish, reorder and delete with permanent IDs', async () => {
      for (const [category, config] of Object.entries(categories)) {
        const originalCount = (await request(`/resume/${category}`)).body[config.root].length;
        const example = JSON.parse(fs.readFileSync(path.join(__dirname, '../resume_data', `${category}.json`)))[config.root][0];
        const entry = { ...example };
        delete entry.id;
        const created = await api(`/api/resume/${category}`, 'POST', { entry });
        assert.equal(typeof created.id, 'string');
        assert.equal(created.published, false);
        assert.equal((await request(`/resume/${category}`)).body[config.root].length, originalCount);
        const key = category === 'testimonials' ? 'quote' : category === 'certificates' || category === 'awards' ? 'title' : 'label';
        const edited = await api(`/api/resume/${category}/${created.id}`, 'PATCH',
          { entry: { [key]: 'Edited in database' }, published: true, sort_order: -10 });
        assert.equal(edited.id, created.id);
        const first = (await request(`/resume/${category}`)).body[config.root][0];
        assert.equal(first[key], 'Edited in database');
        assert.equal(first.id, created.id);
        assert.equal((await request(`/api/resume/${category}/${created.id}`, 'PUT',
          { entry: { id: 'replacement-id' } })).status, 400);
        const history = await api(`/api/portfolio/history?resource_type=${config.table}&resource_id=${created.id}`);
        assert.ok(history.some(h => h.operation === 'INSERT'));
        assert.ok(history.some(h => h.operation === 'UPDATE'));
        await api(`/api/resume/${category}/${created.id}`, 'DELETE');
        assert.equal((await request(`/resume/${category}`)).body[config.root].length, originalCount);
      }
    });
    await t.test('database is authoritative and restart/import cannot overwrite edited content or IDs', async () => {
      const record = (await api('/api/resume/speech'))[0];
      const old = record.entry.label;
      await api(`/api/resume/speech/${record.id}`, 'PATCH', { entry: { label: 'Persisted database correction' } });
      const again = await migratePortfolio(pool);
      assert.equal(again.alreadyImported, true);
      const edited = await api(`/api/resume/speech/${record.id}`);
      assert.equal(edited.id, record.id);
      assert.equal(edited.entry.label, 'Persisted database correction');
      await api(`/api/resume/speech/${record.id}`, 'PATCH', { entry: { label: old } });
    });
    await t.test('existing Complete workshops allow edits, contacts and reversible status changes without publishing', async () => {
      const beforeFeed = (await request('/resume/workshops')).body;
      let row = await api('/api/workshops/1', 'PATCH', { notes: 'Corrected private note', fee_amount: 90 });
      assert.equal(row.status, 'Complete');
      assert.equal(row.fee_amount, 90);
      assert.equal(row.cost_basis, '$90');
      assert.equal(row.resume_entry_id, null);
      row = await api('/api/workshops/1/status', 'PATCH', { status: 'In Progress' });
      assert.equal(row.status, 'In Progress');
      await api('/api/workshops/1/status', 'PATCH', { status: 'Complete' });
      await api('/api/workshops/1/contacts', 'POST', { contact_id: 1 });
      assert.deepEqual((await request('/resume/workshops')).body, beforeFeed);
      const history = await api('/api/workshops/1/history');
      assert.ok(history.some(h => h.before_data.notes === 'Private original notes' && h.after_data.notes === 'Corrected private note'));
    });
    await t.test('organization relationships, renaming and event grouping retain private workshop history', async () => {
      const org = await api('/api/organizations', 'POST', { name: 'New Organization', notes: 'Private organization notes' });
      await api(`/api/organizations/${org.id}/contacts`, 'POST', { contact_id: 1 });
      assert.equal((await api(`/api/organizations/${org.id}/contacts`))[0].id, 1);
      const event = await api('/api/events', 'POST', { name: 'Expo', organization_id: org.id, event_date: '2026-10-07' });
      const workshop = await api('/api/workshops', 'POST', { organization_id: org.id, event_id: event.id, workshop_title: 'Separate topic' });
      assert.equal(workshop.organization_id, org.id);
      assert.equal(workshop.organization_name, org.name);
      assert.equal(workshop.event_id, event.id);
      await api(`/api/organizations/${org.id}`, 'PATCH', { name: 'Renamed Organization' });
      assert.equal((await api(`/api/workshops/${workshop.id}`)).organization_name, 'Renamed Organization');
      const filtered = await api(`/api/workshops?organization_id=${org.id}&event_id=${event.id}`);
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].id, workshop.id);
      assert.equal((await request(`/api/organizations/${org.id}`, 'DELETE')).status, 409);
      await api(`/api/organizations/${org.id}/contacts/1`, 'DELETE');
      assert.equal((await api(`/api/organizations/${org.id}/contacts`)).length, 0);
      const legacy = await api('/api/workshops', 'POST', { organization_name: 'Renamed Organization' });
      assert.equal(legacy.organization_id, org.id);
    });
    await t.test('sessions and workshop activity use real FKs and record their own changes', async () => {
      const session = await api('/api/workshops/1/sessions', 'POST', {
        starts_at: '2026-10-07T09:00:00-04:00', time_zone: 'America/New_York',
        duration_minutes: 50, attendees: 46
      });
      assert.equal(session.workshop_id, 1);
      await api(`/api/workshops/1/sessions/${session.id}`, 'PATCH', { attendees: 47 });
      assert.equal((await api('/api/workshops/1/sessions'))[0].attendees, 47);
      assert.equal((await request(`/api/workshops/2/sessions/${session.id}`, 'PATCH', { attendees: 1 })).status, 404);
      for (const body of [{ attendees: -1 }, { duration_minutes: 1.5 }, { time_zone: 'No/Zone' },
        { starts_at: '2026-10-07T09:00:00' }]) {
        assert.equal((await request('/api/workshops/1/sessions', 'POST', body)).status, 400);
      }
      const log = await api('/api/workshops/1/activity-logs', 'POST', { log_text: 'New email', contact_id: 1 });
      assert.equal(log.workshop_id, 1);
      assert.equal(log.entity_type, 'workshop');
      assert.equal(log.entity_id, 1);
      const oldStyle = await api('/api/activity-logs', 'POST', { entity_type: 'workshop', entity_id: 1, log_text: 'Old client call' });
      assert.equal(oldStyle.workshop_id, 1);
      assert.equal((await request('/api/activity-logs', 'POST',
        { entity_type: 'workshop', entity_id: 999, log_text: 'Invalid new activity' })).status, 404);
      await api(`/api/activity-logs/${log.id}`, 'PATCH', { log_text: 'Corrected email notes' });
      const logs = await api('/api/workshops/1/activity-logs');
      assert.ok(logs.some(l => l.log_text === 'Original email history'));
      assert.ok(logs.some(l => l.log_text === 'Corrected email notes'));
      const history = await api('/api/workshops/1/history');
      assert.ok(history.some(h => h.resource_type === 'crm_workshop_sessions' && h.operation === 'UPDATE'));
      assert.ok(history.some(h => h.resource_type === 'crm_activity_logs' && h.operation === 'UPDATE'));
      assert.equal((await request('/api/workshops/1', 'DELETE')).status, 409);
      await api(`/api/workshops/1/sessions/${session.id}`, 'DELETE');
      await api(`/api/activity-logs/${log.id}`, 'DELETE');
      assert.ok((await api('/api/workshops/1/history')).some(h => h.resource_type === 'crm_activity_logs' && h.operation === 'DELETE'));
    });
    await t.test('legacy resume links remain nullable, validated and never title-matched', async () => {
      const publicEntry = (await api('/api/resume/workshops'))[0];
      const first = await api('/api/workshops', 'POST', { organization_name: 'Link Org', resume_entry_id: publicEntry.id });
      const second = await api('/api/workshops', 'POST', { organization_name: 'Link Org', resume_entry_id: publicEntry.id });
      assert.equal(first.resume_entry_id, second.resume_entry_id);
      await api(`/api/workshops/${first.id}`, 'PATCH', { notes: 'Omitting link' });
      assert.equal((await api(`/api/workshops/${first.id}`)).resume_entry_id, publicEntry.id);
      const bad = await request(`/api/workshops/${first.id}`, 'PATCH', { notes: 'Must not save', resume_entry_id: 'missing' });
      assert.equal(bad.status, 400);
      assert.equal((await api(`/api/workshops/${first.id}`)).notes, 'Omitting link');
      assert.equal((await request(`/api/resume/workshops/${publicEntry.id}`, 'DELETE')).status, 409);
      await api(`/api/workshops/${first.id}`, 'PATCH', { resume_entry_id: null });
      assert.equal((await api(`/api/workshops/${first.id}`)).resume_entry_id, null);
      assert.equal((await api(`/api/workshops/${second.id}`)).resume_entry_id, publicEntry.id);
      const noAuto = await api('/api/workshops', 'POST', { organization_name: 'Link Org', workshop_title: publicEntry.entry.label });
      assert.equal(noAuto.resume_entry_id, null);
    });
    await t.test('many-to-many links preserve legacy links, private CRM state and public tallies', async () => {
      const entries = await api('/api/resume/workshops');
      const [a, b] = entries.map(row => row.id);
      const draft = await api('/api/resume/workshops', 'POST', { entry: { label: 'Private draft linked talk' } });
      const first = await api('/api/workshops', 'POST', {
        organization_name: 'Expo links', status: 'Complete', notes: 'Private notes', contact_id: 1,
        fee_amount: 100, fee_type: 'flat', resume_entry_id: a
      });
      const second = await api('/api/workshops', 'POST', { organization_name: 'Another delivery' });
      const path = `/api/workshops/${first.id}/resume-entries`;
      const before = (await pool.query(`SELECT to_jsonb(w) - 'resume_entry_id' AS state
        FROM public.crm_workshops w WHERE id = $1`, [first.id])).rows[0].state;
      const activityBefore = (await pool.query('SELECT * FROM public.crm_activity_logs ORDER BY id')).rows;
      const contactsBefore = (await pool.query('SELECT * FROM public.crm_workshop_contacts ORDER BY workshop_id, contact_id')).rows;
      const publicBefore = (await request('/resume/workshops')).body;
      // Re-running development preparation must not reset legacy links or feeds.
      await migratePortfolio(pool);
      assert.deepEqual((await api(path)).resume_entry_ids, [a]);
      assert.equal((await request(path, 'GET', undefined, false)).status, 401);
      assert.equal((await request(path, 'POST', { resume_entry_id: b }, false)).status, 401);
      assert.equal((await request(`${path}/${encodeURIComponent(a)}`, 'DELETE', undefined, false)).status, 401);
      assert.equal((await request('/api/workshops/999999/resume-entries')).status, 404);
      assert.equal((await request('/api/workshops/no/resume-entries')).status, 400);
      for (const body of [{ resume_entry_id: 'missing' }, { resume_entry_id: null },
        { resume_entry_id: '' }, { resume_entry_ids: [a] }, { resume_entry_id: b, status: 'Active' }]) {
        assert.equal((await request(path, 'POST', body)).status, 400);
      }
      assert.deepEqual((await api(path, 'POST', { resume_entry_id: b })).resume_entry_ids, [a, b].sort());
      assert.deepEqual((await api(path, 'POST', { resume_entry_id: b })).resume_entry_ids, [a, b].sort());
      await api(path, 'POST', { resume_entry_id: a }); // primary is not duplicated
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM public.crm_workshop_resume_links
        WHERE workshop_id = $1`, [first.id])).rows[0].n, 1);
      await api(`/api/workshops/${second.id}/resume-entries`, 'POST', { resume_entry_id: b });
      const reverse = await api(`/api/workshops?resume_entry_id=${encodeURIComponent(b)}`);
      assert.ok(reverse.some(w => w.id === first.id));
      assert.ok(reverse.some(w => w.id === second.id));
      const listed = (await api('/api/workshops')).find(w => w.id === first.id);
      assert.deepEqual(listed.resume_entry_ids, [a, b].sort());
      assert.deepEqual((await api(`/api/workshops/${first.id}`)).resume_entry_ids, [a, b].sort());
      await api(path, 'POST', { resume_entry_id: draft.id });
      assert.equal((await request(`/api/resume/workshops/${draft.id}`, 'DELETE')).status, 409);
      assert.equal((await api(`/api/resume/workshops/${draft.id}`)).published, false);
      await api(`${path}/${encodeURIComponent(draft.id)}`, 'DELETE');
      assert.deepEqual((await api(`${path}/unknown`, 'DELETE')).resume_entry_ids, [a, b].sort());
      assert.deepEqual((await api(`${path}/${encodeURIComponent(a)}`, 'DELETE')).resume_entry_ids, [b]);
      assert.equal((await api(`/api/workshops/${first.id}`)).resume_entry_id, null);
      assert.deepEqual((await pool.query(`SELECT to_jsonb(w) - 'resume_entry_id' AS state
        FROM public.crm_workshops w WHERE id = $1`, [first.id])).rows[0].state, before);
      assert.deepEqual((await pool.query('SELECT * FROM public.crm_activity_logs ORDER BY id')).rows, activityBefore);
      assert.deepEqual((await pool.query('SELECT * FROM public.crm_workshop_contacts ORDER BY workshop_id, contact_id')).rows, contactsBefore);
      assert.deepEqual((await request('/resume/workshops')).body, publicBefore);
      // Old clients replace/clear only the legacy slot; extra links survive.
      assert.deepEqual((await api(`/api/workshops/${first.id}`, 'PATCH', { resume_entry_id: a })).resume_entry_ids, [a, b].sort());
      assert.deepEqual((await api(`/api/workshops/${first.id}`, 'PUT', { resume_entry_id: null })).resume_entry_ids, [b]);
      assert.deepEqual((await api(`/api/workshops/${first.id}`, 'PATCH', { notes: 'Edited' })).resume_entry_ids, [b]);
      assert.deepEqual((await api(`/api/workshops/${first.id}/status`, 'PATCH', { status: 'Complete' })).resume_entry_ids, [b]);
      const rejected = await request(`/api/workshops/${first.id}`, 'PATCH', { resume_entry_ids: [], notes: 'Do not save' });
      assert.equal(rejected.status, 400);
      assert.equal((await api(`/api/workshops/${first.id}`)).notes, 'Edited');
      await api(`${path}/${encodeURIComponent(b)}`, 'DELETE');
      assert.deepEqual((await api(`/api/workshops/${second.id}/resume-entries`)).resume_entry_ids, [b]);
      await api(`/api/resume/workshops/${draft.id}`, 'DELETE');
    });
    await t.test('speaker menu is editable in the database with ordered categories and topics', async () => {
      const menu = await api('/api/speaker-menu');
      await api('/api/speaker-menu', 'PATCH', { subtitle: 'Updated database subtitle' });
      await api('/api/speaker-menu/categories', 'POST', {
        id: 'new-category', content: { title: 'New Category' }, published: true, sort_order: -1
      });
      await api('/api/speaker-menu/topics', 'POST', {
        id: 'new-topic', category_id: 'new-category', content: { title: 'New Topic', description: 'Description', type: 'workshop' },
        published: true
      });
      let feed = (await request('/speaker_data/speaker_menu.json')).body;
      assert.equal(feed.subtitle, 'Updated database subtitle');
      assert.equal(feed.categories[0].items[0].title, 'New Topic');
      await api('/api/speaker-menu/topics/new-topic', 'PATCH', { content: { title: 'Edited Topic' } });
      feed = (await request('/speaker_data/speaker_menu.json')).body;
      assert.equal(feed.categories[0].items[0].description, 'Description');
      assert.equal(feed.categories[0].items[0].title, 'Edited Topic');
      assert.equal((await request('/api/speaker-menu/categories/new-category', 'DELETE')).status, 409);
      await api('/api/speaker-menu/topics/new-topic', 'DELETE');
      await api('/api/speaker-menu/categories/new-category', 'DELETE');
      await api('/api/speaker-menu', 'PATCH', { subtitle: menu.subtitle });
    });
    await require('./helpers/workshop-resource-checks')(t, { pool, api, request, migratePortfolio });
    await t.test('testimonial imports are atomic, repeatable, preserve IDs/dates and keep distinct events', async () => {
      const before = (await pool.query('SELECT * FROM public.resume_testimonials ORDER BY id')).rows;
      const original = before.find(row => row.name === 'Kathleen McGurrin');
      const glenn = before.find(row => row.name === 'Glenn Talavera');
      const rows = [
        { name: 'Kathleen McGurrin', title: 'Human Resources', organization: 'County of Monmouth',
          event: 'Monmouth County Fall Employee Expo', date: '2026', category: 'WORKSHOP & EVENT ATTENDEES',
          quote: 'Exact new quote — with punctuation!' },
        { name: original.name, title: original.title, organization: original.organization,
          event: original.event, date: '', category: 'WORKSHOP & EVENT ATTENDEES',
          quote: 'Exact replacement quote.' },
        { name: glenn.name, title: glenn.title, organization: glenn.organization,
          event: 'Monmouth County · Public Speaking & Active Listening', date: '',
          category: 'WORKSHOP & EVENT ATTENDEES', quote: 'Exact Glenn quote.' }
      ];
      const preview = await importTestimonials(pool, rows, { dryRun: true });
      assert.equal(preview.created, 1);
      assert.equal(preview.matched, 2);
      assert.deepEqual((await pool.query('SELECT * FROM public.resume_testimonials ORDER BY id')).rows, before);
      const faultPool = { ...pool, async connect() {
        const db = await pool.connect();
        return { ...db, query(sql, params) {
          if (sql.startsWith('UPDATE public.resume_testimonials')) throw new Error('Import write failed');
          return db.query(sql, params);
        } };
      } };
      await assert.rejects(importTestimonials(faultPool, rows), /Import write failed/);
      assert.deepEqual((await pool.query('SELECT * FROM public.resume_testimonials ORDER BY id')).rows, before);
      const workshopBefore = (await request('/resume/workshops')).body;
      await importTestimonials(pool, rows);
      const imported = (await pool.query('SELECT * FROM public.resume_testimonials ORDER BY sort_order, id')).rows;
      assert.equal(imported.length, before.length + 1);
      assert.equal(imported[0].date, '2026');
      assert.equal(imported[1].id, original.id);
      assert.equal(imported[1].date, original.date);
      assert.equal(imported[2].id, glenn.id);
      assert.equal(imported[2].date, glenn.date);
      assert.deepEqual(imported.map(row => row.quote), rows.map(row => row.quote));
      const again = await importTestimonials(pool, rows);
      assert.equal(again.created, 0);
      assert.deepEqual((await pool.query('SELECT * FROM public.resume_testimonials ORDER BY sort_order, id')).rows, imported);
      const feed = (await request('/resume/testimonials', 'GET', undefined, false)).body;
      assert.deepEqual(feed.records.map(row => row.quote), rows.map(row => row.quote));
      assert.deepEqual((await request('/resume/workshops')).body, workshopBefore);
      // Ambiguous matches must stop the entire import, not guess or remove records.
      await api('/api/resume/testimonials', 'POST', { entry: { ...rows[0] } });
      await assert.rejects(importTestimonials(pool, rows), /Ambiguous/);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await client.query('ROLLBACK');
    await client.end();
  }
});
