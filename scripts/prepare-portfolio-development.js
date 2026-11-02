'use strict';

// Development-only schema/data preparation. Never put this in a deployment
// build/run command or change its target to the CRM/production connection.
const { Pool } = require('pg');
const { migratePortfolio } = require('../portfolio/migrate');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Development DATABASE_URL is required');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000
  });
  try {
    const result = await migratePortfolio(pool);
    console.log('Development portfolio prepared:', JSON.stringify(result));
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch(error => {
  console.error('Development portfolio preparation failed:', error.message);
  process.exitCode = 1;
});

module.exports = { main };
