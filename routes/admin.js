'use strict';
const express = require('express');

module.exports = function adminRoutes(ctx) {
  const router = express.Router();
  const { pool, authenticate, openai, sendGmailSingle, createGmailTransporter, sendPushNotification, runProdBackup, BACKUP_DIR, fs, path, log } = ctx;

router.post('/getRequestCount', authenticate, async (req, res) => {
  try {
    log(req);
    const params = req.body;
    
    // Simple count query - no parameters needed
    const query = `SELECT COUNT(*) as count FROM public.request`;
    
    const result = await pool.query(query);
    res.json(result.rows);
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /getAllRequests - Get all requests
router.post('/getAllRequests', authenticate, async (req, res) => {
  try {
    log(req);
    const params = req.body;
    
    // Select all requests, sorted by most recent first
    const query = `SELECT * FROM public.request ORDER BY timestamp DESC`;
    
    const result = await pool.query(query);
    res.json(result.rows);
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /getAllPrayers - Get all prayers sorted by most recent first
router.post('/getAllPrayers', authenticate, async (req, res) => {
  try {
    log(req);
    const params = req.body;
    
    // Select all prayers, sorted by most recent first (by prayer_id since no timestamp column)
    const query = `SELECT * FROM public.prayers ORDER BY prayer_id DESC`;
    
    const result = await pool.query(query);
    res.json(result.rows);
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /getBlogArticle - Get single blog article with content from flat file

router.post('/getChatCompletion', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    if (!params.content) {
      return res.json({ error: 1, result: "Required param 'content' missing" });
    }
    
    // Call OpenAI API with the content as user message
    // the newest OpenAI model is "gpt-5" which was released August 7, 2025. do not change this unless explicitly requested by the user
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: params.content
        }
      ]
    });
    
    // Return the full OpenAI response (matches original curl output format)
    res.json(response);
    
  } catch (error) {
    console.error('OpenAI API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /getDailyBreadAudio - Generate (or serve cached) TTS audio for a Daily Bread devotional
// No authentication required. Supports Range requests for ExoPlayer streaming.

router.post('/sendBroadcastEmail', authenticate, async (req, res) => {
  log(req);
  const params = req.body;
  
  const requiredParams = ["includeAllUsers", "subject", "body", "buttonLink", "buttonText"];
  for (let i = 0; i < requiredParams.length; i++) {
    const requiredParam = requiredParams[i];
    if (params[requiredParam] === undefined) {
      res.json({ error: 1, result: "Required param '" + requiredParam + "' missing" });
      return;
    }
  }

  try {
    // Get all user emails from database
    let userRecipients = [];
    
    if (params.includeAllUsers) {
      const usersQuery = 'SELECT email, user_name, real_name FROM public."user" WHERE email IS NOT NULL AND email != \'\'';
      const usersResult = await pool.query(usersQuery);
      
      userRecipients = usersResult.rows;
      
      console.log(`📧 Preparing to send broadcast email to ${userRecipients.length} users in batches`);
    } else {
      console.log('📧 Sending test broadcast email (to prayoverus@gmail.com only)');
    }

    // Function to create personalized HTML email template
    const createEmailHtml = (firstName, body, buttonLink, buttonText) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background-color: #f5f5f5;
    }
    .email-container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      padding: 30px 20px;
      text-align: center;
    }
    .logo {
      width: 80px;
      height: 80px;
      margin: 0 auto 15px;
      background-color: white;
      border-radius: 50%;
      padding: 10px;
    }
    .header h1 {
      color: #ffffff;
      margin: 0;
      font-size: 28px;
      font-weight: 600;
    }
    .content {
      padding: 40px 30px;
      line-height: 1.6;
      color: #333333;
      font-size: 16px;
    }
    .button-container {
      text-align: center;
      margin: 30px 0;
      padding: 20px 0;
    }
    .button {
      display: inline-block;
      padding: 14px 40px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #ffffff;
      text-decoration: none;
      border-radius: 25px;
      font-weight: 600;
      font-size: 16px;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
    }
    .footer {
      background-color: #f8f9fa;
      padding: 20px;
      text-align: center;
      color: #666666;
      font-size: 14px;
      border-top: 1px solid #e0e0e0;
    }
    .footer a {
      color: #667eea;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="header">
      <img src="https://prayoverus.com/assets/img/logo/just-the-cross.png" alt="Pray Over Us" class="logo">
      <h1>Pray Over Us</h1>
    </div>
    <div class="content">
      <p>Hi ${firstName},</p>
      ${body}
    </div>
    <div class="button-container">
      <a href="${buttonLink}" class="button">${buttonText}</a>
    </div>
    <div class="footer">
      <p>This email was sent from Pray Over Us</p>
      <p><a href="https://prayoverus.com">Visit Our Website</a></p>
    </div>
  </div>
</body>
</html>
    `;

    // Set up Gmail transporter for broadcast
    const broadcastTransporter = createGmailTransporter();

    let successCount = 0;
    let failCount = 0;
    const delayBetweenEmails = 600; // 600ms between emails
    const logInterval = 10; // Log progress every 10 emails

    // Send emails with rate limiting
    const recipientsToSend = params.includeAllUsers ? userRecipients : [{email: process.env.GMAIL_USER, user_name: "Paul", real_name: "Paul"}];
    
    for (let i = 0; i < recipientsToSend.length; i++) {
      const user = recipientsToSend[i];
      const firstName = user.real_name || user.user_name || "Friend";
      
      // Create personalized email HTML
      const personalizedHtml = createEmailHtml(firstName, params.body, params.buttonLink, params.buttonText);
      
      // Build CC list - avoid duplicating the TO recipient
      const ccEmails = [];
      if (user.email !== process.env.GMAIL_USER) {
        ccEmails.push(process.env.GMAIL_USER);
      }
      if (user.email !== "prayoverus@gmail.com" && process.env.GMAIL_USER !== "prayoverus@gmail.com") {
        ccEmails.push("prayoverus@gmail.com");
      }
      
      try {
        await broadcastTransporter.sendMail({
          from: `"Pray Over Us" <${process.env.GMAIL_USER}>`,
          to: `"${user.user_name}" <${user.email}>`,
          cc: ccEmails.length > 0 ? ccEmails.join(", ") : undefined,
          replyTo: process.env.GMAIL_USER,
          subject: params.subject,
          html: personalizedHtml,
          text: "Email from PrayOverUs.com"
        });
        successCount++;
        
        // Log progress periodically
        if ((i + 1) % logInterval === 0 || i + 1 === recipientsToSend.length) {
          console.log(`📧 Progress: ${i + 1}/${recipientsToSend.length} emails sent (${successCount} successful, ${failCount} failed)`);
        }
        
        // Add delay after each email to respect rate limit (except for the last one)
        if (i + 1 < recipientsToSend.length) {
          await new Promise(resolve => setTimeout(resolve, delayBetweenEmails));
        }
        
      } catch (emailError) {
        console.error(`Failed to send to ${user.email}:`, emailError);
        failCount++;
        
        // Still wait even on error to maintain rate limit
        if (i + 1 < recipientsToSend.length) {
          await new Promise(resolve => setTimeout(resolve, delayBetweenEmails));
        }
      }
    }
    
    const message = params.includeAllUsers 
      ? `Broadcast email sent: ${successCount} successful, ${failCount} failed out of ${recipientsToSend.length} total` 
      : "Test broadcast email sent to prayoverus@gmail.com";
    
    console.log(`📧 Broadcast complete: ${message}`);
    
    res.json({ 
      error: 0, 
      result: message,
      successCount: successCount,
      failCount: failCount,
      totalRecipients: recipientsToSend.length
    });

  } catch (err) {
    console.error('Broadcast email error:', err);
    res.json({ error: 1, result: err.message });
  }
});

router.get('/debug', async (req, res) => {
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

router.post('/sendBroadcastNotification', async (req, res) => {
  try {
    const { adminKey, title, message } = req.body;
    
    // Validate required fields
    if (!adminKey) {
      return res.status(401).json({ error: 1, result: 'adminKey is required' });
    }
    
    if (!message) {
      return res.status(400).json({ error: 1, result: 'message is required' });
    }
    
    // Verify admin key
    const validAdminKey = process.env.ADMIN_BROADCAST_KEY;
    if (!validAdminKey || adminKey !== validAdminKey) {
      return res.status(403).json({ error: 1, result: 'Invalid admin key' });
    }
    
    // Get all users with valid Expo push tokens
    const tokenQuery = `
      SELECT user_id, fcm_token, real_name, user_name 
      FROM public.user 
      WHERE fcm_token IS NOT NULL 
        AND fcm_token != '' 
        AND fcm_token LIKE 'ExponentPushToken%'
    `;
    const tokenResult = await pool.query(tokenQuery);
    
    if (tokenResult.rows.length === 0) {
      return res.json({ 
        error: 0, 
        result: 'No users with valid push tokens found',
        sent: 0,
        failed: 0
      });
    }
    
    console.log(`📢 Broadcasting notification to ${tokenResult.rows.length} users`);
    
    const notificationTitle = title || 'Pray Over Us';
    let successCount = 0;
    let failedCount = 0;
    const tokensToRemove = [];
    
    // Send notifications to all users
    for (const user of tokenResult.rows) {
      const result = await sendPushNotification(
        user.fcm_token,
        notificationTitle,
        message,
        { type: 'broadcast' }
      );
      
      if (result.success) {
        successCount++;
      } else {
        failedCount++;
        if (result.shouldRemoveToken) {
          tokensToRemove.push(user.user_id);
        }
      }
    }
    
    // Clean up invalid tokens
    if (tokensToRemove.length > 0) {
      const cleanupQuery = `
        UPDATE public.user 
        SET fcm_token = NULL 
        WHERE user_id = ANY($1)
      `;
      await pool.query(cleanupQuery, [tokensToRemove]);
      console.log(`🗑️  Removed ${tokensToRemove.length} invalid tokens`);
    }
    
    console.log(`✅ Broadcast complete: ${successCount} sent, ${failedCount} failed`);
    
    res.json({
      error: 0,
      result: 'Broadcast notification sent',
      sent: successCount,
      failed: failedCount,
      tokensRemoved: tokensToRemove.length
    });
    
  } catch (error) {
    console.error('Error sending broadcast notification:', error);
    res.status(500).json({ error: 1, result: error.message });
  }
});

router.post('/createBackup', async (req, res) => {
  try {
    const key = req.body.key || req.headers['x-admin-key'];
    if (key !== process.env.ADMIN_BROADCAST_KEY) {
      return res.status(403).json({ error: 1, result: 'Unauthorized' });
    }
    const backupFile = await runProdBackup();
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.sql'));
    res.json({ error: 0, result: 'Backup created', file: path.basename(backupFile), total_backups: files.length });
  } catch (error) {
    console.error('Manual backup error:', error);
    res.status(500).json({ error: 1, result: error.message });
  }
});

  return router;
};
