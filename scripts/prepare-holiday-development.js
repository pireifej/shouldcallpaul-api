'use strict';
// Development only. Never target the CRM/production connection and never place
// this script in a deployment build/run command. Publish owns managed prod DDL.
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Development DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(fs.readFileSync(path.join(__dirname, '../migrations/holiday-greetings.sql'), 'utf8'));
    await client.query(fs.readFileSync(path.join(__dirname, '../migrations/holiday-greetings-email.sql'), 'utf8'));
    await client.query('COMMIT');
    console.log('Development Holiday Greetings schema prepared; no production migration was run.');
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error('Development Holiday Greetings schema preparation failed');
  } finally { client.release(); await pool.end(); }
}
if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
module.exports = { main };
