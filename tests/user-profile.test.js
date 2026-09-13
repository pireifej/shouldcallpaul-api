'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const usersRoutes = require('../routes/users');

class FakeUserPool {
  constructor() {
    this.user = {
      user_id: 7,
      user_about: 'About',
      user_title: 'Member',
      church_id: null,
      email: 'person@example.com',
      real_name: 'Pat',
      last_name: 'Smith',
      phone: ''
    };
  }

  async query(sql, params = []) {
    if (!sql.includes('UPDATE public."user"')) {
      throw new Error(`Unexpected test query: ${sql}`);
    }

    if (Number(params.at(-1)) !== this.user.user_id) return { rows: [] };

    const assignments = sql.match(/SET (.+)\s+WHERE/s)?.[1] || '';
    for (const match of assignments.matchAll(/(\w+) = \$(\d+)/g)) {
      this.user[match[1]] = params[Number(match[2]) - 1];
    }
    return { rows: [{ ...this.user }] };
  }
}

function makeServer(pool) {
  const app = express();
  const multer = () => ({ single: () => (req, res, next) => next() });
  multer.memoryStorage = () => ({});
  app.use(express.json());
  app.use(usersRoutes({
    pool,
    authenticate: (req, res, next) => next(),
    multer,
    path: require('node:path')
  }));
  return app;
}

let server;
let baseUrl;
let pool;

test.before(async () => {
  pool = new FakeUserPool();
  server = makeServer(pool).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function updateUser(body) {
  const response = await fetch(`${baseUrl}/updateUser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('phone can be updated by itself and is returned', async () => {
  const body = await updateUser({ userId: 7, phone: '+1 (555) 867-5309' });

  assert.equal(body.error, 0);
  assert.equal(body.user.phone, '+1 (555) 867-5309');
  assert.equal(pool.user.phone, '+1 (555) 867-5309');
});

test('phone can be cleared with an empty string', async () => {
  const body = await updateUser({ userId: 7, phone: '' });

  assert.equal(body.error, 0);
  assert.equal(body.user.phone, '');
  assert.equal(pool.user.phone, '');
});

test('phone rejects non-string and overly long values', async () => {
  let body = await updateUser({ userId: 7, phone: 5558675309 });
  assert.equal(body.error, 1);
  assert.match(body.result, /Phone must be a string/);

  body = await updateUser({ userId: 7, phone: '1'.repeat(51) });
  assert.equal(body.error, 1);
  assert.match(body.result, /no more than 50 characters/);
});

test('requests without an update field are rejected', async () => {
  const body = await updateUser({ userId: 7 });
  assert.equal(body.error, 1);
  assert.match(body.result, /At least one field/);
});

test('existing profile fields continue to update', async () => {
  const body = await updateUser({ userId: 7, real_name: 'Carolyn' });

  assert.equal(body.error, 0);
  assert.equal(body.user.real_name, 'Carolyn');
  assert.equal(body.user.phone, '');
});