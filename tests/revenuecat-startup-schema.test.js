'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ensureWebsiteRequestLimitSchema } = require('../websiteRequestLimitSchema');

function fixture({ duplicateCount = 0, failAt = null, failure = null } = {}) {
  const calls = [];
  const pool = {
    async query(sql) {
      calls.push(sql);
      // Any customer-row mutation is forbidden, even on a conflict.
      assert.doesNotMatch(sql, /\b(UPDATE|DELETE|TRUNCATE)\b/i);
      if (failAt && sql.includes(failAt)) throw failure;
      return { rows: [{ duplicate_count: duplicateCount }] };
    }
  };
  return { pool, calls };
}

test('duplicate mappings stop startup without resetting links or continuing schema work', async () => {
  const f = fixture({ duplicateCount: 1 });
  await assert.rejects(ensureWebsiteRequestLimitSchema('test', f.pool), error => {
    assert.equal(error.code, 'REVENUECAT_MAPPING_CONFLICT');
    assert.match(error.message, /mappings were preserved/);
    assert.doesNotMatch(error.message, /synthetic-customer/);
    return true;
  });
  assert.equal(f.calls.length, 2);
  assert(f.calls[1].includes('HAVING COUNT(*) > 1'));
  assert(f.calls.every(sql => !sql.includes('CREATE UNIQUE INDEX')));
});

test('non-conflicting mappings retain unique index and existing request schema behavior', async () => {
  const f = fixture();
  await ensureWebsiteRequestLimitSchema('test', f.pool);
  assert.equal(f.calls.length, 6);
  assert.match(f.calls[2], /CREATE UNIQUE INDEX IF NOT EXISTS user_revenuecat_app_user_id_unique_idx/);
  assert.match(f.calls[2], /WHERE revenuecat_app_user_id IS NOT NULL/);
  assert.match(f.calls[3], /ADD COLUMN IF NOT EXISTS request_source/);
  assert.match(f.calls[4], /ADD COLUMN IF NOT EXISTS website_request_date/);
  assert.equal(f.calls[5], 'DROP INDEX IF EXISTS public.request_website_daily_unique_idx');
});

test('duplicate-check database failure propagates instead of bypassing the guard', async () => {
  const failure = new Error('Synthetic database unavailable');
  const f = fixture({ failAt: 'SELECT COUNT', failure });
  await assert.rejects(ensureWebsiteRequestLimitSchema('test', f.pool), error => error === failure);
  assert.equal(f.calls.length, 2);
});

test('uniqueness race fails without clearing any purchase mappings', async () => {
  const failure = Object.assign(new Error('Synthetic uniqueness conflict'), { code: '23505' });
  const f = fixture({ failAt: 'CREATE UNIQUE INDEX', failure });
  await assert.rejects(ensureWebsiteRequestLimitSchema('test', f.pool), error => error === failure);
  assert.equal(f.calls.length, 3);
});

test('server uses the guarded initializer for both pools and blocks startup on failure', () => {
  // Do not import server.js: that would run real startup migrations.
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(source, /require\('\.\/websiteRequestLimitSchema'\)/);
  assert.match(source, /ensureWebsiteRequestLimitSchema\('dev', pool\)/);
  assert.match(source, /ensureWebsiteRequestLimitSchema\('prod', auditPool\)/);
  assert.match(source, /Promise\.all\(\[globalNotesMigrationReady, websiteRequestLimitMigrationReady, crmSchemaMigrationReady, portfolioMigrationReady\]\)\.then\(\(\) => server\.listen/);
  assert.doesNotMatch(source, /SET revenuecat_app_user_id = NULL/i);
});
