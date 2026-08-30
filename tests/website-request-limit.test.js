'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const prayersRoutes = require('../routes/prayers');
const {
  WEBSITE_DAILY_LIMIT_CODE,
  WEBSITE_DOWNLOAD_URL,
  WEBSITE_REQUEST_SOURCE,
  USER_DAILY_POST_LIMIT_USER_IDS,
  USER_DAILY_POST_LIMIT_CODE,
  getUtcCalendarDate,
  isUserDailyPostLimited,
  userDailyPostLimitPayload,
  sendUserDailyPostLimitResponse,
  checkUserDailyPostLimit,
  websiteDailyLimitPayload,
  sendWebsiteDailyLimitResponse,
  checkWebsiteRequestLimit
} = require('../websiteRequestLimit');

test('only the selected users have the all-client daily limit', () => {
  assert.deepEqual(USER_DAILY_POST_LIMIT_USER_IDS, [353, 1393, 1400]);
  assert.equal(isUserDailyPostLimited(353), true);
  assert.equal(isUserDailyPostLimited(1393), true);
  assert.equal(isUserDailyPostLimited('1400'), true);
  assert.equal(isUserDailyPostLimited(42), false);
});

test('unselected users bypass the targeted daily-limit lookup', async () => {
  let queryCount = 0;
  const pool = {
    async query() {
      queryCount++;
      return { rows: [] };
    }
  };

  const result = await checkUserDailyPostLimit(pool, { userId: 42 });

  assert.deepEqual(result, { limited: false, requestDate: null });
  assert.equal(queryCount, 0);
});

test('selected-user limit counts any request status on the UTC date', async () => {
  let query;
  const pool = {
    async query(sql, params) {
      query = { sql, params };
      return { rows: [{ request_id: 2140, active: 3 }] };
    }
  };

  const result = await checkUserDailyPostLimit(
    pool,
    { userId: '1393' },
    new Date('2026-08-30T23:59:59.000Z')
  );

  assert.equal(result.limited, true);
  assert.equal(result.requestDate, '2026-08-30');
  assert.match(query.sql, /timestamp::date = \$2::date/);
  assert.doesNotMatch(query.sql, /active/);
  assert.deepEqual(query.params, [1393, '2026-08-30']);
});

test('the selected-user limit has a stable 429 response', () => {
  let statusCode;
  let responseBody;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  assert.deepEqual(userDailyPostLimitPayload(), {
    error: 1,
    code: USER_DAILY_POST_LIMIT_CODE,
    result: 'You can post one prayer request per day. Your limit resets at midnight UTC.'
  });

  sendUserDailyPostLimitResponse(res);
  assert.equal(statusCode, 429);
  assert.equal(responseBody.code, USER_DAILY_POST_LIMIT_CODE);
});

test('content moderation returns the selected-user limit before calling AI', async () => {
  let openAiCallCount = 0;
  const pool = {
    async query(sql) {
      if (sql.includes('timestamp::date')) {
        return { rows: [{ request_id: 2141 }] };
      }
      throw new Error(`Unexpected test query: ${sql}`);
    }
  };
  const app = express();
  app.use(express.json());
  app.use(prayersRoutes({
    pool,
    authenticate: (req, res, next) => next(),
    openai: {
      chat: {
        completions: {
          create() {
            openAiCallCount++;
            return Promise.resolve({ choices: [] });
          }
        }
      }
    },
    multer,
    path,
    fs
  }));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/checkPrayerContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 1393,
          requestText: 'Please pray for me'
        })
      }
    );
    const body = await response.json();

    assert.equal(response.status, 429);
    assert.equal(body.code, USER_DAILY_POST_LIMIT_CODE);
    assert.equal(openAiCallCount, 0);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('mobile requests bypass the website-only lookup', async () => {
  let queryCount = 0;
  const pool = {
    async query() {
      queryCount++;
      return { rows: [] };
    }
  };

  const result = await checkWebsiteRequestLimit(pool, { userId: 42 }, 'mobile');

  assert.equal(result.limited, false);
  assert.equal(result.requestDate, null);
  assert.equal(queryCount, 0);
});

test('website request dates use a fixed UTC calendar day', () => {
  const instant = new Date('2026-08-26T03:30:00.000Z');
  assert.equal(getUtcCalendarDate(instant), '2026-08-26');
});

test('the first website request is allowed and checks the stored day', async () => {
  let query;
  const pool = {
    async query(sql, params) {
      query = { sql, params };
      return { rows: [] };
    }
  };

  const result = await checkWebsiteRequestLimit(pool, {
    userId: 42,
    tz: 'America/New_York'
  }, WEBSITE_REQUEST_SOURCE, new Date('2026-08-26T03:30:00.000Z'));

  assert.equal(result.limited, false);
  assert.equal(result.requestDate, '2026-08-26');
  assert.match(query.sql, /request_source = \$2/);
  assert.deepEqual(query.params, [42, 'website', '2026-08-26']);
});

test('a second website request is reported as limited', async () => {
  const pool = {
    async query() {
      return { rows: [{ request_id: 9001 }] };
    }
  };

  const result = await checkWebsiteRequestLimit(pool, {
    userId: 42,
    tz: 'America/New_York'
  }, WEBSITE_REQUEST_SOURCE, new Date('2026-08-26T03:30:00.000Z'));

  assert.equal(result.limited, true);
  assert.equal(result.requestDate, '2026-08-26');
});

test('changing request timezones cannot change the daily bucket', async () => {
  const checkedDates = [];
  const pool = {
    async query(sql, params) {
      checkedDates.push(params[2]);
      return { rows: [] };
    }
  };
  const instant = new Date('2026-08-26T23:30:00.000Z');

  await checkWebsiteRequestLimit(
    pool,
    { userId: 42, tz: 'Pacific/Kiritimati' },
    WEBSITE_REQUEST_SOURCE,
    instant
  );
  await checkWebsiteRequestLimit(
    pool,
    { userId: 42, tz: 'Pacific/Honolulu' },
    WEBSITE_REQUEST_SOURCE,
    instant
  );

  assert.deepEqual(checkedDates, ['2026-08-26', '2026-08-26']);
});

test('the daily-limit response has a stable code and app link', () => {
  assert.deepEqual(websiteDailyLimitPayload(), {
    error: 1,
    code: WEBSITE_DAILY_LIMIT_CODE,
    result: 'You can post one prayer request per day from the website. To post additional requests, download the Pray Over Us app and sign in with the same credentials.',
    downloadUrl: WEBSITE_DOWNLOAD_URL
  });
});

test('the daily-limit response uses HTTP 429', () => {
  let statusCode;
  let responseBody;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    }
  };

  sendWebsiteDailyLimitResponse(res);

  assert.equal(statusCode, 429);
  assert.equal(responseBody.code, WEBSITE_DAILY_LIMIT_CODE);
});

test('the legacy endpoint limits the authenticated website identity despite body source', async () => {
  let websiteLookupCount = 0;
  const pool = {
    async query(sql) {
      if (sql.includes('SELECT can_post')) {
        return { rows: [{ can_post: true }] };
      }
      if (sql.includes('request_source = $2')) {
        websiteLookupCount++;
        return { rows: [{ request_id: 9001 }] };
      }
      throw new Error(`Unexpected test query: ${sql}`);
    }
  };
  const app = express();
  app.use(express.json());
  app.use(prayersRoutes({
    pool,
    authenticate: (req, res, next) => {
      req.apiClientType = WEBSITE_REQUEST_SOURCE;
      next();
    },
    multer,
    path,
    fs
  }));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const idempotencyKey = `website-limit-test-${process.pid}`;
  const idempotencyFile = path.join(__dirname, '..', 'routes', `${idempotencyKey}.txt`);

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/createRequestAndPrayer`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: 42,
          requestText: 'Please pray for me',
          requestTitle: 'A prayer request',
          sendEmail: 'true',
          tz: 'Pacific/Kiritimati',
          idempotencyKey,
          source: 'mobile'
        })
      }
    );
    const body = await response.json();

    assert.equal(response.status, 429);
    assert.equal(body.code, WEBSITE_DAILY_LIMIT_CODE);
    assert.equal(websiteLookupCount, 1);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (fs.existsSync(idempotencyFile)) fs.unlinkSync(idempotencyFile);
  }
});