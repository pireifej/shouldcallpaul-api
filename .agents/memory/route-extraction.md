---
name: Route extraction — factory pattern
description: How server.js routes were split into routes/ files using a factory/context pattern
---

# Route Extraction Architecture

## Pattern
Each route file exports a factory function: `module.exports = function xRoutes(ctx) { const router = express.Router(); ... return router; }`

Server.js calls: `app.use(xRoutes(ctx))` after ALL helpers and shared state are defined.

## Why
server.js was 5,278 lines with 58 endpoints. Now 1,238 lines (setup + helpers + crons only).

## Route files (routes/)
- misc.js      — /, health, getAllChurches
- auth.js      — login, requestPasswordReset, reset, resetPassword
- users.js     — getUser, getUserByEmail, getUsersByChurch, updateUser, deleteUser, registerFCMToken, createUser, uploadProfilePicture, getUserBadges
- prayers.js   — createRequestAndPrayer, prayFor, getCommunityWall, getMyRequests, getAnsweredPrayers, editRequest, and 15 more prayer endpoints
- devotional.js — getDailyDevotional, generateDevotional, getDailyBreadAudio, getFaithRanks, readDailyBread
- blog.js      — getAllBlogArticles, getBlogArticle, admin blog CRUD
- admin.js     — sendBroadcastEmail, sendBroadcastNotification, debug, createBackup, getChatCompletion
- resume.js    — contact, resume/:filename
- rosary.js    — rosary/complete, rosary-room/:code

## What stays in server.js
All shared helpers, DB pools, clients (openai, pexels), caches, auth middleware, rosary room state + WebSocket handler, devotional generation functions (used by crons too), backup function (used by cron), all cron jobs, server.listen.

## Key ctx object includes
pool, auditPool, openai, pexels, authenticate, bcrypt, generatePrayer, translateText, computeRank, awardBadge, loadFaithRanks, generateDailyDevotional, sendDailyDevotionalNotification, mailerSendSingle, createGmailTransporter, uploadImage, uploadImageFromUrl, sendPushNotification, prayerAudioCache, dailyBreadAudioCache, PRAYER_AUDIO_DIR, DEVOTIONAL_AUDIO_DIR, serveAudioBuffer, rooms, generateRoomCode, broadcastToRoom, getRoomState, assignDecades, runProdBackup, BACKUP_DIR, log, getBaseUrl, getRandomString, multer, fs, path, crypto, PORT

## ctx placement
ctx must be defined AFTER all helpers (including runProdBackup at ~line 5038). The route requires (require('./routes/...')) happen early but the factory is only called via app.use() which comes after ctx is built.

## Pitfalls encountered
- serveAudioBuffer (defined between route handlers) needed to stay in server.js helpers and be passed via ctx — used by both devotional.js (getDailyBreadAudio) and prayers.js (getPrayerAudio)
- Functions shared by cron jobs AND routes (generateDailyDevotional, runProdBackup, sendDailyDevotionalNotification) stay in server.js scope and are also included in ctx
- Each route file's destructure must explicitly list all ctx vars it uses — silent undefined if omitted
