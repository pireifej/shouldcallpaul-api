'use strict';
// DEVELOPMENT ONLY. Never use the production pool, startup, or deployment build.
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Development DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, '../migrations/subscription-identity-reconciliation.sql'), 'utf8'));
    console.log('Development subscription reconciliation schema prepared; no approvals or mappings changed.');
  } catch {
    throw new Error('Development subscription reconciliation schema preparation failed');
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
