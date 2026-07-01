'use strict';
const express = require('express');
const crypto = require('crypto');

module.exports = function authRoutes(ctx) {
  const router = express.Router();
  const { pool, authenticate, bcrypt, saltRounds, computeRank, awardBadge, loadFaithRanks, sendGmailSingle, createGmailTransporter, getBaseUrl, log } = ctx;

router.post('/login', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["password", "email"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: 1, result: "Required params '" + requiredParam + "' missing"});
      }
    }
    
    // PostgreSQL query with proper SQL injection protection
    const query = `
      SELECT 
        password,
        user_name,
        email,
        real_name,
        user_title,
        user_about,
        location,
        active,
        timestamp,
        user_id,
        picture,
        church_id,
        auth_provider,
        COALESCE(faith_points, 0) as faith_points,
        COALESCE(rosary_count, 0) as rosary_count
      FROM public."user" 
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `;
    
    const result = await pool.query(query, [params.email.trim()]);
    
    // Did not find email address in user list
    if (result.rows.length === 0) {
      return res.json({error: 1, result: "Email address not found."});
    }
    
    const user = result.rows[0];
    
    // Check if account is active
    if (!user.active) {
      return res.json({error: 1, result: "Account has been deactivated."});
    }
    
    const hash = user.password;
    delete user.password; // Remove password from response
    
    // Compare password with bcrypt
    bcrypt.compare(params.password, hash, async function(err, passwordMatch) {
      if (err) {
        return res.json({error: 1, result: "Authentication error occurred."});
      }
      
      if (!passwordMatch) {
        const providerHint = user.auth_provider && user.auth_provider !== 'email'
          ? ` This account was created with ${user.auth_provider === 'google' ? 'Google' : user.auth_provider === 'facebook' ? 'Facebook' : user.auth_provider}. Try signing in that way.`
          : ' Maybe you forgot your password?';
        return res.json({error: 1, result: `We have your email address!${providerHint}`});
      }
      
      // Successful login - return user data with faith rank
      const ranks = await loadFaithRanks();
      user.faith_rank = computeRank(user.faith_points, ranks);
      res.json({error: 0, result: [user]});
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.json({error: 1, result: error.message});
  }
});

router.post('/requestPasswordReset', async (req, res) => {
  try {
    const params = req.body;
    
    if (!params.email) {
      return res.json({error: 1, result: "Email is required"});
    }
    
    const email = params.email.toLowerCase().trim();
    
    const userQuery = await pool.query(
      'SELECT user_id, user_name, real_name FROM public."user" WHERE LOWER(email) = $1 AND active = 1',
      [email]
    );
    
    if (userQuery.rows.length === 0) {
      return res.json({error: 0, result: "If that email exists, you'll receive a password reset link shortly."});
    }
    
    const user = userQuery.rows[0];
    
    const recentTokenQuery = await pool.query(
      'SELECT created_at FROM password_reset_tokens WHERE user_id = $1 AND created_at > NOW() - INTERVAL \'5 minutes\' ORDER BY created_at DESC LIMIT 1',
      [user.user_id]
    );
    
    if (recentTokenQuery.rows.length > 0) {
      return res.json({error: 0, result: "If that email exists, you'll receive a password reset link shortly."});
    }
    
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    
    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.user_id, token, expiresAt]
    );
    
    const resetLink = `https://shouldcallpaul.replit.app/reset?token=${token}`;
    const firstName = user.real_name || user.user_name || "Friend";
    
    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f5f5f5; }
    .email-container { max-width: 600px; margin: 0 auto; background-color: #ffffff; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px 20px; text-align: center; }
    .logo { width: 80px; height: 80px; margin: 0 auto 15px; background-color: white; border-radius: 50%; padding: 10px; }
    .header h1 { color: #ffffff; margin: 0; font-size: 28px; font-weight: 600; }
    .content { padding: 40px 30px; line-height: 1.6; color: #333333; font-size: 16px; }
    .button-container { text-align: center; margin: 30px 0; padding: 20px 0; }
    .button { display: inline-block; padding: 14px 40px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; border-radius: 25px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); }
    .warning { background-color: #fff8e1; border-left: 4px solid #f59e0b; padding: 14px 16px; margin: 20px 0; border-radius: 0 6px 6px 0; font-size: 15px; color: #555; }
    .footer { background-color: #f8f9fa; padding: 20px; text-align: center; color: #666666; font-size: 14px; border-top: 1px solid #e0e0e0; }
    .footer a { color: #667eea; text-decoration: none; }
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
      <p>We received a request to reset your password for your Pray Over Us account.</p>
      <p>Click the button below to set a new password. This link expires in <strong>1 hour</strong> and can only be used once.</p>
    </div>
    <div class="button-container">
      <a href="${resetLink}" class="button">Reset My Password</a>
    </div>
    <div class="content">
      <div class="warning">
        🔒 If you didn't request this, you can safely ignore this email — your password will not change.
      </div>
    </div>
    <div class="footer">
      <p>This email was sent from Pray Over Us</p>
      <p><a href="https://prayoverus.com">Visit Our Website</a></p>
    </div>
  </div>
</body>
</html>
    `;
    
    const transporter = createGmailTransporter();
    await transporter.sendMail({
      from: `"Pray Over Us" <${process.env.GMAIL_USER}>`,
      to: `"${firstName}" <${email}>`,
      bcc: email !== "programmerpauly@gmail.com" ? "programmerpauly@gmail.com" : undefined,
      replyTo: process.env.GMAIL_USER,
      subject: "Reset Your Password - Pray Over Us",
      html: emailHtml,
      text: "Password reset requested for your Pray Over Us account"
    });
    
    console.log(`📧 Password reset email sent to ${email}`);
    
    res.json({error: 0, result: "If that email exists, you'll receive a password reset link shortly."});
    
  } catch (error) {
    console.error('Password reset request error:', error);
    res.json({error: 1, result: "An error occurred. Please try again later."});
  }
});

// GET /reset - Redirect page that bounces email link into the app's custom scheme
router.get('/reset', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send('Missing token.');
  const appLink = `prayoverus://reset-password?token=${token}`;
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Redirecting…</title>
  <meta http-equiv="refresh" content="0;url=${appLink}">
</head>
<body style="font-family:Arial,sans-serif;text-align:center;padding:60px 20px;">
  <p>Opening Pray Over Us…</p>
  <p><a href="${appLink}">Tap here if the app doesn't open automatically.</a></p>
  <script>window.location.href = "${appLink}";</script>
</body>
</html>`);
});

router.post('/resetPassword', async (req, res) => {
  try {
    const params = req.body;
    
    if (!params.token || !params.newPassword) {
      return res.json({error: 1, result: "Token and new password are required"});
    }
    
    if (params.newPassword.length < 6) {
      return res.json({error: 1, result: "Password must be at least 6 characters"});
    }
    
    const tokenQuery = await pool.query(
      'SELECT user_id, expires_at, used FROM password_reset_tokens WHERE token = $1',
      [params.token]
    );
    
    if (tokenQuery.rows.length === 0) {
      return res.json({error: 1, result: "Invalid or expired reset link"});
    }
    
    const tokenData = tokenQuery.rows[0];
    
    if (tokenData.used) {
      return res.json({error: 1, result: "This reset link has already been used"});
    }
    
    if (new Date() > new Date(tokenData.expires_at)) {
      return res.json({error: 1, result: "This reset link has expired"});
    }
    
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(params.newPassword, saltRounds);
    
    await pool.query(
      'UPDATE public."user" SET password = $1 WHERE user_id = $2',
      [hashedPassword, tokenData.user_id]
    );
    
    await pool.query(
      'UPDATE password_reset_tokens SET used = true WHERE token = $1',
      [params.token]
    );
    
    console.log(`✅ Password reset successful for user ${tokenData.user_id}`);
    
    res.json({error: 0, result: "Password reset successful! You can now log in with your new password."});
    
  } catch (error) {
    console.error('Password reset error:', error);
    res.json({error: 1, result: "An error occurred. Please try again later."});
  }
});

router.post('/changePassword', authenticate, async (req, res) => {
  try {
    log(req);
    const { userId, currentPassword, newPassword } = req.body || {};

    if (!userId || !currentPassword || !newPassword) {
      return res.json({ error: 1, result: 'userId, currentPassword, and newPassword are required' });
    }

    if (newPassword.length < 6) {
      return res.json({ error: 1, result: 'New password must be at least 6 characters' });
    }

    if (currentPassword === newPassword) {
      return res.json({ error: 1, result: 'New password must be different from your current password' });
    }

    const userResult = await pool.query(
      'SELECT user_id, password FROM public."user" WHERE user_id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.json({ error: 1, result: 'User not found' });
    }

    const passwordMatch = await bcrypt.compare(currentPassword, userResult.rows[0].password);
    if (!passwordMatch) {
      return res.json({ error: 1, result: 'Current password is incorrect' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE public."user" SET password = $1 WHERE user_id = $2',
      [hashedPassword, userId]
    );

    console.log(`✅ Password changed for user ${userId}`);
    res.json({ error: 0, result: 'Password changed successfully' });

  } catch (error) {
    console.error('changePassword error:', error);
    res.json({ error: 1, result: 'An error occurred. Please try again.' });
  }
});

router.post('/socialLogin', authenticate, async (req, res) => {
  try {
    const { provider, email, firstName, lastName, picture, providerId } = req.body;

    if (!provider || !email) {
      return res.json({ error: 1, result: "Required params 'provider' and 'email' missing" });
    }

    const validProviders = ['google', 'facebook', 'apple'];
    if (!validProviders.includes(provider.toLowerCase())) {
      return res.json({ error: 1, result: `Unsupported provider '${provider}'` });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const providerKey = provider.toLowerCase();
    const providerIdCol = providerKey === 'google' ? 'google_id' : providerKey === 'facebook' ? 'facebook_id' : null;

    // ── Step 1: Look up existing user by email ──────────────────────────────
    const existingResult = await pool.query(`
      SELECT 
        user_id, user_name, email, real_name, last_name, user_title, user_about,
        location, active, timestamp, picture, church_id, auth_provider,
        google_id, facebook_id,
        COALESCE(faith_points, 0) as faith_points,
        COALESCE(rosary_count, 0) as rosary_count
      FROM public."user"
      WHERE LOWER(email) = $1
      LIMIT 1
    `, [normalizedEmail]);

    if (existingResult.rows.length > 0) {
      const user = existingResult.rows[0];

      if (!user.active) {
        return res.json({ error: 1, result: "This account has been deactivated." });
      }

      // Optionally store provider ID for future fast lookups
      if (providerId && providerIdCol && !user[providerIdCol]) {
        await pool.query(
          `UPDATE public."user" SET ${providerIdCol} = $1 WHERE user_id = $2`,
          [String(providerId), user.user_id]
        ).catch(e => console.warn(`Could not store ${providerIdCol}:`, e.message));
      }

      const ranks = await loadFaithRanks();
      user.faith_rank = computeRank(user.faith_points, ranks);
      delete user.password;
      return res.json({ error: 0, result: [user], isNewUser: false });
    }

    // ── Step 2: No existing user — create one ───────────────────────────────
    const username = Math.random().toString(36).slice(2, 7);
    const placeholderPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), saltRounds);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const maxIdResult = await client.query('SELECT COALESCE(MAX(user_id), 0) + 1 as next_id FROM public."user"');
      const nextUserId = maxIdResult.rows[0].next_id;

      const insertResult = await client.query(`
        INSERT INTO public."user" (
          user_id, user_name, password, email, real_name, last_name, location,
          user_title, user_about, picture, type, active, auth_provider
          ${providerIdCol ? ', ' + providerIdCol : ''}
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13${providerIdCol ? ',$14' : ''})
        RETURNING user_id
      `, [
        nextUserId, username, placeholderPassword, normalizedEmail,
        firstName || '', lastName || '', ' ', ' ', ' ',
        picture || '', 'standard', 1, providerKey,
        ...(providerIdCol && providerId ? [String(providerId)] : [])
      ]);

      const userId = insertResult.rows[0].user_id;

      await client.query(`
        INSERT INTO public.settings (user_id, use_alias, request_emails, prayer_emails, allow_comments, general_emails, summary_emails)
        VALUES ($1, 1, 1, 1, 1, 1, 1)
      `, [userId]);

      await client.query('COMMIT');

      // Award Cornerstone badge (new member)
      awardBadge(userId, 'cornerstone').catch(() => {});

      // Send welcome email (fire-and-forget)
      const welcomeHtml = `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
  <h2 style="color:#667eea;">Welcome to Pray Over Us 🙏</h2>
  <p>Hi ${firstName || 'friend'},</p>
  <p>Your account has been created using ${providerKey.charAt(0).toUpperCase() + providerKey.slice(1)}. You can now post prayer requests and pray for others in the community.</p>
  <p>Blessings,<br>The Pray Over Us Team</p>
</body></html>`;
      sendGmailSingle(welcomeHtml, { email: 'prayoverus@gmail.com', name: 'PrayOverUs' }, { email: normalizedEmail, name: firstName || 'Friend' }, "Welcome to 'Pray Over Us'", null, null).catch(() => {});

      const ranks = await loadFaithRanks();
      const newUser = {
        user_id: userId, user_name: username, email: normalizedEmail,
        real_name: firstName || '', last_name: lastName || '',
        picture: picture || '', church_id: null, auth_provider: providerKey,
        faith_points: 0, rosary_count: 0, active: 1,
      };
      newUser.faith_rank = computeRank(0, ranks);

      return res.json({ error: 0, result: [newUser], isNewUser: true });

    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('socialLogin error:', error);
    res.json({ error: 1, result: "An error occurred. Please try again." });
  }
});

  return router;
};
