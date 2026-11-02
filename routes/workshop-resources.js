'use strict';
const express = require('express');
const { randomUUID } = require('node:crypto');
const { transaction } = require('../portfolio/store');

module.exports = function workshopResources({ auditPool: pool, authenticate }) {
  const router = express.Router();
  const root = '/api/workshops/:id/resources';
  const fail = (message, status = 400) => Object.assign(new Error(message), { status });
  let schemaReady;
  const ready = () => schemaReady ||= pool.query(
    "SELECT to_regclass('public.crm_workshop_resources') AS relation"
  ).then(result => Boolean(result.rows[0]?.relation))
    .catch(error => { schemaReady = undefined; throw error; });
  const route = fn => async (req, res) => {
    try {
      if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) {
        throw fail('Invalid workshop id');
      }
      if (!await ready()) throw fail('Workshop resource schema is pending. Publish the additive database migration first.', 503);
      const data = await transaction(pool, async db => {
        // All resource operations serialize on the parent, keeping ordering atomic.
        const workshop = await db.query('SELECT id FROM public.crm_workshops WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!workshop.rows.length) throw fail('Workshop not found', 404);
        return fn(req, db);
      });
      res.json({ success: true, data });
    } catch (error) {
      res.status(error.status || 500).json({
        success: false, error: error.status ? error.message : 'Unable to manage workshop resources'
      });
    }
  };
  const list = async (db, id) => (await db.query(`SELECT * FROM public.crm_workshop_resources
    WHERE workshop_id = $1 ORDER BY sort_order, id`, [id])).rows;
  const bodyObject = body => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('A JSON object is required');
  };
  const validate = (body, create = false) => {
    bodyObject(body);
    if (!Object.keys(body).length || Object.keys(body).some(key => !['label', 'url', 'sort_order'].includes(key))) {
      throw fail('Send label, url, and optionally sort_order only');
    }
    const input = { ...body };
    if (create || Object.hasOwn(input, 'label')) {
      if (typeof input.label !== 'string' || !input.label.trim() || input.label.trim().length > 200) {
        throw fail('label must contain 1 to 200 characters');
      }
      input.label = input.label.trim();
    }
    if (create || Object.hasOwn(input, 'url')) {
      if (typeof input.url !== 'string') throw fail('url must be a valid HTTP/HTTPS URL');
      input.url = input.url.trim();
      let url;
      try { url = new URL(input.url); } catch {}
      if (!url || !/^https?:\/\//i.test(input.url) || !['http:', 'https:'].includes(url.protocol) ||
          !url.hostname || url.username || url.password || /\s/.test(input.url) || input.url.length > 4096) {
        throw fail('url must be an HTTP/HTTPS URL without credentials or unencoded whitespace (maximum 4096 characters)');
      }
    }
    if (Object.hasOwn(input, 'sort_order') && (!Number.isSafeInteger(input.sort_order) || input.sort_order < 0)) {
      throw fail('sort_order must be a non-negative integer');
    }
    return input;
  };
  const persistOrder = async (db, workshopId, rows) => {
    for (const [index, row] of rows.entries()) {
      await db.query(`UPDATE public.crm_workshop_resources SET sort_order = $3, updated_at = NOW()
        WHERE workshop_id = $1 AND id = $2 AND sort_order IS DISTINCT FROM $3`, [workshopId, row.id, index]);
    }
  };
  router.get(root, authenticate, route((req, db) => list(db, req.params.id)));
  router.post(root, authenticate, route(async (req, db) => {
    const input = validate(req.body, true);
    const rows = await list(db, req.params.id);
    const position = input.sort_order ?? rows.length;
    if (position > rows.length) throw fail(`sort_order must be between 0 and ${rows.length}`);
    const result = await db.query(`INSERT INTO public.crm_workshop_resources
      (id, workshop_id, label, url, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [randomUUID(), req.params.id, input.label, input.url, position]);
    rows.splice(position, 0, result.rows[0]);
    await persistOrder(db, req.params.id, rows);
    return (await list(db, req.params.id)).find(row => row.id === result.rows[0].id);
  }));
  // Register before the parameterized PUT route: "reorder" is not a resource ID.
  router.put(`${root}/reorder`, authenticate, route(async (req, db) => {
    bodyObject(req.body);
    const ids = req.body.resource_ids;
    if (Object.keys(req.body).length !== 1 || !Array.isArray(ids) ||
        ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
      throw fail('resource_ids must be an array of unique resource ID strings');
    }
    const rows = await list(db, req.params.id);
    const byId = new Map(rows.map(row => [row.id, row]));
    if (ids.length !== rows.length || ids.some(id => !byId.has(id))) {
      throw fail('resource_ids must contain every current resource for this workshop exactly once; refresh and retry', 409);
    }
    await persistOrder(db, req.params.id, ids.map(id => byId.get(id)));
    return list(db, req.params.id);
  }));
  const update = route(async (req, db) => {
    const input = validate(req.body);
    const rows = await list(db, req.params.id);
    const currentIndex = rows.findIndex(row => row.id === req.params.resource_id);
    if (currentIndex < 0) throw fail('Resource not found in this workshop', 404);
    const position = input.sort_order ?? currentIndex;
    if (position >= rows.length) throw fail(`sort_order must be between 0 and ${rows.length - 1}`);
    const current = rows[currentIndex];
    await db.query(`UPDATE public.crm_workshop_resources SET label = $3, url = $4, updated_at = NOW()
      WHERE workshop_id = $1 AND id = $2`, [req.params.id, current.id,
      input.label ?? current.label, input.url ?? current.url]);
    rows.splice(currentIndex, 1);
    rows.splice(position, 0, current);
    await persistOrder(db, req.params.id, rows);
    return (await list(db, req.params.id)).find(row => row.id === current.id);
  });
  router.patch(`${root}/:resource_id`, authenticate, update);
  router.put(`${root}/:resource_id`, authenticate, update);
  router.delete(`${root}/:resource_id`, authenticate, route(async (req, db) => {
    const result = await db.query(`DELETE FROM public.crm_workshop_resources
      WHERE workshop_id = $1 AND id = $2 RETURNING id`, [req.params.id, req.params.resource_id]);
    if (!result.rows.length) throw fail('Resource not found in this workshop', 404);
    await persistOrder(db, req.params.id, await list(db, req.params.id));
    return { deleted_id: result.rows[0].id };
  }));
  return router;
};
