'use strict';
const { randomUUID } = require('node:crypto');
const { transaction } = require('./store');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Accept the old GUI's ISO-midnight representation as well as date-only input.
// Preserve its written calendar date, never convert between timezones.
function legacyDate(value) {
  if (value === null || value === '') return null;
  if (validDate(value)) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]00:00:00(?:\.0{1,6})?(?:Z|[+-]00:00)?$/.test(value) &&
      validDate(value.slice(0, 10))) return value.slice(0, 10);
  throw fail('historical_date must be YYYY-MM-DD, an ISO midnight date, or null');
}

module.exports = function workshopDates(pool) {
  let available;
  const ready = () => available ||= pool.query(
    "SELECT to_regclass('public.crm_workshop_engagement_dates') AS relation"
  ).then(result => Boolean(result.rows[0]?.relation)).catch(error => { available = undefined; throw error; });
  const rows = async (db, id) => (await db.query(`SELECT id, workshop_id,
    to_char(engagement_date, 'YYYY-MM-DD') AS engagement_date
    FROM public.crm_workshop_engagement_dates WHERE workshop_id = $1 ORDER BY engagement_date, id`, [id])).rows;

  async function sync(db, id) {
    const result = await db.query(`SELECT id, historical_date::date::text AS legacy_date,
      historical_date::text AS original_date FROM public.crm_workshops WHERE id = $1 FOR UPDATE`, [id]);
    if (!result.rows.length) throw fail('Workshop not found', 404);
    const workshop = result.rows[0];
    if (workshop.legacy_date && !validDate(workshop.legacy_date)) {
      throw fail(`Cannot safely migrate historical_date for workshop ${id}: ${workshop.original_date}`, 409);
    }
    const children = (await db.query(`SELECT id, legacy_slot, additional,
      to_char(engagement_date, 'YYYY-MM-DD') AS engagement_date
      FROM public.crm_workshop_engagement_dates WHERE workshop_id = $1`, [id])).rows;
    const old = children.find(row => row.legacy_slot);
    const target = children.find(row => row.engagement_date === workshop.legacy_date);
    if (old && old.engagement_date === workshop.legacy_date) return;
    // An independently added date never becomes disposable just because an old
    // client also selected it. Only legacy-owned-only rows may be replaced/cleared.
    if (old?.additional) {
      await db.query('UPDATE public.crm_workshop_engagement_dates SET legacy_slot = false WHERE workshop_id = $1 AND id = $2', [id, old.id]);
    }
    if (!workshop.legacy_date || target) {
      if (old && !old.additional) await db.query('DELETE FROM public.crm_workshop_engagement_dates WHERE workshop_id = $1 AND id = $2', [id, old.id]);
      if (target) await db.query('UPDATE public.crm_workshop_engagement_dates SET legacy_slot = true WHERE workshop_id = $1 AND id = $2', [id, target.id]);
    } else if (old && !old.additional) {
      await db.query('UPDATE public.crm_workshop_engagement_dates SET engagement_date = $3 WHERE workshop_id = $1 AND id = $2',
        [id, old.id, workshop.legacy_date]);
    } else {
      await db.query(`INSERT INTO public.crm_workshop_engagement_dates(id,workshop_id,engagement_date,legacy_slot,additional)
        VALUES ($1,$2,$3,true,false)`, [randomUUID(), id, workshop.legacy_date]);
    }
  }

  // Data-only, idempotent backfill after Publish installs the schema. Parent locks
  // serialize legacy writes, child writes and first-read migration across workers.
  const run = async (id, action, required = false) => {
    if (!await ready()) {
      if (required) throw fail('Workshop engagement-date schema is pending. Publish the additive migration first.', 503);
      return action(pool, false);
    }
    return transaction(pool, async db => {
      if (id === undefined) await backfill(db);
      else await sync(db, id);
      return action(db, true);
    });
  };
  async function backfill(db) {
    // Once migrated, collection reads need one check, not N queries per workshop.
    const parents = (await db.query(`SELECT w.id FROM public.crm_workshops w
      LEFT JOIN public.crm_workshop_engagement_dates d ON d.workshop_id = w.id AND d.legacy_slot
      WHERE w.historical_date::date IS DISTINCT FROM d.engagement_date
      ORDER BY w.id FOR UPDATE OF w`)).rows;
    for (const parent of parents) await sync(db, parent.id);
  }
  async function decorate(db, data, enabled, changed = false) {
    if (!enabled) return data; // Older deployment schema: preserve the old contract.
    const workshops = Array.isArray(data) ? data : [data];
    // One batched query rather than one request/query per workshop.
    const ids = workshops.map(row => row.id);
    if (changed) for (const id of ids) await sync(db, id);
    const dates = (await db.query(`SELECT id, workshop_id,
      to_char(engagement_date, 'YYYY-MM-DD') AS engagement_date
      FROM public.crm_workshop_engagement_dates WHERE workshop_id = ANY($1::integer[])
      ORDER BY engagement_date, id`, [ids])).rows;
    for (const workshop of workshops) workshop.engagement_dates = dates.filter(row => row.workshop_id === workshop.id);
    return data;
  }
  return { ready, run, rows, decorate, backfill };
};
module.exports.validDate = validDate;
module.exports.legacyDate = legacyDate;
module.exports.fail = fail;
