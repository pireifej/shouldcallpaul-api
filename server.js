const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Enable CORS for mobile and web apps
app.use(express.json({ limit: '50mb' })); // Parse JSON request bodies
app.use(express.text({ limit: '50mb' })); // Parse text request bodies

// Serve static files for profile images and blog images
app.use('/profile_images', express.static('profile_images'));
app.use('/img', express.static('blog_articles/img'));

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

// POST /getAllBlogArticles - Get all blog articles with timezone conversion
app.post('/getAllBlogArticles', async (req, res) => {
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
app.post('/getUserByEmail', async (req, res) => {
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
      WHERE LOWER(email) LIKE LOWER($1)
      LIMIT 1
    `;
    
    const result = await pool.query(query, [params.email]);
    res.json(result.rows);
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Simple logging function to match original functionality
const log = (req) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - Body:`, req.body);
};

// POST /getAllUsers - Get all users with prayer and request counts
app.post('/getAllUsers', async (req, res) => {
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
        ("user".timestamp AT TIME ZONE 'UTC' AT TIME ZONE $1) as timestamp,
        (SELECT COUNT(*) FROM public.user_request WHERE user_request.user_id = "user".user_id) as prayer_count,
        (SELECT COUNT(*) FROM public.request WHERE request.user_id = "user".user_id) as request_count
      FROM public."user"
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
app.post('/getRequestCount', async (req, res) => {
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
app.post('/getAllRequests', async (req, res) => {
  try {
    log(req);
    const params = req.body;
    
    // Select all requests
    const query = `SELECT * FROM public.request`;
    
    const result = await pool.query(query);
    res.json(result.rows);
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /getBlogArticle - Get single blog article with content from flat file
app.post('/getBlogArticle', async (req, res) => {
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
        picture
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

// POST /getRequestFeed - Get prayer request feed
app.post('/getRequestFeed', async (req, res) => {
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
        "user".picture
      FROM public.request
      INNER JOIN public.category ON category.category_id = request.fk_category_id
      INNER JOIN public."user" ON "user".user_id = request.user_id
      INNER JOIN public.settings ON settings.user_id = "user".user_id
      INNER JOIN public.prayers ON prayers.prayer_id = request.fk_prayer_id
      INNER JOIN public.user_family ON user_family.user_id = request.user_id
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
app.post('/getUser', async (req, res) => {
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
          settings.use_alias,
          settings.request_emails,
          settings.prayer_emails,
          settings.allow_comments,
          settings.general_emails,
          settings.summary_emails,
          user_family.family_id,
          ("user".timestamp AT TIME ZONE 'UTC' AT TIME ZONE $2) as timestamp,
          (SELECT COUNT(*) FROM public.user_request WHERE user_request.user_id = "user".user_id) as prayer_count,
          (SELECT COUNT(*) FROM public.request WHERE request.user_id = "user".user_id) as request_count
        FROM public."user"
        LEFT JOIN public.settings ON settings.user_id = $1
        LEFT JOIN public.user_family ON user_family.user_id = $1
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
          settings.use_alias,
          settings.request_emails,
          settings.prayer_emails,
          settings.allow_comments,
          settings.general_emails,
          settings.summary_emails,
          user_family.family_id,
          ("user".timestamp AT TIME ZONE 'UTC' AT TIME ZONE $2) as timestamp,
          (SELECT COUNT(*) FROM public.user_request WHERE user_request.user_id = "user".user_id) as prayer_count,
          (SELECT COUNT(*) FROM public.request WHERE request.user_id = "user".user_id) as request_count
        FROM public."user"
        LEFT JOIN public.settings ON settings.user_id = "user".user_id
        LEFT JOIN public.user_family ON user_family.user_id = "user".user_id
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

// POST /getChatCompletion - OpenAI chat completion endpoint  
app.post('/getChatCompletion', async (req, res) => {
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
app.post('/prayFor', async (req, res) => {
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
      INSERT INTO public.user_request (request_id, user_id) 
      VALUES ($1, $2)
    `;
    
    const insertResult = await pool.query(insertQuery, [params.requestId, params.userId]);
    
    if (insertResult.rowCount === 1) {
      // Step 2: Get request owner information
      const requestOwnerQuery = `
        SELECT 
          "user".real_name, 
          "user".email, 
          "user".picture, 
          request.request_text, 
          settings.prayer_emails 
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
      
      // Return success response with the prayer data
      res.json({
        success: true,
        message: "Prayer recorded successfully",
        data: {
          requestOwner: {
            name: requestOwner?.real_name,
            email: requestOwner?.email,
            requestText: requestOwner?.request_text,
            wantsEmails: requestOwner?.prayer_emails
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

// POST /createRequestAndPrayer - Create a prayer request and generate AI prayer
app.post('/createRequestAndPrayer', async (req, res) => {
  try {
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
        for_me, for_all, active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING request_id
    `;

    const forMe = (params.forMe === "false") ? 0 : 1;
    const forAll = (params.forAll === "false") ? 0 : 1;

    // Build parameters array with all values (null for optional ones)
    const queryParams = [
      params.userId,                          // $1
      params.requestText,                     // $2
      params.requestTitle,                    // $3
      8,                                      // $4 - fk_category_id
      params.otherPerson || null,             // $5
      params.picture || null,                 // $6
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
    const promptToGeneratePrayer = `I want a Catholic prayer to pray for someone named ${realName}, who has the following prayer request: ${params.requestText}.`;
    
    try {
      // Make internal call to our getChatCompletion endpoint
      const chatResponse = await fetch(`http://localhost:${PORT}/getChatCompletion`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: promptToGeneratePrayer })
      });

      const chatResult = await chatResponse.json();

      if (!chatResult.choices || chatResult.choices.length === 0) {
        res.json({ error: "Failed to get a prayer from OpenAI" });
        return;
      }

      const newPrayer = chatResult.choices[0].message.content.replace(/'/g, "");

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