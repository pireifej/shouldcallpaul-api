'use strict';

const { checkFreeTierDailyLimit } = require('./freeTierRequestLimit');
const { WEBSITE_REQUEST_SOURCE } = require('./websiteRequestLimit');

// Generation happens BEFORE this transaction. Persist a complete request and
// its prayer atomically; a failed generation or failed write cannot spend quota.
async function persistCompletedPost({
  pool, userId, isPro, requestSource, postingNow, insertQuery, queryParams, prayerText, lang
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!isPro) {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [Number(userId)]);
    }
    // One instant for the recheck, calendar bucket and inserted UTC timestamp.
    const instant = postingNow();
    const limit = await checkFreeTierDailyLimit(client, userId, isPro, instant);
    if (limit.limited) {
      await client.query('ROLLBACK');
      return { limited: true };
    }
    const values = [...queryParams];
    values[10] = requestSource === WEBSITE_REQUEST_SOURCE ? limit.requestDate : null;
    values[11] = instant.toISOString();
    const inserted = await client.query(insertQuery, values);
    const requestId = inserted.rows[0].request_id;
    const prayer = await client.query(`
      INSERT INTO public.prayers (
        prayer_title, prayer_text, prayer_text_me, tags, active,
        prayer_file_name, prayer_en, prayer_es
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING prayer_id`,
    ['openAI-generated', prayerText, prayerText, 'openAI', 1, 'openAI',
      lang === 'en' ? prayerText : null, lang === 'es' ? prayerText : null]);
    const prayerId = prayer.rows[0].prayer_id;
    await client.query('UPDATE public.request SET fk_prayer_id = $1, active = 1 WHERE request_id = $2',
      [prayerId, requestId]);
    await client.query('COMMIT');
    return { limited: false, requestId, prayerId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { persistCompletedPost };
