'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Client } = require('pg');
const {
  getPostingCalendarDate,
  checkFreeTierDailyLimit
} = require('../freeTierRequestLimit');

test('posting calendar changes at Eastern midnight, not UTC midnight', () => {
  for (const [instant, expected] of [
    ['2026-10-21T23:59:59Z', '2026-10-21'],
    ['2026-10-22T00:00:00Z', '2026-10-21'],
    ['2026-10-22T03:59:59.999Z', '2026-10-21'],
    ['2026-10-22T04:00:00Z', '2026-10-22'],
    ['2026-01-02T04:59:59.999Z', '2026-01-01'],
    ['2026-01-02T05:00:00Z', '2026-01-02'],
    ['2026-01-01T01:00:00Z', '2025-12-31']
  ]) {
    assert.equal(getPostingCalendarDate(new Date(instant)), expected, instant);
  }
});

test('a free user without a same-day post is allowed; invalid identities fail before SQL', async () => {
  let calls = 0;
  const pool = { query: async (sql, params) => {
    calls++;
    assert.deepEqual(params, [42, '2026-10-22']);
    assert.doesNotMatch(sql, /active|request_source|website_request_date/);
    return { rows: [] };
  } };
  assert.deepEqual(await checkFreeTierDailyLimit(pool, 42, false,
    new Date('2026-10-22T15:00:00Z')), { limited: false, requestDate: '2026-10-22' });
  for (const invalid of [0, -1, NaN, 'no-user', 2.5]) {
    await assert.rejects(checkFreeTierDailyLimit(pool, invalid, false),
      error => error.statusCode === 400);
  }
  assert.equal(calls, 1);
});

test('calendar SQL handles real timestamp columns, session timezones and DST', {
  skip: !process.env.DATABASE_URL && 'DATABASE_URL is required for isolated PostgreSQL checks'
}, async t => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    // Session-local fixture only: never insert or update application requests.
    await client.query(`CREATE TEMP TABLE posting_calendar_test (
      request_id INTEGER, user_id INTEGER, timestamp TIMESTAMP WITHOUT TIME ZONE,
      active SMALLINT, request_source TEXT
    ) ON COMMIT DROP`);
    let quotaSql;
    const isolatedPool = { query: (sql, params) => {
      quotaSql = sql;
      return client.query(sql.replace('public.request', 'pg_temp.posting_calendar_test'), params);
    } };

    await t.test('the observed previous-evening post does not consume the next Eastern day', async () => {
      await client.query(`INSERT INTO pg_temp.posting_calendar_test
        VALUES (1, 42, '2026-10-22 00:10:50.299037', 3, 'mobile')`);
      for (const timezone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
        await client.query(`SELECT set_config('TimeZone', $1, true)`, [timezone]);
        const previousEvening = await checkFreeTierDailyLimit(isolatedPool, 42, false,
          new Date('2026-10-22T03:59:59Z'));
        assert.equal(previousEvening.limited, true);
        const nextMorning = await checkFreeTierDailyLimit(isolatedPool, 42, false,
          new Date('2026-10-22T15:00:00Z'));
        assert.deepEqual(nextMorning, { limited: false, requestDate: '2026-10-22' });
      }
    });

    await t.test('exact lower/upper boundaries and statuses count across every client', async () => {
      for (const [instant, expected] of [
        ['2026-10-22 03:59:59.999999', false],
        ['2026-10-22 04:00:00', true],
        ['2026-10-23 03:59:59.999999', true],
        ['2026-10-23 04:00:00', false]
      ]) {
        for (const active of [0, 1, 2, 3]) {
          for (const source of ['mobile', 'website', null]) {
            await client.query('TRUNCATE pg_temp.posting_calendar_test');
            await client.query(`INSERT INTO pg_temp.posting_calendar_test
              VALUES (1, 42, $1::timestamp, $2, $3)`, [instant, active, source]);
            const result = await checkFreeTierDailyLimit(isolatedPool, 42, false,
              new Date('2026-10-22T15:00:00Z'));
            assert.equal(result.limited, expected, `${instant}/${active}/${source}`);
            assert.equal((await checkFreeTierDailyLimit(isolatedPool, 43, false,
              new Date('2026-10-22T15:00:00Z'))).limited, false);
          }
        }
      }
    });

    await t.test('spring/fall DST days span 23/25 hours, with inclusive/exclusive bounds', async () => {
      const expressions = quotaSql.match(/timestamp >= (.*)\n\s+AND timestamp < (.*)\n/);
      assert.ok(expressions);
      const [, lower, upper] = expressions;
      for (const [date, hours, start, end] of [
        ['2026-03-08', 23, '2026-03-08 05:00:00', '2026-03-09 04:00:00'],
        ['2026-11-01', 25, '2026-11-01 04:00:00', '2026-11-02 05:00:00']
      ]) {
        const boundaries = await client.query(`SELECT $1::int AS user_id,
          (${lower})::text AS start, (${upper})::text AS end,
          EXTRACT(EPOCH FROM ((${upper}) - (${lower}))) / 3600 AS hours`, [42, date]);
        assert.equal(Number(boundaries.rows[0].hours), hours);
        assert.equal(boundaries.rows[0].start, start);
        assert.equal(boundaries.rows[0].end, end);
        for (const [instant, expected] of [[start, true], [end, false]]) {
          await client.query('TRUNCATE pg_temp.posting_calendar_test');
          await client.query(`INSERT INTO pg_temp.posting_calendar_test
            VALUES (1, 42, $1::timestamp, 1, 'mobile')`, [instant]);
          const result = await checkFreeTierDailyLimit(isolatedPool, 42, false,
            new Date(`${date}T17:00:00Z`));
          assert.equal(result.limited, expected);
        }
      }
    });
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
