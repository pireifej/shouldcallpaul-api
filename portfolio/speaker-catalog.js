'use strict';
const { randomUUID } = require('node:crypto');
const seed = require('./speaker-catalog-seed');
const fail = (message, status = 400, details) => Object.assign(new Error(message), { status, details });
const own = (object, key) => Object.hasOwn(object, key);
const normalize = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase()
  .replace(/&/g, ' and ').replace(/['’‘]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() : '';
const states = ['draft', 'scheduled', 'complete', 'cancelled'];
const lock = db => db.query("SELECT pg_advisory_xact_lock(hashtext('speaker-catalog-writes'))");
async function ready(db) {
  const result = await db.query("SELECT to_regclass('public.speaker_workshop_topics') AS relation");
  return Boolean(result.rows[0]?.relation);
}
async function requireReady(db) {
  if (!await ready(db)) throw fail('Speaker catalog schema is pending. Prepare development and Publish the additive migration.', 503);
}
async function alias(db, title, topicId) {
  const key = normalize(title);
  if (key) await db.query(`INSERT INTO public.speaker_topic_aliases(normalized_title,topic_id)
    VALUES($1,$2) ON CONFLICT DO NOTHING`, [key, topicId]);
}
async function match(db, title) {
  const key = normalize(title);
  if (!key) return { state: 'unmatched', topic_ids: [], candidates: [] };
  const remembered = (await db.query('SELECT topic_id FROM public.speaker_title_mappings WHERE normalized_title=$1 ORDER BY topic_id', [key])).rows;
  if (remembered.length) return { state: 'matched', source: 'remembered', topic_ids: remembered.map(r => r.topic_id), candidates: [] };
  const topics = (await db.query(`SELECT DISTINCT t.id,t.content,t.category_id,t.catalog_hidden,t.archived
    FROM public.speaker_topics t LEFT JOIN public.speaker_topic_aliases a ON a.topic_id=t.id
    WHERE a.normalized_title=$1 OR t.catalog_title_key=$1 ORDER BY t.id`, [key])).rows;
  return {
    state: topics.length === 1 ? 'matched' : topics.length ? 'ambiguous' : 'unmatched',
    source: 'exact_or_alias',
    topic_ids: topics.length === 1 ? [topics[0].id] : [],
    candidates: topics.map(t => ({ id: t.id, title: t.content.title, category_id: t.category_id,
      catalog_hidden: t.catalog_hidden, archived: t.archived }))
  };
}
function publicContent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('New topic must be an object');
  const allowed = ['title','description','category_id','type','parts','public_copy_confirmed'];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw fail(`Unknown new topic field: ${key}`);
  if (input.public_copy_confirmed !== true) throw fail('public_copy_confirmed must be true for reusable, client-neutral offering copy');
  for (const [key, max] of [['title',200],['description',2000],['category_id',200]]) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > max) throw fail(`${key} must be nonempty text (maximum ${max} characters)`);
  }
  const type = input.type ?? 'workshop';
  if (!['workshop','series','program','presentation'].includes(type)) throw fail('Invalid topic type');
  if (input.parts !== undefined && (!Array.isArray(input.parts) || input.parts.length > 50 ||
      input.parts.some(p => typeof p !== 'string' || !p.trim() || p.length > 200))) throw fail('parts must be an array of nonempty short strings');
  const copy = [input.title,input.description,...(input.parts || [])].join(' ');
  if (/<[^>]*>|https?:\/\/|[\w.+-]+@[\w.-]+|\$\s*\d|\b\d{4}-\d{2}-\d{2}\b/i.test(copy)) {
    throw fail('Offering copy must be plain, reusable text without links, email addresses, fees, or event dates');
  }
  return { type, title: input.title.trim(), description: input.description.trim(),
    ...(input.parts ? { parts: input.parts.map(p => p.trim()) } : {}) };
}
async function createTopic(db, input) {
  const content = publicContent(input);
  const category = await db.query('SELECT id FROM public.speaker_categories WHERE id=$1', [input.category_id]);
  if (!category.rows.length) throw fail('Unknown speaker category');
  const existing = await match(db, content.title);
  if (existing.state === 'ambiguous' || existing.topic_ids.length > 1) throw fail('Offering title is ambiguous; choose existing topic IDs', 409, existing);
  if (existing.topic_ids.length === 1) return existing.topic_ids[0];
  const id = randomUUID();
  content.id = id;
  await db.query(`INSERT INTO public.speaker_topics(id,category_id,published,content,catalog_title_key,sort_order)
    VALUES($1,$2,true,$3,$4,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM public.speaker_topics WHERE category_id=$2))`,
  [id,input.category_id,JSON.stringify(content),normalize(content.title)]);
  await alias(db, content.title, id);
  return id;
}
async function links(db, id) {
  return (await db.query('SELECT topic_id,source FROM public.speaker_workshop_topics WHERE resume_entry_id=$1 ORDER BY topic_id', [id])).rows;
}
async function reconcileWorkshop(db, workshop, choice) {
  if (choice !== undefined) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw fail('catalog must be an object');
    for (const key of Object.keys(choice)) if (!['topic_ids','new_topics','remember_title'].includes(key)) throw fail(`Unknown catalog field: ${key}`);
    if (choice.remember_title !== undefined && typeof choice.remember_title !== 'boolean') throw fail('remember_title must be boolean');
    if (!Array.isArray(choice.topic_ids ?? []) || (choice.topic_ids ?? []).some(id => typeof id !== 'string' || !id.trim()) ||
      !Array.isArray(choice.new_topics ?? []) || (choice.topic_ids?.length || 0) + (choice.new_topics?.length || 0) > 30) throw fail('Provide topic_ids and/or new_topics arrays, maximum 30 topics');
    if (!own(choice,'topic_ids') && !own(choice,'new_topics')) throw fail('catalog requires topic_ids or new_topics');
    const ids = [...new Set(choice.topic_ids || [])];
    for (const id of ids) if (!(await db.query('SELECT id FROM public.speaker_topics WHERE id=$1', [id])).rows.length) throw fail(`Unknown speaker topic: ${id}`);
    for (const input of choice.new_topics || []) ids.push(await createTopic(db,input));
    const unique = [...new Set(ids)];
    await db.query('UPDATE public.resume_workshops SET catalog_topics_explicit=true WHERE id=$1', [workshop.id]);
    await db.query('DELETE FROM public.speaker_workshop_topics WHERE resume_entry_id=$1', [workshop.id]);
    for (const id of unique) await db.query("INSERT INTO public.speaker_workshop_topics(resume_entry_id,topic_id,source) VALUES($1,$2,'explicit')", [workshop.id,id]);
    // Empty selection intentionally stays unlinked until a later title edit/save.
    // An empty remembered set cannot be confused with an affirmative match.
    const key = normalize(workshop.label);
    if (choice.remember_title !== false && key && unique.length) {
      await db.query('DELETE FROM public.speaker_title_mappings WHERE normalized_title=$1', [key]);
      for (const id of unique) await db.query('INSERT INTO public.speaker_title_mappings(normalized_title,topic_id) VALUES($1,$2)', [key,id]);
    }
    return;
  }
  const parent = (await db.query('SELECT catalog_topics_explicit FROM public.resume_workshops WHERE id=$1',[workshop.id])).rows[0];
  if (parent?.catalog_topics_explicit || (await links(db, workshop.id)).some(row => row.source === 'explicit')) return;
  const resolution = await match(db, workshop.label);
  await db.query("DELETE FROM public.speaker_workshop_topics WHERE resume_entry_id=$1 AND source='automatic'", [workshop.id]);
  for (const id of resolution.topic_ids) await db.query(`INSERT INTO public.speaker_workshop_topics(resume_entry_id,topic_id,source)
    VALUES($1,$2,'automatic') ON CONFLICT DO NOTHING`, [workshop.id,id]);
}
async function reconcileAll(db) {
  const rows = (await db.query('SELECT id,label FROM public.resume_workshops ORDER BY id')).rows;
  for (const workshop of rows) await reconcileWorkshop(db,workshop);
}
async function metadata(db, row) {
  const selected = await links(db,row.id);
  const suggestion = await match(db,row.label);
  return { completion_status: row.completion_status, topic_ids: selected.map(r => r.topic_id),
    match_state: selected.length ? 'linked' : suggestion.state, suggestion };
}
async function review(db) {
  const rows = (await db.query('SELECT id,label,published,completion_status FROM public.resume_workshops ORDER BY sort_order,id')).rows;
  const records = [];
  for (const row of rows) records.push({ ...row, catalog: await metadata(db,row) });
  return { linked: records.filter(r => r.catalog.topic_ids.length), needs_review: records.filter(r => !r.catalog.topic_ids.length) };
}
async function initialize(db) {
  await lock(db);
  const marker = 'delivered-speaker-catalog-v1';
  if ((await db.query('SELECT name FROM public.portfolio_migrations WHERE name=$1',[marker])).rows.length) return;
  // Only the verified public-history baseline is completed; never infer from age.
  await db.query("UPDATE public.resume_workshops SET completion_status='complete' WHERE id=ANY($1::text[])", [seed.verifiedCompletedIds]);
  const topics = (await db.query('SELECT * FROM public.speaker_topics ORDER BY id')).rows;
  for (const topic of topics) {
    await alias(db,topic.content.title,topic.id);
    const key = normalize(topic.content.title);
    // Existing duplicate normalized titles remain ambiguous rather than merged.
    if (!(await db.query('SELECT id FROM public.speaker_topics WHERE catalog_title_key=$1',[key])).rows.length) {
      await db.query('UPDATE public.speaker_topics SET catalog_title_key=$2 WHERE id=$1',[topic.id,key]);
    }
  }
  const career = topics.find(t => t.id === seed.career.id);
  if (career && [seed.career.oldTitle,seed.career.title].includes(career.content.title)) {
    await db.query(`UPDATE public.speaker_topics SET content=$2,catalog_title_key=$3 WHERE id=$1`,
      [career.id,JSON.stringify({...career.content,title:seed.career.title,description:seed.career.description}),normalize(seed.career.title)]);
    await alias(db,seed.career.title,career.id);
  }
  for (const [id,title] of seed.archive) {
    await db.query('UPDATE public.speaker_topics SET published=false,archived=true WHERE id=$1 AND content->>\'title\'=$2',[id,title]);
  }
  // Remove the one existing client-specific catalog title, not historical copy.
  const respect = topics.find(t => t.id === 'week_of_respect_franklin' &&
    t.content.title === 'Week of Respect Presentation — Franklin School');
  if (respect) {
    const content = { ...respect.content,title:'Week of Respect Presentation',
      description:'An engaging presentation promoting kindness, inclusion, and positive communication among students.' };
    await db.query('UPDATE public.speaker_topics SET content=$2,catalog_title_key=$3 WHERE id=$1',
      [respect.id,JSON.stringify(content),normalize(content.title)]);
    await alias(db,content.title,respect.id);
  }
  for (const [id,titles] of Object.entries(seed.aliases)) {
    if (topics.some(t => t.id === id)) for (const title of titles) await alias(db,title,id);
  }
  await reconcileAll(db);
  const result = await review(db);
  await db.query('INSERT INTO public.portfolio_migrations(name,imported_counts) VALUES($1,$2)',
    [marker,JSON.stringify({ linked:result.linked.length,needs_review:result.needs_review.length })]);
}
module.exports = { normalize, states, lock, ready, requireReady, alias, match, publicContent,
  createTopic, links, reconcileWorkshop, reconcileAll, metadata, review, initialize, fail };
