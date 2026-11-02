'use strict';
const express = require('express');
const { categories, validateEntry } = require('../portfolio/catalog');
const { transaction, adminRecord, readFeed, saveEntry, readSpeakerMenu } = require('../portfolio/store');

const own = (obj, key) => Object.hasOwn(obj, key);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const integerId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

function validateFields(body, fields, { required = [], partial = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Body must be an object');
  for (const key of Object.keys(body)) if (!own(fields, key)) throw fail(`Unknown field: ${key}`);
  if (!partial) for (const key of required) if (!own(body, key) || body[key] === null) throw fail(`${key} is required`);
  for (const [key, value] of Object.entries(body)) {
    const type = fields[key];
    if (value === null) {
      if (required.includes(key)) throw fail(`${key} cannot be null`);
      continue;
    }
    if (type === 'text' && typeof value !== 'string') throw fail(`${key} must be text or null`);
    if (required.includes(key) && typeof value === 'string' && !value.trim()) throw fail(`${key} cannot be empty`);
    if (type === 'id' && !integerId(value)) throw fail(`${key} must be a positive integer or null`);
    if (type === 'count' && (!Number.isSafeInteger(value) || value < 0)) throw fail(`${key} must be a non-negative integer or null`);
    if (type === 'order' && !Number.isSafeInteger(value)) throw fail(`${key} must be an integer`);
    if (type === 'boolean' && typeof value !== 'boolean') throw fail(`${key} must be boolean`);
    if (type === 'object' && (typeof value !== 'object' || Array.isArray(value))) throw fail(`${key} must be an object`);
    if (type === 'date' && !validDate(value)) throw fail(`${key} must be a valid YYYY-MM-DD date`);
    if (type === 'instant' && (typeof value !== 'string' ||
        !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || Number.isNaN(Date.parse(value)))) {
      throw fail(`${key} must be an ISO timestamp with an explicit offset`);
    }
  }
  if (own(body, 'time_zone')) {
    if (body.time_zone === null) throw fail('time_zone cannot be null');
    try { new Intl.DateTimeFormat('en', { timeZone: body.time_zone }); }
    catch { throw fail('Invalid time_zone'); }
  }
}

module.exports = function portfolioRoutes({ auditPool: pool, authenticate }) {
  const router = express.Router();
  const ok = (res, data) => res.json({ success: true, data });
  const route = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      const status = e.status || ({ '23503': 409, '23505': 409, '23514': 400, '22P02': 400, '22007': 400, '22008': 400 }[e.code]) || 500;
      const message = e.status ? e.message : status === 409
        ? 'Record is referenced by another record, or its unique ID/name already exists'
        : status === 400 ? 'Invalid field value or reference' : 'Database operation failed';
      if (status === 500) console.error('Portfolio API:', e.message);
      res.status(status).json({ success: false, error: message });
    }
  };
  const requireCategory = value => {
    if (!own(categories, value)) throw fail('Unknown resume category', 404);
    return categories[value];
  };
  const requireWorkshop = async (db, id) => {
    if (!integerId(id)) throw fail('Invalid workshop ID');
    const result = await db.query('SELECT id FROM public.crm_workshops WHERE id = $1', [id]);
    if (!result.rows.length) throw fail('Workshop not found', 404);
  };

  router.get('/api/resume/categories', authenticate, route(async (req, res) => {
    ok(res, Object.entries(categories).map(([category, config]) => ({
      category, root: config.root, fields: config.fields,
      ...(category === 'workshops' ? { sessions: 'array of public session objects' } : {})
    })));
  }));
  router.get('/api/resume/:category', authenticate, route(async (req, res) => {
    const config = requireCategory(req.params.category);
    const rows = await pool.query(`SELECT * FROM public.${config.table} ORDER BY sort_order, id`);
    ok(res, await Promise.all(rows.rows.map(row => adminRecord(pool, req.params.category, row))));
  }));
  router.get('/api/resume/:category/:id', authenticate, route(async (req, res) => {
    const config = requireCategory(req.params.category);
    const result = await pool.query(`SELECT * FROM public.${config.table} WHERE id = $1`, [req.params.id]);
    if (!result.rows.length) throw fail('Resume entry not found', 404);
    ok(res, await adminRecord(pool, req.params.category, result.rows[0]));
  }));
  const writeResume = updating => route(async (req, res) => {
    const category = req.params.category;
    const config = requireCategory(category);
    validateFields(req.body, {
      entry: 'object', published: 'boolean', sort_order: 'order', organization_id: 'id'
    }, { required: updating ? [] : ['entry'], partial: updating });
    if (own(req.body, 'published') && req.body.published === null) throw fail('published cannot be null');
    if (own(req.body, 'sort_order') && req.body.sort_order === null) throw fail('sort_order cannot be null');
    if (own(req.body, 'entry')) {
      const error = validateEntry(category, req.body.entry);
      if (error) throw fail(error);
    }
    if (!updating) {
      const titleKey = ['awards', 'certificates'].includes(category) ? 'title' : category === 'testimonials' ? 'name' : 'label';
      if (typeof req.body.entry[titleKey] !== 'string' || !req.body.entry[titleKey].trim()) {
        throw fail(`entry.${titleKey} is required`);
      }
    }
    if (!Object.keys(req.body).length) throw fail('No fields to update');
    const result = await transaction(pool, async db => {
      let current = null;
      if (updating) {
        const found = await db.query(`SELECT * FROM public.${config.table} WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!found.rows.length) throw fail('Resume entry not found', 404);
        current = found.rows[0];
        if (own(req.body.entry || {}, 'id') && req.body.entry.id !== current.id) throw fail('Entry IDs are permanent and cannot be changed');
      }
      return saveEntry(db, category, req.body, current);
    });
    ok(res, result);
  });
  router.post('/api/resume/:category', authenticate, writeResume(false));
  router.put('/api/resume/:category/:id', authenticate, writeResume(true));
  router.patch('/api/resume/:category/:id', authenticate, writeResume(true));
  router.delete('/api/resume/:category/:id', authenticate, route(async (req, res) => {
    const config = requireCategory(req.params.category);
    const result = await pool.query(`DELETE FROM public.${config.table} WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows.length) throw fail('Resume entry not found', 404);
    ok(res, { deleted_id: result.rows[0].id });
  }));

  // Old static JSON URLs now read from the same database, not stale backup files.
  for (const prefix of ['/resume_data', '/resume']) {
    router.get(`${prefix}/:filename`, route(async (req, res) => {
      const category = req.params.filename.replace(/\.json$/, '');
      if (!own(categories, category)) {
        if (prefix === '/resume_data') return res.status(404).json({ error: 'Resume feed not found' });
        return res.status(404).json({ error: 'Resume feed not found' });
      }
      res.json(await readFeed(pool, category));
    }));
  }

  const resources = [
    { path: '/api/organizations', table: 'crm_organizations', fields: { name: 'text', website: 'text', notes: 'text' }, required: ['name'] },
    { path: '/api/events', table: 'crm_events', fields: {
      organization_id: 'id', name: 'text', event_date: 'date', venue_name: 'text', venue_address: 'text', notes: 'text'
    }, required: ['name'] }
  ];
  for (const config of resources) {
    router.get(config.path, authenticate, route(async (req, res) => {
      const params = [];
      let where = '';
      if (config.table === 'crm_events' && req.query.organization_id) {
        if (!integerId(req.query.organization_id)) throw fail('Invalid organization_id');
        params.push(req.query.organization_id); where = ' WHERE organization_id = $1';
      }
      ok(res, (await pool.query(`SELECT * FROM public.${config.table}${where} ORDER BY id`, params)).rows);
    }));
    router.get(`${config.path}/:id`, authenticate, route(async (req, res) => {
      if (!integerId(req.params.id)) throw fail('Invalid ID');
      const result = await pool.query(`SELECT * FROM public.${config.table} WHERE id = $1`, [req.params.id]);
      if (!result.rows.length) throw fail('Record not found', 404);
      ok(res, result.rows[0]);
    }));
    const write = updating => route(async (req, res) => {
      validateFields(req.body, config.fields, { required: config.required, partial: updating });
      const keys = Object.keys(req.body);
      if (!keys.length) throw fail('No fields to update');
      const params = keys.map(k => req.body[k]);
      let result;
      if (updating) {
        if (!integerId(req.params.id)) throw fail('Invalid ID');
        params.push(req.params.id);
        result = await pool.query(`UPDATE public.${config.table} SET
          ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = NOW()
          WHERE id = $${params.length} RETURNING *`, params);
        if (!result.rows.length) throw fail('Record not found', 404);
      } else {
        result = await pool.query(`INSERT INTO public.${config.table} (${keys.join(', ')})
          VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, params);
      }
      ok(res, result.rows[0]);
    });
    router.post(config.path, authenticate, write(false));
    router.put(`${config.path}/:id`, authenticate, write(true));
    router.patch(`${config.path}/:id`, authenticate, write(true));
    router.delete(`${config.path}/:id`, authenticate, route(async (req, res) => {
      if (!integerId(req.params.id)) throw fail('Invalid ID');
      const result = await pool.query(`DELETE FROM public.${config.table} WHERE id = $1 RETURNING id`, [req.params.id]);
      if (!result.rows.length) throw fail('Record not found', 404);
      ok(res, { deleted_id: result.rows[0].id });
    }));
  }

  router.get('/api/organizations/:id/contacts', authenticate, route(async (req, res) => {
    ok(res, (await pool.query(`SELECT c.* FROM public.crm_organization_contacts oc
      JOIN public.crm_contacts c ON c.id = oc.contact_id WHERE oc.organization_id = $1 ORDER BY c.id`, [req.params.id])).rows);
  }));
  router.post('/api/organizations/:id/contacts', authenticate, route(async (req, res) => {
    validateFields(req.body, { contact_id: 'id' }, { required: ['contact_id'] });
    await pool.query(`INSERT INTO public.crm_organization_contacts(organization_id, contact_id)
      VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, req.body.contact_id]);
    ok(res, { organization_id: Number(req.params.id), contact_id: Number(req.body.contact_id) });
  }));
  router.delete('/api/organizations/:id/contacts/:contact_id', authenticate, route(async (req, res) => {
    await pool.query('DELETE FROM public.crm_organization_contacts WHERE organization_id = $1 AND contact_id = $2',
      [req.params.id, req.params.contact_id]);
    ok(res, {});
  }));

  const sessionFields = {
    starts_at: 'instant', time_zone: 'text', duration_minutes: 'count', attendees: 'count',
    venue_name: 'text', venue_address: 'text', notes: 'text'
  };
  router.get('/api/workshops/:id/sessions', authenticate, route(async (req, res) => {
    await requireWorkshop(pool, req.params.id);
    ok(res, (await pool.query(`SELECT * FROM public.crm_workshop_sessions
      WHERE workshop_id = $1 ORDER BY starts_at NULLS LAST, id`, [req.params.id])).rows);
  }));
  const writeSession = updating => route(async (req, res) => {
    validateFields(req.body, sessionFields, { partial: true });
    const keys = Object.keys(req.body);
    if (!keys.length) throw fail('At least one session field is required');
    const result = await transaction(pool, async db => {
      await requireWorkshop(db, req.params.id);
      const values = keys.map(k => req.body[k]);
      if (updating) {
        values.push(req.params.id, req.params.session_id);
        const found = await db.query(`UPDATE public.crm_workshop_sessions SET
          ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = NOW()
          WHERE workshop_id = $${values.length - 1} AND id = $${values.length} RETURNING *`, values);
        if (!found.rows.length) throw fail('Session not found in this workshop', 404);
        return found.rows[0];
      }
      values.push(req.params.id);
      return (await db.query(`INSERT INTO public.crm_workshop_sessions (${keys.join(', ')}, workshop_id)
        VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, values)).rows[0];
    });
    ok(res, result);
  });
  router.post('/api/workshops/:id/sessions', authenticate, writeSession(false));
  router.put('/api/workshops/:id/sessions/:session_id', authenticate, writeSession(true));
  router.patch('/api/workshops/:id/sessions/:session_id', authenticate, writeSession(true));
  router.delete('/api/workshops/:id/sessions/:session_id', authenticate, route(async (req, res) => {
    const result = await pool.query(`DELETE FROM public.crm_workshop_sessions
      WHERE workshop_id = $1 AND id = $2 RETURNING id`, [req.params.id, req.params.session_id]);
    if (!result.rows.length) throw fail('Session not found in this workshop', 404);
    ok(res, { deleted_id: result.rows[0].id });
  }));
  router.get('/api/workshops/:id/activity-logs', authenticate, route(async (req, res) => {
    await requireWorkshop(pool, req.params.id);
    ok(res, (await pool.query(`SELECT a.*, c.name AS contact_name FROM public.crm_activity_logs a
      LEFT JOIN public.crm_contacts c ON c.id = a.contact_id
      WHERE a.workshop_id = $1 ORDER BY a.log_date DESC, a.id DESC`, [req.params.id])).rows);
  }));
  router.post('/api/workshops/:id/activity-logs', authenticate, route(async (req, res) => {
    validateFields(req.body, { log_text: 'text', contact_id: 'id', log_date: 'instant' }, { required: ['log_text'] });
    const result = await transaction(pool, async db => {
      await requireWorkshop(db, req.params.id);
      const inserted = await db.query(`INSERT INTO public.crm_activity_logs
        (entity_type, entity_id, workshop_id, contact_id, log_text, log_date)
        VALUES ('workshop',$1,$1,$2,$3,COALESCE($4::timestamptz, NOW())) RETURNING *`,
      [req.params.id, req.body.contact_id ?? null, req.body.log_text, req.body.log_date ?? null]);
      if (req.body.contact_id) await db.query('UPDATE public.crm_contacts SET last_contact_date = NOW() WHERE id = $1', [req.body.contact_id]);
      return inserted.rows[0];
    });
    ok(res, result);
  }));
  router.get('/api/workshops/:id/history', authenticate, route(async (req, res) => {
    if (!integerId(req.params.id)) throw fail('Invalid workshop ID');
    ok(res, (await pool.query(`SELECT * FROM public.portfolio_change_history
      WHERE workshop_id = $1 ORDER BY id DESC`, [req.params.id])).rows);
  }));
  router.get('/api/portfolio/history', authenticate, route(async (req, res) => {
    const { resource_type, resource_id } = req.query;
    const allowed = [...Object.values(categories).map(c => c.table), 'crm_workshops',
      'crm_workshop_sessions', 'crm_organizations', 'crm_events', 'crm_activity_logs',
      'crm_workshop_contacts', 'crm_organization_contacts', 'resume_workshop_sessions',
      'speaker_menu', 'speaker_categories', 'speaker_topics'];
    if (!allowed.includes(resource_type) || !resource_id) throw fail('Valid resource_type and resource_id are required');
    ok(res, (await pool.query(`SELECT * FROM public.portfolio_change_history
      WHERE resource_type = $1 AND resource_id = $2 ORDER BY id DESC`, [resource_type, resource_id])).rows);
  }));

  router.get('/speaker_data/speaker_menu.json', route(async (req, res) => res.json(await readSpeakerMenu(pool))));
  router.get('/api/speaker-menu', authenticate, route(async (req, res) => {
    const menu = await pool.query('SELECT title, subtitle FROM public.speaker_menu WHERE id = 1');
    const groups = await pool.query('SELECT * FROM public.speaker_categories ORDER BY sort_order, id');
    const topics = await pool.query('SELECT * FROM public.speaker_topics ORDER BY sort_order, id');
    ok(res, { ...menu.rows[0], categories: groups.rows, topics: topics.rows });
  }));
  router.patch('/api/speaker-menu', authenticate, route(async (req, res) => {
    validateFields(req.body, { title: 'text', subtitle: 'text' }, { required: ['title', 'subtitle'], partial: true });
    const keys = Object.keys(req.body);
    if (!keys.length) throw fail('No fields to update');
    ok(res, (await pool.query(`UPDATE public.speaker_menu SET
      ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = 1 RETURNING *`,
    keys.map(k => req.body[k]))).rows[0]);
  }));

  // Speaker menu content is separate from completed engagements.
  for (const kind of ['categories', 'topics']) {
    const table = `speaker_${kind}`;
    const path = `/api/speaker-menu/${kind}`;
    const allowed = { id: 'text', content: 'object', published: 'boolean', sort_order: 'order',
      ...(kind === 'topics' ? { category_id: 'text' } : {}) };
    const write = updating => route(async (req, res) => {
      validateFields(req.body, allowed, {
        required: ['id', 'content', 'published', 'sort_order', ...(kind === 'topics' ? ['category_id'] : [])],
        partial: true
      });
      if (!updating && (!req.body.id?.trim() || !req.body.content || (kind === 'topics' && !req.body.category_id))) {
        throw fail('id, content, and (for topics) category_id are required');
      }
      if (updating && own(req.body, 'id') && req.body.id !== req.params.id) throw fail('IDs are permanent');
      const result = await transaction(pool, async db => {
        let current;
        if (updating) {
          current = (await db.query(`SELECT * FROM public.${table} WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
          if (!current) throw fail('Record not found', 404);
        }
        const content = { ...current?.content, ...req.body.content };
        const id = current?.id || req.body.id;
        if (!content.title || typeof content.title !== 'string') throw fail('content.title is required');
        if (content.id !== undefined && content.id !== id) throw fail('content.id must match the permanent ID');
        if (kind === 'categories' && own(content, 'items')) throw fail('Manage category items through the topics API');
        content.id = id;
        const input = {
          id, content: JSON.stringify(content), sort_order: req.body.sort_order ?? current?.sort_order ?? 0,
          published: req.body.published ?? current?.published ?? false,
          ...(kind === 'topics' ? { category_id: req.body.category_id ?? current?.category_id } : {})
        };
        const keys = Object.keys(input);
        const params = Object.values(input);
        if (updating) return (await db.query(`UPDATE public.${table} SET
          ${keys.slice(1).map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, params)).rows[0];
        return (await db.query(`INSERT INTO public.${table} (${keys.join(', ')})
          VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, params)).rows[0];
      });
      ok(res, result);
    });
    router.post(path, authenticate, write(false));
    router.put(`${path}/:id`, authenticate, write(true));
    router.patch(`${path}/:id`, authenticate, write(true));
    router.delete(`${path}/:id`, authenticate, route(async (req, res) => {
      const result = await pool.query(`DELETE FROM public.${table} WHERE id = $1 RETURNING id`, [req.params.id]);
      if (!result.rows.length) throw fail('Record not found', 404);
      ok(res, { deleted_id: result.rows[0].id });
    }));
  }
  return router;
};
