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


// GET /verifyEmail?token=xxx - Public email verification endpoint
router.get('/verifyEmail', async (req, res) => {
  const { token } = req.query;

  const page = (icon, title, message, color) => `
<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Pray Over Us</title>
<style>
  body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .card{background:#fff;border-radius:16px;padding:48px 36px;max-width:420px;width:90%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.08);}
  .icon{font-size:64px;margin-bottom:16px;}
  h1{margin:0 0 12px;font-size:24px;color:#1a1a1a;}
  p{margin:0 0 28px;color:#555;font-size:16px;line-height:1.6;}
  a{display:inline-block;padding:12px 32px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;text-decoration:none;border-radius:25px;font-weight:600;font-size:15px;}
</style></head><body>
<div class="card">
  <div class="icon">${icon}</div>
  <h1 style="color:${color}">${title}</h1>
  <p>${message}</p>
  <a href="https://www.prayoverus.com">Open Pray Over Us</a>
</div></body></html>`;

  if (!token) {
    return res.status(400).send(page('❌', 'Invalid Link', 'This verification link is missing a token. Please check your welcome email and try again.', '#dc2626'));
  }

  try {
    const tokenRes = await pool.query(
      `SELECT t.id, t.user_id, t.used, t.expires_at, u.real_name, u.email_verified
       FROM public.email_verification_tokens t
       JOIN public."user" u ON u.user_id = t.user_id
       WHERE t.token = $1`,
      [token]
    );

    if (tokenRes.rows.length === 0) {
      return res.send(page('❌', 'Link Not Found', 'This verification link is invalid or has already been used. If you need help, email us at prayoverus@gmail.com.', '#dc2626'));
    }

    const row = tokenRes.rows[0];

    if (row.email_verified) {
      return res.send(page('✅', 'Already Verified!', 'Your email address is already confirmed. You\'re all set — God bless! 🙏', '#16a34a'));
    }

    if (row.used || new Date() > new Date(row.expires_at)) {
      return res.send(page('⏰', 'Link Expired', 'This verification link has expired. Please email us at prayoverus@gmail.com and we\'ll sort it out for you.', '#d97706'));
    }

    await pool.query(
      `UPDATE public."user" SET email_verified = true WHERE user_id = $1`,
      [row.user_id]
    );
    await pool.query(
      `UPDATE public.email_verification_tokens SET used = true WHERE id = $1`,
      [row.id]
    );

    const name = row.real_name || 'Friend';
    return res.send(page('🙏', 'Email Confirmed!', `Thank you, ${name}! Your email is now verified. Welcome to the Pray Over Us community — you are not alone.`, '#16a34a'));

  } catch (err) {
    console.error('Email verification error:', err);
    return res.status(500).send(page('❌', 'Something went wrong', 'Please try again later or email us at prayoverus@gmail.com.', '#dc2626'));
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
