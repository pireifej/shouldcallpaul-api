'use strict';

const WEBSITE_REQUEST_SOURCE = 'website';
const WEBSITE_DAILY_LIMIT_CODE = 'WEBSITE_DAILY_LIMIT';
const WEBSITE_DOWNLOAD_URL = 'https://prayoverus.com/download';
const WEBSITE_DAILY_LIMIT_MESSAGE =
  'You can post one prayer request per day from the website. To post additional requests, download the Pray Over Us app and sign in with the same credentials.';

function getUtcCalendarDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
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
  getUtcCalendarDate,
  websiteDailyLimitPayload,
  sendWebsiteDailyLimitResponse,
  checkWebsiteRequestLimit
};