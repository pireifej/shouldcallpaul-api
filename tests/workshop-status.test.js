'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const crmRoutes = require('../routes/crm');

class FakeWorkshopPool {
  constructor() {
    this.workshops = [
      { id: 1, organization_name: 'Inactive Org', status: 'Inactive' },
      { id: 2, organization_name: 'Complete Org', status: 'Complete' },
      { id: 3, organization_name: 'Active Org', status: 'Active' },
      { id: 4, organization_name: 'Scheduled Org', status: 'In Progress' }
    ];
    this.nextId = 5;
  }

  async query(sql, params = []) {
    if (sql.includes('SELECT id, status FROM crm_workshops')) {
      const workshop = this.workshops.find(candidate => candidate.id === Number(params[0]));
      return { rows: workshop ? [{ id: workshop.id, status: workshop.status }] : [] };
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
        cost_basis: params[5],
        notes: params[6]
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
      if (sql.includes('status = $1')) workshop.status = params[0];
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

test('a workshop can be created directly as In Progress', async () => {
  const response = await apiRequest('/api/workshops', {
    method: 'POST',
    body: JSON.stringify({
      organization_name: 'New Scheduled Org',
      workshop_title: 'Scheduled AI Workshop',
      status: 'In Progress'
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.status, 'In Progress');
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
  assert.equal((await byId.json()).data.status, 'In Progress');
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