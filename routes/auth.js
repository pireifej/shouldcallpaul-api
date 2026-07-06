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
        COALESCE(rosary_count, 0) as rosary_count,
        (SELECT COUNT(*) FROM public.user_request WHERE user_id = "user".user_id) as prayer_count,
        (SELECT COUNT(*) FROM public.request WHERE user_id = "user".user_id) as request_count
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

// GET /reset - Try to open the app via deep link; fall back to a web reset form
router.get('/reset', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send('Missing token.');
  const appLink = `prayoverus://reset-password?token=${token}`;
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reset Password – Pray Over Us</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background: #f5f5f5; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: #fff; border-radius: 16px; padding: 40px 32px; max-width: 420px; width: 100%; box-shadow: 0 4px 24px rgba(0,0,0,0.08); text-align: center; }
    .logo { font-size: 48px; margin-bottom: 12px; }
    h1 { font-size: 22px; font-weight: 700; color: #1a1a1a; margin-bottom: 6px; }
    .subtitle { font-size: 15px; color: #666; margin-bottom: 20px; line-height: 1.5; }
    .spinner { width: 36px; height: 36px; border: 3px solid #e0e0e0; border-top-color: #667eea; border-radius: 50%; animation: spin .8s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .app-btn { display: inline-block; padding: 11px 28px; background: linear-gradient(135deg, #667eea, #764ba2); color: #fff; text-decoration: none; border-radius: 25px; font-weight: 600; font-size: 14px; margin-bottom: 20px; }
    .divider { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; color: #aaa; font-size: 13px; }
    .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: #e0e0e0; }
    label { display: block; text-align: left; font-size: 13px; font-weight: 600; color: #444; margin-bottom: 6px; }
    input[type=password] { width: 100%; padding: 12px 14px; border: 1.5px solid #ddd; border-radius: 10px; font-size: 15px; outline: none; transition: border-color .2s; margin-bottom: 14px; }
    input[type=password]:focus { border-color: #667eea; }
    button[type=submit] { width: 100%; padding: 13px; background: linear-gradient(135deg, #667eea, #764ba2); color: #fff; border: none; border-radius: 25px; font-size: 16px; font-weight: 600; cursor: pointer; }
    button[type=submit]:disabled { opacity: .6; cursor: default; }
    .msg { margin-top: 16px; font-size: 14px; padding: 10px 14px; border-radius: 8px; display: none; }
    .msg.success { background: #e6f9f0; color: #1a7f4b; display: block; }
    .msg.error   { background: #fdecea; color: #b00020; display: block; }
    #fallback { display: none; }
  </style>
</head>
<body>
<div class="card">
  <div class="logo">🙏</div>
  <div id="launching">
    <h1>Opening Pray Over Us…</h1>
    <p class="subtitle">Taking you to the app to reset your password.</p>
    <div class="spinner"></div>
  </div>
  <div id="fallback">
    <h1>Reset Your Password</h1>
    <p class="subtitle">The app didn't open — reset your password here instead.</p>
    <a class="app-btn" href="${appLink}">Try opening the app again</a>
    <div class="divider">or reset here in your browser</div>
    <form id="resetForm">
      <label for="pw">New password</label>
      <input type="password" id="pw" placeholder="At least 6 characters" required minlength="6">
      <label for="pw2">Confirm password</label>
      <input type="password" id="pw2" placeholder="Repeat new password" required minlength="6">
      <button type="submit" id="submitBtn">Set New Password</button>
      <div class="msg" id="msg"></div>
    </form>
  </div>
</div>
<script>
  // Auto-fire the deep link immediately — if the app is installed it will open
  window.location.href = '${appLink}';

  // If still on this page after 2.5s the app didn't open — show the web form
  setTimeout(function() {
    document.getElementById('launching').style.display = 'none';
    document.getElementById('fallback').style.display = 'block';
  }, 2500);

  document.getElementById('resetForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const pw  = document.getElementById('pw').value;
    const pw2 = document.getElementById('pw2').value;
    const msg = document.getElementById('msg');
    const btn = document.getElementById('submitBtn');
    msg.className = 'msg';
    msg.style.display = 'none';
    if (pw !== pw2) {
      msg.textContent = 'Passwords do not match.';
      msg.className = 'msg error';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await fetch('/resetPassword', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: '${token}', newPassword: pw })
      });
      const data = await res.json();
      if (data.error === 0) {
        document.querySelector('.card').innerHTML = \`
          <div style="font-size:64px;margin-bottom:16px;">✅</div>
          <h1 style="font-size:22px;font-weight:700;color:#1a1a1a;margin-bottom:10px;">Password Updated!</h1>
          <p style="font-size:15px;color:#555;line-height:1.6;">Your password has been changed successfully.<br>You can now log in to the Pray Over Us app with your new password.</p>
        \`;
      } else {
        msg.textContent = data.result || 'Something went wrong. Please request a new reset link.';
        msg.className = 'msg error';
        btn.disabled = false;
        btn.textContent = 'Set New Password';
      }
    } catch(err) {
      msg.textContent = 'Network error. Please try again.';
      msg.className = 'msg error';
      btn.disabled = false;
      btn.textContent = 'Set New Password';
    }
  });
</script>
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

router.post('/googleLogin', authenticate, async (req, res) => {
  try {
    const { email, google_id, first_name, last_name, picture } = req.body;

    if (!email) return res.json({ error: 1, result: "Required param 'email' missing" });
    if (!google_id) return res.json({ error: 1, result: "Required param 'google_id' missing" });

    const normalizedEmail = email.toLowerCase().trim();

    // Shared query to fetch full user object matching /login format
    const fetchUserQuery = `
      SELECT
        u.user_id, u.user_name, u.email, u.real_name, u.last_name,
        u.user_title, u.user_about, u.location, u.picture, u.profile_picture_url,
        u.church_id, u.active, u.auth_provider, u.google_id,
        u.timestamp,
        COALESCE(u.faith_points, 0) as faith_points,
        COALESCE(u.rosary_count, 0) as rosary_count,
        c.church_name,
        (SELECT COUNT(*) FROM public.user_request WHERE user_id = u.user_id) as prayer_count,
        (SELECT COUNT(*) FROM public.request WHERE user_id = u.user_id) as request_count
      FROM public."user" u
      LEFT JOIN public.church c ON c.church_id = u.church_id
      WHERE LOWER(u.email) = $1
      LIMIT 1
    `;

    // ── Step 1: Look up by email ─────────────────────────────────────────────
    const existing = await pool.query(fetchUserQuery, [normalizedEmail]);

    if (existing.rows.length > 0) {
      const user = existing.rows[0];

      if (!user.active) {
        return res.json({ error: 1, result: "This account has been deactivated." });
      }

      // Store google_id if not already set
      if (!user.google_id) {
        await pool.query(
          `UPDATE public."user" SET google_id = $1, auth_provider = 'google' WHERE user_id = $2`,
          [String(google_id), user.user_id]
        ).catch(e => console.warn('googleLogin: could not store google_id:', e.message));
        user.google_id = String(google_id);
        user.auth_provider = 'google';
      }

      const ranks = await loadFaithRanks();
      user.faith_rank = computeRank(user.faith_points, ranks);
      return res.json({ error: 0, result: [user], isNewUser: false });
    }

    // ── Step 2: No match — create new user ──────────────────────────────────
    const username = Math.random().toString(36).slice(2, 7);
    const placeholderPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), saltRounds);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { rows: [{ next_id }] } = await client.query(
        `SELECT COALESCE(MAX(user_id), 0) + 1 as next_id FROM public."user"`
      );

      await client.query(`
        INSERT INTO public."user" (
          user_id, user_name, password, email, real_name, last_name,
          location, user_title, user_about, picture, type, active,
          auth_provider, google_id
        ) VALUES ($1,$2,$3,$4,$5,$6,' ',' ',' ',$7,'standard',1,'google',$8)
      `, [
        next_id, username, placeholderPassword, normalizedEmail,
        first_name || '', last_name || '',
        picture || '', String(google_id)
      ]);

      await client.query(`
        INSERT INTO public.settings
          (user_id, use_alias, request_emails, prayer_emails, allow_comments, general_emails, summary_emails)
        VALUES ($1, 1, 1, 1, 1, 1, 1)
      `, [next_id]);

      await client.query('COMMIT');

      // Fire-and-forget: badge + welcome email
      awardBadge(next_id, 'cornerstone').catch(() => {});
      const welcomeHtml = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;padding:20px;">
        <h2>Welcome to Pray Over Us 🙏</h2>
        <p>Hi ${first_name || 'friend'}, your account has been created with Google Sign-In.</p>
        <p>Blessings,<br>The Pray Over Us Team</p>
      </body></html>`;
      sendGmailSingle(
        welcomeHtml,
        { email: 'prayoverus@gmail.com', name: 'PrayOverUs' },
        { email: normalizedEmail, name: first_name || 'Friend' },
        "Welcome to 'Pray Over Us'", null, null
      ).catch(() => {});

      // Fetch the newly created user with all computed fields
      const newUserResult = await pool.query(fetchUserQuery, [normalizedEmail]);
      const newUser = newUserResult.rows[0];
      const ranks = await loadFaithRanks();
      newUser.faith_rank = computeRank(newUser.faith_points, ranks);

      return res.json({ error: 0, result: [newUser], isNewUser: true });

    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('googleLogin error:', error);
    res.json({ error: 1, result: "An error occurred. Please try again." });
  }
});

// POST /appleLogin — Sign in with Apple
// Apple only sends email + name on the FIRST login; subsequent logins only send apple_user_id + identity_token
router.post('/appleLogin', authenticate, async (req, res) => {
  try {
    const { identity_token, apple_user_id, email, first_name, last_name } = req.body;

    if (!identity_token) return res.json({ error: 1, result: "Required param 'identity_token' missing" });
    if (!apple_user_id) return res.json({ error: 1, result: "Required param 'apple_user_id' missing" });

    const normalizedEmail = email ? email.toLowerCase().trim() : null;

    // Shared query — mirrors /googleLogin response shape
    const fetchUserQuery = `
      SELECT
        u.user_id, u.user_name, u.email, u.real_name, u.last_name,
        u.user_title, u.user_about, u.location, u.picture, u.profile_picture_url,
        u.church_id, u.active, u.auth_provider, u.apple_id,
        u.timestamp,
        COALESCE(u.faith_points, 0) as faith_points,
        COALESCE(u.rosary_count, 0) as rosary_count,
        c.church_name,
        (SELECT COUNT(*) FROM public.user_request WHERE user_id = u.user_id) as prayer_count,
        (SELECT COUNT(*) FROM public.request WHERE user_id = u.user_id) as request_count
      FROM public."user" u
      LEFT JOIN public.church c ON c.church_id = u.church_id
      WHERE u.apple_id = $1
      LIMIT 1
    `;

    // ── Step 1: Look up by apple_user_id ─────────────────────────────────────
    const byAppleId = await pool.query(fetchUserQuery, [apple_user_id]);

    if (byAppleId.rows.length > 0) {
      const user = byAppleId.rows[0];
      if (!user.active) return res.json({ error: 1, result: "This account has been deactivated." });
      const ranks = await loadFaithRanks();
      user.faith_rank = computeRank(user.faith_points, ranks);
      return res.json({ error: 0, result: [user], isNewUser: false });
    }

    // ── Step 2: Fall back to email lookup (handles first-login case) ─────────
    if (normalizedEmail) {
      const byEmail = await pool.query(`
        SELECT
          u.user_id, u.user_name, u.email, u.real_name, u.last_name,
          u.user_title, u.user_about, u.location, u.picture, u.profile_picture_url,
          u.church_id, u.active, u.auth_provider, u.apple_id,
          u.timestamp,
          COALESCE(u.faith_points, 0) as faith_points,
          COALESCE(u.rosary_count, 0) as rosary_count,
          c.church_name,
          (SELECT COUNT(*) FROM public.user_request WHERE user_id = u.user_id) as prayer_count,
          (SELECT COUNT(*) FROM public.request WHERE user_id = u.user_id) as request_count
        FROM public."user" u
        LEFT JOIN public.church c ON c.church_id = u.church_id
        WHERE LOWER(u.email) = $1
        LIMIT 1
      `, [normalizedEmail]);

      if (byEmail.rows.length > 0) {
        const user = byEmail.rows[0];
        if (!user.active) return res.json({ error: 1, result: "This account has been deactivated." });

        // Store apple_id on the matched account
        await pool.query(
          `UPDATE public."user" SET apple_id = $1, auth_provider = 'apple' WHERE user_id = $2`,
          [apple_user_id, user.user_id]
        ).catch(e => console.warn('appleLogin: could not store apple_id:', e.message));
        user.apple_id = apple_user_id;
        user.auth_provider = 'apple';

        const ranks = await loadFaithRanks();
        user.faith_rank = computeRank(user.faith_points, ranks);
        return res.json({ error: 0, result: [user], isNewUser: false });
      }
    }

    // ── Step 3: No match — create new user ───────────────────────────────────
    // Apple doesn't always send email; without it we can't create an account
    if (!normalizedEmail) {
      return res.json({
        error: 1,
        result: "No account found for this Apple ID. Please sign in with email/password or try again — Apple should provide your email on a fresh sign-in."
      });
    }

    const username = Math.random().toString(36).slice(2, 7);
    const placeholderPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), saltRounds);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { rows: [{ next_id }] } = await client.query(
        `SELECT COALESCE(MAX(user_id), 0) + 1 as next_id FROM public."user"`
      );

      await client.query(`
        INSERT INTO public."user" (
          user_id, user_name, password, email, real_name, last_name,
          location, user_title, user_about, picture, type, active,
          auth_provider, apple_id
        ) VALUES ($1,$2,$3,$4,$5,$6,' ',' ',' ',' ','standard',1,'apple',$7)
      `, [
        next_id, username, placeholderPassword, normalizedEmail,
        first_name || '', last_name || '',
        apple_user_id
      ]);

      await client.query(`
        INSERT INTO public.settings
          (user_id, use_alias, request_emails, prayer_emails, allow_comments, general_emails, summary_emails)
        VALUES ($1, 1, 1, 1, 1, 1, 1)
      `, [next_id]);

      await client.query('COMMIT');

      // Fire-and-forget: badge + welcome email
      awardBadge(next_id, 'cornerstone').catch(() => {});
      const welcomeHtml = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;padding:20px;">
        <h2>Welcome to Pray Over Us 🙏</h2>
        <p>Hi ${first_name || 'friend'}, your account has been created with Apple Sign-In.</p>
        <p>Blessings,<br>The Pray Over Us Team</p>
      </body></html>`;
      sendGmailSingle(
        welcomeHtml,
        { email: 'prayoverus@gmail.com', name: 'PrayOverUs' },
        { email: normalizedEmail, name: first_name || 'Friend' },
        "Welcome to 'Pray Over Us'", null, null
      ).catch(() => {});

      // Fetch the newly created user with all computed fields
      const newUserResult = await pool.query(fetchUserQuery, [apple_user_id]);
      const newUser = newUserResult.rows[0];
      const ranks = await loadFaithRanks();
      newUser.faith_rank = computeRank(newUser.faith_points, ranks);

      return res.json({ error: 0, result: [newUser], isNewUser: true });

    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('appleLogin error:', error);
    res.json({ error: 1, result: "An error occurred. Please try again." });
  }
});

  // GET /auth/google/callback - Relay Google OAuth callback to app's custom scheme
  router.get('/auth/google/callback', (req, res) => {
    const params = new URLSearchParams(req.query).toString();
    res.redirect(`prayoverus://auth?${params}`);
  });

  // POST /auth/google/token - Exchange Google OAuth code for tokens + user info
  router.post('/auth/google/token', async (req, res) => {
    try {
      const { code, codeVerifier, redirectUri } = req.body;
      if (!code || !redirectUri) {
        return res.status(400).json({ error: 'code and redirectUri are required' });
      }
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientSecret) {
        return res.status(500).json({ error: 'Server not configured for Google OAuth' });
      }
      const params = new URLSearchParams({
        code,
        client_id: '798628803696-b9b82e0mer9c3cm7rpngmpr9eet2hilj.apps.googleusercontent.com',
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      if (codeVerifier) params.set('code_verifier', codeVerifier);
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) {
        return res.status(400).json({ error: tokenData.error, error_description: tokenData.error_description });
      }
      const userInfoRes = await fetch('https://www.googleapis.com/userinfo/v2/me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userInfo = await userInfoRes.json();
      res.json({ access_token: tokenData.access_token, ...userInfo });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
