'use strict';
const { randomUUID } = require('node:crypto');
const { categories, quote } = require('./catalog');

async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function recordFromRow(db, category, row) {
  const config = categories[category];
  const entry = {};
  // Preserve legacy field presence, nulls, and capitalization exactly.
  for (const key of row.field_names) {
    if (key === 'id') entry.id = row.id;
    else if (key !== 'sessions') entry[key] = row[key];
  }
  if (category === 'workshops' && row.field_names.includes('sessions')) {
    const sessions = await db.query(`SELECT content FROM public.resume_workshop_sessions
      WHERE resume_entry_id = $1 ORDER BY sort_order, id`, [row.id]);
    entry.sessions = sessions.rows.map(s => s.content);
  }
  return entry;
}

async function adminRecord(db, category, row) {
  return {
    id: row.id, published: row.published, sort_order: row.sort_order,
    organization_id: row.organization_id, created_at: row.created_at, updated_at: row.updated_at,
    entry: await recordFromRow(db, category, row)
  };
}

async function readFeed(db, category) {
  const config = categories[category];
  const rows = await db.query(`SELECT * FROM public.${config.table}
    WHERE published = true ORDER BY sort_order, id`);
  return { [config.root]: await Promise.all(rows.rows.map(row => recordFromRow(db, category, row))) };
}

async function saveEntry(db, category, input, current = null, { imported = false } = {}) {
  const config = categories[category];
  const id = current?.id || input.entry?.id || randomUUID();
  const prior = current ? await recordFromRow(db, category, current) : {};
  const entry = { ...prior, ...input.entry };
  // Existing legacy records retain their exact feed shape; new records expose IDs.
  if (!imported && !current) entry.id = id;
  const columns = Object.keys(config.fields);
  const values = [
    id, input.published ?? current?.published ?? imported,
    input.sort_order ?? current?.sort_order ?? 0,
    Object.hasOwn(input, 'organization_id') ? input.organization_id : current?.organization_id ?? null,
    Object.keys(entry)
  ];
  for (const key of columns) {
    const value = entry[key] ?? null;
    values.push(config.fields[key] === 'jsonb' && value !== null ? JSON.stringify(value) : value);
  }
  const names = ['id', 'published', 'sort_order', 'organization_id', 'field_names', ...columns];
  const placeholders = values.map((_, i) => `$${i + 1}`);
  let result;
  if (current) {
    result = await db.query(`UPDATE public.${config.table} SET
      ${names.slice(1).map((key, i) => `${quote(key)} = $${i + 2}`).join(', ')},
      updated_at = NOW() WHERE id = $1 RETURNING *`, values);
  } else {
    result = await db.query(`INSERT INTO public.${config.table}
      (${names.map(quote).join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`, values);
  }
  if (category === 'workshops' && Object.hasOwn(input.entry || {}, 'sessions')) {
    await db.query('DELETE FROM public.resume_workshop_sessions WHERE resume_entry_id = $1', [id]);
    for (const [index, session] of entry.sessions.entries()) {
      await db.query(`INSERT INTO public.resume_workshop_sessions
        (resume_entry_id, sort_order, time, time_zone, duration_minutes, attendees, content)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, index, session.time ?? null,
        session.timeZone ?? null, session.durationMinutes ?? null, session.attendees ?? null,
        JSON.stringify(session)]);
    }
  }
  return adminRecord(db, category, result.rows[0]);
}

async function readSpeakerMenu(db) {
  const settings = await db.query('SELECT title, subtitle FROM public.speaker_menu WHERE id = 1');
  if (!settings.rows.length) throw new Error('Speaker menu has not been imported');
  const groups = await db.query('SELECT * FROM public.speaker_categories WHERE published ORDER BY sort_order, id');
  const categories = [];
  for (const group of groups.rows) {
    const topics = await db.query(`SELECT content FROM public.speaker_topics
      WHERE category_id = $1 AND published ORDER BY sort_order, id`, [group.id]);
    categories.push({ ...group.content, items: topics.rows.map(t => t.content) });
  }
  return { ...settings.rows[0], categories };
}

async function buildResumeContext(db) {
  const sections = [];
  for (const category of Object.keys(categories)) {
    const feed = await readFeed(db, category);
    sections.push(`${category.toUpperCase()}:\n` + feed[categories[category].root].map(entry =>
      JSON.stringify(entry).replace(/<[^>]+>/g, ' ').slice(0, 1600)).join('\n'));
  }
  const menu = await readSpeakerMenu(db);
  sections.push('SPEAKING TOPICS:\n' + menu.categories.flatMap(c => c.items.map(i => i.title)).join('\n'));
  return sections.join('\n\n');
}

module.exports = { transaction, recordFromRow, adminRecord, readFeed, saveEntry, readSpeakerMenu, buildResumeContext };
