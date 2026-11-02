'use strict';
const express = require('express');
const { transaction } = require('../portfolio/store');
const { resumeIdsSql, linkSchema } = require('../portfolio/workshop-links');
const { validateResumeEntryReference } = require('../resumeWorkshopCatalog');

module.exports = function workshopResumeLinks({ auditPool: pool, authenticate }) {
  const router = express.Router();
  const ready = linkSchema(pool);
  const failure = (message, status) => Object.assign(new Error(message), { status });
  const route = fn => async (req, res) => {
    try {
      if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) {
        throw failure('Invalid workshop id', 400);
      }
      if (!await ready()) throw failure('Workshop link schema is pending. Publish the additive database migration first.', 503);
      const data = await transaction(pool, db => fn(req, db));
      res.json({ success: true, data });
    } catch (error) {
      const status = error.status || (error.code === '23503' ? 409 : 500);
      res.status(status).json({ success: false, error: status === 500 ? 'Unable to manage workshop links' : error.message });
    }
  };
  const workshop = async (db, id) => {
    // Serialize link edits with legacy workshop edits/deletion.
    const found = await db.query('SELECT id FROM public.crm_workshops WHERE id = $1 FOR UPDATE', [id]);
    if (!found.rows.length) throw failure('Workshop not found', 404);
  };
  const links = async (db, id) => {
    const result = await db.query(`SELECT id AS workshop_id, ${resumeIdsSql('w')}
      FROM public.crm_workshops w WHERE id = $1`, [id]);
    return result.rows[0];
  };
  router.get('/api/workshops/:id/resume-entries', authenticate, route(async (req, db) => {
    await workshop(db, req.params.id);
    return links(db, req.params.id);
  }));
  router.post('/api/workshops/:id/resume-entries', authenticate, route(async (req, db) => {
    const body = req.body;
    if (!body || Object.keys(body).length !== 1 || typeof body.resume_entry_id !== 'string' ||
        !body.resume_entry_id.trim()) throw failure('Send only a non-empty resume_entry_id string', 400);
    await workshop(db, req.params.id);
    const error = await validateResumeEntryReference(body.resume_entry_id, db);
    if (error) throw failure(error, 400);
    await db.query(`INSERT INTO public.crm_workshop_resume_links(workshop_id, resume_entry_id)
      SELECT id, $2 FROM public.crm_workshops
      WHERE id = $1 AND resume_entry_id IS DISTINCT FROM $2
      ON CONFLICT DO NOTHING`, [req.params.id, body.resume_entry_id]);
    return links(db, req.params.id);
  }));
  router.delete('/api/workshops/:id/resume-entries/:resume_entry_id', authenticate, route(async (req, db) => {
    await workshop(db, req.params.id);
    await db.query('DELETE FROM public.crm_workshop_resume_links WHERE workshop_id = $1 AND resume_entry_id = $2',
      [req.params.id, req.params.resume_entry_id]);
    // A requested unlink must also remove the matching legacy slot, not other links.
    await db.query(`UPDATE public.crm_workshops SET resume_entry_id = NULL
      WHERE id = $1 AND resume_entry_id = $2`, [req.params.id, req.params.resume_entry_id]);
    return links(db, req.params.id);
  }));
  return router;
};
