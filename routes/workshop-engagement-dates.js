'use strict';
const express = require('express');
const { randomUUID } = require('node:crypto');
const { validDate, fail } = require('../portfolio/workshop-dates');

module.exports = function workshopEngagementDates({ authenticate }, dates) {
  const router = express.Router();
  const root = '/api/workshops/:id/engagement-dates';
  const route = fn => async (req, res) => {
    try {
      if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) throw fail('Invalid workshop id');
      const data = await dates.run(req.params.id, db => fn(req, db), true);
      res.json({ success: true, data });
    } catch (e) {
      res.status(e.status || (e.code === '23505' ? 409 : 500)).json({
        success: false, error: e.code === '23505' ? 'This workshop already has that engagement date'
          : e.status ? e.message : 'Unable to manage engagement dates'
      });
    }
  };
  function input(body) {
    if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || !validDate(body.engagement_date)) {
      throw fail('Send only engagement_date as a real YYYY-MM-DD calendar date');
    }
    return body.engagement_date;
  }
  const current = async (db, req) => {
    const result = await db.query(`SELECT id, legacy_slot FROM public.crm_workshop_engagement_dates
      WHERE workshop_id = $1 AND id = $2`, [req.params.id, req.params.date_id]);
    if (!result.rows.length) throw fail('Engagement date not found in this workshop', 404);
    return result.rows[0];
  };
  router.get(root, authenticate, route((req, db) => dates.rows(db, req.params.id)));
  router.post(root, authenticate, route(async (req, db) => {
    const date = input(req.body);
    const id = randomUUID();
    await db.query(`INSERT INTO public.crm_workshop_engagement_dates(id,workshop_id,engagement_date)
      VALUES ($1,$2,$3)`, [id, req.params.id, date]);
    return (await dates.rows(db, req.params.id)).find(row => row.id === id);
  }));
  const update = route(async (req, db) => {
    const row = await current(db, req);
    const date = input(req.body);
    await db.query(`UPDATE public.crm_workshop_engagement_dates SET engagement_date = $3
      WHERE workshop_id = $1 AND id = $2`, [req.params.id, row.id, date]);
    if (row.legacy_slot) await db.query('UPDATE public.crm_workshops SET historical_date = $2 WHERE id = $1', [req.params.id, date]);
    return (await dates.rows(db, req.params.id)).find(item => item.id === row.id);
  });
  router.put(`${root}/:date_id`, authenticate, update);
  router.patch(`${root}/:date_id`, authenticate, update);
  router.delete(`${root}/:date_id`, authenticate, route(async (req, db) => {
    const row = await current(db, req);
    await db.query('DELETE FROM public.crm_workshop_engagement_dates WHERE workshop_id = $1 AND id = $2', [req.params.id, row.id]);
    if (row.legacy_slot) await db.query('UPDATE public.crm_workshops SET historical_date = NULL WHERE id = $1', [req.params.id]);
    return { deleted_id: row.id };
  }));
  return router;
};
