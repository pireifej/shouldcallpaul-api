'use strict';
const express = require('express');

module.exports = function prayersRoutes(ctx) {
  const router = express.Router();
  const { pool, authenticate, generatePrayer, translateText, computeRank, awardBadge, loadFaithRanks, sendGmailSingle, uploadImage, sendPushNotification, prayerAudioCache, MAX_PRAYER_AUDIO_CACHE, PRAYER_AUDIO_DIR, openai, multer, path, fs, log, serveAudioBuffer } = ctx;

router.get('/api/requests', authenticate, async (req, res) => {
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

router.post('/getRequestById', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    if (!params.requestId) {
      return res.json({ error: 1, result: "Required param 'requestId' missing" });
    }
    
    const requestId = params.requestId;
    
    // Get the request with all details
    // Use LEFT JOINs for optional tables to ensure request is found even if related data is missing
    const query = `
      SELECT 
        request.request_id,
        request.user_id,
        COALESCE(CASE WHEN $1='es' THEN request.content_es ELSE request.content_en END, request.request_text) as request_text,
        request.request_title,
        request.picture as request_picture,
        request.my_church_only,
        request.active,
        request.fk_prayer_id,
        request.other_person_email,
        settings.use_alias,
        settings.allow_comments,
        request.timestamp as timestamp,
        "user".user_name,
        "user".real_name,
        "user".picture as user_picture,
        "user".church_id,
        prayers.prayer_title,
        COALESCE(CASE WHEN $1='es' THEN prayers.prayer_es ELSE prayers.prayer_en END, prayers.prayer_text) as prayer_text
      FROM public.request
      LEFT JOIN public."user" ON "user".user_id = request.user_id
      LEFT JOIN public.settings ON settings.user_id = "user".user_id
      LEFT JOIN public.prayers ON prayers.prayer_id = request.fk_prayer_id
      WHERE request.request_id = $2
    `;
    
    const lang = ['en', 'es'].includes(params.lang) ? params.lang : 'en';
    const result = await pool.query(query, [lang, requestId]);
    
    if (result.rows.length === 0) {
      return res.json({ error: 1, result: "Request not found" });
    }
    
    const request = result.rows[0];
    
    // Get prayed_by_names (who prayed for this request)
    const prayedByQuery = `
      SELECT 
        u.user_id,
        COALESCE(u.real_name, u.user_name, 'Anonymous') as name,
        COALESCE(u.profile_picture_url, u.picture) as picture,
        u.faith_points,
        COUNT(*) as pray_count
      FROM public.user_request ur
      INNER JOIN public."user" u ON u.user_id = ur.user_id
      WHERE ur.request_id = $1
      GROUP BY u.user_id, u.real_name, u.user_name, u.profile_picture_url, u.picture, u.faith_points
      ORDER BY pray_count DESC
    `;
    
    const prayedByResult = await pool.query(prayedByQuery, [requestId]);
    
    // Load faith ranks for prayed_by_people
    const ranks = await loadFaithRanks();
    
    // Format prayed_by_names like getCommunityWall
    const prayedByNames = prayedByResult.rows.map(row => {
      const count = parseInt(row.pray_count);
      if (count === 1) {
        return row.name;
      } else if (count === 2) {
        return `${row.name} prayed twice`;
      } else {
        return `${row.name} prayed ${count} times`;
      }
    });
    
    // Format prayed_by_people with name and picture
    const prayedByPeople = prayedByResult.rows.map(row => {
      const count = parseInt(row.pray_count);
      let displayName;
      if (count === 1) {
        displayName = row.name;
      } else if (count === 2) {
        displayName = `${row.name} prayed twice`;
      } else {
        displayName = `${row.name} prayed ${count} times`;
      }
      return {
        name: displayName,
        picture: row.picture,
        faith_points: row.faith_points || 0,
        faith_rank: computeRank(row.faith_points, ranks)
      };
    });
    
    // Check if logged-in user has prayed for this request
    const loggedInUserId = params.userId;
    let userHasPrayed = false;
    if (loggedInUserId) {
      const userHasPrayedQuery = `
        SELECT EXISTS(
          SELECT 1 FROM public.user_request 
          WHERE user_id = $1 AND request_id = $2
        ) as has_prayed
      `;
      const userHasPrayedResult = await pool.query(userHasPrayedQuery, [loggedInUserId, requestId]);
      userHasPrayed = userHasPrayedResult.rows[0]?.has_prayed || false;
    }
    
    // Add prayed_by_names and prayed_by_people to the response
    request.prayed_by_names = prayedByNames;
    request.prayed_by_people = prayedByPeople;
    request.prayer_count = prayedByResult.rows.reduce((sum, row) => sum + parseInt(row.pray_count), 0);
    request.user_has_prayed = userHasPrayed;
    
    res.json({ error: 0, request: request });
    
  } catch (error) {
    console.error('Database query error:', error);
    res.status(500).json({ error: 1, result: 'Internal server error' });
  }
});

// POST /getUser - Get user profile with stats

router.post('/testGeneratePrayer', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    if (!params.requestText) {
      return res.json({ error: "Required param 'requestText' missing" });
    }
    
    // Use the shared generatePrayer function
    const result = await generatePrayer(params.requestText, params.authorName, params.lang || 'en');
    
    if (result.error) {
      return res.json({ error: result.error });
    }

    // Return the generated prayer without storing to database
    res.json({
      success: true,
      requestText: params.requestText,
      authorName: result.authorName,
      generatedPrayer: result.processedPrayer,
      rawPrayer: result.rawPrayer
    });

  } catch (error) {
    console.error('Test prayer generation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /regeneratePrayer - Regenerate prayer for an existing request and update the database
router.post('/regeneratePrayer', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    // Validate required parameters
    if (!params.requestId) {
      return res.json({ error: "Required param 'requestId' missing" });
    }
    
    const requestId = params.requestId;
    
    // Step 1: Get the request details from database (LEFT JOIN to handle requests without users)
    const requestQuery = `
      SELECT r.request_text, r.user_id, u.real_name, u.user_name
      FROM public.request r
      LEFT JOIN public."user" u ON r.user_id = u.user_id
      WHERE r.request_id = $1
    `;
    
    const requestResult = await pool.query(requestQuery, [requestId]);
    
    if (requestResult.rows.length === 0) {
      return res.json({ error: "Request not found" });
    }
    
    const requestText = requestResult.rows[0].request_text;
    const realName = requestResult.rows[0].real_name || requestResult.rows[0].user_name || "Someone";
    
    // Step 2: Generate prayer using shared function
    const prayerGenResult = await generatePrayer(requestText, realName, params.lang || 'en');
    
    if (prayerGenResult.error) {
      return res.json({ error: prayerGenResult.error });
    }

    const newPrayer = prayerGenResult.processedPrayer;

    // Step 3: Insert the new prayer into prayers table
    const prayerInsertQuery = `
      INSERT INTO public.prayers (prayer_title, prayer_text, prayer_text_me, tags, active, prayer_file_name) 
      VALUES ($1, $2, $3, $4, $5, $6) 
      RETURNING prayer_id
    `;

    const dbInsertResult = await pool.query(prayerInsertQuery, [
      'openAI-generated',
      newPrayer,
      newPrayer,
      'openAI',
      1,
      'openAI'
    ]);

    const prayerId = dbInsertResult.rows[0].prayer_id;

    // Step 5: Update the request with the new prayer ID
    const updateQuery = `
      UPDATE public.request 
      SET fk_prayer_id = $1 
      WHERE request_id = $2
    `;

    await pool.query(updateQuery, [prayerId, requestId]);

    // Step 6: Return success response
    res.json({
      success: true,
      requestId: requestId,
      prayerId: prayerId,
      authorName: realName,
      requestText: requestText,
      prayer: newPrayer
    });

  } catch (error) {
    console.error('Regenerate prayer error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /prayFor - Record when someone prays for a request

router.post('/prayFor', authenticate, async (req, res) => {
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
      // Award 1 faith point to the user who prayed
      await pool.query('UPDATE public."user" SET faith_points = faith_points + 1 WHERE user_id = $1', [params.userId]);
      
      // Step 2: Get request owner information
      const requestOwnerQuery = `
        SELECT 
          "user".user_id,
          "user".real_name, 
          "user".email,
          "user".email_bounced,
          "user".picture,
          "user".fcm_token, 
          request.request_text,
          request.request_title, 
          settings.prayer_emails,
          settings.push_notifications 
        FROM public.request 
        INNER JOIN public."user" ON "user".user_id = request.user_id 
        LEFT JOIN public.settings ON settings.user_id = request.user_id 
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
      if (requestOwner?.prayer_emails && requestOwner?.email && !requestOwner?.email_bounced) {
        try {
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
    .quote-box { background-color: #f0f4ff; border-left: 4px solid #667eea; padding: 14px 16px; margin: 20px 0; border-radius: 0 6px 6px 0; font-style: italic; color: #444; }
    .button-container { text-align: center; margin: 30px 0; padding: 20px 0; }
    .button { display: inline-block; padding: 14px 40px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; border-radius: 25px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); }
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
      <p>Hi ${requestOwner.real_name},</p>
      <p>🙏 <strong>${userWhoPrayed.real_name}</strong> just prayed for your request:</p>
      <div class="quote-box">"${requestOwner.request_text}"</div>
      <p>You are not alone. The Pray Over Us community is standing with you.</p>
      <p>Blessings,<br>The Pray Over Us Team</p>
    </div>
    <div class="button-container">
      <a href="https://www.prayoverus.com" class="button">Open the App</a>
    </div>
    <div class="footer">
      <p>You received this because you have prayer email notifications enabled.</p>
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
            email: requestOwner.email, 
            name: requestOwner.real_name 
          };
          
          const subject = `${userWhoPrayed.real_name} prayed for your request`;
          
          emailResult = await sendGmailSingle(emailTemplate, fromPerson, toPerson, subject, null, null);
          console.log('Prayer notification email sent:', emailResult);
        } catch (emailError) {
          console.error('Failed to send prayer notification email:', emailError);
          emailResult = { error: 1, result: emailError.message };
        }
      }
      
      // Step 5: Send push notification if the request owner has an Expo token and wants push notifications
      let pushResult = { success: false };
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
          
          console.log('Prayer notification push result:', pushResult);
          
          // Remove invalid/expired tokens from database
          if (pushResult.shouldRemoveToken) {
            await pool.query(
              'UPDATE public."user" SET fcm_token = NULL WHERE user_id = $1',
              [requestOwner.user_id]
            );
            console.log(`🗑️  Removed invalid Expo token for user ${requestOwner.user_id}`);
          }
        } catch (pushError) {
          console.error('Failed to send prayer notification push:', pushError);
          pushResult = { success: false, error: pushError.message };
        }
      }
      
      // Badge checks (fire-and-forget — errors never block the response)
      let newBadge = null;
      try {
        const uid = params.userId;
        const utcHour = new Date().getUTCHours();

        // first_responder: one of first 3 to pray on this request
        const prayCountRes = await pool.query(
          'SELECT COUNT(*) FROM public.user_request WHERE request_id = $1', [params.requestId]
        );
        if (parseInt(prayCountRes.rows[0].count) <= 3) {
          newBadge = await awardBadge(uid, 'first_responder') || newBadge;
        }

        // total pray count — reused for first_step, the_encourager, intercessor
        const totalPrayRes = await pool.query(
          'SELECT COUNT(*) FROM public.user_request WHERE user_id = $1', [uid]
        );
        const totalPrays = parseInt(totalPrayRes.rows[0].count);

        // first_step: very first prayer
        if (totalPrays === 1) {
          newBadge = await awardBadge(uid, 'first_step') || newBadge;
        }

        // the_encourager: 25+ distinct requests prayed for
        if (totalPrays >= 25) {
          newBadge = await awardBadge(uid, 'the_encourager') || newBadge;
        }

        // intercessor: 50+ total prayers
        if (totalPrays >= 50) {
          newBadge = await awardBadge(uid, 'intercessor') || newBadge;
        }

        // the_welcome_mat: prayed for requests from 5+ distinct people
        const distinctPeopleRes = await pool.query(
          `SELECT COUNT(DISTINCT r.user_id) AS cnt
           FROM public.user_request ur
           JOIN public.request r ON r.request_id = ur.request_id
           WHERE ur.user_id = $1`,
          [uid]
        );
        if (parseInt(distinctPeopleRes.rows[0].cnt) >= 5) {
          newBadge = await awardBadge(uid, 'the_welcome_mat') || newBadge;
        }

        // faithful_friend: prayed for the same person's requests 3+ times
        const faithfulRes = await pool.query(
          `SELECT COUNT(ur.request_id) AS pray_count
           FROM public.user_request ur
           JOIN public.request r ON r.request_id = ur.request_id
           WHERE ur.user_id = $1
           GROUP BY r.user_id
           ORDER BY pray_count DESC
           LIMIT 1`,
          [uid]
        );
        if (faithfulRes.rows.length > 0 && parseInt(faithfulRes.rows[0].pray_count) >= 3) {
          newBadge = await awardBadge(uid, 'faithful_friend') || newBadge;
        }

        // midnight_intercessor: 5+ prayers between 11 PM–4 AM UTC
        if (utcHour >= 23 || utcHour < 4) {
          const nightRes = await pool.query(
            `SELECT COUNT(*) FROM public.user_request WHERE user_id = $1
             AND (EXTRACT(HOUR FROM timestamp) >= 23 OR EXTRACT(HOUR FROM timestamp) < 4)`,
            [uid]
          );
          if (parseInt(nightRes.rows[0].count) >= 5) {
            newBadge = await awardBadge(uid, 'midnight_intercessor') || newBadge;
          }
        }

        // night_owl: 10+ prayers between midnight and 4 AM UTC
        if (utcHour < 4) {
          const nightOwlRes = await pool.query(
            `SELECT COUNT(*) FROM public.user_request WHERE user_id = $1
             AND EXTRACT(HOUR FROM timestamp) < 4`,
            [uid]
          );
          if (parseInt(nightOwlRes.rows[0].count) >= 10) {
            newBadge = await awardBadge(uid, 'night_owl') || newBadge;
          }
        }

        // early_riser: 5+ prayers before 7 AM UTC
        if (utcHour < 7) {
          const earlyRes = await pool.query(
            `SELECT COUNT(*) FROM public.user_request WHERE user_id = $1
             AND EXTRACT(HOUR FROM timestamp) < 7`,
            [uid]
          );
          if (parseInt(earlyRes.rows[0].count) >= 5) {
            newBadge = await awardBadge(uid, 'early_riser') || newBadge;
          }
        }

        // weekend_warrior: prayed on both Saturday AND Sunday within the same 7-day window
        const weekendRes = await pool.query(
          `SELECT
             COUNT(DISTINCT DATE(timestamp)) FILTER (WHERE EXTRACT(DOW FROM timestamp) = 6) AS sat_days,
             COUNT(DISTINCT DATE(timestamp)) FILTER (WHERE EXTRACT(DOW FROM timestamp) = 0) AS sun_days
           FROM public.user_request
           WHERE user_id = $1 AND timestamp >= NOW() - INTERVAL '7 days'`,
          [uid]
        );
        if (parseInt(weekendRes.rows[0].sat_days) >= 1 && parseInt(weekendRes.rows[0].sun_days) >= 1) {
          newBadge = await awardBadge(uid, 'weekend_warrior') || newBadge;
        }

        // steadfast: prayed on each of at least 7 distinct days in the last 7 days
        const steadfastRes = await pool.query(
          `SELECT COUNT(DISTINCT DATE(timestamp AT TIME ZONE 'UTC')) AS day_count
           FROM public.user_request
           WHERE user_id = $1 AND timestamp >= NOW() - INTERVAL '7 days'`,
          [uid]
        );
        if (parseInt(steadfastRes.rows[0].day_count) >= 7) {
          newBadge = await awardBadge(uid, 'steadfast') || newBadge;
        }

        // global_heart: prayed for requests from 3+ distinct churches
        const churchRes = await pool.query(
          `SELECT COUNT(DISTINCT u.church_id) AS cnt
           FROM public.user_request ur
           JOIN public.request r ON r.request_id = ur.request_id
           JOIN public."user" u ON u.user_id = r.user_id
           WHERE ur.user_id = $1 AND u.church_id IS NOT NULL`,
          [uid]
        );
        if (parseInt(churchRes.rows[0].cnt) >= 3) {
          newBadge = await awardBadge(uid, 'global_heart') || newBadge;
        }

        // shepherds_heart: prayed for requests from every church in the app
        const shepherdRes = await pool.query(
          `SELECT
             (SELECT COUNT(DISTINCT church_id) FROM public."user" WHERE church_id IS NOT NULL) AS total_churches,
             COUNT(DISTINCT u.church_id) AS prayed_churches
           FROM public.user_request ur
           JOIN public.request r ON r.request_id = ur.request_id
           JOIN public."user" u ON u.user_id = r.user_id
           WHERE ur.user_id = $1 AND u.church_id IS NOT NULL`,
          [uid]
        );
        const totalChurches = parseInt(shepherdRes.rows[0].total_churches);
        const prayedChurches = parseInt(shepherdRes.rows[0].prayed_churches);
        if (totalChurches > 0 && prayedChurches >= totalChurches) {
          newBadge = await awardBadge(uid, 'shepherds_heart') || newBadge;
        }
      } catch (badgeErr) {
        console.warn('Badge check failed (non-blocking):', badgeErr.message);
      }

      // Return success response with the prayer data
      res.json({
        success: true,
        message: "Prayer recorded successfully",
        emailSent: emailResult?.error === 0,
        pushSent: pushResult.success === true,
        new_badge: newBadge,
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

// Spam detection function
function isSpam(text) {
  if (!text || typeof text !== 'string') return false;
  
  // Check for random gibberish strings (high consonant ratio, no real words)
  const gibberishPattern = /[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ]{6,}/;
  if (gibberishPattern.test(text)) {
    return { isSpam: true, reason: 'Contains random character strings' };
  }
  
  // Check for excessive random uppercase/lowercase mixing within words
  const mixedCaseGibberish = /[A-Z][a-z][A-Z][a-z][A-Z]/;
  if (mixedCaseGibberish.test(text)) {
    return { isSpam: true, reason: 'Suspicious text pattern detected' };
  }
  
  // Check for strings that look like random IDs (letters + numbers in weird patterns)
  const randomIdPattern = /[A-Za-z]{3,}[0-9]{2,}[A-Za-z]{2,}|[0-9]{2,}[A-Za-z]{3,}[0-9]{2,}/;
  if (randomIdPattern.test(text)) {
    return { isSpam: true, reason: 'Contains suspicious ID-like strings' };
  }
  
  // Check ratio of consonants to vowels (gibberish tends to have very few vowels)
  const vowels = (text.match(/[aeiouAEIOU]/g) || []).length;
  const consonants = (text.match(/[bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ]/g) || []).length;
  if (consonants > 0 && vowels > 0 && consonants / vowels > 4) {
    return { isSpam: true, reason: 'Text has unusual character distribution' };
  }
  
  // Check for very long "words" without spaces (likely gibberish)
  const longWordPattern = /\S{25,}/;
  if (longWordPattern.test(text)) {
    return { isSpam: true, reason: 'Contains unusually long strings' };
  }
  
  return { isSpam: false };
}

// Configure multer for prayer image uploads - use memory storage for security
const prayerImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('That image format isn\'t supported. Please use a photo from your camera roll.'));
    }
  }
});

// POST /editRequest - Edit an existing prayer request (author only)
router.post('/editRequest', authenticate, (req, res) => {
  const contentType = req.get('Content-Type') || '';
  
  if (contentType.includes('multipart/form-data')) {
    prayerImageUpload.single('picture')(req, res, async (err) => {
      await handleEditRequest(req, res, err);
    });
  } else {
    handleEditRequest(req, res, null);
  }
});

async function handleEditRequest(req, res, multerError) {
  try {
    if (multerError) {
      if (multerError.code === 'LIMIT_FILE_SIZE') {
        return res.json({ error: 1, result: 'Image size exceeds 5MB limit' });
      }
      if (multerError.message.includes('image format')) {
        return res.json({ error: 1, result: multerError.message });
      }
      console.error('Image upload error:', multerError);
      return res.json({ error: 1, result: 'Failed to upload image' });
    }
    
    const params = req.body;
    
    if (!params.requestId || !params.userId) {
      return res.json({ 
        error: 1, 
        result: "Required params 'requestId' and 'userId' missing" 
      });
    }
    
    const hasRequestText = params.requestText !== undefined && params.requestText !== null;
    const hasRequestTitle = params.requestTitle !== undefined && params.requestTitle !== null;
    const hasNewPicture = req.file && req.file.buffer;
    const removePicture = params.removePicture === true || params.removePicture === 'true';
    
    if (!hasRequestText && !hasRequestTitle && !hasNewPicture && !removePicture) {
      return res.json({ 
        error: 1, 
        result: "At least one field to update is required (requestText, requestTitle, picture, or removePicture)" 
      });
    }
    
    const ownershipQuery = `
      SELECT user_id, request_title, picture 
      FROM public.request 
      WHERE request_id = $1
    `;
    
    const ownershipResult = await pool.query(ownershipQuery, [params.requestId]);
    
    if (ownershipResult.rows.length === 0) {
      return res.json({ error: 1, result: "Prayer request not found" });
    }
    
    const requestOwnerId = ownershipResult.rows[0].user_id;
    
    if (requestOwnerId !== parseInt(params.userId)) {
      return res.json({ error: 1, result: "You can only edit your own prayer requests" });
    }
    
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const urlPattern = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.(com|org|net|edu|gov|io|co|us|info|biz|me|app|dev|ai|tech|online|site|xyz|uk|ca|au|de|fr|in|br|jp|ru|cn|it|es|nl|se|no|dk|fi|pl|be|ch|at|cz|gr|pt|ie|nz|sg|hk|my|za|mx|ar|cl|pe|ve|co\.uk|co\.in|co\.jp|co\.nz|co\.za|ca\.gov|ac\.uk|edu\.au|gov\.uk|org\.uk|net\.au|gov\.au))\b/i;
    
    if (hasRequestText) {
      if (emailPattern.test(params.requestText)) {
        return res.json({ error: 1, result: "Prayer requests cannot contain email addresses. Please remove any email addresses and try again." });
      }
      if (urlPattern.test(params.requestText)) {
        return res.json({ error: 1, result: "Prayer requests cannot contain website links or URLs. Please remove any web addresses and try again." });
      }
    }
    
    if (hasRequestTitle) {
      if (emailPattern.test(params.requestTitle)) {
        return res.json({ error: 1, result: "Prayer request titles cannot contain email addresses. Please remove any email addresses and try again." });
      }
      if (urlPattern.test(params.requestTitle)) {
        return res.json({ error: 1, result: "Prayer request titles cannot contain website links or URLs. Please remove any web addresses and try again." });
      }
    }
    
    const setClauses = [];
    const queryParams = [];
    let paramIndex = 1;
    
    if (hasRequestText) {
      setClauses.push(`request_text = $${paramIndex}`);
      queryParams.push(params.requestText);
      paramIndex++;
    }
    
    if (hasRequestTitle) {
      setClauses.push(`request_title = $${paramIndex}`);
      queryParams.push(params.requestTitle);
      paramIndex++;
    }
    
    if (hasNewPicture) {
      try {
        const pictureUrl = await uploadImage(req.file.buffer, 'prayer-app/prayer-images');
        console.log(`✅ Prayer image uploaded to Cloudinary: ${pictureUrl}`);
        setClauses.push(`picture = $${paramIndex}`);
        queryParams.push(pictureUrl);
        paramIndex++;
      } catch (imageError) {
        console.error('Error uploading prayer image to Cloudinary:', imageError);
        return res.json({ error: 1, result: 'Failed to upload image' });
      }
    } else if (removePicture) {
      setClauses.push(`picture = NULL`);
    }
    
    setClauses.push('updated_timestamp = NOW()');
    
    queryParams.push(params.requestId);
    
    const updateQuery = `
      UPDATE public.request 
      SET ${setClauses.join(', ')} 
      WHERE request_id = $${paramIndex}
      RETURNING request_id, request_text, request_title, picture, updated_timestamp
    `;
    
    const updateResult = await pool.query(updateQuery, queryParams);
    
    if (updateResult.rows.length === 0) {
      return res.json({ error: 1, result: "Failed to update prayer request" });
    }
    
    console.log(`✅ Prayer request ${params.requestId} edited by user ${params.userId}`);
    
    res.json({ 
      error: 0, 
      result: "Prayer request updated successfully",
      data: {
        requestId: updateResult.rows[0].request_id,
        requestText: updateResult.rows[0].request_text,
        requestTitle: updateResult.rows[0].request_title,
        picture: updateResult.rows[0].picture,
        updatedTimestamp: updateResult.rows[0].updated_timestamp
      }
    });
    
  } catch (error) {
    console.error('Error in /editRequest endpoint:', error);
    res.json({ error: 1, result: error.message || 'Internal server error' });
  }
}

// POST /createRequestAndPrayer - Create a prayer request and generate AI prayer
router.post('/createRequestAndPrayer', authenticate, (req, res) => {
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
  try {
    // Handle multer errors for image uploads
    if (multerError) {
      if (multerError.code === 'LIMIT_FILE_SIZE') {
        return res.json({ error: 1, result: 'Image size exceeds 5MB limit' });
      }
      
      if (multerError.message.includes('image format')) {
        return res.json({ error: 1, result: multerError.message });
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

    // Validate that request doesn't contain email addresses or websites
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const urlPattern = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.(com|org|net|edu|gov|io|co|us|info|biz|me|app|dev|ai|tech|online|site|xyz|uk|ca|au|de|fr|in|br|jp|ru|cn|it|es|nl|se|no|dk|fi|pl|be|ch|at|cz|gr|pt|ie|nz|sg|hk|my|za|mx|ar|cl|pe|ve|co\.uk|co\.in|co\.jp|co\.nz|co\.za|ca\.gov|ac\.uk|edu\.au|gov\.uk|org\.uk|net\.au|gov\.au))\b/i;
    
    const requestText = params.requestText || '';
    const requestTitle = params.requestTitle || '';
    
    if (emailPattern.test(requestText) || emailPattern.test(requestTitle)) {
        return res.json({ 
            error: 1, 
            result: "Prayer requests cannot contain email addresses. Please remove any email addresses and try again." 
        });
    }
    
    if (urlPattern.test(requestText) || urlPattern.test(requestTitle)) {
        return res.json({ 
            error: 1, 
            result: "Prayer requests cannot contain website links or URLs. Please remove any web addresses and try again." 
        });
    }

    // Step 1: Insert the request into the database (simplified approach)
    const lang = ['en', 'es'].includes(params.lang) ? params.lang : 'en';

    const insertQuery = `
      INSERT INTO public.request (
        user_id, request_text, request_title, picture, fk_prayer_id,
        other_person_email, active, my_church_only, timestamp, updated_timestamp,
        content_en, content_es
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), $9, $10)
      RETURNING request_id
    `;

    const myChurchOnly = (params.myChurchOnly === true || params.myChurchOnly === "true") ? true : false;
    
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
      pictureUrl,                             // $4
      params.prayerId || null,                // $5
      params.otherPersonEmail || null,        // $6
      1,                                      // $7 - active (1 for true in smallint)
      myChurchOnly,                           // $8 - my_church_only flag
      lang === 'en' ? params.requestText : null,  // $9 - content_en
      lang === 'es' ? params.requestText : null   // $10 - content_es
    ];

    const insertResult = await pool.query(insertQuery, queryParams);
    const requestId = insertResult.rows[0].request_id;
    
    // Save uploaded image file to Cloudinary if present
    if (req.file && req.file.buffer) {
      try {
        // Upload to Cloudinary for persistence across deployments
        pictureUrl = await uploadImage(
          req.file.buffer,
          'prayer-app/prayer-images'
        );
        
        console.log(`✅ Prayer image uploaded to Cloudinary: ${pictureUrl}`);
        
        // Update the request with the actual image URL
        const updatePictureQuery = `UPDATE public.request SET picture = $1 WHERE request_id = $2`;
        await pool.query(updatePictureQuery, [pictureUrl, requestId]);
        
      } catch (imageError) {
        console.error('Error saving prayer image to Cloudinary:', imageError);
        // Reset picture to NULL on upload failure so clients don't get broken placeholder URL
        pictureUrl = null;
        const updatePictureQuery = `UPDATE public.request SET picture = NULL WHERE request_id = $1`;
        await pool.query(updatePictureQuery, [requestId]);
        // Continue without image - don't fail the whole request, but log the error
        console.warn(`⚠️ Prayer request ${requestId} created without image due to storage error`);
      }
    }

    // Award faith points: 5 if request has a picture, 3 if no picture
    const hasImage = pictureUrl && pictureUrl !== null && pictureUrl !== 'PENDING_IMAGE_UPLOAD';
    const faithPointsToAward = hasImage ? 5 : 3;
    await pool.query('UPDATE public."user" SET faith_points = faith_points + $1 WHERE user_id = $2', [faithPointsToAward, params.userId]);

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

    // Step 3: Generate prayer using shared function
    try {
      const prayerGenResult = await generatePrayer(params.requestText, realName, params.lang || 'en');
      
      if (prayerGenResult.error) {
        res.json({ error: prayerGenResult.error });
        return;
      }

      const newPrayer = prayerGenResult.processedPrayer;

      // Step 4: Insert the generated prayer
      const prayerInsertQuery = `
        INSERT INTO public.prayers (prayer_title, prayer_text, prayer_text_me, tags, active, prayer_file_name, prayer_en, prayer_es) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
        RETURNING prayer_id
      `;

      const dbInsertResult = await pool.query(prayerInsertQuery, [
        'openAI-generated',
        newPrayer,
        newPrayer,
        'openAI',
        1,          // active field is smallint, use 1 instead of true
        'openAI',
        lang === 'en' ? newPrayer : null,  // prayer_en
        lang === 'es' ? newPrayer : null   // prayer_es
      ]);

      const prayerId = dbInsertResult.rows[0].prayer_id;

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
        message: "Prayer shared with the community"
      });

      // Badge checks for posting a prayer request (fire-and-forget)
      Promise.resolve().then(async () => {
        try {
          // prolific: 10+ prayer requests posted
          const requestCountRes = await pool.query(
            `SELECT COUNT(*) FROM public.request WHERE user_id = $1`, [params.userId]
          );
          if (parseInt(requestCountRes.rows[0].count) >= 10) {
            await awardBadge(params.userId, 'prolific');
          }

          // prayer_gallery: 5+ requests posted with images
          const imageCountRes = await pool.query(
            `SELECT COUNT(*) FROM public.request WHERE user_id = $1 AND picture IS NOT NULL`, [params.userId]
          );
          if (parseInt(imageCountRes.rows[0].count) >= 5) {
            await awardBadge(params.userId, 'prayer_gallery');
          }
        } catch (badgeErr) {
          console.warn('Post-request badge check failed:', badgeErr.message);
        }
      });

      // Async: translate request text and prayer to the other language (fire-and-forget)
      const otherLang = lang === 'es' ? 'en' : 'es';
      translateText(params.requestText, lang, otherLang, 'text').then(translatedText => {
        const col = otherLang === 'es' ? 'content_es' : 'content_en';
        return pool.query(`UPDATE public.request SET ${col} = $1 WHERE request_id = $2`, [translatedText, requestId]);
      }).catch(e => console.error(`Request text translation error (request ${requestId}):`, e.message));

      translateText(newPrayer, lang, otherLang, 'prayer_html').then(translatedPrayer => {
        const col = otherLang === 'es' ? 'prayer_es' : 'prayer_en';
        return pool.query(`UPDATE public.prayers SET ${col} = $1 WHERE prayer_id = $2`, [translatedPrayer, prayerId]);
      }).catch(e => console.error(`Prayer translation error (prayer ${prayerId}):`, e.message));

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
          <div style="margin: 30px 0; text-align: center;">
            <a href="https://prayoverus.com/index.html?requestId=${requestId}" 
               style="display: inline-block; background-color: #3498db; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">
              View Request
            </a>
          </div>
          <hr style="border: 1px solid #eee; margin: 20px 0;">
          <p style="color: #7f8c8d; font-size: 12px;">
            This is an automated notification from PrayOverUs.com
          </p>
        </div>
      `;

      const fromPerson = { 
        email: "prayoverus@gmail.com", 
        name: "PrayOverUs Notifications" 
      };
      
      const toPerson = {
        email: "prayoverus@gmail.com",
        name: "Paul"
      };

      sendGmailSingle(
        notificationHtml,
        fromPerson,
        toPerson,
        `New Prayer Request: ${params.requestTitle}`,
        null,
        null
      ).catch(emailError => {
        console.error('Admin notification email failed:', emailError);
      });

      // Send push notifications to all users (except the poster)
      try {
        const allUsersQuery = `
          SELECT user_id, fcm_token, real_name
          FROM public."user"
          WHERE fcm_token IS NOT NULL
            AND user_id != $1
        `;
        const allUsersResult = await pool.query(allUsersQuery, [params.userId]);
        
        if (allUsersResult.rows.length > 0) {
          console.log(`📢 Sending new request notifications to ${allUsersResult.rows.length} users`);
          
          const notificationTitle = "New Prayer Request 🙏";
          const notificationBody = `${realName} shared a prayer request`;
          const notificationData = {
            type: 'new_request',
            requestId: requestId.toString(),
            posterName: realName
          };
          
          // Send notifications to each user (could batch for large numbers)
          for (const user of allUsersResult.rows) {
            try {
              const pushResult = await sendPushNotification(
                user.fcm_token,
                notificationTitle,
                notificationBody,
                notificationData
              );
              
              // Remove invalid tokens
              if (pushResult.shouldRemoveToken) {
                await pool.query(
                  'UPDATE public."user" SET fcm_token = NULL WHERE user_id = $1',
                  [user.user_id]
                );
                console.log(`🗑️ Removed invalid token for user ${user.user_id}`);
              }
            } catch (pushError) {
              console.error(`Failed to send notification to user ${user.user_id}:`, pushError);
            }
          }
        }
      } catch (notifyError) {
        console.error('Error sending new request notifications:', notifyError);
      }

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

router.post('/addComment', authenticate, async (req, res) => {
  try {
    const { userId, requestId, comment } = req.body;
    if (!userId) return res.json({ error: 1, result: "Required param 'userId' missing" });
    if (!requestId) return res.json({ error: 1, result: "Required param 'requestId' missing" });
    if (!comment || !comment.trim()) return res.json({ error: 1, result: "Required param 'comment' missing" });

    await pool.query(
      `INSERT INTO public.comments (user_id, request_id, comment, timestamp) VALUES ($1, $2, $3, NOW())`,
      [userId, requestId, comment.trim()]
    );

    res.json({ error: 0, result: "Comment added" });

  } catch (error) {
    console.error('Error in /addComment:', error);
    res.json({ error: 1, result: "Internal server error: " + error.message });
  }
});


router.post('/getPrayerByRequestId', authenticate, async (req, res) => {
  log(req);
  const params = req.body;

  const requiredParam = "requestId";
  if (!params[requiredParam]) {
    res.json({ error: "Required param '" + requiredParam + "' missing" });
    return;
  }

  try {
    const lang = ['en', 'es'].includes(params.lang) ? params.lang : 'en';

    const query = `
      SELECT COALESCE(
        CASE WHEN $1='es' THEN p.prayer_es ELSE p.prayer_en END,
        p.prayer_text
      ) as prayer_text
      FROM public.request r
      INNER JOIN public.prayers p ON r.fk_prayer_id = p.prayer_id
      WHERE r.request_id = $2
    `;

    const result = await pool.query(query, [lang, params.requestId]);

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
    res.json({ error: 1, result: "Database error: " + err.message });
  }
});

// POST /getPrayerAudio - Generate (or serve cached) TTS audio for a prayer request
router.post('/getPrayerAudio', authenticate, async (req, res) => {
  try {
    const { requestId, text } = req.body;
    if (!requestId) return res.status(400).json({ message: "requestId is required" });
    if (!text) return res.status(400).json({ message: "text is required" });

    const key = String(requestId);

    // 1. In-memory cache
    if (prayerAudioCache.has(key)) {
      console.log(`🔊 Prayer audio cache hit for requestId ${key}`);
      return serveAudioBuffer(req, res, prayerAudioCache.get(key));
    }

    // 2. Disk cache
    const audioPath = path.join(PRAYER_AUDIO_DIR, `prayer_${key}.mp3`);
    if (fs.existsSync(audioPath)) {
      console.log(`🔊 Prayer audio served from disk for requestId ${key}`);
      const audioBuffer = fs.readFileSync(audioPath);
      if (prayerAudioCache.size >= MAX_PRAYER_AUDIO_CACHE) {
        prayerAudioCache.delete(prayerAudioCache.keys().next().value);
      }
      prayerAudioCache.set(key, audioBuffer);
      return serveAudioBuffer(req, res, audioBuffer);
    }

    // 3. Generate, save, serve
    console.log(`🔊 Generating prayer audio for requestId ${key} (${text.length} chars)...`);
    const ttsResponse = await openai.audio.speech.create({
      model: 'tts-1-hd',
      voice: 'nova',
      input: text.slice(0, 4000),
      response_format: 'mp3'
    });

    const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
    fs.writeFileSync(audioPath, audioBuffer);
    if (prayerAudioCache.size >= MAX_PRAYER_AUDIO_CACHE) {
      prayerAudioCache.delete(prayerAudioCache.keys().next().value);
    }
    prayerAudioCache.set(key, audioBuffer);
    console.log(`🔊 Prayer audio saved for requestId ${key} (${audioBuffer.length} bytes)`);

    serveAudioBuffer(req, res, audioBuffer);

  } catch (error) {
    console.error('Prayer audio generation error:', error);
    res.status(500).json({ message: "Failed to generate audio" });
  }
});

// POST /getDetailedPrayerByRequestId - Get or generate a longer detailed prayer for a request

router.post('/getDetailedPrayerByRequestId', authenticate, async (req, res) => {
  try {
    const { requestId, lang = 'en' } = req.body;
    if (!requestId) return res.json({ error: 1, result: "Required param 'requestId' missing" });

    const cacheCol = lang === 'es' ? 'detailed_prayer_es' : 'detailed_prayer';

    // Check DB cache first
    const cacheCheck = await pool.query(
      `SELECT ${cacheCol} FROM public.request WHERE request_id = $1`,
      [requestId]
    );

    if (cacheCheck.rows.length === 0) {
      return res.json({ error: 1, result: "Request not found" });
    }

    if (cacheCheck.rows[0][cacheCol]) {
      return res.json({ error: 0, result: cacheCheck.rows[0][cacheCol] });
    }

    // Fetch request text + author name for generation
    const dataQuery = await pool.query(
      `SELECT r.request_text, u.real_name
       FROM public.request r
       JOIN public."user" u ON r.user_id = u.user_id
       WHERE r.request_id = $1`,
      [requestId]
    );

    if (dataQuery.rows.length === 0) {
      return res.json({ error: 1, result: "Request not found" });
    }

    const { request_text, real_name } = dataQuery.rows[0];
    const authorName = real_name || "Someone";
    const spanishInstruction = lang === 'es'
      ? '\n\nIMPORTANT: Write this entire prayer in Spanish (Latin American Spanish). Every word must be in Spanish.'
      : '';

    const prompt = `You are an expert prayer writer composing a rich, extended Catholic-style intercessory prayer.

Prayer Request: ${request_text}
Submitted by: ${authorName}

Write a detailed prayer in 4 sections:
1. Opening — Address God/Jesus/Mary reverently, acknowledge His power and love (1 paragraph)
2. Intercession — Specifically pray for the person and need mentioned, using their name or relationship (1 paragraph)
3. Scripture-inspired section — Draw on a relevant scriptural theme (e.g. healing, strength, peace, trust) without quoting chapter/verse directly (1 paragraph)
4. Closing — A confident, surrendering conclusion that trusts in God's will (1 paragraph)

Rules:
- Use markdown-style bold (**text**) for all names (including divine names: God, Lord, Jesus, Holy Spirit, Mary, Father) and key intercession words (heal, protect, guide, bless, comfort, strengthen, peace, grace, mercy, love, hope, faith, wisdom, courage).
- DO NOT invent names not in the request text. Use possessive phrases (e.g. "${authorName}'s mother") instead.
- Do NOT end with "Amen".
- Total length: 180–220 words.
- Output plain text with a blank line between each section.${spanishInstruction}`;

    const chatResponse = await fetch(`http://localhost:${PORT}/getChatCompletion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization },
      body: JSON.stringify({ content: prompt })
    });

    const chatResult = await chatResponse.json();

    if (!chatResult.choices || chatResult.choices.length === 0) {
      return res.json({ error: 1, result: "Prayer generation failed. Please try again." });
    }

    const detailedPrayer = chatResult.choices[0].message.content.trim();

    // Cache in DB (language-specific column)
    await pool.query(
      `UPDATE public.request SET ${cacheCol} = $1 WHERE request_id = $2`,
      [detailedPrayer, requestId]
    );

    res.json({ error: 0, result: detailedPrayer });

  } catch (error) {
    console.error('Error in /getDetailedPrayerByRequestId:', error);
    res.json({ error: 1, result: "Internal server error: " + error.message });
  }
});

// POST /getPrayedFor - Get all requests that a user has prayed for
router.post('/getPrayedFor', authenticate, async (req, res) => {
  try {
    log(req);
    const params = req.body;
    
    // Validate required parameters
    const requiredParams = ["userId"];
    for (let i = 0; i < requiredParams.length; i++) {
      const requiredParam = requiredParams[i];
      if (!params[requiredParam]) {
        return res.json({error: 1, result: "Required params '" + requiredParam + "' missing"});
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

// POST /getMyRequests - Get all of user's own prayer requests (active, answered, and archived)
router.post('/getMyRequests', authenticate, async (req, res) => {
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
    const query = `
      SELECT DISTINCT 
        request.request_id,
        request.user_id,
        request.active,
        COALESCE(CASE WHEN $2='es' THEN request.content_es ELSE request.content_en END, request.request_text) as request_text,
        request.fk_prayer_id,
        prayers.prayer_title,
        request.request_title,
        request.picture as request_picture,
        settings.use_alias,
        settings.allow_comments,
        request.timestamp as timestamp,
        request.timestamp as timestamp_raw,
        "user".user_name,
        "user".real_name,
        "user".picture,
        "user".church_id
      FROM public.request
      INNER JOIN public."user" ON "user".user_id = request.user_id
      LEFT JOIN public.settings ON settings.user_id = "user".user_id
      LEFT JOIN public.prayers ON prayers.prayer_id = request.fk_prayer_id
      WHERE request.user_id = $1
      ORDER BY timestamp_raw DESC
    `;

    const lang = ['en', 'es'].includes(params.lang) ? params.lang : 'en';
    const result = await pool.query(query, [params.userId, lang]);
    res.json(result.rows);

  } catch (err) {
    console.error('Database query error:', err);
    res.json({ error: 1, result: "Database error: " + err.message });
  }
});

// POST /getAnsweredPrayers - Get user's own answered prayer requests (active = 2)
router.post('/getAnsweredPrayers', authenticate, async (req, res) => {
  log(req);
  const params = req.body;

  if (!params.userId) {
    return res.json({ error: 1, result: "Required params 'userId' missing" });
  }

  try {
    const query = `
      SELECT DISTINCT
        request.request_id,
        request.user_id,
        COALESCE(CASE WHEN $2='es' THEN request.content_es ELSE request.content_en END, request.request_text) as request_text,
        request.fk_prayer_id,
        prayers.prayer_title,
        request.request_title,
        request.picture as request_picture,
        request.answered_message,
        settings.use_alias,
        settings.allow_comments,
        request.timestamp as timestamp,
        request.timestamp as timestamp_raw,
        "user".user_name,
        "user".real_name,
        "user".picture,
        "user".church_id
      FROM public.request
      INNER JOIN public."user" ON "user".user_id = request.user_id
      LEFT JOIN public.settings ON settings.user_id = "user".user_id
      LEFT JOIN public.prayers ON prayers.prayer_id = request.fk_prayer_id
      WHERE request.user_id = $1 AND request.active = 2
      ORDER BY timestamp_raw DESC
    `;

    const lang = ['en', 'es'].includes(params.lang) ? params.lang : 'en';
    const result = await pool.query(query, [params.userId, lang]);
    res.json(result.rows);

  } catch (err) {
    console.error('Database query error:', err);
    res.json({ error: 1, result: "Database error: " + err.message });
  }
});

// POST /getCommunityWall - Get community prayer wall with prayer counts and names
router.post('/getCommunityWall', authenticate, async (req, res) => {
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
    const lang = ['en', 'es'].includes(params.lang) ? params.lang : 'en';
    const filterByChurch = params.filterByChurch === true || params.filterByChurch === 'true';
    
    // Build the WHERE clause based on church filter and my_church_only flag
    let whereClause = 'WHERE request.active = 1';
    let queryParams = [params.userId, lang];
    
    // Always filter by my_church_only flag:
    // If request.my_church_only = TRUE, only show to users in the same church as the request creator
    // If request.my_church_only = FALSE, show to everyone
    whereClause += ` AND (
      COALESCE(request.my_church_only, FALSE) = FALSE
      OR "user".church_id = (SELECT church_id FROM public."user" WHERE user_id = $1)
    )`;
    
    if (filterByChurch) {
      // Additional client-side filter - only show prayers from users in the same church
      // UNLESS the requesting user's church_id is 4 (None), which means "show all prayers"
      whereClause += ` AND (
        "user".church_id = (SELECT church_id FROM public."user" WHERE user_id = $1)
        OR (SELECT church_id FROM public."user" WHERE user_id = $1) = 4
      )`;
    }
    
    // Only show prayer requests from the last 6 months to keep the community wall fresh
    whereClause += ` AND request.timestamp >= NOW() - INTERVAL '6 months'`;
    
    // PostgreSQL query to get all active requests with prayer information
    const query = `
      SELECT DISTINCT 
        request.request_id,
        request.user_id,
        COALESCE(CASE WHEN $2='es' THEN request.content_es ELSE request.content_en END, request.request_text) as request_text,
        request.fk_prayer_id,
        prayers.prayer_title,
        request.request_title,
        request.picture as request_picture,
        COALESCE(request.my_church_only, FALSE) as my_church_only,
        settings.use_alias,
        settings.allow_comments,
        request.timestamp as timestamp,
        request.timestamp as timestamp_raw,
        "user".user_name,
        "user".real_name,
        "user".picture,
        "user".church_id,
        COALESCE(prayer_info.prayer_count, 0) as prayer_count,
        COALESCE(prayer_info.prayed_by_names, ARRAY[]::text[]) as prayed_by_names,
        COALESCE(prayer_info.prayed_by_people, '[]'::jsonb) as prayed_by_people,
        CASE WHEN prayer_info.user_has_prayed THEN true ELSE false END as user_has_prayed
      FROM public.request
      INNER JOIN public."user" ON "user".user_id = request.user_id
      LEFT JOIN public.settings ON settings.user_id = "user".user_id
      LEFT JOIN public.prayers ON prayers.prayer_id = request.fk_prayer_id
      LEFT JOIN LATERAL (
        SELECT 
          COALESCE(SUM(user_prayer_count), 0)::int as prayer_count,
          ARRAY_AGG(
            CASE 
              WHEN user_prayer_count = 1 THEN user_real_name
              WHEN user_prayer_count = 2 THEN user_real_name || ' prayed twice'
              ELSE user_real_name || ' prayed ' || user_prayer_count || ' times'
            END
            ORDER BY user_prayer_count DESC, user_real_name
          ) FILTER (WHERE user_real_name IS NOT NULL) as prayed_by_names,
          JSONB_AGG(
            JSONB_BUILD_OBJECT(
              'name', CASE 
                WHEN user_prayer_count = 1 THEN user_real_name
                WHEN user_prayer_count = 2 THEN user_real_name || ' prayed twice'
                ELSE user_real_name || ' prayed ' || user_prayer_count || ' times'
              END,
              'picture', COALESCE(user_profile_picture_url, user_picture),
              'faith_points', COALESCE(user_faith_points, 0)
            )
            ORDER BY user_prayer_count DESC, user_real_name
          ) FILTER (WHERE user_real_name IS NOT NULL) as prayed_by_people,
          BOOL_OR(praying_user_id = $1) as user_has_prayed
        FROM (
          SELECT 
            praying_user.user_id as praying_user_id,
            praying_user.real_name as user_real_name,
            praying_user.profile_picture_url as user_profile_picture_url,
            praying_user.picture as user_picture,
            praying_user.faith_points as user_faith_points,
            COUNT(*)::int as user_prayer_count
          FROM public.user_request
          INNER JOIN public."user" as praying_user ON praying_user.user_id = user_request.user_id
          WHERE user_request.request_id = request.request_id
          GROUP BY praying_user.user_id, praying_user.real_name, praying_user.profile_picture_url, praying_user.picture, praying_user.faith_points
        ) as per_user_counts
      ) as prayer_info ON true
      ${whereClause}
      ORDER BY timestamp_raw DESC
    `;

    const result = await pool.query(query, queryParams);
    const ranks = await loadFaithRanks();
    const rows = result.rows.map(row => {
      if (row.prayed_by_people && Array.isArray(row.prayed_by_people)) {
        row.prayed_by_people = row.prayed_by_people.map(person => {
          if (person) {
            person.faith_rank = computeRank(person.faith_points, ranks);
          }
          return person;
        }).filter(Boolean);
      }
      return row;
    });
    res.json(rows);

  } catch (err) {
    console.error('Database query error:', err);
    res.json({ error: 1, result: "Database error: " + err.message });
  }
});

// POST /deleteRequestById - Delete a request by ID (owner only)
router.post('/deleteRequestById', authenticate, async (req, res) => {
  try {
    const params = req.body;
    
    if (!params.request_id) {
      return res.json({ error: 1, result: "Required param 'request_id' missing" });
    }
    if (!params.userId) {
      return res.json({ error: 1, result: "Required param 'userId' missing" });
    }
    
    // Check if request exists and belongs to the caller
    const checkResult = await pool.query(
      `SELECT request_id, request_title, user_id FROM public.request WHERE request_id = $1`,
      [params.request_id]
    );
    
    if (checkResult.rows.length === 0) {
      return res.json({ error: 1, result: "Request not found" });
    }

    const request = checkResult.rows[0];
    if (String(request.user_id) !== String(params.userId)) {
      return res.json({ error: 1, result: "You can only delete your own prayer requests" });
    }
    
    // Delete the request
    const deleteResult = await pool.query(
      `DELETE FROM public.request WHERE request_id = $1 RETURNING request_id, request_title`,
      [params.request_id]
    );
    
    if (deleteResult.rows.length === 0) {
      return res.json({ error: 1, result: "Failed to delete request" });
    }
    
    const deletedRequest = deleteResult.rows[0];
    res.json({ 
      error: 0, 
      result: "Request deleted successfully",
      deleted_request: {
        request_id: deletedRequest.request_id,
        request_title: deletedRequest.request_title
      }
    });
    
  } catch (error) {
    console.error('Delete request error:', error);
    res.status(500).json({ error: 1, result: 'Internal server error: ' + error.message });
  }
});

// POST /archivePrayerRequest - Mark own prayer request as answered/archived (sets active = 0)
router.post('/archivePrayerRequest', authenticate, async (req, res) => {
  try {
    const { request_id, user_id } = req.body;
    if (!request_id || !user_id) {
      return res.json({ error: 1, result: "request_id and user_id are required" });
    }
    const check = await pool.query(
      'SELECT request_id, user_id FROM public.request WHERE request_id = $1',
      [request_id]
    );
    if (check.rows.length === 0) {
      return res.json({ error: 1, result: "Prayer request not found" });
    }
    if (check.rows[0].user_id !== parseInt(user_id)) {
      return res.json({ error: 1, result: "You can only archive your own prayer requests" });
    }
    await pool.query(
      'UPDATE public.request SET active = 0 WHERE request_id = $1',
      [request_id]
    );
    res.json({ error: 0, result: "Prayer request archived successfully" });
  } catch (error) {
    console.error('Archive prayer request error:', error);
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// POST /markPrayerAnswered - Mark prayer as answered, notify everyone who prayed for it
router.post('/markPrayerAnswered', authenticate, async (req, res) => {
  try {
    const { request_id, user_id, answered_message } = req.body;

    if (!request_id || !user_id) {
      return res.json({ error: 1, result: "request_id and user_id are required" });
    }
    if (!answered_message || answered_message.trim().length === 0) {
      return res.json({ error: 1, result: "Please share how your prayer was answered" });
    }

    // Verify ownership and get request details
    const checkResult = await pool.query(
      `SELECT request.request_id, request.user_id, request.request_title, request.request_text,
              "user".real_name as requester_name
       FROM public.request
       INNER JOIN public."user" ON "user".user_id = request.user_id
       WHERE request.request_id = $1`,
      [request_id]
    );

    if (checkResult.rows.length === 0) {
      return res.json({ error: 1, result: "Prayer request not found" });
    }
    const requestRow = checkResult.rows[0];
    if (requestRow.user_id !== parseInt(user_id)) {
      return res.json({ error: 1, result: "You can only mark your own prayer requests as answered" });
    }

    // Mark as answered (active = 2) and save the gratitude message
    await pool.query(
      `UPDATE public.request SET active = 2, answered_message = $2 WHERE request_id = $1`,
      [request_id, answered_message.trim()]
    );

    // Find all distinct users who prayed for this request (excluding the requester)
    const prayersResult = await pool.query(
      `SELECT DISTINCT
         "user".user_id,
         "user".real_name,
         "user".email,
         "user".fcm_token,
         COALESCE(settings.prayer_emails, 1) != 0 as prayer_emails,
         COALESCE(settings.push_notifications, TRUE) as push_notifications
       FROM public.user_request
       INNER JOIN public."user" ON "user".user_id = user_request.user_id
       LEFT JOIN public.settings ON settings.user_id = "user".user_id
       WHERE user_request.request_id = $1
         AND user_request.user_id != $2
         AND COALESCE("user".email_bounced, false) = false`,
      [request_id, user_id]
    );

    const prayers = prayersResult.rows;
    const requesterName = requestRow.requester_name || 'Someone';
    const requestTitle = requestRow.request_title || 'a prayer request';
    const snippet = answered_message.trim().length > 200
      ? answered_message.trim().slice(0, 197) + '…'
      : answered_message.trim();

    let pushCount = 0;
    let emailCount = 0;

    for (const person of prayers) {
      // Push notification
      if (person.push_notifications && person.fcm_token) {
        try {
          const pushResult = await sendPushNotification(
            person.fcm_token,
            `${requesterName}'s prayer was answered! 🙌`,
            `"${requestTitle}" — tap to read their testimony`,
            { type: 'prayer_answered', requestId: request_id.toString(), requesterId: user_id.toString() }
          );
          if (pushResult.shouldRemoveToken) {
            await pool.query(
              'UPDATE public."user" SET fcm_token = NULL WHERE user_id = $1',
              [person.user_id]
            );
          } else {
            pushCount++;
          }
        } catch (pushErr) {
          console.error(`Failed push for user ${person.user_id}:`, pushErr.message);
        }
      }

      // Email notification
      if (person.prayer_emails && person.email && !person.email_bounced) {
        try {
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
    .quote-box { background-color: #f0fff4; border-left: 4px solid #34d399; padding: 14px 16px; margin: 20px 0; border-radius: 0 6px 6px 0; font-style: italic; color: #444; }
    .button-container { text-align: center; margin: 30px 0; padding: 20px 0; }
    .button { display: inline-block; padding: 14px 40px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #ffffff; text-decoration: none; border-radius: 25px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); }
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
      <p>Hi ${person.real_name || 'Friend'},</p>
      <p>🙌 <strong>${requesterName}</strong> wanted you to know that a prayer you prayed for has been answered!</p>
      <p>Here's what they shared:</p>
      <div class="quote-box">"${snippet}"</div>
      <p>Your prayers made a difference. Thank you for standing with this community.</p>
      <p>God bless you,<br>The Pray Over Us Team</p>
    </div>
    <div class="button-container">
      <a href="https://www.prayoverus.com" class="button">Open the App</a>
    </div>
    <div class="footer">
      <p>You received this because you prayed for this request.</p>
      <p><a href="https://prayoverus.com">Visit Our Website</a></p>
    </div>
  </div>
</body>
</html>
          `;
          await sendGmailSingle(
            emailTemplate,
            { email: 'prayoverus@gmail.com', name: 'PrayOverUs' },
            { email: person.email, name: person.real_name || 'Friend' },
            `🙌 ${requesterName}'s prayer was answered`,
            null, null
          );
          emailCount++;
        } catch (emailErr) {
          console.error(`Failed email for user ${person.user_id}:`, emailErr.message);
        }
      }
    }

    // Badge checks on answered prayer
    let newBadge = null;
    try {
      // the_rejoicer: 5+ answered prayers
      const answeredRes = await pool.query(
        `SELECT COUNT(*) FROM public.request WHERE user_id = $1 AND active = 2`, [user_id]
      );
      const answeredCount = parseInt(answeredRes.rows[0].count);
      if (answeredCount >= 5) {
        newBadge = await awardBadge(user_id, 'the_rejoicer') || newBadge;
      }

      // chain_breaker: first prayer ever marked answered
      if (answeredCount === 1) {
        newBadge = await awardBadge(user_id, 'chain_breaker') || newBadge;
      }

      // rainbow_promise: this request was answered within 7 days of being posted
      const ageRes = await pool.query(
        `SELECT request_date_time FROM public.request WHERE request_id = $1`, [request_id]
      );
      if (ageRes.rows.length > 0) {
        const posted = new Date(ageRes.rows[0].request_date_time);
        const daysSincePosted = (Date.now() - posted.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSincePosted <= 7) {
          newBadge = await awardBadge(user_id, 'rainbow_promise') || newBadge;
        }
      }

      // persistent: request was open for 30+ days before being answered
      if (ageRes.rows.length > 0) {
        const posted = new Date(ageRes.rows[0].request_date_time);
        const daysSincePosted = (Date.now() - posted.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSincePosted >= 30) {
          newBadge = await awardBadge(user_id, 'persistent') || newBadge;
        }
      }
    } catch (badgeErr) {
      console.warn('Badge check failed (non-blocking):', badgeErr.message);
    }

    console.log(`✅ Prayer ${request_id} marked answered by user ${user_id} — ${pushCount} pushes, ${emailCount} emails sent`);
    res.json({
      error: 0,
      result: "Your prayer has been marked as answered",
      notified: prayers.length,
      pushCount,
      emailCount,
      new_badge: newBadge
    });

  } catch (error) {
    console.error('Mark prayer answered error:', error);
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// POST /deleteUser - Delete user and all related data with backup

  return router;
};
