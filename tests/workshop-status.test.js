'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const crmRoutes = require('../routes/crm');

class FakeWorkshopPool {
  constructor() {
    this.workshops = [
      { id: 1, organization_name: 'Inactive Org', status: 'Inactive' },
      { id: 2, organization_name: 'Completed Org', status: 'Completed' },
      { id: 3, organization_name: 'Active Org', status: 'Active' }
    ];
  }

  async query(sql, params = []) {
    if (sql.includes('SELECT id, status FROM crm_workshops')) {
      const workshop = this.workshops.find(candidate => candidate.id === Number(params[0]));
      return { rows: workshop ? [{ id: workshop.id, status: workshop.status }] : [] };
    }

    if (sql.includes('UPDATE crm_workshops') && sql.includes("status IN ('Active', 'Inactive')")) {
      const workshop = this.workshops.find(candidate => candidate.id === Number(params[1]));
      if (!workshop || !['Active', 'Inactive'].includes(workshop.status)) return { rows: [] };
      workshop.status = params[0];
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

test('Completed is never accepted as a writable status', async () => {
  const response = await changeStatus(1, 'Completed');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'status must be Active or Inactive');
});

test('completed workshop records are read-only', async () => {
  const response = await changeStatus(2, 'Active');
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'Completed workshops are read-only');
  assert.equal(pool.workshops[1].status, 'Completed');
});