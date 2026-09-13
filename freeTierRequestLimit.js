'use strict';

const DAILY_LIMIT_RESPONSE = Object.freeze({
  error: 'DAILY_LIMIT_REACHED',
  message: 'Free tier is limited to 1 request per day. Upgrade to Pro for unlimited requests.'
});

function getUtcCalendarDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

async function checkFreeTierDailyLimit(pool, userId, isPro, now = new Date()) {
  if (isPro) return { limited: false, requestDate: null };

  const numericUserId = Number(userId);
  if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) {
    const error = new Error('userId must be a positive integer');
    error.statusCode = 400;
    throw error;
  }

  const requestDate = getUtcCalendarDate(now);
  const result = await pool.query(
    `SELECT request_id
     FROM public.request
     WHERE user_id = $1
       AND timestamp::date = $2::date
     LIMIT 1`,
    [numericUserId, requestDate]
  );

  return { limited: result.rows.length > 0, requestDate };
}

function sendFreeTierDailyLimitResponse(res) {
  return res.status(403).json(DAILY_LIMIT_RESPONSE);
}

module.exports = {
  DAILY_LIMIT_RESPONSE,
  getUtcCalendarDate,
  checkFreeTierDailyLimit,
  sendFreeTierDailyLimitResponse
};
