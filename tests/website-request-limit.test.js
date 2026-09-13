'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
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
  assert.deepEqual(USER_DAILY_POST_LIMIT_USER_IDS, [1393, 1400]);
  assert.equal(isUserDailyPostLimited(353), false);
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

test('the selected-user limit has a stable application-error response', () => {
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
  assert.equal(statusCode, 200);
  assert.equal(responseBody.code, USER_DAILY_POST_LIMIT_CODE);
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
