'use strict';
const express = require('express');

module.exports = function moderationRoutes(ctx) {
  const router = express.Router();
  const { pool, authenticate, createGmailTransporter, log } = ctx;

  // POST /reportContent - Report a prayer request for review
  router.post('/reportContent', authenticate, async (req, res) => {
    log(req);
    try {
      const { requestId, reportedBy, reportedAt } = req.body;

      if (!requestId || !reportedBy) {
        return res.status(400).json({ ok: false, error: "Required params 'requestId' and 'reportedBy' missing" });
      }

      await pool.query(`
        INSERT INTO public.content_reports (request_id, reported_by, reported_at, created_at)
        VALUES ($1, $2, $3, NOW())
      `, [requestId, reportedBy, reportedAt || new Date().toISOString()]);

      // Fire-and-forget admin email notification
      (async () => {
        try {
          const transporter = createGmailTransporter();
          await transporter.sendMail({
            from: `"Pray Over Us" <${process.env.GMAIL_USER}>`,
            to: process.env.GMAIL_USER,
            subject: `🚩 Content reported — prayer #${requestId}`,
            text: `A prayer request has been reported.\n\nRequest ID: ${requestId}\nReported by user ID: ${reportedBy}\nReported at: ${reportedAt || new Date().toISOString()}\n\nPlease review this request in the admin panel.`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #e74c3c;">🚩 Content Reported</h2>
                <p>A prayer request has been flagged for review.</p>
                <table style="border-collapse: collapse; width: 100%;">
                  <tr><td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Request ID</td><td style="padding: 8px; border: 1px solid #ddd;">#${requestId}</td></tr>
                  <tr><td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Reported by (user ID)</td><td style="padding: 8px; border: 1px solid #ddd;">${reportedBy}</td></tr>
                  <tr><td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Reported at</td><td style="padding: 8px; border: 1px solid #ddd;">${reportedAt || new Date().toISOString()}</td></tr>
                </table>
                <p style="margin-top: 20px; color: #7f8c8d; font-size: 0.9em;">Please review this request in the admin panel.</p>
              </div>
            `
          });
        } catch (emailErr) {
          console.error('reportContent email failed (non-fatal):', emailErr.message);
        }
      })();

      return res.json({ ok: true });
    } catch (err) {
      console.error('reportContent error:', err);
      return res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  // POST /blockUser - Block a user
  router.post('/blockUser', authenticate, async (req, res) => {
    log(req);
    try {
      const { blockerId, blockedId } = req.body;

      if (!blockerId || !blockedId) {
        return res.status(400).json({ ok: false, error: "Required params 'blockerId' and 'blockedId' missing" });
      }

      await pool.query(`
        INSERT INTO public.user_blocks (blocker_id, blocked_id, created_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (blocker_id, blocked_id) DO NOTHING
      `, [blockerId, blockedId]);

      // Fire-and-forget admin email notification
      (async () => {
        try {
          const transporter = createGmailTransporter();
          await transporter.sendMail({
            from: `"Pray Over Us" <${process.env.GMAIL_USER}>`,
            to: process.env.GMAIL_USER,
            subject: `🚫 User blocked — user #${blockedId}`,
            text: `A user has been blocked.\n\nBlocker user ID: ${blockerId}\nBlocked user ID: ${blockedId}\nTimestamp: ${new Date().toISOString()}`,
            html: `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #e67e22;">🚫 User Blocked</h2>
                <p>A user has blocked another user.</p>
                <table style="border-collapse: collapse; width: 100%;">
                  <tr><td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Blocker (user ID)</td><td style="padding: 8px; border: 1px solid #ddd;">${blockerId}</td></tr>
                  <tr><td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Blocked (user ID)</td><td style="padding: 8px; border: 1px solid #ddd;">${blockedId}</td></tr>
                  <tr><td style="padding: 8px; font-weight: bold; border: 1px solid #ddd;">Timestamp</td><td style="padding: 8px; border: 1px solid #ddd;">${new Date().toISOString()}</td></tr>
                </table>
              </div>
            `
          });
        } catch (emailErr) {
          console.error('blockUser email failed (non-fatal):', emailErr.message);
        }
      })();

      return res.json({ ok: true });
    } catch (err) {
      console.error('blockUser error:', err);
      return res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  return router;
};
