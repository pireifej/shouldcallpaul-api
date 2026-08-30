'use strict';

const WEBSITE_REQUEST_SOURCE = 'website';
const WEBSITE_DAILY_LIMIT_CODE = 'WEBSITE_DAILY_LIMIT';
const WEBSITE_DOWNLOAD_URL = 'https://prayoverus.com/download';
const WEBSITE_DAILY_LIMIT_MESSAGE =
  'You can post one prayer request per day from the website. To post additional requests, download the Pray Over Us app and sign in with the same credentials.';

// Temporary targeted limit list. Move this to a user-level database setting
// when the admin UI needs to manage these limits without a code change.
const USER_DAILY_POST_LIMIT_USER_IDS = Object.freeze([1393, 1400]);
const USER_DAILY_POST_LIMIT_CODE = 'USER_DAILY_POST_LIMIT';
const USER_DAILY_POST_LIMIT_MESSAGE =
  'You can post one prayer request per day. Your limit resets at midnight UTC.';

function getUtcCalendarDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function isUserDailyPostLimited(userId) {
  const numericUserId = Number(userId);
  return Number.isInteger(numericUserId) &&
    USER_DAILY_POST_LIMIT_USER_IDS.includes(numericUserId);
}

function userDailyPostLimitPayload() {
  return {
    error: 1,
    code: USER_DAILY_POST_LIMIT_CODE,
    result: USER_DAILY_POST_LIMIT_MESSAGE
  };
}

function sendUserDailyPostLimitResponse(res) {
  return res.status(429).json(userDailyPostLimitPayload());
}

async function checkUserDailyPostLimit(pool, params, now = new Date()) {
  const userId = Number(params?.userId ?? params?.user_id);
  if (!isUserDailyPostLimited(userId)) {
    return { limited: false, requestDate: null };
  }

  const requestDate = getUtcCalendarDate(now);
  const result = await pool.query(
    `SELECT request_id
     FROM public.request
     WHERE user_id = $1
       AND timestamp::date = $2::date
     LIMIT 1`,
    [userId, requestDate]
  );

  return {
    limited: result.rows.length > 0,
    requestDate
  };
}

function websiteDailyLimitPayload() {
  return {
    error: 1,
    code: WEBSITE_DAILY_LIMIT_CODE,
    result: WEBSITE_DAILY_LIMIT_MESSAGE,
    downloadUrl: WEBSITE_DOWNLOAD_URL
  };
}

function sendWebsiteDailyLimitResponse(res) {
  return res.status(429).json(websiteDailyLimitPayload());
}

async function checkWebsiteRequestLimit(pool, params, requestSource, now = new Date()) {
  if (requestSource !== WEBSITE_REQUEST_SOURCE) {
    return { limited: false, requestDate: null };
  }

  const requestDate = getUtcCalendarDate(now);
  const result = await pool.query(
    `SELECT request_id
     FROM public.request
     WHERE user_id = $1
       AND request_source = $2
       AND website_request_date = $3
     LIMIT 1`,
    [params.userId, WEBSITE_REQUEST_SOURCE, requestDate]
  );

  return {
    limited: result.rows.length > 0,
    requestDate
  };
}

module.exports = {
  WEBSITE_REQUEST_SOURCE,
  WEBSITE_DAILY_LIMIT_CODE,
  WEBSITE_DOWNLOAD_URL,
  WEBSITE_DAILY_LIMIT_MESSAGE,
  USER_DAILY_POST_LIMIT_USER_IDS,
  USER_DAILY_POST_LIMIT_CODE,
  USER_DAILY_POST_LIMIT_MESSAGE,
  getUtcCalendarDate,
  isUserDailyPostLimited,
  userDailyPostLimitPayload,
  sendUserDailyPostLimitResponse,
  checkUserDailyPostLimit,
  websiteDailyLimitPayload,
  sendWebsiteDailyLimitResponse,
  checkWebsiteRequestLimit
};