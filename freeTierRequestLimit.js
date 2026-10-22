'use strict';

const DAILY_LIMIT_RESPONSE = Object.freeze({
  error: 'DAILY_LIMIT_REACHED',
  message: 'Free tier is limited to 1 request per day. Upgrade to Pro for unlimited requests.'
});

// One app-wide day, not a caller-provided timezone or a rolling 24-hour window.
const POSTING_TIME_ZONE = 'America/New_York';
const postingDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: POSTING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function getPostingCalendarDate(now = new Date()) {
  const parts = Object.fromEntries(
    postingDateFormatter.formatToParts(now).map(({ type, value }) => [type, value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function checkFreeTierDailyLimit(pool, userId, isPro, now = new Date()) {
  if (isPro) return { limited: false, requestDate: null };

  const numericUserId = Number(userId);
  if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) {
    const error = new Error('userId must be a positive integer');
    error.statusCode = 400;
    throw error;
  }

  const requestDate = getPostingCalendarDate(now);
  const result = await pool.query(
    `SELECT request_id
     FROM public.request
     WHERE user_id = $1
       AND timestamp >= (($2::date::timestamp AT TIME ZONE '${POSTING_TIME_ZONE}') AT TIME ZONE 'UTC')
       AND timestamp < ((($2::date + 1)::timestamp AT TIME ZONE '${POSTING_TIME_ZONE}') AT TIME ZONE 'UTC')
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
  POSTING_TIME_ZONE,
  getPostingCalendarDate,
  checkFreeTierDailyLimit,
  sendFreeTierDailyLimitResponse
};
