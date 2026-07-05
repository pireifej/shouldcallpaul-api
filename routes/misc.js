'use strict';
const express = require('express');

module.exports = function miscRoutes(ctx) {
  const router = express.Router();
  const { pool } = ctx;

router.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Prayer Over Us API Server',
    timestamp: new Date().toISOString() 
  });
});

// Health check endpoint (no authentication required)
router.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// GET /getAllChurches - Get all churches (no authentication required)
// GET /getFaithRanks - Get all faith rank levels

router.get('/getAllChurches', async (req, res) => {
  try {
    const query = `
      SELECT church_id, church_name, church_addr
      FROM public.church
      ORDER BY church_name ASC
    `;
    
    const result = await pool.query(query);
    
    res.json({
      error: 0,
      churches: result.rows
    });
  } catch (err) {
    console.error('Error fetching churches:', err);
    res.status(500).json({ error: 'Database error: ' + err.message });
  }
});


// GET /getStats - Public stats (no authentication required)
router.get('/getStats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM public.user_request) AS "totalPrayers",
        (SELECT COUNT(*) FROM public.request)      AS "totalRequests",
        (SELECT COUNT(*) FROM public."user")       AS "totalUsers"
    `);
    const row = result.rows[0];
    res.json({
      error: 0,
      totalPrayers: parseInt(row.totalPrayers),
      totalRequests: parseInt(row.totalRequests),
      totalUsers: parseInt(row.totalUsers)
    });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 1, result: 'Database error: ' + err.message });
  }
});

  return router;
};
