'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const multer = require('multer');
const prayers = require('../routes/prayers');
const subscriptions = require('../routes/subscriptions');
const { requireUserSession, issueUserSessionToken } = require('../userSession');

async function withApp(run) {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'synthetic-member-history-session-secret';
  const queries = [];
  const app = express();
  app.use(express.json());
  const ctx = {
    contentPaywallEnabled: false,
    authenticate: (req, res, next) => req.get('authorization') === 'Basic test'
      ? next() : res.sendStatus(401),
    requireUserSession, multer,
    pool: { async query(sql, params) {
      queries.push({ sql, params });
      return { rows: params[0] === 999 ? [] : [{ request_id: 123 }] };
    } },
    // The policy endpoint must work even when RevenueCat cannot be called.
    proSubscriptionService: new Proxy({}, { get() { throw new Error('Provider unavailable'); } })
  };
  app.use(prayers(ctx));
  app.use(subscriptions(ctx));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const request = (body = {}, { token = issueUserSessionToken(42), appAuth = true,
    method = 'POST', url = '/getPrayedFor' } = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { 'content-type': 'application/json',
        ...(appAuth ? { authorization: 'Basic test' } : {}),
        ...(token ? { 'x-user-session-token': token } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
    });
  try { await run(request, queries); } finally {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
}

test('member prayer history selects target independently of viewer and preserves response and visibility SQL', async () => {
  await withApp(async (request, queries) => {
    const response = await request({ userId: 42, targetUserId: 43, lang: 'es' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(await response.json(), [{ request_id: 123 }]);
    assert.deepEqual(queries[0].params, [43, 'es']);
    assert.match(queries[0].sql, /WHERE ur\.user_id = \$1/);
    assert.match(queries[0].sql, /AND r\.active != 3/);
    assert.match(queries[0].sql, /ORDER BY r\.timestamp DESC/);
    assert.doesNotMatch(queries[0].sql, /detailed_prayer|extended_prayer/);
    assert.equal((await request({ targetUserId: '43' })).status, 200);
    assert.deepEqual(queries[1].params, [43, 'en']);
    const empty = await request({ targetUserId: 999 });
    assert.deepEqual(await empty.json(), []);
  });
});

test('omitted target preserves own-history behavior, with or without legacy viewer userId', async () => {
  await withApp(async (request, queries) => {
    for (const body of [{}, { userId: 42 }, { user_id: 42 }]) {
      assert.equal((await request(body)).status, 200);
      assert.deepEqual(queries.at(-1).params, [42, 'en']);
    }
  });
});

test('history rejects invalid targets before querying', async () => {
  await withApp(async (request, queries) => {
    for (const targetUserId of [null, '', ' ', 0, -1, 1.5, '1.5', '1e2', true,
      [], {}, '43 OR 1=1', Number.MAX_SAFE_INTEGER + 1]) {
      const response = await request({ targetUserId });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'INVALID_TARGET_USER_ID');
    }
    assert.equal(queries.length, 0);
  });
});

test('history and access policy reject missing or expired sessions and missing app auth', async () => {
  await withApp(async (request, queries) => {
    for (const options of [{}, { method: 'GET', url: '/api/subscriptions/access-policy' }]) {
      assert.equal((await request({}, { ...options, token: null })).status, 401);
      const expired = issueUserSessionToken(42, { nowSeconds: 1, ttlSeconds: 1 });
      assert.equal((await request({}, { ...options, token: expired })).status, 401);
      assert.equal((await request({}, { ...options, appAuth: false })).status, 401);
    }
    assert.equal(queries.length, 0);
  });
});

test('target cannot impersonate viewer and legacy foreign userId still fails closed', async () => {
  await withApp(async (request, queries) => {
    for (const body of [{ userId: 43 }, { userId: 43, targetUserId: 43 }]) {
      const response = await request(body);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, 'USER_ID_MISMATCH');
    }
    assert.equal(queries.length, 0);
  });
});

test('access policy is available during provider outage and contains no account entitlement claim', async () => {
  await withApp(async (request, queries) => {
    const response = await request({}, { method: 'GET', url: '/api/subscriptions/access-policy' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      contentPaywallEnabled: false,
      dailyBread: { requiresPro: false },
      prayerWalk: { requiresPro: false },
      extendedPrayer: { requiresPro: true }
    });
    assert.equal(queries.length, 0);
  });
});
