'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const prayersRoutes = require('../routes/prayers');
const devotionalRoutes = require('../routes/devotional');
const {
  RevenueCatProService,
  PRO_REQUIRED_RESPONSE
} = require('../revenueCatProService');
const {
  DAILY_LIMIT_RESPONSE,
  checkFreeTierDailyLimit,
  sendFreeTierDailyLimitResponse
} = require('../freeTierRequestLimit');
const {
  issueUserSessionToken,
  verifyUserSessionToken,
  requireUserSession
} = require('../userSession');

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    }
  };
}

test('RevenueCat active entitlement is cached and confirmed identity is saved', async () => {
  let providerCalls = 0;
  const queries = [];
  let storedAppUserId = null;
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('SELECT revenuecat_app_user_id')) {
        return { rows: [{ revenuecat_app_user_id: storedAppUserId }] };
      }
      if (sql.includes('UPDATE public."user"')) {
        storedAppUserId = params[0];
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  const service = new RevenueCatProService({
    pool,
    projectId: 'project',
    entitlementId: 'pro-entitlement',
    entitlementKey: 'Pray Over Us Pro',
    connectorsFactory: () => ({
      async proxy() {
        providerCalls++;
        return jsonResponse(200, {
          items: [{ entitlement_id: 'pro-entitlement' }]
        });
      }
    })
  });

  const first = await service.getProStatus({
    userId: 42,
    revenuecatAppUserId: '$RCAnonymousID:subscriber'
  });
  const second = await service.getProStatus({
    userId: 42,
    revenuecatAppUserId: '$RCAnonymousID:subscriber'
  });

  assert.equal(first.isPro, true);
  assert.equal(second.isPro, true);
  assert.equal(second.source, 'cache');
  assert.equal(providerCalls, 1);
  assert.equal(queries.filter(query => query.sql.includes('UPDATE public."user"')).length, 1);
});

test('inactive RevenueCat identity is not saved', async () => {
  let updateCount = 0;
  const service = new RevenueCatProService({
    pool: {
      async query(sql) {
        if (sql.includes('SELECT revenuecat_app_user_id')) {
          return { rows: [{ revenuecat_app_user_id: null }] };
        }
        updateCount++;
        return { rows: [] };
      }
    },
    projectId: 'project',
    entitlementId: 'pro-entitlement',
    connectorsFactory: () => ({
      proxy: async () => jsonResponse(200, { items: [] })
    })
  });

  const status = await service.getProStatus({
    userId: 42,
    revenuecatAppUserId: '$RCAnonymousID:free'
  });

  assert.equal(status.isPro, false);
  assert.equal(updateCount, 0);
});

test('a supplied RevenueCat identity cannot replace an existing mapping', async () => {
  let providerCalls = 0;
  const service = new RevenueCatProService({
    pool: {
      query: async () => ({
        rows: [{ revenuecat_app_user_id: '$RCAnonymousID:original' }]
      })
    },
    projectId: 'project',
    entitlementId: 'pro-entitlement',
    connectorsFactory: () => ({
      async proxy() {
        providerCalls++;
        return jsonResponse(200, { items: [{ entitlement_id: 'pro-entitlement' }] });
      }
    })
  });

  await assert.rejects(
    service.getProStatus({
      userId: 42,
      revenuecatAppUserId: '$RCAnonymousID:different'
    }),
    error => error.statusCode === 409
  );
  assert.equal(providerCalls, 0);
});

test('RevenueCat lookups reject excess distinct work when concurrency queue is full', async () => {
  let releaseFirst;
  const firstLookup = new Promise(resolve => {
    releaseFirst = resolve;
  });
  const service = new RevenueCatProService({
    pool: { query: async () => ({ rows: [] }) },
    projectId: 'project',
    entitlementId: 'pro-entitlement',
    maxConcurrentLookups: 1,
    maxQueuedLookups: 0,
    connectorsFactory: () => ({
      proxy: async () => {
        await firstLookup;
        return jsonResponse(200, { items: [] });
      }
    })
  });

  const first = service.getFreshEntitlementStatus('first-id');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    service.getFreshEntitlementStatus('second-id'),
    error => error.statusCode === 503
  );
  releaseFirst();
  await first;
});

test('free tier is limited after one request on the UTC day and Pro bypasses lookup', async () => {
  let queryCount = 0;
  const pool = {
    async query(sql, params) {
      queryCount++;
      assert.match(sql, /timestamp::date = \$2::date/);
      assert.deepEqual(params, [42, '2026-09-13']);
      return { rows: [{ request_id: 9001 }] };
    }
  };

  const free = await checkFreeTierDailyLimit(
    pool,
    42,
    false,
    new Date('2026-09-13T23:59:59.000Z')
  );
  const pro = await checkFreeTierDailyLimit(pool, 42, true);

  assert.deepEqual(free, { limited: true, requestDate: '2026-09-13' });
  assert.deepEqual(pro, { limited: false, requestDate: null });
  assert.equal(queryCount, 1);
});

test('free-tier daily-limit response uses the exact 403 contract', () => {
  let status;
  let body;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    }
  };

  sendFreeTierDailyLimitResponse(res);
  assert.equal(status, 403);
  assert.deepEqual(body, DAILY_LIMIT_RESPONSE);
});

async function withServer(router, callback) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function prayerRouter(overrides = {}) {
  return prayersRoutes({
    pool: { query: async () => ({ rows: [] }) },
    authenticate: (req, res, next) => next(),
    generatePrayer: async (...args) => ({
      authorName: args[1],
      processedPrayer: args[4] ? 'extended prayer' : 'standard prayer',
      rawPrayer: args[4] ? 'extended prayer' : 'standard prayer'
    }),
    proSubscriptionService: {
      getProStatus: async () => ({ isPro: false })
    },
    requirePro: (req, res) => res.status(403).json(PRO_REQUIRED_RESPONSE),
    requireUserSession: (req, res, next) => next(),
    prayerAudioCache: new Map(),
    MAX_PRAYER_AUDIO_CACHE: 10,
    PRAYER_AUDIO_DIR: '/tmp',
    multer,
    path,
    fs,
    ...overrides
  });
}

test('standard prayer generation is free and defaults extended to false', async () => {
  await withServer(prayerRouter(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/prayers/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestText: 'Please pray for my family.' })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.extended, false);
    assert.equal(body.generatedPrayer, 'standard prayer');
  });
});

test('extended prayer generation denies free users', async () => {
  await withServer(prayerRouter(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/prayers/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 42,
        revenuecatAppUserId: '$RCAnonymousID:free',
        requestText: 'Please pray for my family.',
        extended: true
      })
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), PRO_REQUIRED_RESPONSE);
  });
});

test('extended prayer generation is enabled for Pro users', async () => {
  await withServer(prayerRouter({
    proSubscriptionService: {
      getProStatus: async () => ({ isPro: true })
    }
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/prayers/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 42,
        revenuecatAppUserId: '$RCAnonymousID:pro',
        requestText: 'Please pray for my family.',
        extended: true
      })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.extended, true);
    assert.equal(body.generatedPrayer, 'extended prayer');
  });
});

test('extended generation reports a retryable failure instead of a short fallback', async () => {
  await withServer(prayerRouter({
    generatePrayer: async () => {
      const error = new Error('Extended prayer generation is temporarily unavailable; please retry');
      error.statusCode = 503;
      error.code = 'PRAYER_GENERATION_UNAVAILABLE';
      throw error;
    },
    proSubscriptionService: {
      getProStatus: async () => ({ isPro: true })
    }
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/prayers/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: 42,
        requestText: 'Please pray for my family.',
        extended: true
      })
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error, 'PRAYER_GENERATION_UNAVAILABLE');
  });
});

test('today’s Daily Bread content and audio are free while archive features enforce the Pro guard', async () => {
  const deny = (req, res) => res.status(403).json(PRO_REQUIRED_RESPONSE);
  const dailyRouter = devotionalRoutes({
    pool: {
      query: async () => ({
        rows: [{
          id: 1,
          date: '2026-09-16',
          lang: 'en',
          title: 'Daily Bread',
          bible_verse: 'Be still.',
          verse_reference: 'Psalm 46:10',
          article_body: 'A devotional for today.',
          prayer: 'Amen.',
          theme: 'Peace',
          image_url: null
        }]
      })
    },
    authenticate: (req, res, next) => next(),
    requireUserSession: (req, res, next) => next(),
    requirePro: deny,
    dailyBreadAudioCache: new Map()
  });

  await withServer(dailyRouter, async (baseUrl) => {
    for (const endpoint of ['/api/daily-bread', '/getDailyDevotional']) {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 42 })
      });
      assert.equal(response.status, 200, endpoint);
      assert.equal((await response.json()).error, 0, endpoint);
    }

    const audioResponse = await fetch(`${baseUrl}/getDailyBreadAudio`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 42, date: '2026-09-16', checkOnly: true })
    });
    assert.equal(audioResponse.status, 200);
    assert.equal((await audioResponse.json()).success, true);

    for (const endpoint of [
      '/getDailyDevotionalById',
      '/getDailyDevotionalArchive',
      '/readDailyBread'
    ]) {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 42 })
      });
      assert.equal(response.status, 403, endpoint);
    }
  });

  await withServer(prayerRouter({ requirePro: deny }), async (baseUrl) => {
    for (const endpoint of [
      '/api/prayer-walk/stream',
      '/getPrayerAudio',
      '/getDetailedPrayerByRequestId'
    ]) {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 42, requestId: 1, text: 'Prayer' })
      });
      assert.equal(response.status, 403, endpoint);
    }
  });
});

test('signed user sessions verify their user ID and expiration', () => {
  const secret = 'test-session-secret-that-is-long-enough';
  const token = issueUserSessionToken(42, {
    secret,
    nowSeconds: 1_000,
    ttlSeconds: 60
  });
  assert.equal(verifyUserSessionToken(token, { secret, nowSeconds: 1_030 }).sub, 42);
  assert.throws(
    () => verifyUserSessionToken(token, { secret, nowSeconds: 1_061 }),
    /Expired or invalid/
  );
  assert.throws(
    () => verifyUserSessionToken(`${token}tampered`, { secret, nowSeconds: 1_030 }),
    /Invalid user session token/
  );
});

test('user-session middleware rejects body impersonation and derives userId from token', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'middleware-test-session-secret';
  try {
    const token = issueUserSessionToken(42);
    const app = express();
    app.use(express.json());
    app.post('/secure', requireUserSession, (req, res) => {
      res.json({ userId: req.userId, bodyUserId: req.body.userId });
    });

    await withServer(app, async (baseUrl) => {
      const valid = await fetch(`${baseUrl}/secure`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-session-token': token
        },
        body: JSON.stringify({})
      });
      assert.deepEqual(await valid.json(), { userId: 42, bodyUserId: 42 });

      const mismatch = await fetch(`${baseUrl}/secure`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-session-token': token
        },
        body: JSON.stringify({ userId: 99 })
      });
      assert.equal(mismatch.status, 403);
      assert.equal((await mismatch.json()).error, 'USER_ID_MISMATCH');

      const missing = await fetch(`${baseUrl}/secure`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 42 })
      });
      assert.equal(missing.status, 401);
      assert.equal((await missing.json()).error, 'USER_SESSION_REQUIRED');
    });
  } finally {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
});

test('/getPrayer never returns cached extended content to a free user', async () => {
  await withServer(prayerRouter({
    pool: {
      query: async () => ({
        rows: [{
          extended_prayer: 'premium extended prayer',
          standard_prayer: 'free standard prayer'
        }]
      })
    }
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/getPrayer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 42, requestId: 1 })
    });
    const body = await response.json();
    assert.equal(body.prayerText, 'free standard prayer');
    assert.equal(body.isExtended, false);
  });
});