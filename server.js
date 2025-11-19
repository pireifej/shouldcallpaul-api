const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const { MailerSend, EmailParams, Sender, Recipient } = require("mailersend");
const multer = require('multer');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Enable CORS for mobile and web apps
app.use(express.json({ limit: '50mb' })); // Parse JSON request bodies
app.use(express.text({ limit: '50mb' })); // Parse text request bodies

// Serve static files for profile images and blog images
app.use('/profile_images', express.static('profile_images'));
app.use('/profile-pictures', express.static('public/profile-pictures'));
app.use('/prayer-images', express.static('public/prayer-images'));
app.use('/img', express.static('blog_articles/img'));
app.use('/resume_data', express.static('resume_data'));

// Comprehensive request/response logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  
  // Log incoming request
  console.log(`\n🔵 INCOMING REQUEST ${timestamp}`);
  console.log(`   Method: ${req.method}`);
  console.log(`   Path: ${req.path}`);
  console.log(`   IP: ${req.ip || req.connection.remoteAddress || 'unknown'}`);
  console.log(`   User-Agent: ${req.get('User-Agent') || 'none'}`);
  console.log(`   Content-Type: ${req.get('Content-Type') || 'none'}`);
  
  // Log request body for POST/PUT requests
  if (req.method === 'POST' || req.method === 'PUT') {
    console.log(`   Payload:`, req.body);
  }
  
  // Intercept response
  const originalSend = res.send;
  res.send = function(data) {
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    // Determine if response is error or success
    let responseStatus = 'SUCCESS';
    let errorInfo = null;
    
    if (res.statusCode >= 400) {
      responseStatus = 'ERROR';
    }
    
    // Try to parse response data to check for error property
    try {
      const parsedData = JSON.parse(data);
      if (parsedData && parsedData.error) {
        responseStatus = 'ERROR';
        errorInfo = parsedData.error;
      }
    } catch (e) {
      // Response is not JSON, keep current status
    }
    
    // Log response status
    console.log(`🔴 RESPONSE ${timestamp}`);
    console.log(`   Status: ${res.statusCode} (${responseStatus})`);
    console.log(`   Duration: ${duration}ms`);
    if (errorInfo) {
      console.log(`   Error: ${errorInfo}`);
    }
    console.log(`───────────────────────────────────────`);
    
    // Call original send
    originalSend.call(this, data);
  };
  
  next();
});

// Utility function to generate random string
function getRandomString(length) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// PostgreSQL connection pool - use production database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize OpenAI client
// the newest OpenAI model is "gpt-5" which was released August 7, 2025. do not change this unless explicitly requested by the user
const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY 
});

// Initialize Firebase Admin SDK
let firebaseInitialized = false;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  firebaseInitialized = true;
  console.log('✅ Firebase Admin SDK initialized successfully');
} catch (error) {
  console.error('❌ Firebase initialization failed:', error.message);
  console.log('⚠️  Push notifications will not work without Firebase credentials');
}

// Email sending function using MailerSend
async function mailerSendSingle(template, fromPerson, toPerson, subject, extraResult, res) {
    const mailerSend = new MailerSend({
        apiKey: process.env.MAILERSEND_API_KEY
    });

    const sentFrom = new Sender(fromPerson.email, fromPerson.name);

    const recipients = [
        new Recipient(toPerson.email, toPerson.name)
    ];

    const bcc = (toPerson.email == "programmerpauly@gmail.com") ? [] : [new Recipient("programmerpauly@gmail.com", "Programmer Pauly")];

    const emailParams = new EmailParams()
        .setFrom(sentFrom)
        .setTo(recipients)
        .setBcc(bcc)
        .setReplyTo(sentFrom)
        .setSubject(subject)
        .setHtml(template)
        .setText("Email from PrayOverUs.com");

    const extraResultMessage = (extraResult) ? "|" + extraResult : "";

    try {
        await mailerSend.email.send(emailParams);
        if (res) {
            res.json({error: 0, result:"email sent from " + fromPerson.email + " to " + toPerson.email + extraResultMessage});
        }
        return {error: 0, result:"email sent from " + fromPerson.email + " to " + toPerson.email + extraResultMessage};
    } catch(error) {
        console.error('Email sending error:', error);
        if (res) {
            res.json({error: 1, result: error.message});
        }
        return {error: 1, result: error.message};
    }
}

// Push notification function using Firebase Cloud Messaging
async function sendPushNotification(fcmToken, title, body, data = {}) {
  if (!firebaseInitialized) {
    console.log('⚠️  Firebase not initialized, skipping push notification');
    return { error: 1, result: 'Firebase not initialized' };
  }

  if (!fcmToken) {
    return { error: 1, result: 'No FCM token provided' };
  }

  try {
    const message = {
      notification: {
        title: title,
        body: body
      },
      data: data,
      token: fcmToken,
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'prayer_notifications'
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1
          }
        }
      }
    };

    const response = await admin.messaging().send(message);
    console.log('✅ Push notification sent successfully:', response);
    return { error: 0, result: 'Push notification sent', messageId: response };
  } catch (error) {
    console.error('❌ Push notification error:', error);
    
    // Handle invalid/expired tokens
    if (error.code === 'messaging/invalid-registration-token' || 
        error.code === 'messaging/registration-token-not-registered') {
      console.log('🗑️  Invalid FCM token, should be removed from database');
      return { error: 1, result: 'Invalid token', shouldRemoveToken: true };
    }
    
    return { error: 1, result: error.message };
  }
}

function log(req, params) {
    let date_ob = new Date();
    console.log(new Date(), req.originalUrl, JSON.stringify(req.body));
}

// Basic authentication middleware - supports dual passwords
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  // Extract base64 encoded credentials
  const base64Credentials = authHeader.slice(6);
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
  const [username, password] = credentials.split(':');
  
  // Check credentials against environment variables - accept either password
  const validUsername = username === process.env.API_USERNAME;
  const validPassword1 = password === process.env.API_PASSWORD;
  const validPassword2 = password === process.env.API_PASSWORD2;
  
  if (validUsername && (validPassword1 || validPassword2)) {
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

// POST /getAllBlogArticles - Get all blog articles with timezone conversion
app.post('/getAllBlogArticles', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["tz"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: "Required params '" + requiredParam + "' missing"});
      }
    }
    
    // PostgreSQL timezone conversion query (converting from UTC to specified timezone)
    const query = `
      SELECT 
        id, 
        preview, 
        title, 
        image, 
        (created_datetime AT TIME ZONE 'UTC' AT TIME ZONE $1) as timestamp 
      FROM public.blog_article 
      ORDER BY created_datetime DESC
    `;
    
    const result = await pool.query(query, [params.tz]);
    res.json(result.rows);
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /getUserByEmail - Get user by email address
app.post('/getUserByEmail', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["email"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: "Required params '" + requiredParam + "' missing"});
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
        picture
      FROM public."user" 
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `;
    
    const result = await pool.query(query, [params.email]);
    res.json(result.rows);
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /getAllUsers - Get all users with prayer and request counts
app.post('/getAllUsers', authenticate, async (req, res) => {
  try {
    log(req);
    const params = req.body;
    const userId = params["userId"];
    
    // Validate required parameters
    const requiredParams = ["tz"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: "Required params '" + requiredParam + "' missing"});
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
app.post('/getRequestCount', authenticate, async (req, res) => {
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
app.post('/getAllRequests', authenticate, async (req, res) => {
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
app.post('/getAllPrayers', authenticate, async (req, res) => {
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
app.post('/getBlogArticle', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["id", "tz"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: "Required params '" + requiredParam + "' missing"});
      }
    }
    
    // PostgreSQL query to get blog article metadata
    const query = `
      SELECT 
        title, 
        preview, 
        image, 
        blog_article_file,
        (created_datetime AT TIME ZONE 'UTC' AT TIME ZONE $2) as timestamp 
      FROM public.blog_article 
      WHERE id = $1
    `;
    
    const result = await pool.query(query, [params.id, params.tz]);
    
    if (result.rows.length === 0) {
      return res.json({error: 1, result: "Blog article not found"});
    }
    
    const articleData = result.rows[0];
    const blogArticleFile = articleData.blog_article_file;
    
    // Read the flat file content
    const fs = require('fs');
    const path = require('path');
    
    const filePath = path.join(__dirname, 'blog_articles', blogArticleFile + '.txt');
    
    fs.readFile(filePath, 'utf8', function (err, data) {
      if (err) {
        console.log(err);
        return res.json({error: 1, result: err.message || err});
      }
      
      console.log('Successfully read blog article:', blogArticleFile);
      
      const article = {
        title: articleData.title,
        content: data,
        date: articleData.timestamp,
        image: articleData.image
      };
      
      res.json({error: 0, result: article});
    });
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({error: 1, result: 'Internal server error'});
  }
});

// POST /login - User authentication endpoint
app.post('/login', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["password", "email"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: "Required params '" + requiredParam + "' missing"});
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
        church_id
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
    bcrypt.compare(params.password, hash, function(err, passwordMatch) {
      if (err) {
        return res.json({error: 1, result: "Authentication error occurred."});
      }
      
      if (!passwordMatch) {
        return res.json({error: 1, result: "We have your email address! Maybe you forgot your password?"});
      }
      
      // Successful login - return user data
      res.json({error: 0, result: [user]});
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.json({error: 1, result: error.message});
  }
});

app.post('/requestPasswordReset', async (req, res) => {
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
    
    const resetLink = `https://prayoverus.com/reset-password.html?token=${token}`;
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
    
    const mailerSend = new MailerSend({
      apiKey: process.env.MAILERSEND_API_KEY
    });
    
    const sentFrom = new Sender("paul@prayoverus.com", "Pray Over Us");
    const emailParams = new EmailParams()
      .setFrom(sentFrom)
      .setTo([new Recipient(email, firstName)])
      .setBcc([new Recipient("programmerpauly@gmail.com", "Paul")])
      .setReplyTo(sentFrom)
      .setSubject("Reset Your Password - Pray Over Us")
      .setHtml(emailHtml)
      .setText("Password reset requested for your Pray Over Us account");
    
    await mailerSend.email.send(emailParams);
    
    console.log(`📧 Password reset email sent to ${email}`);
    
    res.json({error: 0, result: "If that email exists, you'll receive a password reset link shortly."});
    
  } catch (error) {
    console.error('Password reset request error:', error);
    res.json({error: 1, result: "An error occurred. Please try again later."});
  }
});

app.post('/resetPassword', async (req, res) => {
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

// POST /getRequestFeed - Get prayer request feed
app.post('/getRequestFeed', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // No required parameters for this endpoint (matches original)
    const requiredParams = [];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: "Required params '" + requiredParam + "' missing"});
      }
    }
    
    const requestId = params["requestId"] ? params["requestId"] : null;
    const userId = params["userId"];
    const timezone = params["tz"] || 'UTC';
    
    // Build the base query with PostgreSQL syntax
    let query = `
      SELECT DISTINCT 
        request.request_id,
        request.user_id,
        request.request_text,
        request.fk_prayer_id,
        request.fk_user_id,
        prayers.prayer_title,
        request.request_title,
        request.picture as request_picture,
        request.other_person,
        category.category_name,
        settings.use_alias,
        settings.allow_comments,
        (request.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $1) as timestamp,
        "user".user_name,
        "user".real_name,
        "user".picture,
        "user".church_id
      FROM public.request
      INNER JOIN public.category ON category.category_id = request.fk_category_id
      INNER JOIN public."user" ON "user".user_id = request.user_id
      INNER JOIN public.settings ON settings.user_id = "user".user_id
      INNER JOIN public.prayers ON prayers.prayer_id = request.fk_prayer_id
      WHERE request.active = 1
    `;
    
    const queryParams = [timezone];
    let paramCount = 1;
    
    // Get a specific request only
    if (requestId) {
      paramCount++;
      query += ` AND request.request_id = $${paramCount}`;
      queryParams.push(requestId);
    }
    
    // Not your request (exclude user 569)
    if (!requestId) {
      query += ` AND (request.user_id <> 569)`;
    }
    
    // You already prayed - exclude requests user already prayed for
    if (!requestId && userId) {
      paramCount++;
      query += ` AND request.request_id NOT IN 
        (SELECT request_id FROM public.user_request WHERE user_request.user_id = $${paramCount})`;
      queryParams.push(userId);
    }
    
    query += ` ORDER BY timestamp DESC`;
    
    const result = await pool.query(query, queryParams);
    res.json(result.rows);
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /getUser - Get user profile with stats
app.post('/getUser', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["userId"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: "Required params '" + requiredParam + "' missing"});
      }
    }
    
    const userId = params.userId;
    const timezone = params.tz || 'UTC';
    
    // Check if userId is numeric to determine if it could be a user_id
    const isNumeric = !isNaN(userId) && !isNaN(parseFloat(userId));
    
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
    res.json(result.rows);
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /updateUser - Update user profile (About, Title, Church)
app.post('/updateUser', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    if (!params.userId) {
      return res.json({ error: 1, result: "Required param 'userId' missing" });
    }
    
    // Validate that at least one field is being updated
    if (!params.user_about && !params.user_title && !params.church_id) {
      return res.json({ error: 1, result: "At least one field (user_about, user_title, or church_id) must be provided" });
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
    
    // Add userId as the last parameter for WHERE clause
    queryParams.push(params.userId);
    
    const query = `
      UPDATE public."user" 
      SET ${updateFields.join(', ')}
      WHERE user_id = $${paramIndex}
      RETURNING user_id, user_about, user_title, church_id
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
app.post('/getChatCompletion', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    if (!params.content) {
      return res.json({ error: "Required param 'content' missing" });
    }
    
    // Call OpenAI API with the content as user message
    // the newest OpenAI model is "gpt-5" which was released August 7, 2025. do not change this unless explicitly requested by the user
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo", // Using same model as original function
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

// POST /prayFor - Record when someone prays for a request
app.post('/prayFor', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["requestId", "userId"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({ error: "Required params '" + requiredParam + "' missing" });
      }
    }
    
    // Step 1: Insert prayer record into user_request table
    const insertQuery = `
      INSERT INTO public.user_request (request_id, user_id, timestamp) 
      VALUES ($1, $2, NOW())
    `;
    
    const insertResult = await pool.query(insertQuery, [params.requestId, params.userId]);
    
    if (insertResult.rowCount === 1) {
      // Step 2: Get request owner information
      const requestOwnerQuery = `
        SELECT 
          "user".user_id,
          "user".real_name, 
          "user".email, 
          "user".picture,
          "user".fcm_token, 
          request.request_text,
          request.request_title, 
          settings.prayer_emails,
          settings.push_notifications 
        FROM public.request 
        INNER JOIN public."user" ON "user".user_id = request.user_id 
        INNER JOIN public.settings ON settings.user_id = request.user_id 
        WHERE request.request_id = $1
      `;
      
      // Step 3: Get user who prayed information
      const userWhoPrayedQuery = `
        SELECT "user".real_name, "user".email 
        FROM public."user" 
        WHERE "user".user_id = $1
      `;
      
      // Execute both queries
      const [requestOwnerResult, userWhoPrayedResult] = await Promise.all([
        pool.query(requestOwnerQuery, [params.requestId]),
        pool.query(userWhoPrayedQuery, [params.userId])
      ]);
      
      const requestOwner = requestOwnerResult.rows[0];
      const userWhoPrayed = userWhoPrayedResult.rows[0];
      
      // Step 4: Send email notification if the request owner wants emails
      let emailResult = null;
      if (requestOwner?.prayer_emails && requestOwner?.email) {
        try {
          const emailTemplate = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #2c3e50;">Someone prayed for your request!</h2>
              <p>Dear ${requestOwner.real_name},</p>
              <p><strong>${userWhoPrayed.real_name}</strong> just prayed for your prayer request:</p>
              <div style="background-color: #f8f9fa; padding: 15px; border-left: 4px solid #3498db; margin: 20px 0;">
                <em>"${requestOwner.request_text}"</em>
              </div>
              <p>You are not alone in your prayers. The PrayOverUs community is standing with you.</p>
              <p>Blessings,<br>The PrayOverUs Team</p>
              <hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;">
              <p style="font-size: 12px; color: #666;">
                This email was sent because you have prayer email notifications enabled. 
                You can manage your settings in your PrayOverUs account.
              </p>
            </div>
          `;
          
          const fromPerson = { 
            email: "paul@prayoverus.com", 
            name: "PrayOverUs" 
          };
          
          const toPerson = { 
            email: requestOwner.email, 
            name: requestOwner.real_name 
          };
          
          const subject = `${userWhoPrayed.real_name} prayed for your request`;
          
          emailResult = await mailerSendSingle(emailTemplate, fromPerson, toPerson, subject, null, null);
          console.log('Prayer notification email sent:', emailResult);
        } catch (emailError) {
          console.error('Failed to send prayer notification email:', emailError);
          emailResult = { error: 1, result: emailError.message };
        }
      }
      
      // Step 5: Send push notification if the request owner has a FCM token and wants push notifications
      let pushResult = null;
      if (requestOwner?.push_notifications !== false && requestOwner?.fcm_token) {
        try {
          const notificationTitle = "Someone prayed for you 🙏";
          const notificationBody = `${userWhoPrayed.real_name} just prayed for your request`;
          const notificationData = {
            type: 'prayer',
            requestId: params.requestId.toString(),
            userId: requestOwner.user_id.toString(),
            prayerUserName: userWhoPrayed.real_name
          };
          
          pushResult = await sendPushNotification(
            requestOwner.fcm_token,
            notificationTitle,
            notificationBody,
            notificationData
          );
          
          console.log('Prayer notification push sent:', pushResult);
          
          // If token is invalid, remove it from database
          if (pushResult.shouldRemoveToken) {
            await pool.query(
              'UPDATE public."user" SET fcm_token = NULL WHERE user_id = $1',
              [requestOwner.user_id]
            );
            console.log(`🗑️  Removed invalid FCM token for user ${requestOwner.user_id}`);
          }
        } catch (pushError) {
          console.error('Failed to send prayer notification push:', pushError);
          pushResult = { error: 1, result: pushError.message };
        }
      }
      
      // Return success response with the prayer data
      res.json({
        success: true,
        message: "Prayer recorded successfully",
        emailSent: emailResult?.error === 0,
        pushSent: pushResult?.error === 0,
        data: {
          requestOwner: {
            name: requestOwner?.real_name,
            email: requestOwner?.email,
            requestText: requestOwner?.request_text,
            wantsEmails: requestOwner?.prayer_emails,
            wantsPushNotifications: requestOwner?.push_notifications
          },
          userWhoPrayed: {
            name: userWhoPrayed?.real_name,
            email: userWhoPrayed?.email
          }
        }
      });
      
    } else {
      res.json({ error: "Failed to record prayer" });
    }
    
  } catch (error) {
    console.error('Database query error:', error);
    
    // Handle duplicate prayer attempts
    if (error.code === '23505') { // PostgreSQL unique violation
      res.json({ error: "You have already prayed for this request" });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// POST /contact - Send contact email 
app.post('/contact', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["subject", "to", "content"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({ error: "Required parameter '" + requiredParam + "' missing" });
      }
    }
    
    // Define sender (same as prayer notifications)
    const fromPerson = { 
      email: "paul@prayoverus.com", 
      name: "PrayOverUs" 
    };
    
    // Recipient from parameter
    const toPerson = {
      email: params.to,
      name: "Recipient"
    };
    
    // Create HTML template for contact message
    const emailTemplate = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Website Contact Message</h2>
        <div style="background-color: #f8f9fa; padding: 15px; border-left: 4px solid #3498db; margin: 20px 0;">
          <p><strong>Subject:</strong> ${params.subject}</p>
        </div>
        <div style="margin: 20px 0; line-height: 1.6;">
          <p><strong>Message:</strong></p>
          <div style="background-color: #ffffff; padding: 15px; border: 1px solid #ddd; border-radius: 5px;">
            ${params.content}
          </div>
        </div>
        <p>This message was sent through the PrayOverUs.com contact form.</p>
        <hr style="border: 1px solid #eee; margin: 20px 0;">
        <p style="color: #7f8c8d; font-size: 12px;">
          Sent from PrayOverUs.com contact system
        </p>
      </div>
    `;
    
    // Send the email
    const emailResult = await mailerSendSingle(
      emailTemplate,
      fromPerson,
      toPerson,
      `Contact: ${params.subject}`,
      null,
      null
    );
    
    if (emailResult.error === 0) {
      res.json({ 
        error: 0, 
        result: "Contact message sent successfully" 
      });
    } else {
      res.json({ 
        error: 1, 
        result: emailResult.result 
      });
    }
    
  } catch (error) {
    console.error('Error in /contact endpoint:', error);
    res.json({ error: error.message });
  }
});

// GET /resume/:filename - Serve resume JSON files
app.get('/resume/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    // Sanitize filename to prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    
    // Add .json extension if not provided
    const jsonFilename = filename.endsWith('.json') ? filename : filename + '.json';
    const filePath = path.join(__dirname, 'resume_data', jsonFilename);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Resume file not found' });
    }
    
    // Read and return JSON file
    const jsonData = fs.readFileSync(filePath, 'utf8');
    const parsedData = JSON.parse(jsonData);
    
    res.json(parsedData);
    
  } catch (error) {
    console.error('Error serving resume file:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /registerFCMToken - Register or update a user's FCM token for push notifications
app.post('/registerFCMToken', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    if (!params.userId || !params.fcmToken) {
      return res.json({ error: 1, result: "Required params 'userId' and 'fcmToken' missing" });
    }
    
    // Update the user's FCM token in the database
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
    
    console.log(`✅ FCM token registered for user ${result.rows[0].real_name} (ID: ${params.userId})`);
    
    res.json({ 
      error: 0, 
      result: "FCM token registered successfully",
      userId: params.userId
    });
    
  } catch (error) {
    console.error('Error registering FCM token:', error);
    res.status(500).json({ error: 1, result: 'Internal server error' });
  }
});

// POST /createUser - Create a new user account with settings and family
app.post('/createUser', authenticate, async (req, res) => {
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
          contacted_timestamp, active, church_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
        params.church_id || 4
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
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2c3e50;">Welcome to 'Pray Over Us'</h2>
          <p>Dear ${params.firstName},</p>
          <p>You have joined the prayer community of faithfuls.</p>
          <p>Post your prayer requests and pray for other people.</p>
          ${passwordMessage ? `<div style="background-color: #f8f9fa; padding: 15px; border-left: 4px solid #3498db; margin: 20px 0;">
            <strong>Important:</strong> ${passwordMessage}
          </div>` : ''}
          <div style="text-align: center; margin: 30px 0;">
            <a href="https://www.prayoverus.com/index.html" 
               style="background-color: #3498db; color: white; padding: 12px 24px; 
                      text-decoration: none; border-radius: 5px; display: inline-block;">
              Login now!
            </a>
          </div>
          <p>Blessings,<br>The PrayOverUs Team</p>
          <hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;">
          <p style="font-size: 12px; color: #666;">
            Sent from PrayOverUs.com registration system
          </p>
        </div>
      `;
      
      const fromPerson = { 
        email: "paul@prayoverus.com", 
        name: "PrayOverUs" 
      };
      
      const toPerson = { 
        email: params.email, 
        name: params.firstName 
      };
      
      // Send email (don't wait for it to complete)
      mailerSendSingle(emailTemplate, fromPerson, toPerson, "Welcome to 'Pray Over Us'", null, null)
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

// Configure multer for prayer image uploads - use memory storage for security
const prayerImageUpload = multer({
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

// POST /createRequestAndPrayer - Create a prayer request and generate AI prayer
app.post('/createRequestAndPrayer', authenticate, (req, res) => {
  // Check content type and handle accordingly
  const contentType = req.get('Content-Type') || '';
  
  if (contentType.includes('multipart/form-data')) {
    // Handle multipart/form-data with image upload
    prayerImageUpload.single('image')(req, res, async (err) => {
      await handleCreateRequestAndPrayer(req, res, err);
    });
  } else {
    // Handle JSON request (original behavior)
    handleCreateRequestAndPrayer(req, res, null);
  }
});

// Shared handler for both JSON and multipart/form-data
async function handleCreateRequestAndPrayer(req, res, multerError) {
  let imagePath = null;
  
  // Clean up uploaded file on any error
  const cleanupFile = () => {
    if (imagePath && fs.existsSync(imagePath)) {
      try {
        fs.unlinkSync(imagePath);
      } catch (unlinkErr) {
        console.error('Failed to delete file:', unlinkErr);
      }
    }
  };
  
  try {
    // Handle multer errors for image uploads
    if (multerError) {
      if (multerError.code === 'LIMIT_FILE_SIZE') {
        return res.json({ error: 1, result: 'Image size exceeds 5MB limit' });
      }
      
      if (multerError.message === 'Only JPG, PNG, and WEBP formats are allowed') {
        return res.json({ error: 1, result: 'Only JPG, PNG, and WEBP formats are allowed' });
      }
      
      console.error('Image upload error:', multerError);
      return res.json({ error: 1, result: 'Failed to upload image' });
    }
    
    const params = req.body;
    
    const idempotencyKey = params["idempotencyKey"];
    
    // Now you have the key and can use it for your checks
    console.log(`Received idempotency key: ${idempotencyKey}`);

    const newRequestCheck = path.join(__dirname, idempotencyKey + ".txt");

    // Check if the file already exists
    if (fs.existsSync(newRequestCheck)) {
        res.json({ error: `File for key ID ${idempotencyKey} already exists.` });
        return; // Quit and do not continue
    }

    console.log(newRequestCheck);

    // Write the new file
    try {
        const fileContent = JSON.stringify(params, null, 2);
        fs.writeFileSync(newRequestCheck, idempotencyKey);
        console.log(`Successfully created file for key ${idempotencyKey}.`);
    } catch (err) {
        console.error(`Error writing file for key ${idempotencyKey}:`, err);
        res.status(500).json({ error: "Could not create request file." });
        return;
    }

    // Validate required parameters
    const requiredParams = ["userId", "requestText", "requestTitle", "sendEmail"];
    for (let i = 0; i < requiredParams.length; i++) {
        const requiredParam = requiredParams[i];
        if (!params[requiredParam]) {
            res.json({ error: "Required param '" + requiredParam + "' missing" });
            return;
        }
    }

    // Step 1: Insert the request into the database (simplified approach)
    const insertQuery = `
      INSERT INTO public.request (
        user_id, request_text, request_title, fk_category_id, other_person, picture, fk_prayer_id,
        fk_user_id, other_person_gender, other_person_email, relationship,
        for_me, for_all, active, timestamp, updated_timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW())
      RETURNING request_id
    `;

    const forMe = (params.forMe === "false") ? 0 : 1;
    const forAll = (params.forAll === "false") ? 0 : 1;
    
    // Handle image upload if present (multipart/form-data)
    let pictureUrl = params.picture || null;
    
    if (req.file && req.file.buffer) {
      // We have an uploaded image - we'll save it after getting the requestId
      // For now, use a placeholder that we'll update after INSERT
      pictureUrl = 'PENDING_IMAGE_UPLOAD';
    }

    // Build parameters array with all values (null for optional ones)
    const queryParams = [
      params.userId,                          // $1
      params.requestText,                     // $2
      params.requestTitle,                    // $3
      8,                                      // $4 - fk_category_id
      params.otherPerson || null,             // $5
      pictureUrl,                             // $6
      params.prayerId || null,                // $7
      params.otherPersonUserId || null,       // $8
      params.otherPersonGender || null,       // $9
      params.otherPersonEmail || null,        // $10
      params.relationship || null,            // $11
      forMe,                                  // $12
      forAll,                                 // $13
      1                                       // $14 - active (1 for true in smallint)
    ];

    const insertResult = await pool.query(insertQuery, queryParams);
    const requestId = insertResult.rows[0].request_id;
    
    // Save uploaded image file if present
    if (req.file && req.file.buffer) {
      try {
        const ext = path.extname(req.file.originalname).toLowerCase();
        const filename = `${requestId}_prayer${ext}`;
        imagePath = path.join('public/prayer-images', filename);
        
        // Write buffer to disk
        fs.writeFileSync(imagePath, req.file.buffer);
        
        // Build the public URL for the uploaded image
        pictureUrl = `https://shouldcallpaul.replit.app/prayer-images/${filename}`;
        
        // Update the request with the actual image URL
        const updatePictureQuery = `UPDATE public.request SET picture = $1 WHERE request_id = $2`;
        await pool.query(updatePictureQuery, [pictureUrl, requestId]);
        
      } catch (imageError) {
        console.error('Error saving prayer image:', imageError);
        cleanupFile();
        // Continue without image - don't fail the whole request
      }
    }

    // Step 2: Get user details for prayer generation
    const userQuery = `
      SELECT "user".real_name, "user".picture 
      FROM public."user" 
      WHERE "user".user_id = $1
    `;
    const userResult = await pool.query(userQuery, [params.userId]);
    
    if (userResult.rows.length === 0) {
      res.json({ error: "User not found" });
      return;
    }

    const realName = userResult.rows[0].real_name;
    const userPicture = userResult.rows[0].picture;

    // Step 3: Generate prayer using our getChatCompletion endpoint
    const promptToGeneratePrayer = `You are an expert prayer writer, composing a Catholic-style prayer. The prayer should have a traditional, reverent, and intercessory tone.

User Request: ${params.requestText}
Author of Request: ${realName}

IMPORTANT - Identify the Correct Prayer Subject:
The "Author of Request" is the person MAKING the request, but NOT necessarily the person to pray for. You must carefully read the request text to determine the correct subject:

- If the request mentions another person (e.g., "my husband", "my mother", "my friend John"), pray for THAT person (use their specific name if provided)
  Example: "Pray for my husband Jiri for good health" → Pray for Jiri, NOT ${realName}
  
- If the request says "pray for me", "I need...", "help me...", then pray for the author: ${realName}
  Example: "Pray for me to find strength" → Pray for ${realName}

CRITICAL - DO NOT INVENT NAMES:
- NEVER make up or invent names that are not explicitly provided in the request text
- If specific names are NOT provided, use possessive phrases instead
  Example: "Pray for my dad" → Use "${realName}'s father" NOT "Paul Sr." or invented names
  Example: "Pray for my coworkers" → Use "${realName}'s coworkers" NOT "Grace, Michael, and Sarah"
  Example: "Pray for my family" → Use "${realName}'s family" NOT invented family member names
- ONLY use a specific name if it appears verbatim in the request text
- When no name is given, use relationship terms with possessive: "his father", "her mother", "${realName}'s children", etc.

Instructions for Generating the Prayer:

1. Format: The prayer should be suitable for reading aloud and follow a typical structure (e.g., address to God/Jesus/Mary/Saint, statement of need, intercession, concluding doxology).

2. Personalization: Write the prayer in the first person plural (e.g., "We pray for...") or the second person singular (e.g., "Look upon...") to intercede for the prayer subject you identified above.

3. Gender Pronoun Rule: Use a gender pronoun (he/him/his or she/her/hers) only when referring to the prayer subject. Make an educated guess about the appropriate gender based on the common usage of the provided name. If the name is ambiguous or gender-neutral (e.g., Alex, Jordan), use the name itself instead of a pronoun to maintain reverence and accuracy.

4. Integration: Seamlessly weave the correct person's name and the specific request into the body of the prayer.

5. HTML Formatting: Return the prayer as pure HTML with the following requirements:
   - Wrap the following words in <strong> tags for bold emphasis:
     * All person names mentioned in the prayer (the prayer subject and any other individuals mentioned)
     * Divine names: God, Lord, Jesus, Christ, Holy Spirit, Father, Mary, Saint, Savior, Redeemer, Creator
     * Key intercession words: heal, healing, protect, protection, guide, guidance, bless, blessing, comfort, strengthen, peace, grace, mercy, love, hope, faith, wisdom, courage, patience
   - Use <br> tags for line breaks (NOT newline characters)
   - Output ONLY HTML - no plain text newlines or escape characters

6. CRITICAL - NO "AMEN" ENDING: Do NOT end the prayer with "Amen" or any variation (Amen., AMEN, etc.). The app has its own "Amen" button. The prayer MUST end with the final petition or doxology WITHOUT "Amen". This is extremely important.

7. Important: Do NOT use asterisks, markdown formatting, or \\n newlines. Only use HTML tags (<strong> and <br>).`;

    
    try {
      // Make internal call to our getChatCompletion endpoint
      const chatResponse = await fetch(`http://localhost:${PORT}/getChatCompletion`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': req.headers.authorization
        },
        body: JSON.stringify({ content: promptToGeneratePrayer })
      });

      const chatResult = await chatResponse.json();

      if (!chatResult.choices || chatResult.choices.length === 0) {
        res.json({ error: "Failed to get a prayer from OpenAI" });
        return;
      }

      let newPrayer = chatResult.choices[0].message.content;
      
      // Convert markdown-style bold (**text**) to HTML <strong> tags
      newPrayer = newPrayer.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      
      // Convert any remaining newlines to HTML line breaks for proper HTML formatting
      newPrayer = newPrayer.replace(/\n/g, '<br>');
      
      // Safety net: Remove "Amen" from the end if AI added it anyway (case-insensitive)
      newPrayer = newPrayer.replace(/<br>\s*<strong>\s*Amen\.?\s*<\/strong>\s*$/i, '');
      newPrayer = newPrayer.replace(/<br>\s*Amen\.?\s*$/i, '');
      newPrayer = newPrayer.replace(/\s*<strong>\s*Amen\.?\s*<\/strong>\s*$/i, '');
      newPrayer = newPrayer.replace(/\s*Amen\.?\s*$/i, '');

      // Step 4: Insert the generated prayer
      const prayerInsertQuery = `
        INSERT INTO public.prayers (prayer_title, prayer_text, prayer_text_me, tags, active, prayer_file_name) 
        VALUES ($1, $2, $3, $4, $5, $6) 
        RETURNING prayer_id
      `;

      const prayerResult = await pool.query(prayerInsertQuery, [
        'openAI-generated',
        newPrayer,
        newPrayer,
        'openAI',
        1,          // active field is smallint, use 1 instead of true
        'openAI'
      ]);

      const prayerId = prayerResult.rows[0].prayer_id;

      // Step 5: Update the request with the prayer ID
      const updateQuery = `
        UPDATE public.request 
        SET fk_prayer_id = $1, active = 1 
        WHERE request_id = $2
      `;

      await pool.query(updateQuery, [prayerId, requestId]);

      // Step 6: Return success response
      res.json({
        success: true,
        requestId: requestId,
        prayerId: prayerId,
        realName: realName,
        prayer: newPrayer,
        message: "Request and prayer created successfully"
      });

      // Step 7: Send notification email to admin
      const notificationHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px;">New Prayer Request Created</h2>
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <p><strong>Created by:</strong> ${realName}</p>
            <p><strong>Request ID:</strong> ${requestId}</p>
            <p><strong>Prayer ID:</strong> ${prayerId}</p>
          </div>
          <div style="margin: 20px 0;">
            <h3 style="color: #2c3e50;">Request Title:</h3>
            <p style="background-color: #e8f5e9; padding: 15px; border-left: 4px solid #4caf50; margin: 10px 0;">
              ${params.requestTitle}
            </p>
          </div>
          <div style="margin: 20px 0;">
            <h3 style="color: #2c3e50;">Request Text:</h3>
            <p style="background-color: #fff3e0; padding: 15px; border-left: 4px solid #ff9800; margin: 10px 0;">
              ${params.requestText}
            </p>
          </div>
          <div style="margin: 20px 0;">
            <h3 style="color: #2c3e50;">Generated Prayer:</h3>
            <div style="background-color: #f3e5f5; padding: 15px; border-left: 4px solid #9c27b0; margin: 10px 0; line-height: 1.6;">
              ${newPrayer}
            </div>
          </div>
          <hr style="border: 1px solid #eee; margin: 20px 0;">
          <p style="color: #7f8c8d; font-size: 12px;">
            This is an automated notification from PrayOverUs.com
          </p>
        </div>
      `;

      const fromPerson = { 
        email: "paul@prayoverus.com", 
        name: "PrayOverUs Notifications" 
      };
      
      const toPerson = {
        email: "paul@prayoverus.com",
        name: "Paul"
      };

      mailerSendSingle(
        notificationHtml,
        fromPerson,
        toPerson,
        `New Prayer Request: ${params.requestTitle}`,
        null,
        null
      ).catch(emailError => {
        console.error('Admin notification email failed:', emailError);
      });

      // Clean up idempotency file
      if (fs.existsSync(newRequestCheck)) {
        fs.unlink(newRequestCheck, (err) => {
          if (err) {
            console.error(`Error deleting file for key ${idempotencyKey}:`, err);
            return;
          }
          console.log(`Successfully deleted file for key ${idempotencyKey}.`);
        });
      } else {
        console.log(`File for key ${idempotencyKey} does not exist, no action needed.`);
      }

    } catch (chatError) {
      console.error('OpenAI chat completion error:', chatError);
      res.json({ error: "Failed to generate prayer" });
      return;
    }

  } catch (error) {
    console.error('Database error:', error);
    cleanupFile();
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Root endpoint for deployment health checks
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Prayer Over Us API Server',
    timestamp: new Date().toISOString() 
  });
});

// Health check endpoint (no authentication required)
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// GET /getAllChurches - Get all churches (no authentication required)
app.get('/getAllChurches', async (req, res) => {
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

// POST /getPrayerByRequestId - Get prayer text for a specific request
app.post('/getPrayerByRequestId', authenticate, async (req, res) => {
  log(req);
  const params = req.body;

  const requiredParam = "requestId";
  if (!params[requiredParam]) {
    res.json({ error: "Required param '" + requiredParam + "' missing" });
    return;
  }

  try {
    // Use a parameterized query to prevent SQL injection (PostgreSQL syntax)
    const query = `
      SELECT p.prayer_text 
      FROM public.request r
      INNER JOIN public.prayers p ON r.fk_prayer_id = p.prayer_id
      WHERE r.request_id = $1
    `;

    const result = await pool.query(query, [params.requestId]);

    console.log(result.rows);

    if (result.rows.length > 0 && result.rows[0].prayer_text) {
      res.json({
        error: 0,
        prayerText: result.rows[0].prayer_text
      });
    } else {
      res.json({
        error: "Prayer not found for the given requestId",
        prayerText: null
      });
    }
  } catch (err) {
    console.error(err);
    res.json({ error: "Database error: " + err.message });
  }
});

// POST /getPrayedFor - Get all requests that a user has prayed for
app.post('/getPrayedFor', authenticate, async (req, res) => {
  try {
    log(req);
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["userId"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: "Required params '" + requiredParam + "' missing"});
      }
    }
    
    // PostgreSQL query to get all requests the user has prayed for
    const query = `
      SELECT DISTINCT 
        r.*,
        u.picture,
        u.real_name as first_name
      FROM public.request r
      INNER JOIN public.user_request ur ON r.request_id = ur.request_id
      INNER JOIN public."user" u ON r.user_id = u.user_id
      WHERE ur.user_id = $1
      ORDER BY r.timestamp DESC
    `;
    
    const result = await pool.query(query, [params.userId]);
    res.json(result.rows);
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /getMyRequestFeed - Get user's own prayer request feed with authentication
app.post('/getMyRequestFeed', authenticate, async (req, res) => {
  log(req);
  const params = req.body;
  
  const requiredParams = ["userId"];
  for (let i = 0; i < requiredParams.length; i++) {
    const requiredParam = requiredParams[i];
    if (!params[requiredParam]) {
      res.json({ error: "Required params '" + requiredParam + "' missing" });
      return;
    }
  }

  try {
    const timezone = params.tz || 'UTC';
    
    // PostgreSQL query with proper parameterization to prevent SQL injection
    const query = `
      SELECT DISTINCT 
        request.request_id,
        request.user_id,
        request.request_text,
        request.fk_prayer_id,
        request.fk_user_id,
        prayers.prayer_title,
        request.request_title,
        request.picture as request_picture,
        request.other_person,
        category.category_name,
        settings.use_alias,
        settings.allow_comments,
        (request.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $2) as timestamp,
        request.timestamp as timestamp_raw,
        "user".user_name,
        "user".real_name,
        "user".picture
      FROM public.request
      LEFT JOIN public.category ON category.category_id = request.fk_category_id
      INNER JOIN public."user" ON "user".user_id = request.user_id
      LEFT JOIN public.settings ON settings.user_id = "user".user_id
      LEFT JOIN public.prayers ON prayers.prayer_id = request.fk_prayer_id
      WHERE request.user_id = $1
      ORDER BY timestamp_raw DESC
    `;

    const result = await pool.query(query, [params.userId, timezone]);
    res.json(result.rows);

  } catch (err) {
    console.error('Database query error:', err);
    res.json({ error: "Database error: " + err.message });
  }
});

// POST /getMyRequests - Get user's own active prayer requests (active = 1)
app.post('/getMyRequests', authenticate, async (req, res) => {
  log(req);
  const params = req.body;
  
  const requiredParams = ["userId"];
  for (let i = 0; i < requiredParams.length; i++) {
    const requiredParam = requiredParams[i];
    if (!params[requiredParam]) {
      res.json({ error: "Required params '" + requiredParam + "' missing" });
      return;
    }
  }

  try {
    const timezone = params.tz || 'UTC';
    
    // PostgreSQL query with proper parameterization to prevent SQL injection
    const query = `
      SELECT DISTINCT 
        request.request_id,
        request.user_id,
        request.request_text,
        request.fk_prayer_id,
        request.fk_user_id,
        prayers.prayer_title,
        request.request_title,
        request.picture as request_picture,
        request.other_person,
        category.category_name,
        settings.use_alias,
        settings.allow_comments,
        (request.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $2) as timestamp,
        request.timestamp as timestamp_raw,
        "user".user_name,
        "user".real_name,
        "user".picture,
        "user".church_id
      FROM public.request
      LEFT JOIN public.category ON category.category_id = request.fk_category_id
      INNER JOIN public."user" ON "user".user_id = request.user_id
      LEFT JOIN public.settings ON settings.user_id = "user".user_id
      LEFT JOIN public.prayers ON prayers.prayer_id = request.fk_prayer_id
      WHERE request.user_id = $1 AND request.active = 1
      ORDER BY timestamp_raw DESC
    `;

    const result = await pool.query(query, [params.userId, timezone]);
    res.json(result.rows);

  } catch (err) {
    console.error('Database query error:', err);
    res.json({ error: "Database error: " + err.message });
  }
});

// POST /getCommunityWall - Get community prayer wall with prayer counts and names
app.post('/getCommunityWall', authenticate, async (req, res) => {
  log(req);
  const params = req.body;
  
  const requiredParams = ["userId"];
  for (let i = 0; i < requiredParams.length; i++) {
    const requiredParam = requiredParams[i];
    if (!params[requiredParam]) {
      res.json({ error: "Required params '" + requiredParam + "' missing" });
      return;
    }
  }

  try {
    const timezone = params.tz || 'UTC';
    const filterByChurch = params.filterByChurch === true || params.filterByChurch === 'true';
    
    // Build the WHERE clause based on church filter
    let whereClause = 'WHERE request.active = 1';
    let queryParams = [params.userId, timezone];
    
    if (filterByChurch) {
      // Add church filter - only show prayers from users in the same church
      // UNLESS the requesting user's church_id is 4 (None), which means "show all prayers"
      whereClause += ` AND (
        "user".church_id = (SELECT church_id FROM public."user" WHERE user_id = $1)
        OR (SELECT church_id FROM public."user" WHERE user_id = $1) = 4
      )`;
    }
    
    // PostgreSQL query to get all active requests with prayer information
    const query = `
      SELECT DISTINCT 
        request.request_id,
        request.user_id,
        request.request_text,
        request.fk_prayer_id,
        request.fk_user_id,
        prayers.prayer_title,
        request.request_title,
        request.picture as request_picture,
        request.other_person,
        category.category_name,
        settings.use_alias,
        settings.allow_comments,
        (request.timestamp AT TIME ZONE 'UTC' AT TIME ZONE $2) as timestamp,
        request.timestamp as timestamp_raw,
        "user".user_name,
        "user".real_name,
        "user".picture,
        "user".church_id,
        COALESCE(prayer_info.prayer_count, 0) as prayer_count,
        COALESCE(prayer_info.prayed_by_names, ARRAY[]::text[]) as prayed_by_names,
        CASE WHEN prayer_info.user_has_prayed THEN true ELSE false END as user_has_prayed
      FROM public.request
      LEFT JOIN public.category ON category.category_id = request.fk_category_id
      INNER JOIN public."user" ON "user".user_id = request.user_id
      LEFT JOIN public.settings ON settings.user_id = "user".user_id
      LEFT JOIN public.prayers ON prayers.prayer_id = request.fk_prayer_id
      LEFT JOIN LATERAL (
        SELECT 
          COUNT(*)::int as prayer_count,
          ARRAY_AGG(praying_user.real_name ORDER BY praying_user.real_name) as prayed_by_names,
          BOOL_OR(user_request.user_id = $1) as user_has_prayed
        FROM public.user_request
        INNER JOIN public."user" as praying_user ON praying_user.user_id = user_request.user_id
        WHERE user_request.request_id = request.request_id
      ) as prayer_info ON true
      ${whereClause}
      ORDER BY timestamp_raw DESC
    `;

    const result = await pool.query(query, queryParams);
    res.json(result.rows);

  } catch (err) {
    console.error('Database query error:', err);
    res.json({ error: "Database error: " + err.message });
  }
});

// POST /deleteRequestById - Delete a request by ID
app.post('/deleteRequestById', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["request_id"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({ error: "Required param '" + requiredParam + "' missing" });
      }
    }
    
    // Check if request exists first
    const checkQuery = `
      SELECT request_id, request_title, user_id 
      FROM public.request 
      WHERE request_id = $1
    `;
    
    const checkResult = await pool.query(checkQuery, [params.request_id]);
    
    if (checkResult.rows.length === 0) {
      return res.json({ error: "Request with ID " + params.request_id + " not found" });
    }
    
    // Delete the request from the database
    const deleteQuery = `
      DELETE FROM public.request 
      WHERE request_id = $1 
      RETURNING request_id, request_title
    `;
    
    const deleteResult = await pool.query(deleteQuery, [params.request_id]);
    
    if (deleteResult.rows.length === 0) {
      return res.json({ error: "Failed to delete request" });
    }
    
    const deletedRequest = deleteResult.rows[0];
    
    // Return success response
    res.json({ 
      error: 0, 
      message: "Request deleted successfully",
      deleted_request: {
        request_id: deletedRequest.request_id,
        request_title: deletedRequest.request_title
      }
    });
    
  } catch (error) {
    console.error('Delete request error:', error);
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// POST /deleteUser - Delete user and all related data with backup
app.post('/deleteUser', authenticate, async (req, res) => {
  const execPromise = promisify(exec);
  
  try {
    const params = req.body;
    
    // Validate required parameters
    if (!params.userId) {
      return res.json({ error: 1, result: "Required param 'userId' missing" });
    }

    // Step 1: Check if user exists and is active
    const userCheckQuery = `
      SELECT user_id, real_name, email, active 
      FROM public.user 
      WHERE user_id = $1
    `;
    
    const userCheckResult = await pool.query(userCheckQuery, [params.userId]);
    
    if (userCheckResult.rows.length === 0) {
      return res.json({ error: 1, result: "User not found" });
    }
    
    const user = userCheckResult.rows[0];
    
    if (user.active !== 1) {
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
      const pgDumpCommand = `pg_dump "${process.env.DATABASE_URL}" > "${backupFile}"`;
      await execPromise(pgDumpCommand);
      console.log(`Database backup created: ${backupFile}`);
    } catch (backupError) {
      console.error('Backup error:', backupError);
      return res.json({ error: 1, result: "Failed to create database backup: " + backupError.message });
    }

    // Step 4: Begin transaction for deletion
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Delete in correct order to avoid foreign key violations
      
      // 4a. Delete from user_request where this user prayed for others
      const deleteUserRequestSelf = await client.query(
        'DELETE FROM public.user_request WHERE user_id = $1',
        [params.userId]
      );
      
      // 4b. Delete from user_request where others prayed for this user's requests
      const deleteUserRequestOthers = await client.query(
        `DELETE FROM public.user_request 
         WHERE request_id IN (
           SELECT request_id FROM public.request WHERE user_id = $1
         )`,
        [params.userId]
      );
      
      // 4c. Delete from request table (this user's prayer requests)
      const deleteRequests = await client.query(
        'DELETE FROM public.request WHERE user_id = $1',
        [params.userId]
      );
      
      // 4d. Delete from settings table
      const deleteSettings = await client.query(
        'DELETE FROM public.settings WHERE user_id = $1',
        [params.userId]
      );
      
      // 4e. Delete from user table
      const deleteUser = await client.query(
        'DELETE FROM public.user WHERE user_id = $1 RETURNING user_id, real_name, email',
        [params.userId]
      );
      
      await client.query('COMMIT');
      
      // Return success response
      res.json({
        error: 0,
        result: "User deleted successfully",
        deleted_user: deleteUser.rows[0],
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
app.post('/sendBroadcastEmail', authenticate, async (req, res) => {
  log(req);
  const params = req.body;
  
  const requiredParams = ["includeAllUsers", "subject", "body", "buttonLink", "buttonText"];
  for (let i = 0; i < requiredParams.length; i++) {
    const requiredParam = requiredParams[i];
    if (params[requiredParam] === undefined) {
      res.json({ error: "Required param '" + requiredParam + "' missing" });
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
      console.log('📧 Sending test broadcast email (to paul@prayoverus.com only)');
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

    // Set up MailerSend
    const mailerSend = new MailerSend({
      apiKey: process.env.MAILERSEND_API_KEY
    });

    const sentFrom = new Sender("paul@prayoverus.com", "Pray Over Us");

    let successCount = 0;
    let failCount = 0;
    const delayBetweenEmails = 600; // 600ms between emails = 100 emails/min (safe under 120/min limit)
    const logInterval = 10; // Log progress every 10 emails

    // Send emails with rate limiting
    const recipientsToSend = params.includeAllUsers ? userRecipients : [{email: "paul@prayoverus.com", user_name: "Paul", real_name: "Paul"}];
    
    for (let i = 0; i < recipientsToSend.length; i++) {
      const user = recipientsToSend[i];
      const firstName = user.real_name || user.user_name || "Friend";
      
      // Create personalized email HTML
      const personalizedHtml = createEmailHtml(firstName, params.body, params.buttonLink, params.buttonText);
      
      // Build CC list - avoid duplicating the TO recipient
      const ccRecipients = [];
      if (user.email !== "paul@prayoverus.com") {
        ccRecipients.push(new Recipient("paul@prayoverus.com", "Paul"));
      }
      if (user.email !== "prayoverus@gmail.com") {
        ccRecipients.push(new Recipient("prayoverus@gmail.com", "Pray Over Us"));
      }
      
      try {
        const emailParams = new EmailParams()
          .setFrom(sentFrom)
          .setTo([new Recipient(user.email, user.user_name)])
          .setReplyTo(sentFrom)
          .setSubject(params.subject)
          .setHtml(personalizedHtml)
          .setText("Email from PrayOverUs.com");
        
        // Only add CC if there are recipients
        if (ccRecipients.length > 0) {
          emailParams.setCc(ccRecipients);
        }

        await mailerSend.email.send(emailParams);
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
      : "Test broadcast email sent to paul@prayoverus.com";
    
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

// POST /uploadProfilePicture - Upload user profile picture
app.post('/uploadProfilePicture', authenticate, (req, res) => {
  // Wrap multer to properly catch and handle errors
  profilePictureUpload.single('image')(req, res, async (err) => {
    let filePath = null;
    
    // Clean up disk file on any error
    const cleanupFile = () => {
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (unlinkErr) {
          console.error('Failed to delete file:', unlinkErr);
        }
      }
    };
    
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
      
      // Now that all validation passed, safely construct filename and write to disk
      const ext = path.extname(req.file.originalname).toLowerCase();
      const filename = `${userIdNum}_profile${ext}`;
      filePath = path.join('public/profile-pictures', filename);
      
      // Write buffer to disk
      fs.writeFileSync(filePath, req.file.buffer);
      
      // Build the public URL for the uploaded image
      const profilePictureUrl = `https://shouldcallpaul.replit.app/profile-pictures/${filename}`;
      
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
      cleanupFile();
      res.json({ error: 1, result: 'Failed to save image' });
    }
  });
});

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'blog_articles/img/');
  },
  filename: function (req, file, cb) {
    // Use the filename provided in the request or generate from title
    const customName = req.body.imageFilename || 'article-image';
    const ext = path.extname(file.originalname);
    cb(null, customName + ext);
  }
});

const upload = multer({ storage: storage });

// Admin endpoint to create a new blog article
app.post('/admin/createBlogArticle', authenticate, upload.single('image'), async (req, res) => {
  try {
    const { title, content, author, imageFilename } = req.body;
    
    // Validate required fields
    if (!title || !content) {
      return res.json({ error: 1, result: 'Title and content are required' });
    }
    
    if (!req.file) {
      return res.json({ error: 1, result: 'Image file is required' });
    }
    
    // Generate filename-safe blog article file name from title (max 20 chars for DB)
    const blogArticleFile = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 20);
    
    // Generate preview text (first 200 characters)
    const preview = content.substring(0, 200).trim() + '...';
    
    // Generate the HTML content
    const authorName = author || 'Sherri Rase';
    const imageUrl = `https://shouldcallpaul.replit.app/img/${req.file.filename}`;
    
    // Convert plain text content to HTML paragraphs
    const paragraphs = content.split('\n\n').filter(p => p.trim());
    let htmlContent = '';
    
    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i].trim();
      
      // Check if paragraph contains a URL (likely a call-to-action)
      if (para.includes('http://') || para.includes('https://')) {
        const urlMatch = para.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch) {
          const url = urlMatch[0];
          const text = para.replace(url, '').trim();
          htmlContent += `
    <div class="call-to-action">
        <p><strong>${text}</strong></p>
        <p><a href="${url}" target="_blank">Visit for more information</a></p>
    </div>
`;
        }
      }
      // Check if it's a short paragraph (likely a highlight/quote)
      else if (para.length < 300 && i > 0 && i < paragraphs.length - 1) {
        htmlContent += `
    <div class="highlight">
        <p>${para}</p>
    </div>
`;
      }
      // Regular paragraph
      else {
        htmlContent += `
    <p>${para}</p>
`;
      }
    }
    
    const htmlTemplate = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            font-family: Georgia, serif;
            line-height: 1.6;
            color: #333;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
        }
        h1 {
            color: #2c3e50;
            border-bottom: 2px solid #3498db;
            padding-bottom: 10px;
        }
        p {
            margin-bottom: 18px;
            text-align: justify;
        }
        .byline {
            font-style: italic;
            color: #7f8c8d;
            font-size: 0.9em;
        }
        .highlight {
            background-color: #f8f9fa;
            padding: 15px;
            border-left: 4px solid #3498db;
            margin: 20px 0;
        }
        .image-container {
            text-align: center;
            margin: 20px 0;
        }
        .image-container img {
            max-width: 100%;
            height: auto;
            border-radius: 5px;
        }
        .image-caption {
            font-style: italic;
            color: #7f8c8d;
            font-size: 0.9em;
            margin-top: 8px;
        }
        a {
            color: #3498db;
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        .call-to-action {
            background-color: #e8f5e8;
            padding: 15px;
            border-left: 4px solid #27ae60;
            margin: 20px 0;
            text-align: center;
        }
    </style>
</head>
<body>${htmlContent}
</body>
</html>`;
    
    // Save the HTML file
    const htmlFilePath = path.join(__dirname, 'blog_articles', `${blogArticleFile}.txt`);
    fs.writeFileSync(htmlFilePath, htmlTemplate);
    
    // Get the next available ID
    const maxIdResult = await pool.query('SELECT MAX(id) as max_id FROM public.blog_article');
    const nextId = (maxIdResult.rows[0].max_id || 0) + 1;
    
    // Insert into database
    const insertQuery = `
      INSERT INTO public.blog_article (id, created_datetime, title, blog_article_file, preview, image)
      VALUES ($1, NOW(), $2, $3, $4, $5)
      RETURNING id
    `;
    
    const imageDbPath = `img/${req.file.filename}`;
    const result = await pool.query(insertQuery, [
      nextId,
      title,
      blogArticleFile,
      preview,
      imageDbPath
    ]);
    
    console.log(`✅ Blog article created successfully: ID ${nextId}, file: ${blogArticleFile}.txt`);
    
    res.json({
      error: 0,
      result: 'Blog article created successfully',
      articleId: nextId,
      blogArticleFile: blogArticleFile,
      imageUrl: imageUrl
    });
    
  } catch (error) {
    console.error('Error creating blog article:', error);
    res.status(500).json({ error: 1, result: error.message });
  }
});

// Migration endpoint removed for security after successful data import

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