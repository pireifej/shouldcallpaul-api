const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Enable CORS for mobile and web apps
app.use(express.json()); // Parse JSON request bodies

// PostgreSQL connection pool - use production database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Basic authentication middleware
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  // Extract base64 encoded credentials
  const base64Credentials = authHeader.slice(6);
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const [username, password] = credentials.split(':');
  
  // Check credentials against environment variables
  if (username === process.env.API_USERNAME && password === process.env.API_PASSWORD) {
    next(); // Authentication successful
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
};

// GET /api/requests - Retrieve all requests from database
app.get('/api/requests', authenticate, async (req, res) => {
  try {
    // Query the public.request table for all records
    const result = await pool.query('SELECT * FROM public.request ORDER BY timestamp DESC');
    
    // Return the data as JSON array
    res.json(result.rows);
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check endpoint (no authentication required)
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Debug endpoint to check database connection (no authentication)
app.get('/debug', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as current_time, current_database() as db_name');
    res.json({ 
      status: 'Database connected', 
      database: result.rows[0].db_name,
      time: result.rows[0].current_time 
    });
  } catch (error) {
    res.json({ 
      status: 'Database error', 
      error: error.message,
      code: error.code 
    });
  }
});

// Migration endpoint to import development data (requires authentication)
app.post('/migrate-data', authenticate, async (req, res) => {
  try {
    console.log('Starting data migration...');
    
    // Get SQL from request body
    const { sql } = req.body;
    
    if (!sql) {
      return res.status(400).json({ error: 'SQL statements required in request body' });
    }
    
    // Execute migration in transaction
    await pool.query('BEGIN');
    await pool.query(sql);
    await pool.query('COMMIT');
    
    // Check results
    const counts = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM public.blessings) as blessings,
        (SELECT COUNT(*) FROM public.request) as requests,
        (SELECT COUNT(*) FROM public."user") as users,
        (SELECT COUNT(*) FROM public.comments) as comments,
        (SELECT COUNT(*) FROM public.prayers) as prayers,
        (SELECT COUNT(*) FROM public.user_request) as user_requests,
        (SELECT COUNT(*) FROM public.blog_article) as blog_articles,
        (SELECT COUNT(*) FROM public.settings) as settings,
        (SELECT COUNT(*) FROM public.sponge) as sponge
    `);
    
    console.log('Migration completed successfully');
    res.json({
      status: 'Migration completed successfully',
      imported_counts: counts.rows[0]
    });
    
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Migration failed:', error);
    res.status(500).json({
      status: 'Migration failed',
      error: error.message
    });
  }
});

// Start server on 0.0.0.0 for public accessibility
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`API endpoint: http://0.0.0.0:${PORT}/api/requests`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  await pool.end();
  process.exit(0);
});