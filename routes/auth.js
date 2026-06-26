'use strict';
const express = require('express');

module.exports = function authRoutes(ctx) {
  const router = express.Router();
  const { pool, authenticate, bcrypt, saltRounds, computeRank, awardBadge, loadFaithRanks, sendGmailSingle, getBaseUrl, log } = ctx;

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
        COALESCE(faith_points, 0) as faith_points,
        COALESCE(rosary_count, 0) as rosary_count
      FROM public."user" 
      WHERE LOWER(email) LIKE LOWER($1)
      LIMIT 1
    `;
    
    const result = await pool.query(query, ['%' + params.email + '%']);
    
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
        return res.json({error: 1, result: "We have your email address! Maybe you forgot your password?"});
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
  <style>
    body { font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
    .container { max-width: 600px; margin: 20px auto; background-color: white; padding: 30px; border-radius: 10px; }
    .logo { text-align: center; margin-bottom: 20px; }
    .logo img { max-width: 150px; height: auto; }
    .content { line-height: 1.6; color: #333; }
    .button-container { text-align: center; margin: 30px 0; }
    .button { display: inline-block; padding: 15px 30px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #666; font-size: 12px; }
    .warning { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 10px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <img src="https://prayoverus.com/assets/img/logo/hope1.PNG" alt="Pray Over Us">
    </div>
    <div class="content">
      <p>Hi ${firstName},</p>
      <p>We received a request to reset your password for your Pray Over Us account.</p>
      <p>Click the button below to reset your password:</p>
    </div>
    <div class="button-container">
      <a href="${resetLink}" class="button">Reset Password</a>
    </div>
    <div class="warning">
      <strong>⏰ This link expires in 1 hour</strong>
    </div>
    <div class="content">
      <p>If you didn't request a password reset, you can safely ignore this email. Your password will not be changed.</p>
      <p>For security, this link can only be used once.</p>
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

  return router;
};
