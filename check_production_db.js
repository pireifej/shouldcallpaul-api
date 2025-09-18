const { Pool } = require('pg');
require('dotenv').config();

console.log('🔍 Environment Check:');
console.log('DATABASE_URL exists:', !!process.env.DATABASE_URL);
console.log('DATABASE_URL preview:', process.env.DATABASE_URL ? process.env.DATABASE_URL.substring(0, 20) + '...' : 'none');

// Check if there are any production-specific environment variables
const envVars = Object.keys(process.env).filter(key => 
  key.toLowerCase().includes('prod') || 
  key.toLowerCase().includes('deploy') ||
  key.toLowerCase().includes('database')
);

console.log('🔍 Database-related environment variables:');
envVars.forEach(key => {
  if (key.includes('DATABASE') || key.includes('PGHOST')) {
    console.log(`${key}: ${process.env[key]?.substring(0, 20)}...`);
  } else {
    console.log(`${key}: exists`);
  }
});

// Test development database connection
async function testDatabase() {
  try {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    console.log('\n🔄 Testing current DATABASE_URL connection...');
    const result = await pool.query('SELECT COUNT(*) as count FROM public.blog_article');
    console.log(`📊 blog_article records found: ${result.rows[0].count}`);
    
    // Get the database name/host to identify which database this is
    const dbInfo = await pool.query('SELECT current_database(), inet_server_addr(), inet_server_port()');
    console.log('🗄️  Database info:', dbInfo.rows[0]);
    
    await pool.end();
  } catch (error) {
    console.error('❌ Database connection error:', error.message);
  }
}

testDatabase();