'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

test('resume reference migration is idempotent, nullable, and many-to-one', {
  skip: !process.env.DATABASE_URL && 'DATABASE_URL is required for the isolated PostgreSQL migration test'
}, async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
  });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations',
    'workshop-resume-entry-reference.sql'), 'utf8');
  // Exercise the real migration on a session-local table only. No application
  // tables or records are modified, even if this environment points at a shared DB.
  const isolatedSql = sql.replaceAll('public.crm_workshops', 'pg_temp.workshop_resume_migration_test');
  assert.ok(!isolatedSql.includes('public.crm_workshops'));
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE workshop_resume_migration_test (
      id INTEGER PRIMARY KEY, notes TEXT
    ) ON COMMIT DROP`);
    await client.query(`INSERT INTO workshop_resume_migration_test VALUES (1, 'Existing history')`);
    await client.query(isolatedSql);
    await client.query(isolatedSql);
    const existing = await client.query('SELECT * FROM workshop_resume_migration_test WHERE id = 1');
    assert.deepEqual(existing.rows[0], { id: 1, notes: 'Existing history', resume_entry_id: null });
    const columns = await client.query(`SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema LIKE 'pg_temp_%'
        AND table_name = 'workshop_resume_migration_test' AND column_name = 'resume_entry_id'`);
    assert.equal(columns.rows[0].data_type, 'text');
    assert.equal(columns.rows[0].is_nullable, 'YES');
    await client.query(`INSERT INTO workshop_resume_migration_test (id, resume_entry_id)
      VALUES (2, 'shared-entry'), (3, 'shared-entry'), (4, NULL)`);
    const rows = await client.query('SELECT * FROM workshop_resume_migration_test');
    assert.equal(rows.rowCount, 4);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
