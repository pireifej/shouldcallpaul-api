'use strict';
const assert = require('node:assert/strict');
const makeDates = require('../../portfolio/workshop-dates');

module.exports = async function workshopDateChecks({ t, pool, api, request, migratePortfolio }) {
  const parent = await api('/api/workshops', 'POST', {
    organization_name: 'Date testing', status: 'Complete', historical_date: '2026-10-07T00:00:00.000Z',
    notes: 'Keep private notes', fee_amount: 50, fee_type: 'flat'
  });
  const other = await api('/api/workshops', 'POST', { organization_name: 'Other date testing' });
  const root = `/api/workshops/${parent.id}/engagement-dates`;
  const workshop = `/api/workshops/${parent.id}`;
  const legacyId = parent.engagement_dates[0].id;
  let extra;
  await t.test('engagement-date migration materializes legacy calendar dates with permanent IDs and is repeatable', async () => {
    const existing = (await api('/api/workshops/1')).engagement_dates;
    assert.equal(existing[0].engagement_date, '2026-10-07');
    assert.equal(parent.engagement_dates[0].engagement_date, '2026-10-07');
    assert.match(legacyId, /^[0-9a-f-]{36}$/);
    await migratePortfolio(pool);
    assert.deepEqual((await api(workshop)).engagement_dates, parent.engagement_dates);
    assert.deepEqual((await api('/api/workshops/1')).engagement_dates, existing);
    assert.deepEqual(other.engagement_dates, []);
    assert.deepEqual(await api(`/api/workshops/${other.id}/engagement-dates`), []);
  });
  await t.test('engagement-date CRUD, chronological list and workshop list/detail embedded collections', async () => {
    extra = await api(root, 'POST', { engagement_date: '2026-11-08' });
    const early = await api(root, 'POST', { engagement_date: '2026-09-01' });
    assert.equal(extra.workshop_id, parent.id);
    let dates = await api(root);
    assert.deepEqual(dates.map(row => row.engagement_date), ['2026-09-01', '2026-10-07', '2026-11-08']);
    assert.deepEqual((await api(workshop)).engagement_dates, dates);
    assert.deepEqual((await api('/api/workshops')).find(row => row.id === parent.id).engagement_dates, dates);
    const edited = await api(`${root}/${extra.id}`, 'PATCH', { engagement_date: '2026-11-09' });
    assert.equal(edited.id, extra.id);
    assert.equal(edited.engagement_date, '2026-11-09');
    assert.deepEqual(await api(`${root}/${early.id}`, 'DELETE'), { deleted_id: early.id });
    assert.equal((await request(`${root}/${early.id}`, 'DELETE')).status, 404);
  });
  await t.test('real calendar validation, duplicate conflicts and read-only collection fail without changes', async () => {
    const before = await api(root);
    for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '0000-01-01',
      '2026-1-01', '2026-11-07T00:00:00Z', '', null, 20261007, 'infinity']) {
      assert.equal((await request(root, 'POST', { engagement_date: value })).status, 400);
    }
    for (const body of [{}, [], { engagement_date: '2026-12-01', id: 'client-id' },
      { engagement_date: '2026-12-01', workshop_id: other.id }]) {
      assert.equal((await request(root, 'POST', body)).status, 400);
    }
    assert.equal((await request(root, 'POST', { engagement_date: '2026-10-07' })).status, 409);
    assert.equal((await request(`${root}/${extra.id}`, 'PUT', { engagement_date: '2026-10-07' })).status, 409);
    assert.equal((await request(workshop, 'PATCH', { engagement_dates: [], notes: 'Do not save' })).status, 400);
    assert.equal((await api(workshop)).notes, 'Keep private notes');
    assert.deepEqual(await api(root), before);
    const leap = await api(root, 'POST', { engagement_date: '2028-02-29' });
    await api(`${root}/${leap.id}`, 'DELETE');
  });
  await t.test('date ownership is enforced for update and delete; all endpoints require authentication', async () => {
    const foreign = `/api/workshops/${other.id}/engagement-dates/${extra.id}`;
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      assert.equal((await request(foreign, method, method === 'DELETE' ? undefined : { engagement_date: '2027-01-01' })).status, 404);
    }
    for (const [url, method, body] of [
      [root, 'GET'], [root, 'POST', { engagement_date: '2027-01-01' }],
      [`${root}/${extra.id}`, 'PUT', { engagement_date: '2027-01-01' }],
      [`${root}/${extra.id}`, 'PATCH', { engagement_date: '2027-01-01' }],
      [`${root}/${extra.id}`, 'DELETE']
    ]) assert.equal((await request(url, method, body, false)).status, 401);
    assert.equal((await request('/api/workshops/999999/engagement-dates')).status, 404);
    assert.equal((await request('/api/workshops/no/engagement-dates')).status, 400);
    assert.equal((await api(root)).length, 2);
  });
  await t.test('legacy updates, omission and clearing preserve independently added dates and stable IDs', async () => {
    await api(workshop, 'PUT', { historical_date: '2026-10-08' });
    assert.equal((await api(root)).find(row => row.id === legacyId).engagement_date, '2026-10-08');
    await api(workshop, 'PATCH', { notes: 'Keep private notes' });
    assert.equal((await api(root)).length, 2);
    await api(workshop, 'PATCH', { historical_date: null });
    assert.deepEqual((await api(root)).map(row => row.id), [extra.id]);
    // Selecting an already-added date in an older GUI must not transfer ownership.
    await api(workshop, 'PATCH', { historical_date: '2026-11-09' });
    assert.deepEqual((await api(root)).map(row => row.id), [extra.id]);
    await api(workshop, 'PUT', { historical_date: '' });
    assert.deepEqual((await api(root)).map(row => row.id), [extra.id]);
    await api(workshop, 'PATCH', { historical_date: '2026-11-09' });
    await api(workshop, 'PATCH', { historical_date: '2026-10-09' });
    assert.ok((await api(root)).some(row => row.id === extra.id));
    const newLegacy = (await api(root)).find(row => row.id !== extra.id);
    await api(`${root}/${newLegacy.id}`, 'PUT', { engagement_date: '2026-10-10' });
    assert.match((await pool.query('SELECT historical_date::text AS date FROM public.crm_workshops WHERE id = $1', [parent.id])).rows[0].date, /^2026-10-10 /);
    await api(`${root}/${newLegacy.id}`, 'DELETE');
    assert.equal((await api(workshop)).historical_date, null);
    assert.deepEqual((await api(root)).map(row => row.id), [extra.id]);
  });
  await t.test('date-only results remain identical across database timezones and invalid legacy writes are atomic', async () => {
    const before = await api(root);
    for (const zone of ['Pacific/Honolulu', 'Pacific/Kiritimati', 'America/New_York']) {
      await pool.query("SELECT set_config('TimeZone',$1,true)", [zone]);
      assert.deepEqual(await api(root), before);
    }
    await pool.query("SELECT set_config('TimeZone','UTC',true)");
    for (const value of ['2026-02-30', '2026-10-07T23:00:00-05:00', 'not-a-date']) {
      assert.equal((await request(workshop, 'PATCH', { historical_date: value, notes: 'Do not save' })).status, 400);
    }
    assert.equal((await api(workshop)).notes, 'Keep private notes');
    assert.deepEqual(await api(root), before);
  });
  await t.test('all statuses allow dates without changing CRM data, links, private history or public feeds', async () => {
    const beforeFeeds = {};
    for (const category of ['workshops', 'conference', 'speech', 'hackathon', 'patent',
      'projects', 'races', 'awards', 'certificates', 'testimonials']) {
      beforeFeeds[category] = (await request(`/resume/${category}`)).body;
    }
    for (const status of ['Active', 'In Progress', 'Complete', 'Inactive']) {
      await api(`${workshop}/status`, 'PATCH', { status });
      const before = (await pool.query('SELECT * FROM public.crm_workshops WHERE id = $1', [parent.id])).rows[0];
      const logs = (await pool.query('SELECT * FROM public.crm_activity_logs ORDER BY id')).rows;
      const resources = (await pool.query('SELECT * FROM public.crm_workshop_resources ORDER BY id')).rows;
      const links = (await pool.query('SELECT * FROM public.crm_workshop_resume_links ORDER BY workshop_id,resume_entry_id')).rows;
      const contacts = (await pool.query('SELECT * FROM public.crm_workshop_contacts ORDER BY workshop_id,contact_id')).rows;
      const date = await api(root, 'POST', { engagement_date: '2027-03-04' });
      await api(`${root}/${date.id}`, 'PATCH', { engagement_date: '2027-03-05' });
      await api(`${root}/${date.id}`, 'DELETE');
      assert.deepEqual((await pool.query('SELECT * FROM public.crm_workshops WHERE id = $1', [parent.id])).rows[0], before);
      assert.deepEqual((await pool.query('SELECT * FROM public.crm_activity_logs ORDER BY id')).rows, logs);
      assert.deepEqual((await pool.query('SELECT * FROM public.crm_workshop_resources ORDER BY id')).rows, resources);
      assert.deepEqual((await pool.query('SELECT * FROM public.crm_workshop_resume_links ORDER BY workshop_id,resume_entry_id')).rows, links);
      assert.deepEqual((await pool.query('SELECT * FROM public.crm_workshop_contacts ORDER BY workshop_id,contact_id')).rows, contacts);
    }
    for (const [category, feed] of Object.entries(beforeFeeds)) assert.deepEqual((await request(`/resume/${category}`)).body, feed);
  });
  await t.test('unmigratable legacy values report workshop ID and roll back instead of being dropped', async () => {
    await pool.query("UPDATE public.crm_workshops SET historical_date = 'infinity' WHERE id = $1", [other.id]);
    const response = await request(`/api/workshops/${other.id}/engagement-dates`);
    assert.equal(response.status, 409);
    assert.match(response.body.error, new RegExp(`workshop ${other.id}.*infinity`));
    await assert.rejects(makeDates(pool).backfill(pool), /Cannot safely migrate/);
    await pool.query('UPDATE public.crm_workshops SET historical_date = NULL WHERE id = $1', [other.id]);
    assert.deepEqual(await api(`/api/workshops/${other.id}/engagement-dates`), []);
  });
  await t.test('schema-pending date API returns 503 without writes; old workshop API stays compatible', async () => {
    const queries = [];
    const missing = makeDates({ query: async sql => { queries.push(sql); return { rows: [{ relation: null }] }; } });
    await assert.rejects(missing.run(parent.id, () => assert.fail(), true), { status: 503 });
    assert.equal(await missing.run(undefined, (db, enabled) => enabled), false);
    assert.ok(queries.every(sql => sql.startsWith('SELECT')));
  });
};
