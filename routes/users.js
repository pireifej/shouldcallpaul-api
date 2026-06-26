'use strict';
const express = require('express');

module.exports = function usersRoutes(ctx) {
  const router = express.Router();
  const { pool, authenticate, bcrypt, saltRounds, computeRank, awardBadge, loadFaithRanks, sendGmailSingle, uploadImage, getRandomString, multer, path, log } = ctx;

router.post('/getUserByEmail', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["email"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: 1, result: "Required params '" + requiredParam + "' missing"});
      }
    }
    
    // PostgreSQL query with proper SQL injection protection
    const query = `
      SELECT 
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
        COALESCE(faith_points, 0) as faith_points
      FROM public."user" 
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `;
    
    const result = await pool.query(query, [params.email]);
    const ranks = await loadFaithRanks();
    const rows = result.rows.map(row => {
      row.faith_rank = computeRank(row.faith_points, ranks);
      return row;
    });
    res.json(rows);
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /getAllUsers - Get all users with prayer and request counts
router.post('/getAllUsers', authenticate, async (req, res) => {
  try {
    log(req);
    const params = req.body;
    const userId = params["userId"];
    
    // Validate required parameters
    const requiredParams = ["tz"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: 1, result: "Required params '" + requiredParam + "' missing"});
      }
    }
    
    // Build PostgreSQL query with timezone conversion and subqueries
    let query = `
      SELECT 
        "user".user_id,
        "user".user_name,
        "user".cover,
        "user".email,
        "user".real_name,
        "user".location,
        "user".user_title,
        "user".user_about,
        "user".picture,
        "user".church_id,
        church.church_name,
        ("user".timestamp AT TIME ZONE 'UTC' AT TIME ZONE $1) as timestamp,
        (SELECT COUNT(*) FROM public.user_request WHERE user_request.user_id = "user".user_id) as prayer_count,
        (SELECT COUNT(*) FROM public.request WHERE request.user_id = "user".user_id) as request_count
      FROM public."user"
      LEFT JOIN public.church ON church.church_id = "user".church_id
    `;
    
    let queryParams = [params.tz];
    
    // Add WHERE clause if userId is provided
    if (userId) {
      query += ` WHERE "user".user_id = $2`;
      queryParams.push(userId);
    }
    
    query += `;`;
    
    const result = await pool.query(query, queryParams);
    res.json(result.rows);
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /getRequestCount - Get total count of all requests

router.post('/getUser', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["userId"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: 1, result: "Required params '" + requiredParam + "' missing"});
      }
    }
    
    const userId = params.userId;
    // Check if userId is numeric to determine if it could be a user_id
    const isNumeric = !isNaN(userId) && !isNaN(parseFloat(userId));
    const timezone = params.tz || 'UTC';
    
    let query, queryParams;
    
    if (isNumeric) {
      // If numeric, treat as user_id
      const userIdNum = parseInt(userId);
      query = `
        SELECT 
          "user".user_id,
          "user".user_name,
          "user".email,
          "user".cover,
          "user".real_name,
          "user".last_name,
          "user".location,
          "user".user_title,
          "user".user_about,
          "user".gender,
          "user".picture,
          "user".profile_picture_url,
          "user".church_id,
          "user".faith_points,
          COALESCE("user".rosary_count, 0) as rosary_count,
          church.church_name,
          settings.use_alias,
          settings.request_emails,
          settings.prayer_emails,
          settings.allow_comments,
          settings.general_emails,
          settings.summary_emails,
          ("user".timestamp AT TIME ZONE 'UTC' AT TIME ZONE $2) as timestamp,
          (SELECT COUNT(*) FROM public.user_request WHERE user_request.user_id = "user".user_id) as prayer_count,
          (SELECT COUNT(*) FROM public.request WHERE request.user_id = "user".user_id) as request_count
        FROM public."user"
        LEFT JOIN public.settings ON settings.user_id = $1
        LEFT JOIN public.church ON church.church_id = "user".church_id
        WHERE "user".user_id = $1
      `;
      queryParams = [userIdNum, timezone];
    } else {
      // If not numeric, treat as username
      query = `
        SELECT 
          "user".user_id,
          "user".user_name,
          "user".email,
          "user".cover,
          "user".real_name,
          "user".last_name,
          "user".location,
          "user".user_title,
          "user".user_about,
          "user".gender,
          "user".picture,
          "user".profile_picture_url,
          "user".church_id,
          "user".faith_points,
          COALESCE("user".rosary_count, 0) as rosary_count,
          church.church_name,
          settings.use_alias,
          settings.request_emails,
          settings.prayer_emails,
          settings.allow_comments,
          settings.general_emails,
          settings.summary_emails,
          ("user".timestamp AT TIME ZONE 'UTC' AT TIME ZONE $2) as timestamp,
          (SELECT COUNT(*) FROM public.user_request WHERE user_request.user_id = "user".user_id) as prayer_count,
          (SELECT COUNT(*) FROM public.request WHERE request.user_id = "user".user_id) as request_count
        FROM public."user"
        LEFT JOIN public.settings ON settings.user_id = "user".user_id
        LEFT JOIN public.church ON church.church_id = "user".church_id
        WHERE "user".user_name = $1
      `;
      queryParams = [userId, timezone];
    }
    
    const result = await pool.query(query, queryParams);
    const ranks = await loadFaithRanks();
    const rows = result.rows.map(row => {
      row.faith_rank = computeRank(row.faith_points, ranks);
      return row;
    });
    res.json(rows);
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /getUsersByChurch - Get all users belonging to a specific church
router.post('/getUsersByChurch', authenticate, async (req, res) => {
  try {
    const params = req.body;

    if (!params.churchId) {
      return res.json({ error: "Required param 'churchId' missing" });
    }

    const query = `
      SELECT 
        "user".user_id as id,
        COALESCE("user".real_name, "user".user_name) as first_name,
        "user".last_name,
        COALESCE("user".profile_picture_url, "user".picture) as picture,
        COALESCE("user".faith_points, 0) as faith_points,
        "user".user_title as title,
        "user".user_about as about,
        church.church_name,
        (SELECT COUNT(*) FROM public.request WHERE request.user_id = "user".user_id) as request_count,
        (SELECT COUNT(*) FROM public.user_request WHERE user_request.user_id = "user".user_id) as prayer_count
      FROM public."user"
      LEFT JOIN public.church ON church.church_id = "user".church_id
      WHERE "user".church_id = $1
        AND "user".active = 1
      ORDER BY first_name ASC
    `;

    const result = await pool.query(query, [params.churchId]);
    const ranks = await loadFaithRanks();
    const rows = result.rows.map(row => {
      row.faith_rank = computeRank(row.faith_points, ranks);
      return row;
    });
    res.json(rows);

  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /updateUser - Update user profile (About, Title, Church, Email)
router.post('/updateUser', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    if (!params.userId) {
      return res.json({ error: 1, result: "Required param 'userId' missing" });
    }
    
    // Validate that at least one field is being updated
    if (!params.user_about && !params.user_title && !params.church_id && !params.email && !params.real_name && !params.last_name) {
      return res.json({ error: 1, result: "At least one field (user_about, user_title, church_id, email, real_name, or last_name) must be provided" });
    }
    
    // If email is being updated, check for uniqueness
    if (params.email) {
      const emailCheck = await pool.query(
        'SELECT user_id FROM public."user" WHERE email = $1 AND user_id != $2',
        [params.email, params.userId]
      );
      
      if (emailCheck.rows.length > 0) {
        return res.json({ error: 1, result: "Email address is already in use by another user" });
      }
    }
    
    // Build dynamic UPDATE query based on provided fields
    let updateFields = [];
    let queryParams = [];
    let paramIndex = 1;
    
    if (params.user_about !== undefined) {
      updateFields.push(`user_about = $${paramIndex}`);
      queryParams.push(params.user_about);
      paramIndex++;
    }
    
    if (params.user_title !== undefined) {
      updateFields.push(`user_title = $${paramIndex}`);
      queryParams.push(params.user_title);
      paramIndex++;
    }
    
    if (params.church_id !== undefined) {
      updateFields.push(`church_id = $${paramIndex}`);
      queryParams.push(params.church_id);
      paramIndex++;
    }
    
    if (params.email !== undefined) {
      updateFields.push(`email = $${paramIndex}`);
      queryParams.push(params.email);
      paramIndex++;
      updateFields.push(`email_bounced = false`);
    }
    
    if (params.real_name !== undefined) {
      updateFields.push(`real_name = $${paramIndex}`);
      queryParams.push(params.real_name);
      paramIndex++;
    }
    
    if (params.last_name !== undefined) {
      updateFields.push(`last_name = $${paramIndex}`);
      queryParams.push(params.last_name);
      paramIndex++;
    }
    
    // Add userId as the last parameter for WHERE clause
    queryParams.push(params.userId);
    
    const query = `
      UPDATE public."user" 
      SET ${updateFields.join(', ')}
      WHERE user_id = $${paramIndex}
      RETURNING user_id, user_about, user_title, church_id, email, real_name, last_name
    `;
    
    const result = await pool.query(query, queryParams);
    
    if (result.rows.length === 0) {
      return res.json({ error: 1, result: "User not found" });
    }
    
    res.json({ error: 0, result: "User updated successfully", user: result.rows[0] });
    
  } catch (error) {
    console.error('Database update error:', error);
    res.status(500).json({ error: 1, result: 'Internal server error' });
  }
});

// POST /getChatCompletion - OpenAI chat completion endpoint  

router.post('/registerFCMToken', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    if (!params.userId || !params.fcmToken) {
      return res.json({ error: 1, result: "Required params 'userId' and 'fcmToken' missing" });
    }
    
    // Update the user's Expo push token in the database
    // (fcm_token column name kept for backward compatibility)
    const updateQuery = `
      UPDATE public."user" 
      SET fcm_token = $1, fcm_token_updated = NOW() 
      WHERE user_id = $2
      RETURNING user_id, real_name
    `;
    
    const result = await pool.query(updateQuery, [params.fcmToken, params.userId]);
    
    if (result.rows.length === 0) {
      return res.json({ error: 1, result: "User not found" });
    }
    
    console.log(`✅ Expo push token registered for user ${result.rows[0].real_name} (ID: ${params.userId})`);
    
    res.json({ 
      error: 0, 
      result: "Push token registered successfully",
      userId: params.userId
    });
    
  } catch (error) {
    console.error('Error registering push token:', error);
    res.status(500).json({ error: 1, result: 'Internal server error' });
  }
});

// POST /createUser - Create a new user account with settings and family
router.post('/createUser', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["email", "firstName"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: 1, result: "Required params '" + requiredParam + "' missing"});
      }
    }

    // Check if email already exists
    const emailCheckQuery = 'SELECT user_id FROM public.user WHERE email = $1';
    const emailCheckResult = await pool.query(emailCheckQuery, [params.email]);
    
    if (emailCheckResult.rows.length > 0) {
      return res.json({error: 1, result: "An account with this email address already exists"});
    }

    // Generate random username
    const username = getRandomString(5);
    
    // Handle password - generate if not provided
    let mypassword = params.password;
    let weSetPassword = false;
    
    if (!mypassword) {
      mypassword = getRandomString(7);
      weSetPassword = true;
    }

    // Hash password
    const saltRounds = 5;
    const hashedPassword = await bcrypt.hash(mypassword, saltRounds);

    // Start database transaction
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Get the next available user_id
      const maxIdResult = await client.query('SELECT COALESCE(MAX(user_id), 0) + 1 as next_id FROM public.user');
      const nextUserId = maxIdResult.rows[0].next_id;
      
      // Insert user with explicit user_id
      const userInsertQuery = `
        INSERT INTO public.user (
          user_id, user_name, password, email, real_name, last_name, location, 
          user_title, user_about, picture, gender, phone, type, 
          contacted_timestamp, active, church_id, custom_church_name
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING user_id
      `;
      
      const userValues = [
        nextUserId,
        username,
        hashedPassword,
        params.email,
        params.firstName,
        params.lastName || '',
        ' ',
        ' ',
        ' ',
        params.picture || '',
        params.gender || null,
        params.phone || '',
        'standard',
        null,
        1,
        params.church_id ?? null,
        params.custom_church_name || null
      ];
      
      const userResult = await client.query(userInsertQuery, userValues);
      const userId = userResult.rows[0].user_id;
      
      // Insert user settings
      const settingsInsertQuery = `
        INSERT INTO public.settings (
          user_id, use_alias, request_emails, prayer_emails, 
          allow_comments, general_emails, summary_emails
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `;
      
      const settingsValues = [userId, 1, 1, 1, 1, 1, 1];
      await client.query(settingsInsertQuery, settingsValues);
      
      // Commit transaction
      await client.query('COMMIT');
      
      // Send welcome email
      const passwordMessage = weSetPassword ? `Your temporary password is "${mypassword}"` : "";
      
      const emailTemplate = `
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
    .password-box { background-color: #f0f4ff; border-left: 4px solid #667eea; padding: 14px 16px; margin: 20px 0; border-radius: 0 6px 6px 0; font-size: 15px; color: #333; }
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
      <p>Hi ${params.firstName},</p>
      <p>Welcome to the <strong>Pray Over Us</strong> community! 🙏 We're so glad you're here.</p>
      <p>You can now post your own prayer requests and pray for others in the community. You are not alone.</p>
      ${passwordMessage ? `<div class="password-box"><strong>📋 Important:</strong> ${passwordMessage}</div>` : ''}
      <p>Blessings,<br>The Pray Over Us Team</p>
    </div>
    <div class="button-container">
      <a href="https://www.prayoverus.com" class="button">Open Pray Over Us</a>
    </div>
    <div class="footer">
      <p>This email was sent from Pray Over Us</p>
      <p><a href="https://prayoverus.com">Visit Our Website</a></p>
    </div>
  </div>
</body>
</html>
      `;
      
      const fromPerson = { 
        email: "prayoverus@gmail.com", 
        name: "PrayOverUs" 
      };
      
      const toPerson = { 
        email: params.email, 
        name: params.firstName 
      };
      
      // Send email (don't wait for it to complete)
      sendGmailSingle(emailTemplate, fromPerson, toPerson, "Welcome to 'Pray Over Us'", null, null)
        .then(emailResult => {
          console.log('Welcome email sent:', emailResult);
        })
        .catch(emailError => {
          console.error('Welcome email failed:', emailError);
        });
      
      // Return success response
      res.json({
        error: 0,
        result: "User created successfully",
        user_id: userId,
        username: username,
        message: weSetPassword ? `Temporary password sent to ${params.email}` : "User registered successfully"
      });
      
    } catch (dbError) {
      await client.query('ROLLBACK');
      throw dbError;
    } finally {
      client.release();
    }
    
  } catch (error) {
    console.error('Error in /createUser endpoint:', error);
    res.json({ error: 1, result: error.message || 'Internal server error' });
  }
});

router.get('/getUserBadges', authenticate, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.json({ error: 1, result: "userId is required" });
    const result = await pool.query(
      `SELECT b.badge_key, d.title, d.description, d.icon, b.earned_at
       FROM public.badges b
       LEFT JOIN public.badge_definitions d ON d.badge_key = b.badge_key
       WHERE b.user_id = $1
       ORDER BY b.earned_at DESC`,
      [userId]
    );
    res.json({ error: 0, badges: result.rows });
  } catch (error) {
    console.error('Error in /getUserBadges:', error);
    res.json({ error: 1, result: "Internal server error: " + error.message });
  }
});

// POST /addComment - Add a comment to a prayer request

router.post('/deleteUser', authenticate, async (req, res) => {
  const execPromise = promisify(exec);
  const callerIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

  try {
    const params = req.body;

    // ── Guard 1: required userId ──────────────────────────────────────────────
    if (!params.userId) {
      return res.json({ error: 1, result: "Required param 'userId' missing" });
    }

    // ── Guard 2: explicit confirmation phrase required ────────────────────────
    if (params.confirmPhrase !== 'DELETE MY ACCOUNT') {
      // Still audit the blocked attempt
      await auditPool.query(
        `INSERT INTO public.admin_audit_log (action, performed_by_ip, target_user_id, payload, result)
         VALUES ($1, $2, $3, $4, $5)`,
        ['deleteUser_BLOCKED', callerIp, params.userId,
         JSON.stringify({ reason: 'missing or wrong confirmPhrase', provided: params.confirmPhrase || null }),
         'blocked']
      ).catch((e) => console.error('Audit write failed:', e.message));
      return res.json({ error: 1, result: "Deletion requires confirmPhrase: 'DELETE MY ACCOUNT' in request body." });
    }

    // ── Audit log: intent recorded in DB before anything is touched ───────────
    await auditPool.query(
      `INSERT INTO public.admin_audit_log (action, performed_by_ip, target_user_id, payload, result)
       VALUES ($1, $2, $3, $4, $5)`,
      ['deleteUser_INITIATED', callerIp, params.userId,
       JSON.stringify({ userId: params.userId }),
       'pending']
    );
    console.warn(`🚨 deleteUser called for userId=${params.userId} from IP ${callerIp}`);

    // Step 1: Check if user exists and is active
    const userCheckQuery = `
      SELECT user_id, real_name, email, active 
      FROM public."user" 
      WHERE user_id = $1
    `;

    const userCheckResult = await pool.query(userCheckQuery, [params.userId]);

    if (userCheckResult.rows.length === 0) {
      await auditPool.query(
        `UPDATE public.admin_audit_log SET result = $1 WHERE action = 'deleteUser_INITIATED' AND target_user_id = $2 AND result = 'pending'`,
        ['failed: user not found', params.userId]
      ).catch((e) => console.error('Audit write failed:', e.message));
      return res.json({ error: 1, result: "User not found" });
    }

    const user = userCheckResult.rows[0];

    if (user.active !== 1) {
      await auditPool.query(
        `UPDATE public.admin_audit_log SET result = $1 WHERE action = 'deleteUser_INITIATED' AND target_user_id = $2 AND result = 'pending'`,
        ['failed: already inactive', params.userId]
      ).catch((e) => console.error('Audit write failed:', e.message));
      return res.json({ error: 1, result: "User is already inactive or deleted" });
    }

    // Step 2: Create backup directory if it doesn't exist
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // Step 3: Create database backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5);
    const backupFile = path.join(backupDir, `user_deletion_backup_${params.userId}_${timestamp}.sql`);

    try {
      const pgDumpCommand = `pg_dump "${process.env.NEON_DATABASE_URL}" > "${backupFile}"`;
      await execPromise(pgDumpCommand);
      console.log(`Database backup created: ${backupFile}`);
    } catch (backupError) {
      console.error('Backup error:', backupError);
      await auditPool.query(
        `UPDATE public.admin_audit_log SET result = $1 WHERE action = 'deleteUser_INITIATED' AND target_user_id = $2 AND result = 'pending'`,
        ['failed: pg_dump error — ' + backupError.message, params.userId]
      ).catch((e) => console.error('Audit write failed:', e.message));
      return res.json({ error: 1, result: "Failed to create database backup: " + backupError.message });
    }

    // Step 4: Begin transaction for deletion
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const deleteUserRequestSelf = await client.query(
        'DELETE FROM public.user_request WHERE user_id = $1',
        [params.userId]
      );

      const deleteUserRequestOthers = await client.query(
        `DELETE FROM public.user_request 
         WHERE request_id IN (
           SELECT request_id FROM public.request WHERE user_id = $1
         )`,
        [params.userId]
      );

      const deleteRequests = await client.query(
        'DELETE FROM public.request WHERE user_id = $1',
        [params.userId]
      );

      const deleteSettings = await client.query(
        'DELETE FROM public.settings WHERE user_id = $1',
        [params.userId]
      );

      const deleteUserRow = await client.query(
        'DELETE FROM public."user" WHERE user_id = $1 RETURNING user_id, real_name, email',
        [params.userId]
      );

      await client.query('COMMIT');

      // Audit: record successful completion
      await auditPool.query(
        `UPDATE public.admin_audit_log SET result = $1, payload = $2
         WHERE action = 'deleteUser_INITIATED' AND target_user_id = $3 AND result = 'pending'`,
        [
          'completed',
          JSON.stringify({
            deleted_user: deleteUserRow.rows[0],
            counts: {
              user_prayers: deleteUserRequestSelf.rowCount,
              others_prayers: deleteUserRequestOthers.rowCount,
              requests: deleteRequests.rowCount,
              settings: deleteSettings.rowCount
            }
          }),
          params.userId
        ]
      ).catch(() => {});

      console.warn(`✅ deleteUser completed for userId=${params.userId} (${user.email}) from IP ${callerIp}`);

      res.json({
        error: 0,
        result: "User deleted successfully",
        deleted_user: deleteUserRow.rows[0],
        backup_file: backupFile,
        deleted_counts: {
          user_prayers: deleteUserRequestSelf.rowCount,
          others_prayers: deleteUserRequestOthers.rowCount,
          requests: deleteRequests.rowCount,
          settings: deleteSettings.rowCount
        }
      });

    } catch (deleteError) {
      await client.query('ROLLBACK');
      console.error('Deletion error:', deleteError);
      await auditPool.query(
        `UPDATE public.admin_audit_log SET result = $1 WHERE action = 'deleteUser_INITIATED' AND target_user_id = $2 AND result = 'pending'`,
        ['failed: ' + deleteError.message, params.userId]
      ).catch((e) => console.error('Audit write failed:', e.message));
      res.json({ error: 1, result: "Failed to delete user: " + deleteError.message });
    } finally {
      client.release();
    }

  } catch (error) {
    console.error('Error in /deleteUser endpoint:', error);
    res.json({ error: 1, result: "Internal server error: " + error.message });
  }
});

// Debug endpoint to check database connection (no authentication)
// Broadcast email to all users

// Configure multer for profile picture uploads - use memory storage for security
const profilePictureUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['.jpg', '.jpeg', '.png', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, and WEBP formats are allowed'));
    }
  }
});

// POST /uploadProfilePicture - Upload user profile picture to object storage
router.post('/uploadProfilePicture', authenticate, (req, res) => {
  // Wrap multer to properly catch and handle errors
  profilePictureUpload.single('image')(req, res, async (err) => {
    try {
      // Handle multer errors
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.json({ error: 1, result: 'File size exceeds 5MB limit' });
        }
        
        if (err.message === 'Only JPG, PNG, and WEBP formats are allowed') {
          return res.json({ error: 1, result: 'Only JPG, PNG, and WEBP formats are allowed' });
        }
        
        console.error('Upload error:', err);
        return res.json({ error: 1, result: 'Failed to save image' });
      }
      
      // Validate file was uploaded
      if (!req.file) {
        return res.json({ error: 1, result: 'Image file is required' });
      }
      
      // Validate and sanitize userId AFTER file is in memory but BEFORE writing to disk
      const { userId } = req.body;
      
      if (!userId) {
        return res.json({ error: 1, result: 'userId is required' });
      }
      
      const userIdNum = parseInt(userId);
      if (isNaN(userIdNum) || userIdNum <= 0) {
        return res.json({ error: 1, result: 'Invalid userId' });
      }
      
      // Check if user exists in database BEFORE writing file
      const userCheckQuery = 'SELECT user_id FROM public."user" WHERE user_id = $1';
      const userCheckResult = await pool.query(userCheckQuery, [userIdNum]);
      
      if (userCheckResult.rows.length === 0) {
        return res.json({ error: 1, result: 'User not found' });
      }
      
      // Upload to Cloudinary for persistence across deployments
      let profilePictureUrl;
      try {
        profilePictureUrl = await uploadImage(
          req.file.buffer,
          'prayer-app/profile-pictures'
        );
      } catch (uploadError) {
        console.error('Cloudinary upload failed:', uploadError);
        return res.status(500).json({ error: 1, result: 'Failed to upload image to storage' });
      }
      
      console.log(`✅ Profile picture uploaded to Cloudinary: ${profilePictureUrl}`);
      
      // Update both profile_picture_url (new field) and picture (legacy field) for backward compatibility
      // Use separate parameters to avoid PostgreSQL type confusion between TEXT and VARCHAR
      const updateQuery = `
        UPDATE public."user"
        SET profile_picture_url = $1, picture = $2
        WHERE user_id = $3
        RETURNING user_id, profile_picture_url
      `;
      
      await pool.query(updateQuery, [profilePictureUrl, profilePictureUrl, userIdNum]);
      
      res.json({
        error: 0,
        message: 'Profile picture uploaded successfully',
        profile_picture_url: profilePictureUrl
      });
      
    } catch (error) {
      console.error('Profile picture upload error:', error);
      res.json({ error: 1, result: 'Failed to save image' });
    }
  });
});

// Configure multer for blog image uploads — memory storage so we can push to Cloudinary
const upload = multer({ storage: multer.memoryStorage() });

// Admin endpoint to create a new blog article

  return router;
};
