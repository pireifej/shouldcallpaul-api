'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const crmRoutes = require('../routes/crm');
const fs = require('node:fs');
const path = require('node:path');
const resumeRoutes = require('../routes/resume');
const {
  RESUME_WORKSHOPS_PATH,
  validateResumeWorkshopEntries,
  readResumeWorkshopIds
} = require('../resumeWorkshopCatalog');
const resumeBefore = fs.readFileSync(RESUME_WORKSHOPS_PATH, 'utf8');
const resumeIds = [...readResumeWorkshopIds()];

class FakeWorkshopPool {
  constructor() {
    this.workshops = [
      {
        id: 1, organization_name: 'Inactive Org', status: 'Inactive',
        venue_name: null, venue_address: null, fee_amount: null, fee_type: null, cost_basis: null
      },
      {
        id: 2, organization_name: 'Complete Org', status: 'Complete',
        venue_name: null, venue_address: null, fee_amount: '75', fee_type: 'flat', cost_basis: '$75'
      },
      {
        id: 3, organization_name: 'Active Org', status: 'Active',
        venue_name: null, venue_address: null, fee_amount: null, fee_type: null,
        cost_basis: 'Travel and lodging', notes: 'Original note'
      },
      {
        id: 4, organization_name: 'Scheduled Org', status: 'In Progress',
        venue_name: 'Original Venue', venue_address: 'Original Address',
        fee_amount: '50', fee_type: 'session', cost_basis: '$50/session'
      }
    ];
    for (const workshop of this.workshops) workshop.resume_entry_id = null;
    this.queries = [];
    this.nextId = 5;
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    if (sql.includes('SELECT id, status, fee_amount, fee_type, cost_basis FROM crm_workshops')) {
      const workshop = this.workshops.find(candidate => candidate.id === Number(params[0]));
      return {
        rows: workshop
          ? [{
              id: workshop.id,
              status: workshop.status,
              fee_amount: workshop.fee_amount,
              fee_type: workshop.fee_type,
              cost_basis: workshop.cost_basis
            }]
          : []
      };
    }

    if (sql.includes('SELECT w.*') && sql.includes('FROM crm_workshops w')) {
      if (sql.includes('WHERE w.id = $1')) {
        const workshop = this.workshops.find(candidate => candidate.id === Number(params[0]));
        return { rows: workshop ? [{ ...workshop, contact_name: null, contact_email: null }] : [] };
      }
      const rows = sql.includes('w.status = $1')
        ? this.workshops.filter(workshop => workshop.status === params[0])
        : this.workshops;
      return {
        rows: rows.map(workshop => ({ ...workshop, contact_name: null, contact_email: null }))
      };
    }

    if (sql.includes('INSERT INTO crm_workshops')) {
      const workshop = {
        id: this.nextId++,
        organization_name: params[0],
        contact_id: params[1],
        status: params[2],
        workshop_title: params[3],
        historical_date: params[4],
        venue_name: params[5],
        venue_address: params[6],
        fee_amount: params[7] === null || params[7] === undefined ? null : String(params[7]),
        fee_type: params[8],
        cost_basis: params[9],
        notes: params[10],
        resume_entry_id: params[11] ?? null
      };
      this.workshops.push(workshop);
      return { rows: [{ ...workshop }] };
    }

    if (sql.includes('UPDATE crm_workshops') && sql.includes("status IN ('Active', 'In Progress', 'Inactive')")) {
      const workshop = this.workshops.find(candidate => candidate.id === Number(params[1]));
      if (!workshop || !['Active', 'In Progress', 'Inactive'].includes(workshop.status)) return { rows: [] };
      workshop.status = params[0];
      return { rows: [{ ...workshop }] };
    }

    if (sql.includes('UPDATE crm_workshops SET')) {
      const workshop = this.workshops.find(candidate => candidate.id === Number(params.at(-1)));
      if (!workshop) return { rows: [] };
      const assignments = sql.match(/SET (.+), updated_at = NOW\(\) WHERE/s)?.[1] || '';
      for (const match of assignments.matchAll(/(\w+) = \$(\d+)/g)) {
        const field = match[1];
        const value = params[Number(match[2]) - 1];
        workshop[field] = field === 'fee_amount' && value !== null ? String(value) : value;
      }
      return { rows: [{ ...workshop }] };
    }

    throw new Error(`Unexpected test query: ${sql}`);
  }
}

function makeServer(pool) {
  const app = express();
  app.use(express.json());
  app.use(crmRoutes({
    auditPool: pool,
    authenticate: (req, res, next) => {
      if (req.headers.authorization !== 'Bearer test') {
        return res.status(401).json({ error: 'Authentication required' });
      }
      next();
    },
    openai: {}
  }));
  app.use(resumeRoutes({ fs, path, authenticate: (req, res, next) => next() }));
  return app;
}

let server;
let baseUrl;
let pool;

test.before(async () => {
  pool = new FakeWorkshopPool();
  server = makeServer(pool).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  assert.equal(fs.readFileSync(RESUME_WORKSHOPS_PATH, 'utf8'), resumeBefore,
    'CRM operations must never rewrite the resume JSON');
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function changeStatus(id, status) {
  return fetch(`${baseUrl}/api/workshops/${id}/status`, {
    method: 'PATCH',
    headers: {
      authorization: 'Bearer test',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ status })
  });
}

async function apiRequest(path, options = {}) {
  const headers = {
    authorization: 'Bearer test',
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...options.headers
  };
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}

test('workshop status changes require authentication', async () => {
  const response = await fetch(`${baseUrl}/api/workshops/1/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'Active' })
  });
  assert.equal(response.status, 401);
});

test('an inactive database workshop can be activated', async () => {
  const response = await changeStatus(1, 'Active');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.status, 'Active');
  assert.equal(pool.workshops[0].status, 'Active');
});

test('an active database workshop can be made inactive', async () => {
  const response = await changeStatus(3, 'Inactive');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, 'Inactive');
});

test('a workshop can be created with venue details and a structured hourly fee', async () => {
  const response = await apiRequest('/api/workshops', {
    method: 'POST',
    body: JSON.stringify({
      organization_name: 'New Scheduled Org',
      workshop_title: 'Scheduled AI Workshop',
      status: 'In Progress',
      venue_name: 'Brookdale Community College',
      venue_address: '765 Newman Springs Road, Lincroft, NJ 07738',
      fee_amount: 75,
      fee_type: 'hour'
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.status, 'In Progress');
  assert.equal(body.data.venue_name, 'Brookdale Community College');
  assert.equal(body.data.venue_address, '765 Newman Springs Road, Lincroft, NJ 07738');
  assert.equal(body.data.fee_amount, 75);
  assert.equal(body.data.fee_type, 'hour');
  assert.equal(body.data.cost_basis, '$75/hour');
});

test('an In Progress workshop can be fetched and filtered', async () => {
  const filtered = await apiRequest('/api/workshops?status=In%20Progress');
  assert.equal(filtered.status, 200);
  const filteredBody = await filtered.json();
  assert.equal(filteredBody.success, true);
  assert.ok(filteredBody.data.length >= 2);
  assert.ok(filteredBody.data.every(workshop => workshop.status === 'In Progress'));

  const created = filteredBody.data.find(workshop => workshop.organization_name === 'New Scheduled Org');
  assert.ok(created);
  const byId = await apiRequest(`/api/workshops/${created.id}`);
  assert.equal(byId.status, 200);
  const detail = (await byId.json()).data;
  assert.equal(detail.status, 'In Progress');
  assert.equal(detail.venue_name, 'Brookdale Community College');
  assert.equal(detail.fee_amount, 75);
  assert.equal(detail.fee_type, 'hour');
  assert.equal(detail.cost_basis, '$75/hour');
});

test('recognized legacy cost_basis values derive structured fees', async () => {
  const examples = [
    ['$75', 75, 'flat'],
    ['$75/hour', 75, 'hour'],
    ['$50/session', 50, 'session']
  ];

  for (const [costBasis, feeAmount, feeType] of examples) {
    const response = await apiRequest('/api/workshops', {
      method: 'POST',
      body: JSON.stringify({
        organization_name: `Legacy ${feeType} Org`,
        cost_basis: costBasis
      })
    });
    assert.equal(response.status, 200);
    const workshop = (await response.json()).data;
    assert.equal(workshop.cost_basis, costBasis);
    assert.equal(workshop.fee_amount, feeAmount);
    assert.equal(workshop.fee_type, feeType);
  }
});

test('PUT remains partial and explicit null clears a venue field', async () => {
  let response = await apiRequest('/api/workshops/4', {
    method: 'PUT',
    body: JSON.stringify({ venue_name: 'Updated Venue' })
  });
  assert.equal(response.status, 200);
  let workshop = (await response.json()).data;
  assert.equal(workshop.venue_name, 'Updated Venue');
  assert.equal(workshop.venue_address, 'Original Address');
  assert.equal(workshop.cost_basis, '$50/session');

  response = await apiRequest('/api/workshops/4', {
    method: 'PATCH',
    body: JSON.stringify({ venue_address: null })
  });
  assert.equal(response.status, 200);
  workshop = (await response.json()).data;
  assert.equal(workshop.venue_name, 'Updated Venue');
  assert.equal(workshop.venue_address, null);
});

test('unrecognized legacy cost_basis survives unrelated partial updates', async () => {
  const response = await apiRequest('/api/workshops/3', {
    method: 'PATCH',
    body: JSON.stringify({ notes: 'Updated note' })
  });
  assert.equal(response.status, 200);
  const workshop = (await response.json()).data;
  assert.equal(workshop.notes, 'Updated note');
  assert.equal(workshop.cost_basis, 'Travel and lodging');
  assert.equal(workshop.fee_amount, null);
  assert.equal(workshop.fee_type, null);
});

test('structured fee updates synchronize cost_basis', async () => {
  let response = await apiRequest('/api/workshops/3', {
    method: 'PATCH',
    body: JSON.stringify({ fee_amount: 75, fee_type: 'flat' })
  });
  assert.equal(response.status, 200);
  let workshop = (await response.json()).data;
  assert.equal(workshop.fee_amount, 75);
  assert.equal(workshop.fee_type, 'flat');
  assert.equal(workshop.cost_basis, '$75');

  response = await apiRequest('/api/workshops/3', {
    method: 'PATCH',
    body: JSON.stringify({ fee_type: 'session' })
  });
  assert.equal(response.status, 200);
  workshop = (await response.json()).data;
  assert.equal(workshop.fee_amount, 75);
  assert.equal(workshop.fee_type, 'session');
  assert.equal(workshop.cost_basis, '$75/session');
});

test('venue and fee validation rejects invalid values', async () => {
  const cases = [
    [{ fee_amount: -1 }, 'fee_amount must be a non-negative number or null'],
    [{ fee_amount: '75' }, 'fee_amount must be a non-negative number or null'],
    [{ fee_type: 'day' }, 'fee_type must be one of: flat, hour, session, or null'],
    [{ venue_name: 123 }, 'venue_name must be text or null'],
    [{ venue_address: false }, 'venue_address must be text or null']
  ];

  for (const [payload, expectedError] of cases) {
    const response = await apiRequest('/api/workshops/4', {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, expectedError);
  }
});

test('active and In Progress workshops can move through the lifecycle', async () => {
  let response = await changeStatus(1, 'In Progress');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, 'In Progress');

  response = await changeStatus(1, 'Complete');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, 'Complete');

  response = await changeStatus(1, 'Active');
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'Complete workshops are read-only');
});

test('legacy Completed input is normalized to canonical Complete', async () => {
  const response = await apiRequest('/api/workshops', {
    method: 'POST',
    body: JSON.stringify({
      organization_name: 'Legacy Client Org',
      status: 'Completed'
    })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, 'Complete');
});

test('unknown workshop statuses are rejected with the canonical values', async () => {
  const response = await changeStatus(4, 'Scheduled');
  assert.equal(response.status, 400);
  assert.equal(
    (await response.json()).error,
    'status must be one of: Active, In Progress, Complete, Inactive'
  );
});

test('complete workshop records are read-only', async () => {
  const response = await changeStatus(2, 'Active');
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'Complete workshops are read-only');
  assert.equal(pool.workshops[1].status, 'Complete');
});

async function createLinkedWorkshop(fields = {}) {
  const response = await apiRequest('/api/workshops', {
    method: 'POST',
    body: JSON.stringify({ organization_name: 'Reference test', notes: 'Keep this note', ...fields })
  });
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

test('resume workshop IDs are unique permanent strings, independent of labels and ordering', () => {
  const catalog = JSON.parse(resumeBefore);
  assert.equal(resumeIds.length, catalog.records.length);
  assert.ok(resumeIds.every(id => /^[0-9a-f-]{36}$/.test(id)));
  const edited = catalog.records.map(record => ({ ...record, label: 'Edited title' })).reverse();
  assert.deepEqual([...validateResumeWorkshopEntries(edited)].sort(), [...resumeIds].sort());
  assert.throws(() => validateResumeWorkshopEntries([{ id: 'same' }, { id: 'same' }]), /unique/);
  assert.throws(() => validateResumeWorkshopEntries([{ label: 'Missing ID' }]), /permanent/);
  assert.throws(() => validateResumeWorkshopEntries([{ id: '' }]), /permanent/);
});

test('existing resume feed returns unchanged records wrapper with IDs', async () => {
  for (const endpoint of ['/resume/workshops', '/resume/workshops.json']) {
    const response = await fetch(`${baseUrl}${endpoint}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), JSON.parse(resumeBefore));
  }
});

test('workshop create accepts a valid reference and list/detail return it', async () => {
  const workshop = await createLinkedWorkshop({ resume_entry_id: resumeIds[0] });
  assert.equal(workshop.resume_entry_id, resumeIds[0]);
  const detail = await apiRequest(`/api/workshops/${workshop.id}`);
  assert.equal((await detail.json()).data.resume_entry_id, resumeIds[0]);
  const list = await apiRequest('/api/workshops');
  assert.equal((await list.json()).data.find(row => row.id === workshop.id).resume_entry_id, resumeIds[0]);
});

test('older creates and explicit null create unlinked workshops without title matching', async () => {
  const label = JSON.parse(resumeBefore).records[0].label;
  for (const fields of [{ workshop_title: label }, { resume_entry_id: null }]) {
    const workshop = await createLinkedWorkshop(fields);
    assert.equal(workshop.resume_entry_id, null);
  }
});

test('multiple CRM workshops can reference the same resume entry', async () => {
  const first = await createLinkedWorkshop({ resume_entry_id: resumeIds[0] });
  const second = await createLinkedWorkshop({ resume_entry_id: resumeIds[0] });
  assert.notEqual(first.id, second.id);
  assert.equal(first.resume_entry_id, second.resume_entry_id);
});

test('PUT and PATCH preserve omitted references, replace valid references, and unlink on null', async () => {
  for (const method of ['PUT', 'PATCH']) {
    const workshop = await createLinkedWorkshop({ resume_entry_id: resumeIds[0] });
    for (const [body, expected] of [
      [{ notes: 'Updated note' }, resumeIds[0]],
      [{ resume_entry_id: resumeIds[1] }, resumeIds[1]],
      [{ resume_entry_id: null }, null]
    ]) {
      const response = await apiRequest(`/api/workshops/${workshop.id}`, {
        method, body: JSON.stringify(body)
      });
      assert.equal(response.status, 200);
      const data = (await response.json()).data;
      assert.equal(data.resume_entry_id, expected);
      assert.equal(data.notes, 'Updated note');
      assert.equal(data.status, 'Active');
    }
  }
});

test('invalid references reject create and mixed-field updates without any mutation', async () => {
  const workshop = await createLinkedWorkshop({ resume_entry_id: resumeIds[0] });
  for (const value of ['not-an-entry', '', '   ', 42, false, {}, [], ` ${resumeIds[0]}`]) {
    for (const method of ['POST', 'PUT', 'PATCH']) {
      const before = structuredClone(pool.workshops);
      const queryStart = pool.queries.length;
      const endpoint = method === 'POST' ? '/api/workshops' : `/api/workshops/${workshop.id}`;
      const response = await apiRequest(endpoint, {
        method, body: JSON.stringify({
          organization_name: 'Should not be saved', notes: 'Must not replace notes',
          status: 'Complete', resume_entry_id: value
        })
      });
      assert.equal(response.status, 400, `${method}: ${JSON.stringify(value)}`);
      assert.match((await response.json()).error, /resume_entry_id/);
      assert.deepEqual(pool.workshops, before);
      assert.ok(pool.queries.slice(queryStart).every(query => !/\b(INSERT|UPDATE|DELETE)\b/.test(query.sql)));
    }
  }
});

test('Complete workshops allow reference-only linking and unlinking, retaining historical data', async () => {
  for (const method of ['PUT', 'PATCH']) {
    const workshop = await createLinkedWorkshop({
      status: 'Complete', contact_id: 12, fee_amount: 75, fee_type: 'flat',
      venue_name: 'Preserved venue'
    });
    const original = structuredClone(pool.workshops.find(row => row.id === workshop.id));
    for (const value of [resumeIds[0], null]) {
      const queryStart = pool.queries.length;
      const response = await apiRequest(`/api/workshops/${workshop.id}`, {
        method, body: JSON.stringify({ resume_entry_id: value })
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data.resume_entry_id, value);
      assert.deepEqual(pool.workshops.find(row => row.id === workshop.id), {
        ...original, resume_entry_id: value
      });
      const writes = pool.queries.slice(queryStart).filter(query => /^\s*UPDATE/.test(query.sql));
      assert.equal(writes.length, 1);
      assert.match(writes[0].sql, /SET resume_entry_id = \$1, updated_at/);
    }
    const blocked = await apiRequest(`/api/workshops/${workshop.id}`, {
      method, body: JSON.stringify({ resume_entry_id: resumeIds[0], notes: 'Not allowed' })
    });
    assert.equal(blocked.status, 409);
  }
});

test('marking linked or unlinked workshops Complete leaves JSON and references unchanged', async () => {
  for (const reference of [null, resumeIds[0]]) {
    const workshop = await createLinkedWorkshop({ resume_entry_id: reference });
    const response = await changeStatus(workshop.id, 'Complete');
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    assert.equal(data.status, 'Complete');
    assert.equal(data.resume_entry_id, reference);
    assert.equal(fs.readFileSync(RESUME_WORKSHOPS_PATH, 'utf8'), resumeBefore);
  }
});

test('linking and unlinking still require CRM authentication and existing records', async () => {
  for (const method of ['PUT', 'PATCH']) {
    const denied = await fetch(`${baseUrl}/api/workshops/2`, {
      method, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume_entry_id: resumeIds[0] })
    });
    assert.equal(denied.status, 401);
    const missing = await apiRequest('/api/workshops/999999', {
      method, body: JSON.stringify({ resume_entry_id: null })
    });
    assert.equal(missing.status, 404);
  }
});