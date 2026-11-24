'use strict';

// Pre-release characterization, not an exception to session or ownership checks.
// No application database, real customer, provider API or prayer content is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const multer = require('multer');
const path = require('node:path');
const prayers = require('../routes/prayers');
const subscriptions = require('../routes/subscriptions');
const { issueUserSessionToken, requireUserSession } = require('../userSession');
const { RevenueCatProService } = require('../revenueCatProService');

async function withApp(callback, { stored = null, aliases = [], activeCanonical = false } = {}) {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'synthetic-mobile-compatibility-secret';
  let databaseReads = 0;
  const providerCalls = [];
  const service = new RevenueCatProService({
    projectId: 'synthetic-project',
    entitlementId: 'synthetic-pro',
    pool: {
      async query(sql) {
        assert.match(sql, /SELECT revenuecat_app_user_id/);
        return { rows: [{ revenuecat_app_user_id: stored }] };
      }
    },
    connectorsFactory: () => ({
      async proxy(connector, url) {
        assert.equal(connector, 'revenuecat');
        providerCalls.push(url);
        // A legacy customer's active purchase alone must not establish ownership.
        return {
          status: 200,
          ok: true,
          json: async () => ({
            items: url.includes('/aliases?')
              ? aliases.map(id => ({ id }))
              : activeCanonical ? [{ entitlement_id: 'synthetic-pro' }] : []
          })
        };
      }
    })
  });
  const app = express();
  app.use(express.json());
  const authenticate = (req, res, next) =>
    req.get('authorization') === 'Basic synthetic' ? next() : res.sendStatus(401);
  app.use(subscriptions({ authenticate, requireUserSession, proSubscriptionService: service,
    contentPaywallEnabled: false }));
  app.use(prayers({
    authenticate, requireUserSession, proSubscriptionService: service,
    contentPaywallEnabled: false, multer, path, log: () => {},
    pool: { async query() { databaseReads++; return { rows: [] }; } },
    loadFaithRanks: async () => []
  }));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const post = (route, body = {}, token = issueUserSessionToken(42), cookie = false) =>
    fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: 'POST',
      headers: {
        authorization: 'Basic synthetic', 'content-type': 'application/json',
        ...(token ? cookie
          ? { cookie: `user_session_token=${encodeURIComponent(token)}` }
          : { 'x-user-session-token': token } : {})
      },
      body: JSON.stringify(body)
    });
  try {
    await callback({ post, service, providerCalls, reads: () => databaseReads });
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
}

test('community wall accepts older valid header/cookie sessions but not missing, expired or re-signed credentials', async () => {
  await withApp(async ({ post, reads }) => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const older = issueUserSessionToken(42, { nowSeconds: nowSeconds - 29 * 86400 });
    for (const cookie of [false, true]) {
      const response = await post('/getCommunityWall', { userId: '42' }, older, cookie);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), []);
    }
    const before = reads();
    const expired = issueUserSessionToken(42, { nowSeconds: nowSeconds - 31 * 86400 });
    const otherSecret = issueUserSessionToken(42, { secret: 'synthetic-previous-secret' });
    for (const token of [null, expired, otherSecret]) {
      const response = await post('/getCommunityWall', { userId: 42 }, token);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'USER_SESSION_REQUIRED');
    }
    assert.equal(reads(), before, 'Rejected requests must not read the community database');
    assert.equal((await post('/getCommunityWall', { userId: 43 }, older)).status, 403);
  });
});

test('numeric RevenueCat IDs without a saved binding are not backward-compatible purchase proof', async () => {
  await withApp(async ({ post, providerCalls }) => {
    const numeric = await post('/api/subscriptions/pro-status', { revenuecatAppUserId: 42 });
    assert.equal(numeric.status, 400);
    const numericString = await post('/api/subscriptions/pro-status', { revenuecatAppUserId: '42' });
    assert.equal(numericString.status, 403);
    assert.equal((await numericString.json()).error, 'SUBSCRIPTION_IDENTITY_MISMATCH');
    assert.equal(providerCalls.length, 0);
    const inferred = await post('/api/subscriptions/pro-status');
    assert.equal(inferred.status, 200);
    assert.equal((await inferred.json()).isPro, false);
    assert(providerCalls.every(url => url.includes('/customers/pou_v1_')));
    assert(providerCalls.every(url => !url.includes('/customers/42/')));
  });
});

for (const stored of ['42', '$RCAnonymousID:synthetic-legacy']) {
  test(`saved ${stored === '42' ? 'numeric' : 'anonymous legacy'} mapping requires provider alias proof and remains unchanged`, async () => {
    await withApp(async ({ post, service }) => {
      const identity = await post('/api/subscriptions/identity');
      assert.equal(identity.status, 200);
      assert.match((await identity.json()).revenuecatAppUserId, /^pou_v1_/);
      const response = await post('/api/subscriptions/pro-status', { revenuecatAppUserId: stored });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.isPro, false);
      assert.equal(body.identityVerificationRequired, true);
      assert.equal((await service.getAccountIdentity({ userId: 42 })).storedAppUserId, stored);
    }, { stored, activeCanonical: true });
  });

  test(`provider-bound ${stored === '42' ? 'numeric' : 'anonymous legacy'} purchase is recognized without replacing its mapping`, async () => {
    await withApp(async ({ post, service }) => {
      const response = await post('/api/subscriptions/pro-status', {
        revenuecatAppUserId: stored, refresh: true
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.isPro, true);
      assert.equal(body.identityVerificationRequired, false);
      assert.equal((await service.getAccountIdentity({ userId: 42 })).storedAppUserId, stored);
    }, { stored, aliases: [stored], activeCanonical: true });
  });
}
