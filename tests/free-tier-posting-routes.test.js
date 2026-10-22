'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const path = require('node:path');
const multer = require('multer');
const prayersRoutes = require('../routes/prayers');
const { getPostingCalendarDate, DAILY_LIMIT_RESPONSE } = require('../freeTierRequestLimit');

// Exercises the real Express creation handler without external services or user
// data. The fake connection models transaction-scoped advisory-lock ordering.
function fixture(options = {}) {
  const records = [];
  const events = [];
  const files = new Set();
  let clock = new Date('2026-10-22T15:00:00Z');
  let tail = Promise.resolve();
  let initialChecks = 0;
  let releaseInitialChecks;
  const initialBarrier = new Promise(resolve => { releaseInitialChecks = resolve; });

  async function query(sql, params, inTransaction = false) {
    if (/SELECT request_id\s+FROM public.request/.test(sql)) {
      events.push(inTransaction ? 'locked-check' : 'initial-check');
      const rows = records.filter(row => row.user_id === params[0] &&
        getPostingCalendarDate(new Date(row.timestamp)) === params[1]);
      if (options.concurrent && !inTransaction) {
        if (++initialChecks === 2) releaseInitialChecks();
        await initialBarrier;
      }
      return { rows };
    }
    if (sql.includes('INSERT INTO public.request')) {
      assert.match(sql, /\$12::timestamp/);
      assert.doesNotMatch(sql, /NOW\(\)/);
      const row = {
        request_id: records.length + 1, user_id: params[0],
        active: params[5], timestamp: params[11],
        request_source: params[9], website_request_date: params[10]
      };
      records.push(row);
      return { rows: [row] };
    }
    if (sql.includes('SELECT can_post')) return { rows: [{ can_post: true }] };
    if (sql.includes('SELECT "user".real_name')) {
      return { rows: [{ real_name: 'Test Member', picture: null }] };
    }
    if (sql.includes('INSERT INTO public.prayers')) return { rows: [{ prayer_id: 123 }] };
    if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: '1' }] };
    if (sql.trim().startsWith('UPDATE')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected fixture query: ${sql}`);
  }

  const pool = {
    query,
    async connect() {
      let unlock;
      return {
        async query(sql, params) {
          if (sql === 'BEGIN') { events.push('BEGIN'); return { rows: [] }; }
          if (sql.includes('pg_advisory_xact_lock')) {
            assert.deepEqual(params, [42]);
            const previous = tail;
            tail = new Promise(resolve => { unlock = resolve; });
            await previous;
            events.push('lock');
            if (options.onLock) clock = options.onLock();
            return { rows: [] };
          }
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            events.push(sql);
            unlock();
            return { rows: [] };
          }
          return query(sql, params, true);
        },
        release() { events.push('release'); }
      };
    }
  };

  const router = prayersRoutes({
    pool, path, multer,
    postingNow: () => new Date(clock),
    authenticate: (req, res, next) => {
      req.apiClientType = req.get('x-test-client') || 'mobile';
      next();
    },
    requireUserSession: (req, res, next) => { req.userId = 42; next(); },
    fs: {
      existsSync: file => files.has(file),
      writeFileSync: file => files.add(file),
      unlink: (file, done) => { files.delete(file); done(null); }
    },
    proSubscriptionService: { getProStatus: async () => {
      if (options.providerError) throw Object.assign(new Error('Unavailable'), { statusCode: 503 });
      return { isPro: options.isPro || false };
    } },
    generatePrayer: async () => ({ processedPrayer: 'A test prayer.' }),
    translateText: async text => text,
    awardBadge: async () => {},
    prayerAudioCache: new Map()
  });
  return { router, records, events, files, setClock: instant => { clock = new Date(instant); } };
}

async function withServer(f, run) {
  const app = express();
  app.use(express.json());
  app.use(f.router);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  let key = 0;
  const post = (endpoint, client = 'mobile', extra = {}) => fetch(
    `http://127.0.0.1:${server.address().port}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-client': client },
      body: JSON.stringify({
        userId: 42, requestText: 'Please pray for peace.', requestTitle: 'Peace',
        sendEmail: 'false', isTest: true, idempotencyKey: `calendar-test-${++key}`,
        ...extra
      })
    });
  try {
    await run(post);
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

for (const [endpoint, client] of [
  ['/api/prayers/post', 'mobile'],
  ['/createRequestAndPrayer', 'mobile'],
  ['/createWebsiteRequestAndPrayer', 'website']
]) {
  test(`${endpoint}: first Eastern-day post succeeds, cross-client second post is denied`, async () => {
    const f = fixture();
    // The production regression: yesterday evening, but today's UTC date.
    f.records.push({ request_id: 100, user_id: 42, timestamp: '2026-10-22T00:10:50Z', active: 3 });
    await withServer(f, async post => {
      const first = await post(endpoint, client, { tz: 'Pacific/Kiritimati' });
      assert.equal(first.status, 200);
      assert.equal((await first.json()).success, true);
      const second = await post('/api/prayers/post',
        client === 'mobile' ? 'website' : 'mobile', { tz: 'Pacific/Honolulu' });
      assert.equal(second.status, 403);
      assert.deepEqual(await second.json(), DAILY_LIMIT_RESPONSE);
      assert.equal(f.records.length, 2);
      assert.equal(f.files.size, 0);
    });
  });
}

test('two simultaneous free posts cannot both pass the locked check', async () => {
  const f = fixture({ concurrent: true });
  await withServer(f, async post => {
    const responses = await Promise.all([
      post('/api/prayers/post'), post('/createWebsiteRequestAndPrayer', 'website')
    ]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 403]);
    for (const response of responses) {
      const body = await response.json();
      if (response.status === 403) assert.deepEqual(body, DAILY_LIMIT_RESPONSE);
      else assert.equal(body.success, true);
    }
    assert.equal(f.records.length, 1);
    assert.equal(f.events.filter(e => e === 'locked-check').length, 2);
    assert.equal(f.events.filter(e => e === 'COMMIT').length, 1);
    assert.equal(f.events.filter(e => e === 'ROLLBACK').length, 1);
    assert.equal(f.events.filter(e => e === 'release').length, 2);
    assert.equal(f.files.size, 0);
  });
});

test('waiting across Eastern midnight recomputes the check and insertion bucket together', async () => {
  const f = fixture({ onLock: () => new Date('2026-10-22T04:00:00.001Z') });
  f.setClock('2026-10-22T03:59:59.999Z');
  await withServer(f, async post => {
    const response = await post('/createWebsiteRequestAndPrayer', 'website');
    assert.equal((await response.json()).success, true);
    assert.equal(f.records[0].website_request_date, '2026-10-22');
    assert.equal(f.records[0].timestamp, '2026-10-22T04:00:00.001Z');
    const retry = await post('/api/prayers/post');
    assert.equal(retry.status, 403);
    assert.deepEqual(await retry.json(), DAILY_LIMIT_RESPONSE);
  });
});

test('verified Pro users can post repeatedly without quota lookup or user locks', async () => {
  const f = fixture({ isPro: true });
  await withServer(f, async post => {
    for (const client of ['website', 'mobile']) {
      const response = await post('/api/prayers/post', client);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).success, true);
    }
    assert.equal(f.records.length, 2);
    assert.deepEqual(f.events, []);
  });
});

test('subscription verification errors do not become DAILY_LIMIT_REACHED', async () => {
  const f = fixture({ providerError: true });
  await withServer(f, async post => {
    const response = await post('/api/prayers/post');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'PRO_STATUS_UNAVAILABLE');
    assert.equal(f.records.length, 0);
    assert.equal(f.files.size, 0);
  });
});
