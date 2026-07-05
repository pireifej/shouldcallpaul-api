const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');
const { promisify } = require('util');
const nodemailer = require("nodemailer");
const cron = require("node-cron");
const multer = require('multer');
const { sendPushNotification } = require('./pushNotifications');
const { uploadImage, uploadImageFromUrl } = require('./cloudinaryService');
const { createClient: createPexelsClient } = require('pexels');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Trust proxy for correct protocol detection behind reverse proxies
app.set('trust proxy', true);

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
app.use('/audio', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
}, express.static('public/audio'));

// Fields to strip from logged params so passwords/tokens never reach the DB
const SENSITIVE_FIELDS = new Set(['password', 'token', 'fcm_token', 'authorization', 'api_key', 'secret']);
function sanitizeParams(body) {
  if (!body || typeof body !== 'object') return body;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    out[k] = SENSITIVE_FIELDS.has(k.toLowerCase()) ? '***' : v;
  }
  return out;
}

// Endpoints that generate too much noise to log every call (read-only feeds)
const SKIP_LOG_PATHS = new Set(['/api/requests', '/getAllBlogArticles', '/getFaithRanks', '/getDailyDevotional']);

// Comprehensive request/response logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  const callerIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

  // Console log every request
  console.log(`\n🔵 INCOMING REQUEST ${timestamp}`);
  console.log(`   Method: ${req.method}`);
  console.log(`   Path: ${req.path}`);
  console.log(`   IP: ${callerIp}`);
  console.log(`   User-Agent: ${req.get('User-Agent') || 'none'}`);
  console.log(`   Content-Type: ${req.get('Content-Type') || 'none'}`);

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    const SENSITIVE_FIELDS = new Set(['password', 'newPassword', 'confirmPassword', 'token']);
    const safeBody = Object.fromEntries(
      Object.entries(req.body || {}).map(([k, v]) =>
        [k, SENSITIVE_FIELDS.has(k) ? '[REDACTED]' : v]
      )
    );
    console.log(`   Payload:`, safeBody);
  }

  // Intercept response to capture status + write DB log
  const originalSend = res.send;
  res.send = function(data) {
    const duration = Date.now() - startTime;

    let responseStatus = 'SUCCESS';
    let errorInfo = null;
    let responseSummary = null;

    if (res.statusCode >= 400) responseStatus = 'ERROR';

    try {
      const parsed = JSON.parse(data);
      if (parsed && parsed.error && parsed.error !== 0) {
        responseStatus = 'ERROR';
        errorInfo = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
      }
      // Store a short summary (result field, or error string, capped at 200 chars)
      const summary = parsed?.result || parsed?.message || errorInfo || null;
      if (summary) responseSummary = String(summary).slice(0, 200);
    } catch (e) { /* non-JSON response */ }

    console.log(`🔴 RESPONSE ${timestamp}`);
    console.log(`   Status: ${res.statusCode} (${responseStatus})`);
    console.log(`   Duration: ${duration}ms`);
    if (errorInfo) console.log(`   Error: ${errorInfo}`);
    console.log(`───────────────────────────────────────`);

    // Write to DB for all POST/PATCH/DELETE except noisy read-only paths
    const shouldLog = (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE')
      && !SKIP_LOG_PATHS.has(req.path);

    if (shouldLog) {
      const params = sanitizeParams(req.body);
      const userId = req.body?.userId || req.body?.user_id || null;
      auditPool.query(
        `INSERT INTO public.api_request_log (method, endpoint, caller_ip, user_id, params, response_summary)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.method, req.path, callerIp, userId ? parseInt(userId) : null, JSON.stringify(params), responseSummary]
      ).catch((e) => console.error('Audit log write failed:', e.message)); // log failures visibly
    }

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

// Dedicated pool for audit logging — always writes to Neon regardless of environment
const auditPool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// PostgreSQL connection pool - use production database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Ensure all timestamps from pg are serialized as UTC ISO 8601 strings (with Z suffix)
// OID 1114 = timestamp without time zone (pg returns as plain string — treat as UTC)
// OID 1184 = timestamp with time zone (pg returns as JS Date — ensure ISO format)
const { types } = require('pg');
types.setTypeParser(1114, (val) => val ? new Date(val + 'Z').toISOString() : null);
types.setTypeParser(1184, (val) => val ? new Date(val).toISOString() : null);

// Initialize OpenAI client
// the newest OpenAI model is "gpt-5" which was released August 7, 2025. do not change this unless explicitly requested by the user
const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY 
});

const pexels = createPexelsClient(process.env.PEXELS_API_KEY);

// In-memory cache for Daily Bread TTS audio, keyed by date string (e.g. "2026-06-09")
const dailyBreadAudioCache = new Map();
const DEVOTIONAL_AUDIO_DIR = path.join(__dirname, 'audio', 'devotionals');
if (!fs.existsSync(DEVOTIONAL_AUDIO_DIR)) fs.mkdirSync(DEVOTIONAL_AUDIO_DIR, { recursive: true });

const prayerAudioCache = new Map();
const MAX_PRAYER_AUDIO_CACHE = 50;
const PRAYER_AUDIO_DIR = path.join(__dirname, 'audio', 'prayers');
if (!fs.existsSync(PRAYER_AUDIO_DIR)) fs.mkdirSync(PRAYER_AUDIO_DIR, { recursive: true });

// ============================================
// FAITH RANK HELPER FUNCTION
// Computes rank info from faith_points using cached rank data
// ============================================
let cachedFaithRanks = null;

async function loadFaithRanks() {
  if (!cachedFaithRanks) {
    const result = await pool.query('SELECT level, title, min_points, icon FROM public.faith_ranks ORDER BY min_points ASC');
    cachedFaithRanks = result.rows;
  }
  return cachedFaithRanks;
}

function computeRank(faithPoints, ranks) {
  const points = parseInt(faithPoints) || 0;
  if (!ranks || ranks.length === 0) {
    return { level: 0, title: 'Newcomer', icon: '🌱', min_points: 0, points: points, next_rank: null, progress: 0 };
  }

  let currentRank = ranks[0];
  let nextRank = null;

  for (let i = 0; i < ranks.length; i++) {
    if (points >= ranks[i].min_points) {
      currentRank = ranks[i];
      nextRank = i + 1 < ranks.length ? ranks[i + 1] : null;
    }
  }

  let progress = 1;
  if (nextRank) {
    const range = nextRank.min_points - currentRank.min_points;
    progress = range > 0 ? (points - currentRank.min_points) / range : 1;
  }

  return {
    level: currentRank.level,
    title: currentRank.title,
    icon: currentRank.icon,
    min_points: currentRank.min_points,
    points: points,
    next_rank: nextRank ? { level: nextRank.level, title: nextRank.title, icon: nextRank.icon, min_points: nextRank.min_points } : null,
    progress: Math.round(progress * 100) / 100
  };
}

// ============================================
// PRAYER GENERATION HELPER FUNCTION
// Single source of truth for prayer generation prompt and processing
// ============================================
// ── BADGE HELPER ─────────────────────────────────────────────────────────────
// Awards a badge to a user. Returns the badge definition if newly earned, null if already owned.
async function awardBadge(userId, badgeKey) {
  const insert = await pool.query(
    `INSERT INTO public.badges (user_id, badge_key) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING badge_key`,
    [userId, badgeKey]
  );
  if (insert.rowCount === 0) return null; // already had it
  const def = await pool.query(
    'SELECT title, icon, description FROM public.badge_definitions WHERE badge_key = $1',
    [badgeKey]
  );
  return def.rows.length > 0
    ? { badge_key: badgeKey, title: def.rows[0].title, icon: def.rows[0].icon, description: def.rows[0].description }
    : { badge_key: badgeKey };
}
// ─────────────────────────────────────────────────────────────────────────────

async function generatePrayer(requestText, authorName, lang = 'en') {
  const realName = authorName || "Someone";
  
  const promptToGeneratePrayer = `You are an expert prayer writer, composing a Catholic-style prayer. The prayer should have a traditional, reverent, and intercessory tone.

User Request: ${requestText}
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

5. Text Formatting: Use markdown-style bold (**text**) to emphasize:
   - All person names mentioned in the prayer
   - Divine names: God, Lord, Jesus, Christ, Holy Spirit, Father, Mary, Saint, Savior, Redeemer, Creator
   - Key intercession words: heal, healing, protect, protection, guide, guidance, bless, blessing, comfort, strengthen, peace, grace, mercy, love, hope, faith, wisdom, courage, patience

6. CRITICAL - NO "AMEN" ENDING: Do NOT end the prayer with "Amen" or any variation. The app has its own "Amen" button. The prayer MUST end with the final petition or doxology WITHOUT "Amen".

7. Length: The prayer should be 50-80 words (similar to The Lord's Prayer at ~65 words). Be concise yet complete - address the specific request meaningfully without padding.

8. Output plain text with line breaks between paragraphs. Do NOT use HTML tags.${lang === 'es' ? '\n\nIMPORTANT: Generate this entire prayer in Spanish (Latin American Spanish). All text — the address to God, every petition, every intercession, and every divine name in context — must be written in Spanish.' : ''}`;

  // Call OpenAI directly
  let chatResult;
  try {
    chatResult = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: promptToGeneratePrayer }]
    });
  } catch (openaiErr) {
    console.warn('⚠️ OpenAI error in generatePrayer:', openaiErr.message);
    chatResult = {};
  }

  if (!chatResult.choices || chatResult.choices.length === 0) {
    // Fallback prayer bank — used when OpenAI is unavailable
    const fallbackPrayers = [
      "<strong>Heavenly Father</strong>, we come before You with open hearts, trusting in Your perfect wisdom and boundless <strong>love</strong>. You know the needs of Your children before they speak them aloud. We ask that You <strong>bless</strong>, <strong>guide</strong>, and <strong>protect</strong> all who seek Your face today. Grant them <strong>peace</strong> that surpasses understanding, and may Your <strong>grace</strong> be sufficient in every trial they face.",
      "<strong>Lord Jesus Christ</strong>, hear the prayers of Your people. You are our <strong>healer</strong>, our <strong>comforter</strong>, and our ever-present <strong>hope</strong>. We lay our burdens at Your feet and trust that You will work all things for good. Strengthen our <strong>faith</strong>, renew our <strong>hope</strong>, and fill our hearts with Your abiding <strong>love</strong>.",
      "<strong>Heavenly Father</strong>, in Your infinite <strong>mercy</strong> You hear every prayer lifted to You. We bring this intention before Your throne of <strong>grace</strong>, knowing that nothing is impossible for You. May Your <strong>Holy Spirit</strong> move in power, bringing <strong>healing</strong>, <strong>peace</strong>, and Your perfect will to bear. We trust in Your timing and Your plan.",
      "<strong>Lord God</strong>, You are our <strong>refuge</strong> and our <strong>strength</strong>, a very present <strong>help</strong> in times of trouble. We ask You to reach into this situation with Your almighty hand. May Your will be done and Your <strong>glory</strong> revealed. Wrap Your loving arms around those in need and grant them the <strong>comfort</strong> only You can give.",
      "Most <strong>Holy Trinity</strong>, <strong>Father</strong>, <strong>Son</strong>, and <strong>Holy Spirit</strong>, we come before You in trust and <strong>faith</strong>. You are the source of all goodness and every perfect gift. Pour out Your <strong>blessings</strong> upon all who seek You today. May they know Your closeness, feel Your <strong>love</strong>, and walk in the <strong>peace</strong> that only You can give.",
      "<strong>Merciful Jesus</strong>, You carried the cross so we would never carry our burdens alone. We lift this prayer to You with <strong>faith</strong> and <strong>hope</strong>, knowing You see every tear and hear every cry. <strong>Heal</strong> what is broken, <strong>restore</strong> what is lost, and remind Your beloved children that they are never alone. Your <strong>love</strong> never fails.",
      "<strong>Mary</strong>, Queen of <strong>Heaven</strong>, join your prayers to ours as we bring this intention before your <strong>Son</strong>. Through your intercession, may <strong>God's grace</strong> flow abundantly. <strong>Lord</strong>, in Your <strong>mercy</strong>, hear our prayer. Grant <strong>wisdom</strong> to those who seek it, <strong>healing</strong> to those who suffer, and <strong>hope</strong> to all who feel lost.",
      "<strong>Almighty God</strong>, nothing is hidden from Your sight and nothing is beyond Your reach. We come to You not because we have all the answers, but because You do. <strong>Guide</strong> us, <strong>protect</strong> us, and draw near to all who call upon Your name. May Your <strong>peace</strong> guard our hearts and minds as we place our <strong>trust</strong> in You."
    ];
    const fallback = fallbackPrayers[Math.floor(Math.random() * fallbackPrayers.length)];
    console.warn('⚠️ OpenAI unavailable — using fallback prayer');
    return {
      rawPrayer: fallback,
      processedPrayer: fallback,
      tags: [],
      isFallback: true
    };
  }

  let rawPrayer = chatResult.choices[0].message.content;
  let processedPrayer = rawPrayer;
  
  // Convert markdown-style bold (**text**) to HTML <strong> tags
  processedPrayer = processedPrayer.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  
  // Convert single asterisk (*text*) to HTML <em> (italic) tags
  processedPrayer = processedPrayer.replace(/\*(.+?)\*/g, '<em>$1</em>');
  
  // Convert any remaining newlines to HTML line breaks
  processedPrayer = processedPrayer.replace(/\n/g, '<br>');
  
  // Safety net: Remove "Amen" from the end if AI added it anyway
  processedPrayer = processedPrayer.replace(/<br>\s*<strong>\s*Amen\.?\s*<\/strong>\s*$/i, '');
  processedPrayer = processedPrayer.replace(/<br>\s*Amen\.?\s*$/i, '');
  processedPrayer = processedPrayer.replace(/\s*<strong>\s*Amen\.?\s*<\/strong>\s*$/i, '');
  processedPrayer = processedPrayer.replace(/\s*Amen\.?\s*$/i, '');
  
  // Remove horizontal rule/dashes that ChatGPT sometimes adds
  processedPrayer = processedPrayer.replace(/<br>\s*[-—–]{3,}\s*(<br>)?$/i, '');
  processedPrayer = processedPrayer.replace(/\s*[-—–]{3,}\s*$/i, '');

  return {
    success: true,
    rawPrayer: rawPrayer,
    processedPrayer: processedPrayer,
    authorName: realName
  };
}

// Translate text between 'en' and 'es' using OpenAI.
// contentType: 'text' for plain request text, 'prayer_html' for prayer HTML with tags.
async function translateText(text, fromLang, toLang, contentType = 'text') {
  const fromName = fromLang === 'es' ? 'Spanish' : 'English';
  const toName = toLang === 'es' ? 'Spanish' : 'English';
  const htmlNote = contentType === 'prayer_html'
    ? ' Preserve all HTML tags (<strong>, <br>, <em>, etc.) exactly as they appear — only translate the human-readable text between the tags.'
    : '';
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: `Translate the following from ${fromName} to ${toName}. Keep it natural and heartfelt. Preserve names and places as-is.${htmlNote} Return only the translated text, nothing else:\n\n${text}`
    }],
    max_tokens: 600,
  });
  return resp.choices[0].message.content.trim();
}

// Gmail SMTP transporter
function createGmailTransporter() {
    return nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_APP_PASSWORD
        }
    });
}

// Email sending function using Gmail SMTP
async function sendGmailSingle(template, fromPerson, toPerson, subject, extraResult, res) {
    const transporter = createGmailTransporter();

    const bcc = (toPerson.email === "programmerpauly@gmail.com") ? undefined : "programmerpauly@gmail.com";

    const mailOptions = {
        from: `"${fromPerson.name}" <${process.env.GMAIL_USER}>`,
        to: `"${toPerson.name}" <${toPerson.email}>`,
        bcc,
        replyTo: process.env.GMAIL_USER,
        subject,
        html: template,
        text: "Email from PrayOverUs.com"
    };

    const extraResultMessage = (extraResult) ? "|" + extraResult : "";

    try {
        await transporter.sendMail(mailOptions);
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

function log(req, params) {
    let date_ob = new Date();
    console.log(new Date(), req.originalUrl, JSON.stringify(req.body));
}

// Helper function to get base URL from environment or request
function getBaseUrl(req) {
  // 1. Use explicit BASE_URL environment variable if set (for custom domains)
  if (process.env.BASE_URL) {
    return process.env.BASE_URL;
  }
  
  // 2. Derive from request headers for automatic multi-environment support
  // Honor X-Forwarded-Proto header for TLS-offloading proxies (trust proxy must be enabled)
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('host');
  
  if (host) {
    return `${protocol}://${host}`;
  }
  
  // 3. Fallback to production domain only if request info unavailable
  return 'https://shouldcallpaul.replit.app';
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

// ── Audio helper — used by getDailyBreadAudio and getPrayerAudio ──
function serveAudioBuffer(req, res, buffer) {
  const total = buffer.length;
  const rangeHeader = req.headers['range'];

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Type': 'audio/mpeg',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': chunkSize,
        'Cache-Control': 'public, max-age=86400'
      });
      return res.end(buffer.slice(start, end + 1));
    }
  }

  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Content-Length': total,
    'Cache-Control': 'public, max-age=86400'
  });
  res.end(buffer);
}

// POST /testGeneratePrayer - Test prayer generation without storing to database
// Uses the SAME prompt and processing as submitPrayerRequest

// ─────────────────────────────────────────────────────────────────────────────
// Route files
// ─────────────────────────────────────────────────────────────────────────────
const miscRoutes       = require('./routes/misc');
const authRoutes       = require('./routes/auth');
const usersRoutes      = require('./routes/users');
const prayersRoutes    = require('./routes/prayers');
const devotionalRoutes = require('./routes/devotional');
const blogRoutes       = require('./routes/blog');
const adminRoutes      = require('./routes/admin');
const resumeRoutes     = require('./routes/resume');
const rosaryRoutes     = require('./routes/rosary');

const rooms = new Map(); // code -> room object

function generateRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function broadcastToRoom(room, message) {
  const data = JSON.stringify(message);
  room.participants.forEach(p => {
    if (p.ws.readyState === 1) p.ws.send(data);
  });
}

function getRoomState(room) {
  return {
    participants: room.participants.map(p => ({ userId: p.userId, userName: p.userName })),
    hostId: room.hostId,
    currentStep: room.currentStep,
    mysteryType: room.mysteryType,
    decadeAssignments: room.decadeAssignments,
    currentLeaderId: room.currentLeaderId,
    leaderIndex: room.leaderIndex
  };
}

function assignDecades(room) {
  const nonHosts = room.participants.filter(p => p.userId !== room.hostId);
  const assignments = {};
  for (let decade = 1; decade <= 5; decade++) {
    const participant = nonHosts[(decade - 1) % nonHosts.length];
    assignments[decade] = participant ? participant.userId : room.hostId;
  }
  return assignments;
}

// REST endpoint – reconnect/resync
app.get('/rosary-room/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(getRoomState(room));
});

// ─────────────────────────────────────────────
// HTTP + WebSocket Server
// ─────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentUserId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── CREATE ROOM ──
    if (msg.type === 'create_room') {
      const userId = crypto.randomUUID();
      const code = generateRoomCode();
      const room = {
        code,
        hostId: userId,
        participants: [{ userId, userName: msg.userName || 'Host', ws }],
        currentStep: 0,
        mysteryType: null,
        decadeAssignments: {},
        currentLeaderId: userId,
        leaderIndex: 0
      };
      rooms.set(code, room);
      currentRoom = room;
      currentUserId = userId;
      ws.send(JSON.stringify({ type: 'room_created', code, userId }));
      console.log(`[Rosary] Room ${code} created by ${msg.userName}`);
    }

    // ── JOIN ROOM ──
    else if (msg.type === 'join_room') {
      const room = rooms.get(msg.code);
      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
        return;
      }
      const userId = crypto.randomUUID();
      room.participants.push({ userId, userName: msg.userName || 'Guest', ws });
      currentRoom = room;
      currentUserId = userId;
      ws.send(JSON.stringify({ type: 'joined_room', userId, code: msg.code }));
      broadcastToRoom(room, { type: 'room_updated', ...getRoomState(room) });
      console.log(`[Rosary] ${msg.userName} joined room ${msg.code}`);
    }

    // ── START SESSION (host only) ──
    else if (msg.type === 'start_session') {
      if (!currentRoom || currentUserId !== currentRoom.hostId) return;
      currentRoom.mysteryType = msg.mysteryType || 'joyful';
      currentRoom.currentStep = 0;
      currentRoom.leaderIndex = 0;
      currentRoom.currentLeaderId = currentRoom.participants[0].userId;
      currentRoom.decadeAssignments = assignDecades(currentRoom);
      broadcastToRoom(currentRoom, {
        type: 'session_started',
        mysteryType: currentRoom.mysteryType,
        currentStep: 0,
        decadeAssignments: currentRoom.decadeAssignments,
        currentLeaderId: currentRoom.currentLeaderId,
        leaderIndex: currentRoom.leaderIndex
      });
      console.log(`[Rosary] Room ${currentRoom.code} session started (${currentRoom.mysteryType})`);
    }

    // ── DECADE COMPLETE (current leader only) ──
    else if (msg.type === 'decade_complete') {
      if (!currentRoom || currentUserId !== currentRoom.currentLeaderId) return;
      currentRoom.currentStep += 1;
      currentRoom.leaderIndex = (currentRoom.leaderIndex + 1) % currentRoom.participants.length;
      currentRoom.currentLeaderId = currentRoom.participants[currentRoom.leaderIndex].userId;
      broadcastToRoom(currentRoom, {
        type: 'decade_complete',
        currentStep: currentRoom.currentStep,
        currentLeaderId: currentRoom.currentLeaderId
      });
      console.log(`[Rosary] Room ${currentRoom.code} decade complete, step ${currentRoom.currentStep}, new leader ${currentRoom.currentLeaderId}`);
    }

    // ── ADVANCE STEP (current leader only) ──
    else if (msg.type === 'advance_step') {
      if (!currentRoom || currentUserId !== currentRoom.currentLeaderId) return;
      currentRoom.currentStep += 1;
      broadcastToRoom(currentRoom, { type: 'step_changed', currentStep: currentRoom.currentStep });
    }

    // ── GO BACK (host only) ──
    else if (msg.type === 'go_back') {
      if (!currentRoom || currentUserId !== currentRoom.hostId) return;
      if (currentRoom.currentStep > 0) currentRoom.currentStep -= 1;
      broadcastToRoom(currentRoom, { type: 'step_changed', currentStep: currentRoom.currentStep });
    }
  });

  ws.on('close', () => {
    if (!currentRoom) return;
    currentRoom.participants = currentRoom.participants.filter(p => p.userId !== currentUserId);
    if (currentRoom.participants.length === 0) {
      rooms.delete(currentRoom.code);
      console.log(`[Rosary] Room ${currentRoom.code} deleted (empty)`);
      return;
    }
    if (currentRoom.hostId === currentUserId) {
      currentRoom.hostId = currentRoom.participants[0].userId;
      console.log(`[Rosary] Host transferred in room ${currentRoom.code}`);
    }
    // If the disconnected user was the current leader, pass leadership to next participant
    if (currentRoom.currentLeaderId === currentUserId) {
      currentRoom.leaderIndex = currentRoom.leaderIndex % currentRoom.participants.length;
      currentRoom.currentLeaderId = currentRoom.participants[currentRoom.leaderIndex].userId;
      console.log(`[Rosary] Leader transferred in room ${currentRoom.code}`);
    }
    broadcastToRoom(currentRoom, { type: 'room_updated', ...getRoomState(currentRoom) });
  });
});
// ─── DAILY DEVOTIONAL SYSTEM ──────────────────────────────────────────────────

const DEVOTIONAL_THEMES = [
  'Grace', 'Strength', 'Hope', 'Forgiveness', 'Gratitude', 'Faith', 'Love',
  'Peace', 'Patience', 'Courage', 'Humility', 'Joy', 'Mercy', 'Trust',
  'Perseverance', 'Wisdom', 'Compassion', 'Renewal', 'Surrender', 'Light',
  'Healing', 'Purpose', 'Community', 'Silence', 'Abundance'
];

// Compute Easter Sunday for a given year — returns a UTC midnight Date
function getEaster(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

// Return a holiday name if the date matches a known event, otherwise null
function getHolidayTheme(date) {
  // Normalize to UTC calendar date so afternoon calls don't bleed into tomorrow
  const month = date.getUTCMonth() + 1; // 1-12
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  const dow = date.getUTCDay(); // 0=Sun

  // Fixed holidays
  const fixed = {
    '1-1':   { theme: 'Renewal',      event: "New Year's Day" },
    '1-6':   { theme: 'Faith',        event: 'Epiphany' },
    '2-2':   { theme: 'Light',        event: 'Candlemas' },
    '2-14':  { theme: 'Love',         event: "Valentine's Day" },
    '3-17':  { theme: 'Faith',        event: "St. Patrick's Day" },
    '3-19':  { theme: 'Purpose',      event: 'Feast of St. Joseph' },
    '4-23':  { theme: 'Courage',      event: "St. George's Day" },
    '7-4':   { theme: 'Freedom',      event: 'Independence Day' },
    '8-15':  { theme: 'Hope',         event: 'Assumption of Mary' },
    '10-31': { theme: 'Light',        event: 'All Hallows Eve' },
    '11-1':  { theme: 'Community',    event: "All Saints' Day" },
    '11-2':  { theme: 'Mercy',        event: "All Souls' Day" },
    '12-24': { theme: 'Hope',         event: 'Christmas Eve' },
    '12-25': { theme: 'Joy',          event: 'Christmas Day' },
    '12-26': { theme: 'Gratitude',    event: 'Day After Christmas' },
    '12-31': { theme: 'Gratitude',    event: "New Year's Eve" },
  };
  const fixedKey = `${month}-${day}`;
  if (fixed[fixedKey]) return fixed[fixedKey];

  // Easter-relative movable feasts — normalize both sides to UTC midnight for exact day diff
  const easter = getEaster(year);
  const dateUtcMidnight = Date.UTC(year, month - 1, day);
  const diffDays = Math.floor((dateUtcMidnight - easter.getTime()) / 86400000);
  if (diffDays === -46) return { theme: 'Surrender',     event: 'Ash Wednesday' };
  if (diffDays === -7)  return { theme: 'Humility',      event: 'Palm Sunday' };
  if (diffDays === -3)  return { theme: 'Community',     event: 'Holy Thursday' };
  if (diffDays === -2)  return { theme: 'Forgiveness',   event: 'Good Friday' };
  if (diffDays === -1)  return { theme: 'Hope',          event: 'Holy Saturday' };
  if (diffDays === 0)   return { theme: 'Joy',           event: 'Easter Sunday' };
  if (diffDays === 1)   return { theme: 'Renewal',       event: 'Easter Monday' };
  if (diffDays === 39)  return { theme: 'Purpose',       event: 'Ascension Thursday' };
  if (diffDays === 49)  return { theme: 'Courage',       event: 'Pentecost Sunday' };

  // Movable US/cultural holidays
  // Mother's Day: 2nd Sunday in May
  if (month === 5 && dow === 0) {
    const firstSunday = day - ((day - 1) % 7);
    if (day === firstSunday + 7) return { theme: 'Love', event: "Mother's Day" };
  }
  // Father's Day: 3rd Sunday in June
  if (month === 6 && dow === 0) {
    const firstSunday = day - ((day - 1) % 7);
    if (day === firstSunday + 14) return { theme: 'Strength', event: "Father's Day" };
  }
  // Thanksgiving: 4th Thursday in November
  if (month === 11 && dow === 4) {
    const firstThursday = day - ((day - 1) % 7);
    if (day === firstThursday + 21) return { theme: 'Gratitude', event: 'Thanksgiving Day' };
  }
  // Memorial Day: last Monday in May
  if (month === 5 && dow === 1 && day > 24) {
    return { theme: 'Perseverance', event: 'Memorial Day' };
  }
  // Labor Day: 1st Monday in September
  if (month === 9 && dow === 1 && day <= 7) {
    return { theme: 'Purpose', event: 'Labor Day' };
  }
  // MLK Day: 3rd Monday in January
  if (month === 1 && dow === 1 && day >= 15 && day <= 21) {
    return { theme: 'Justice', event: 'Martin Luther King Jr. Day' };
  }

  return null;
}

async function generateDailyDevotional(targetDate, lang = 'en', { sharedTheme = null, sharedImageUrl = null } = {}) {
  const dateStr = targetDate.toISOString().slice(0, 10);

  // Check for a holiday/event on this date
  const holiday = getHolidayTheme(targetDate);
  const theme = sharedTheme || (holiday
    ? holiday.theme
    : DEVOTIONAL_THEMES[Math.floor(Math.random() * DEVOTIONAL_THEMES.length)]);
  const holidayContext = holiday
    ? `Today is ${holiday.event}. Please incorporate this occasion naturally and meaningfully into the devotional.`
    : '';

  const holidayNote = holiday ? ` (${holiday.event})` : '';
  console.log(`📖 Generating ${lang} devotional for ${dateStr}${holidayNote} — theme: ${theme}`);

  // Step 1: Generate text content via GPT
  const gptPrompt = `You are a warm, non-denominational Christian devotional writer. 
Generate a daily devotional on the theme of "${theme}" for ${dateStr}.${holidayContext ? '\n' + holidayContext : ''}
Respond ONLY with a valid JSON object — no markdown, no code fences, just raw JSON — with exactly these fields:
{
  "title": "A short, inspiring title (max 10 words)",
  "articleBody": "A 250-word devotional article in plain prose, split into exactly two paragraphs separated by a blank line. No bullet points.",
  "bibleVerse": "The full text of one relevant Bible verse",
  "verseReference": "Book Chapter:Verse (e.g. Romans 8:28)",
  "prayer": "A short 3-4 sentence closing prayer written in first person",
  "imagePrompt": "A descriptive visual scene suitable for a watercolor painting (2-3 sentences, no text or people)",
  "pexelsQuery": "2-4 words describing a beautiful nature scene that fits this devotional's mood. Use only concrete visual nouns (e.g. 'misty forest sunrise', 'golden wheat field', 'ocean sunrise waves', 'mountain lake reflection'). No abstract words, no holiday names, no people."
}${lang === 'es' ? '\n\nIMPORTANT: Respond entirely in Spanish (Latin American Spanish). Every field — title, articleBody, bibleVerse, verseReference, prayer — must be written in Spanish. The pexelsQuery should remain in English for search purposes.' : ''}`;

  const gptResponse = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: gptPrompt }],
    temperature: 0.8,
    response_format: { type: 'json_object' }
  });

  const content = JSON.parse(gptResponse.choices[0].message.content);

  // Step 2: Fetch a beautiful photo from Pexels (or reuse shared image from EN version)
  let imageUrl = sharedImageUrl || null;
  if (!imageUrl) {
    try {
      const searchQuery = content.pexelsQuery || `${theme} nature peaceful`;
      console.log(`🔍 Pexels search: "${searchQuery}"`);

      const pexelsResponse = await pexels.photos.search({
        query: searchQuery,
        per_page: 15,
        orientation: 'landscape'
      });

      if (pexelsResponse.photos && pexelsResponse.photos.length > 0) {
        const pick = pexelsResponse.photos[Math.floor(Math.random() * pexelsResponse.photos.length)];
        const pexelsUrl = pick.src.large2x || pick.src.large || pick.src.original;
        imageUrl = await uploadImageFromUrl(pexelsUrl, 'devotionals');
        console.log(`🎨 Devotional image fetched from Pexels: "${searchQuery}" (${pick.photographer})`);
      } else {
        console.warn(`⚠️  Pexels returned no photos for query "${searchQuery}"`);
      }
    } catch (imgErr) {
      console.warn(`⚠️  Pexels image fetch failed: ${imgErr.message}`);
    }
  } else {
    console.log(`🎨 Reusing ${lang === 'en' ? 'EN' : 'ES'} devotional image from English version`);
  }

  // Step 4: Save to database
  await pool.query(
    `INSERT INTO public.daily_devotional
      (date, theme, title, article_body, bible_verse, verse_reference, prayer, image_url, image_prompt, lang)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (date, lang) DO UPDATE SET
       theme = EXCLUDED.theme,
       title = EXCLUDED.title,
       article_body = EXCLUDED.article_body,
       bible_verse = EXCLUDED.bible_verse,
       verse_reference = EXCLUDED.verse_reference,
       prayer = EXCLUDED.prayer,
       image_url = EXCLUDED.image_url,
       image_prompt = EXCLUDED.image_prompt`,
    [dateStr, theme, content.title, content.articleBody, content.bibleVerse,
     content.verseReference, content.prayer, imageUrl, content.imagePrompt, lang]
  );

  console.log(`✅ Devotional saved for ${dateStr}: "${content.title}"`);

  // Step 5: Generate TTS audio and save to disk (English and Spanish)
  const prayerIntro = { en: 'Today\'s closing prayer.', es: 'Oración de cierre de hoy.' };
  const audioLang = lang === 'es' ? 'es' : 'en';
  const cacheKey = audioLang === 'es' ? `${dateStr}_es` : dateStr;
  const audioFileName = audioLang === 'es' ? `daily_bread_${dateStr}_es.mp3` : `daily_bread_${dateStr}.mp3`;

  try {
    const audioPath = path.join(DEVOTIONAL_AUDIO_DIR, audioFileName);
    const ttsScript = [
      content.title,
      content.bibleVerse && content.verseReference
        ? `${content.bibleVerse} — ${content.verseReference}`
        : (content.bibleVerse || content.verseReference || ''),
      content.articleBody,
      content.prayer ? `${prayerIntro[audioLang]} ${content.prayer}` : ''
    ].filter(Boolean).join('\n\n').slice(0, 4000);

    const ttsResponse = await openai.audio.speech.create({
      model: 'tts-1-hd',
      voice: 'nova',
      input: ttsScript,
      response_format: 'mp3'
    });
    const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());
    fs.writeFileSync(audioPath, audioBuffer);
    dailyBreadAudioCache.set(cacheKey, audioBuffer);
    console.log(`🔊 Devotional audio saved for ${dateStr} [${audioLang}] (${audioBuffer.length} bytes)`);

    // Cleanup: delete audio files older than 7 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const files = fs.readdirSync(DEVOTIONAL_AUDIO_DIR);
    for (const file of files) {
      const match = file.match(/^daily_bread_(\d{4}-\d{2}-\d{2})(?:_es)?\.mp3$/);
      if (match && new Date(match[1]) < cutoff) {
        fs.unlinkSync(path.join(DEVOTIONAL_AUDIO_DIR, file));
        dailyBreadAudioCache.delete(match[1]);
        dailyBreadAudioCache.delete(`${match[1]}_es`);
        console.log(`🗑️  Deleted old audio: ${file}`);
      }
    }
  } catch (audioErr) {
    console.warn(`⚠️  Audio generation failed for ${dateStr} [${audioLang}]: ${audioErr.message}`);
  }

  return { content, theme, imageUrl };
}
// Daily cron: generate EN + ES devotionals at 12:05 AM UTC every day
cron.schedule('5 0 * * *', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();
  try {
    const existing = await pool.query(
      'SELECT lang FROM public.daily_devotional WHERE date = $1',
      [today]
    );
    const existingLangs = new Set(existing.rows.map(r => r.lang));

    // Generate English first (it picks the theme and image)
    let sharedTheme = null;
    let sharedImageUrl = null;
    if (!existingLangs.has('en')) {
      console.log('📖 Running scheduled English devotional generation...');
      const result = await generateDailyDevotional(now, 'en');
      sharedTheme = result.theme;
      sharedImageUrl = result.imageUrl;
    } else {
      console.log(`📖 English devotional for ${today} already exists — reading theme/image for ES.`);
      const enRow = await pool.query(
        'SELECT theme, image_url FROM public.daily_devotional WHERE date = $1 AND lang = $2',
        [today, 'en']
      );
      if (enRow.rows.length > 0) {
        sharedTheme = enRow.rows[0].theme;
        sharedImageUrl = enRow.rows[0].image_url;
      }
    }

    // Generate Spanish using same theme + image
    if (!existingLangs.has('es')) {
      console.log('📖 Running scheduled Spanish devotional generation...');
      await generateDailyDevotional(now, 'es', { sharedTheme, sharedImageUrl });
    } else {
      console.log(`📖 Spanish devotional for ${today} already exists — skipping.`);
    }
  } catch (error) {
    console.error('Scheduled devotional generation failed:', error.message);
  }
});

console.log('📖 Daily devotional generation scheduled at 12:05 AM UTC');
// ─── DATABASE BACKUP SYSTEM ───────────────────────────────────────────────────

const BACKUP_DIR = path.join(__dirname, 'backups', 'prod');
const MAX_BACKUPS = 30; // Keep last 30 days

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

async function runProdBackup() {
  const prodUrl = process.env.NEON_DATABASE_URL;
  if (!prodUrl) throw new Error('NEON_DATABASE_URL secret is not set');

  ensureBackupDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFile = path.join(BACKUP_DIR, `backup_${timestamp}.sql`);

  const execPromise = promisify(exec);
  await execPromise(`pg_dump "${prodUrl}" -f "${backupFile}"`);

  // Rotate: delete oldest files beyond MAX_BACKUPS
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => a.time - b.time);

  while (files.length > MAX_BACKUPS) {
    const oldest = files.shift();
    fs.unlinkSync(path.join(BACKUP_DIR, oldest.name));
    console.log(`🗑️  Deleted old backup: ${oldest.name}`);
  }

  console.log(`✅ Production DB backup saved: ${backupFile}`);

  // Email the backup as an attachment so it survives redeployments
  try {
    const stats = fs.statSync(backupFile);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    const dateLabel = timestamp.slice(0, 10);
    const transporter = createGmailTransporter();
    await transporter.sendMail({
      from: `"Pray Over Us Backup" <${process.env.GMAIL_USER}>`,
      to: process.env.GMAIL_USER,
      subject: `🗄️ Daily DB Backup — ${dateLabel} (${sizeMB} MB)`,
      text: `Automated daily production database backup.\n\nDate: ${dateLabel}\nFile: ${path.basename(backupFile)}\nSize: ${sizeMB} MB\n\nThis backup was generated automatically at 2:00 AM UTC.`,
      attachments: [{ filename: path.basename(backupFile), path: backupFile }]
    });
    console.log(`📧 Backup emailed to ${process.env.GMAIL_USER}`);
  } catch (emailErr) {
    console.error('⚠️  Backup email failed (file still saved locally):', emailErr.message);
  }

  return backupFile;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared context — passed into every route file as factory argument
// ─────────────────────────────────────────────────────────────────────────────
const ctx = {
  pool,
  auditPool,
  openai,
  pexels,
  authenticate,
  bcrypt,
  generatePrayer,
  translateText,
  computeRank,
  awardBadge,
  loadFaithRanks,
  generateDailyDevotional,
  sendDailyDevotionalNotification,
  sendGmailSingle,
  createGmailTransporter,
  uploadImage,
  uploadImageFromUrl,
  sendPushNotification,
  prayerAudioCache,
  MAX_PRAYER_AUDIO_CACHE,
  dailyBreadAudioCache,
  PRAYER_AUDIO_DIR,
  DEVOTIONAL_AUDIO_DIR,
  serveAudioBuffer,
  rooms,
  generateRoomCode,
  broadcastToRoom,
  getRoomState,
  assignDecades,
  runProdBackup,
  BACKUP_DIR,
  log,
  getBaseUrl,
  getRandomString,
  multer,
  fs,
  path,
  crypto,
  PORT,
};

// Mount all route files
app.use(miscRoutes(ctx));
app.use(authRoutes(ctx));
app.use(usersRoutes(ctx));
app.use(prayersRoutes(ctx));
app.use(devotionalRoutes(ctx));
app.use(blogRoutes(ctx));
app.use(adminRoutes(ctx));
app.use(resumeRoutes(ctx));
app.use(rosaryRoutes(ctx));

// Daily backup at 2:00 AM UTC
cron.schedule('0 2 * * *', async () => {
  console.log('🕑 Running scheduled daily production DB backup...');
  try {
    await runProdBackup();
  } catch (error) {
    console.error('Scheduled backup failed:', error.message);
  }
});

console.log('⏰ Daily production DB backup scheduled at 2:00 AM UTC');

// ── Startup migration: add any missing columns ────────────────────────────────
(async () => {
  const migrations = [
    { col: 'email_bounced',  sql: `ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS email_bounced boolean DEFAULT false` },
    { col: 'apple_id',       sql: `ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS apple_id TEXT` },
    { col: 'email_verified', sql: `ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS email_verified boolean DEFAULT true` },
    { col: 'email_verification_tokens_table', sql: `CREATE TABLE IF NOT EXISTS public.email_verification_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL,
      used BOOLEAN DEFAULT false
    )` },
  ];
  for (const [name, p] of [['dev', pool], ['prod', auditPool]]) {
    for (const { col, sql } of migrations) {
      try {
        await p.query(sql);
        console.log(`✅ Startup migration (${name}): ${col} column ready`);
      } catch (err) {
        console.error(`⚠️  Startup migration (${name}): ${col} failed (non-fatal):`, err.message);
      }
    }
  }
})();

// ── Shared helper: send devotional push notification to all users ──
// tracks which UTC dates have already had a notification sent this server session
const devotionalNotificationSentDates = new Set();

async function sendDailyDevotionalNotification(reason) {
  const today = new Date().toISOString().slice(0, 10);
  if (devotionalNotificationSentDates.has(today)) {
    console.log(`📲 Devotional notification already sent for ${today} — skipping (${reason})`);
    return;
  }
  devotionalNotificationSentDates.add(today);

  console.log(`📲 Sending daily devotional push notification (${reason})...`);
  try {
    const tokenResult = await pool.query(`
      SELECT user_id, fcm_token
      FROM public.user
      WHERE fcm_token IS NOT NULL
        AND fcm_token != ''
        AND fcm_token LIKE 'ExponentPushToken%'
    `);

    if (tokenResult.rows.length === 0) {
      console.log('📲 No users with valid push tokens — skipping devotional notification');
      return;
    }

    console.log(`📲 Sending devotional notification to ${tokenResult.rows.length} users`);

    let successCount = 0;
    let failedCount = 0;
    const tokensToRemove = [];

    for (const user of tokenResult.rows) {
      const result = await sendPushNotification(
        user.fcm_token,
        "Daily Devotional 📖",
        "Today's devotional is ready. Tap to read and reflect.",
        { type: 'daily_devotional', screen: 'DailyDevotional' }
      );
      if (result.success) {
        successCount++;
      } else {
        failedCount++;
        if (result.shouldRemoveToken) tokensToRemove.push(user.user_id);
      }
    }

    if (tokensToRemove.length > 0) {
      await pool.query(
        'UPDATE public.user SET fcm_token = NULL WHERE user_id = ANY($1)',
        [tokensToRemove]
      );
      console.log(`🗑️  Removed ${tokensToRemove.length} invalid tokens`);
    }

    console.log(`✅ Devotional notification complete: ${successCount} sent, ${failedCount} failed`);
  } catch (error) {
    console.error('Devotional notification error:', error.message);
    devotionalNotificationSentDates.delete(today); // allow retry if it errored
  }
}

// ── Daily devotional push notification — 12:00 PM UTC (8 AM Eastern / 7 AM Central) ──
cron.schedule('0 12 * * *', () => sendDailyDevotionalNotification('scheduled cron'));

console.log('⏰ Daily devotional notification scheduled at 12:00 PM UTC (8 AM Eastern)');

// ── Auto-archive prayer requests older than 60 days — 3:00 AM UTC daily ──
cron.schedule('0 3 * * *', async () => {
  console.log('🗂️ Running auto-archive: setting active = 0 for requests older than 60 days...');
  try {
    const result = await pool.query(
      `UPDATE public.request SET active = 0
       WHERE active = 1
         AND timestamp < NOW() - INTERVAL '60 days'`
    );
    console.log(`🗂️ Auto-archive complete: ${result.rowCount} request(s) archived`);
  } catch (error) {
    console.error('Auto-archive cron error:', error.message);
  }
});
console.log('⏰ Auto-archive cron scheduled at 3:00 AM UTC (requests older than 60 days)');

// ── Pending testimony reminders — 1:00 PM UTC daily (9 AM Eastern) ──
// Notifies users with open requests at 7-day intervals (covers 7, 14, 30-day milestones)
cron.schedule('0 13 * * *', async () => {
  console.log('🙏 Running pending testimony reminder cron...');
  try {
    // Find all users with qualifying open requests and their push token
    const result = await pool.query(`
      SELECT
        u.user_id,
        u.fcm_token,
        COALESCE(s.push_notifications, TRUE) as push_notifications,
        COUNT(r.request_id) as qualifying_count,
        ARRAY_AGG(r.request_id) as request_ids
      FROM public.request r
      INNER JOIN public."user" u ON u.user_id = r.user_id
      LEFT JOIN public.settings s ON s.user_id = r.user_id
      WHERE
        r.active = 1
        AND r.timestamp < NOW() - INTERVAL '7 days'
        AND (r.last_reminder_sent IS NULL OR r.last_reminder_sent < NOW() - INTERVAL '7 days')
        AND u.fcm_token IS NOT NULL
        AND u.fcm_token != ''
      GROUP BY u.user_id, u.fcm_token, s.push_notifications
    `);

    console.log(`🙏 Found ${result.rows.length} user(s) with qualifying prayer requests`);

    let notified = 0;
    for (const user of result.rows) {
      if (!user.push_notifications) continue;

      const count = parseInt(user.qualifying_count);
      const title = 'Has God answered your prayer? 🙏';
      const body = `You have ${count} prayer request${count !== 1 ? 's' : ''} that may be ready for a testimony. Open Pray Over Us to share what God did!`;
      const data = {
        type: 'pending_testimony',
        requestId: user.request_ids[0].toString(),
        userId: user.user_id.toString()
      };

      try {
        const pushResult = await sendPushNotification(user.fcm_token, title, body, data);

        if (pushResult.shouldRemoveToken) {
          await pool.query('UPDATE public."user" SET fcm_token = NULL WHERE user_id = $1', [user.user_id]);
          console.log(`🗑️ Removed invalid token for user ${user.user_id}`);
        } else {
          // Mark last_reminder_sent on all qualifying requests for this user
          await pool.query(
            'UPDATE public.request SET last_reminder_sent = NOW() WHERE request_id = ANY($1)',
            [user.request_ids]
          );
          notified++;
          console.log(`🙏 Reminder sent to user ${user.user_id} (${count} request${count !== 1 ? 's' : ''})`);
        }
      } catch (pushErr) {
        console.error(`🙏 Failed to send reminder to user ${user.user_id}:`, pushErr.message);
      }
    }

    console.log(`🙏 Testimony reminder cron complete: ${notified} user(s) notified`);
  } catch (error) {
    console.error('🙏 Testimony reminder cron error:', error.message);
  }
});
console.log('⏰ Pending testimony reminder cron scheduled at 1:00 PM UTC (9 AM Eastern)');

// ── Push token cleanup — 4:00 AM UTC daily ──────────────────────────────────
// Removes push tokens that haven't been updated in 90+ days (stale/abandoned devices)
cron.schedule('0 4 * * *', async () => {
  try {
    const result = await pool.query(`
      UPDATE public."user"
      SET fcm_token = NULL
      WHERE fcm_token IS NOT NULL
        AND fcm_token_updated < NOW() - INTERVAL '90 days'
    `);
    if (result.rowCount > 0) {
      console.log(`🗑️  Push token cleanup: removed ${result.rowCount} stale token(s) older than 90 days`);
    }
  } catch (err) {
    console.error('Push token cleanup cron error:', err.message);
  }
});
console.log('⏰ Push token cleanup scheduled at 4:00 AM UTC (tokens older than 90 days)');

// ──────────────────────────────────────────────────────────────────────────────

// Start server on 0.0.0.0 for public accessibility
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`API endpoint: http://0.0.0.0:${PORT}/api/requests`);
  console.log(`WebSocket (Group Rosary) ready on ws://0.0.0.0:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  await pool.end();
  process.exit(0);
});