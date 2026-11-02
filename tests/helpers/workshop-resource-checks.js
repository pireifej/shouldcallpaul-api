'use strict';
const assert = require('node:assert/strict');

module.exports = async function resourceChecks(t, { pool, api, request, migratePortfolio }) {
  let workshop, other, notes, outline, slides;
  const rows = id => api(`/api/workshops/${id}/resources`);
  const path = () => `/api/workshops/${workshop.id}/resources`;
  await t.test('private resources start empty, persist with stable IDs, and accept every workshop status', async () => {
    for (const status of ['Active', 'In Progress', 'Complete', 'Inactive']) {
      const created = await api('/api/workshops', 'POST', { organization_name: `Resource ${status}`, status, notes: 'Do not change' });
      assert.deepEqual(await rows(created.id), []);
      assert.deepEqual(await api(`/api/workshops/${created.id}/resources/reorder`, 'PUT', { resource_ids: [] }), []);
      const resource = await api(`/api/workshops/${created.id}/resources`, 'POST',
        { label: ' Notes ', url: ' https://example.com/notes?x=1#section ' });
      assert.match(resource.id, /^[a-f0-9-]{36}$/);
      assert.equal(resource.workshop_id, created.id);
      assert.equal(resource.label, 'Notes');
      assert.equal(resource.url, 'https://example.com/notes?x=1#section');
      assert.equal(resource.sort_order, 0);
      assert.ok(resource.created_at);
      assert.ok(resource.updated_at);
      assert.equal((await rows(created.id))[0].id, resource.id);
      assert.equal((await api(`/api/workshops/${created.id}`)).status, status);
      if (status === 'Complete') { workshop = created; notes = resource; }
      if (status === 'Inactive') other = created;
    }
    const stored = await rows(workshop.id);
    await migratePortfolio(pool);
    assert.deepEqual(await rows(workshop.id), stored);
    assert.equal((await pool.query(`SELECT workshop_id FROM public.crm_workshop_resources
      WHERE id = $1`, [notes.id])).rows[0].workshop_id, workshop.id);
  });
  await t.test('resource create, partial PUT/PATCH, move, full reorder and delete maintain dense order', async () => {
    outline = await api(path(), 'POST', { label: 'Outline', url: 'http://example.com/outline' });
    assert.equal(outline.sort_order, 1);
    slides = await api(path(), 'POST', { label: 'PowerPoint', url: 'https://example.com/slides', sort_order: 1 });
    assert.deepEqual((await rows(workshop.id)).map(r => [r.label, r.sort_order]),
      [['Notes', 0], ['PowerPoint', 1], ['Outline', 2]]);
    const renamed = await api(`${path()}/${outline.id}`, 'PATCH', { label: 'Handouts' });
    assert.equal(renamed.id, outline.id);
    assert.equal(renamed.url, outline.url);
    assert.equal(renamed.sort_order, 2);
    const moved = await api(`${path()}/${outline.id}`, 'PUT', { sort_order: 0, url: 'https://example.com/handouts.pdf' });
    assert.equal(moved.label, 'Handouts');
    assert.equal(moved.sort_order, 0);
    assert.deepEqual((await rows(workshop.id)).map(r => r.id), [outline.id, notes.id, slides.id]);
    const reordered = await api(`${path()}/reorder`, 'PUT', { resource_ids: [slides.id, outline.id, notes.id] });
    assert.deepEqual(reordered.map(r => [r.id, r.sort_order]), [[slides.id, 0], [outline.id, 1], [notes.id, 2]]);
    assert.deepEqual(await api(`${path()}/reorder`, 'PUT', { resource_ids: [slides.id, outline.id, notes.id] }), reordered);
    assert.equal((await api(`${path()}/${outline.id}`, 'DELETE')).deleted_id, outline.id);
    assert.deepEqual((await rows(workshop.id)).map(r => [r.id, r.sort_order]), [[slides.id, 0], [notes.id, 1]]);
    assert.equal((await request(`${path()}/${outline.id}`, 'DELETE')).status, 404);
    outline = await api(path(), 'POST', { label: 'Handouts', url: 'https://example.com/handouts.pdf' });
    assert.equal(outline.sort_order, 2);
  });
  await t.test('resource validation rejects unsafe URLs, invalid labels, IDs, orders and mixed updates atomically', async () => {
    const before = await rows(workshop.id);
    for (const url of ['javascript:alert(1)', 'ftp://example.com/a', '/notes', 'https:', 'https:example.com',
      'https://', 'https://example.com/a b', 'https://user:password@example.com', null, 42, 'https://example.com/' + 'a'.repeat(4096)]) {
      assert.equal((await request(path(), 'POST', { label: 'Bad', url })).status, 400);
    }
    for (const label of ['', '   ', null, 42, 'a'.repeat(201)]) {
      assert.equal((await request(path(), 'POST', { label, url: 'https://example.com' })).status, 400);
    }
    for (const body of [{}, [], { label: 'Missing URL' }, { label: 'Extra ID', url: 'https://example.com', workshop_id: other.id },
      { label: 'Wrong order', url: 'https://example.com', sort_order: -1 },
      { label: 'Wrong order', url: 'https://example.com', sort_order: 999 },
      { label: 'Wrong order', url: 'https://example.com', sort_order: 1.5 }]) {
      assert.equal((await request(path(), 'POST', body)).status, 400);
    }
    for (const body of [{}, { label: null }, { url: null }, { id: 'replacement' },
      { label: 'Must not save', url: 'javascript:alert(1)' }, { sort_order: 99 }, { sort_order: '1' }]) {
      assert.equal((await request(`${path()}/${notes.id}`, 'PATCH', body)).status, 400);
    }
    for (const body of [{ resource_ids: [notes.id, notes.id] }, { resource_ids: null }, { resource_ids: [], extra: true }]) {
      assert.equal((await request(`${path()}/reorder`, 'PUT', body)).status, 400);
    }
    for (const ids of [[], [notes.id], [notes.id, slides.id, 'unknown']]) {
      assert.equal((await request(`${path()}/reorder`, 'PUT', { resource_ids: ids })).status, 409);
    }
    assert.deepEqual(await rows(workshop.id), before);
  });
  await t.test('resource authentication and workshop ownership protect every operation', async () => {
    for (const [url, method, body] of [
      [path(), 'GET'], [path(), 'POST', { label: 'Notes', url: 'https://example.com' }],
      [`${path()}/${notes.id}`, 'PATCH', { label: 'Changed' }],
      [`${path()}/${notes.id}`, 'PUT', { label: 'Changed' }],
      [`${path()}/${notes.id}`, 'DELETE'],
      [`${path()}/reorder`, 'PUT', { resource_ids: [] }]
    ]) assert.equal((await request(url, method, body, false)).status, 401);
    assert.equal((await request('/api/workshops/no/resources')).status, 400);
    assert.equal((await request('/api/workshops/999999/resources')).status, 404);
    const before = await rows(workshop.id);
    const otherBefore = await rows(other.id);
    for (const method of ['PUT', 'PATCH']) {
      assert.equal((await request(`/api/workshops/${other.id}/resources/${notes.id}`, method, { label: 'Cross workshop' })).status, 404);
    }
    assert.equal((await request(`/api/workshops/${other.id}/resources/${notes.id}`, 'DELETE')).status, 404);
    assert.equal((await request(`/api/workshops/${other.id}/resources/reorder`, 'PUT',
      { resource_ids: [notes.id] })).status, 409);
    assert.deepEqual(await rows(workshop.id), before);
    assert.deepEqual(await rows(other.id), otherBefore);
  });
  await t.test('shared presentation links use CRM resources without modifying CRM history or public feeds', async () => {
    const entries = await api('/api/resume/workshops');
    await api(`/api/workshops/${workshop.id}`, 'PATCH', { resume_entry_id: entries[0].id });
    await api(`/api/workshops/${workshop.id}/resume-entries`, 'POST', { resume_entry_id: entries[1].id });
    const workshopBefore = await api(`/api/workshops/${workshop.id}`);
    const logsBefore = (await pool.query('SELECT * FROM public.crm_activity_logs ORDER BY id')).rows;
    const contactsBefore = (await pool.query('SELECT * FROM public.crm_workshop_contacts ORDER BY workshop_id, contact_id')).rows;
    const categories = ['workshops', 'speech', 'conference', 'hackathon', 'patent', 'projects', 'races', 'awards', 'certificates', 'testimonials'];
    const feedsBefore = [];
    for (const category of categories) feedsBefore.push((await request(`/resume/${category}`)).body);
    const r = await api(path(), 'POST', { label: 'Private notes', url: 'https://example.com/private-resource-unique' });
    await api(`${path()}/${r.id}`, 'PATCH', { label: 'Private outline' });
    for (const entry of entries.slice(0, 2)) {
      assert.ok((await api(`/api/workshops?resume_entry_id=${encodeURIComponent(entry.id)}`)).some(w => w.id === workshop.id));
    }
    for (const [index, category] of categories.entries()) {
      const feed = (await request(`/resume/${category}`)).body;
      assert.deepEqual(feed, feedsBefore[index]);
      assert.ok(!JSON.stringify(feed).includes('private-resource-unique'));
    }
    assert.deepEqual(await api(`/api/workshops/${workshop.id}`), workshopBefore);
    assert.deepEqual((await pool.query('SELECT * FROM public.crm_activity_logs ORDER BY id')).rows, logsBefore);
    assert.deepEqual((await pool.query('SELECT * FROM public.crm_workshop_contacts ORDER BY workshop_id, contact_id')).rows, contactsBefore);
    await api(`${path()}/${r.id}`, 'DELETE');
  });
};
