'use strict';
const { transaction, saveEntry } = require('./store');

const GROUPS = new Set([
  'EDUCATORS & SCHOOL STAFF', 'STUDENTS', 'WORKSHOP & EVENT ATTENDEES', 'COLLEAGUES'
]);

// One-off content import, not a runtime data source or startup migration.
function parseTestimonials(text, expectedCount = 18) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const entries = [];
  let category;
  for (let i = 0; i < lines.length; i++) {
    if (GROUPS.has(lines[i])) { category = lines[i]; continue; }
    const heading = lines[i].match(/^(\d+)\. (.+)$/);
    if (!heading) continue;
    if (!category || Number(heading[1]) !== entries.length + 1) throw new Error('Unexpected testimonial order or group');
    const take = label => {
      const line = lines[++i];
      if (!line?.startsWith(label)) throw new Error(`Missing ${label} for ${heading[2]}`);
      return line.slice(label.length);
    };
    const attribution = take('Attribution: ');
    const event = take('Context: ');
    let date = '';
    if (lines[i + 1]?.startsWith('Year: ')) {
      date = take('Year: ');
      if (!/^\d{4}$/.test(date)) throw new Error('Invalid supplied year');
    }
    if (lines[++i] !== 'Quote:') throw new Error('Missing Quote:');
    const quote = lines[++i];
    if (!quote?.startsWith('“') || !quote.endsWith('”')) throw new Error('Expected an exact, quoted testimonial paragraph');
    const comma = attribution.indexOf(', ');
    entries.push({
      name: heading[2], title: comma < 0 ? attribution : attribution.slice(0, comma),
      organization: comma < 0 ? '' : attribution.slice(comma + 2),
      event, date, category, quote: quote.slice(1, -1)
    });
  }
  if (entries.length !== expectedCount) throw new Error(`Expected ${expectedCount} testimonials, found ${entries.length}`);
  if (new Set(entries.map(e => JSON.stringify([e.name, e.event]))).size !== entries.length) {
    throw new Error('Duplicate source testimonial identity');
  }
  return entries;
}

function matchingRows(rows, entry) {
  return rows.filter(row => row.name === entry.name && (
    row.event === entry.event ||
    // Explicit reconciliation requested by the owner; not general name matching.
    (entry.name === 'Glenn Talavera' &&
      entry.event === 'Monmouth County · Public Speaking & Active Listening' &&
      row.event === 'Monmouth County Employee Development Expo')
  ));
}

async function importTestimonials(pool, entries, { dryRun = false } = {}) {
  return transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('website-testimonial-content-import'))");
    const existing = (await db.query('SELECT * FROM public.resume_testimonials FOR UPDATE')).rows;
    const plan = entries.map((entry, sort_order) => {
      const candidates = matchingRows(existing, entry);
      if (candidates.length > 1) throw new Error(`Ambiguous existing testimonial: ${entry.name} / ${entry.event}`);
      const current = candidates[0] || null;
      return { current, sort_order, entry: {
        ...entry, date: current?.date?.trim() ? current.date : entry.date
      } };
    });
    const updates = plan.filter(p => p.current).length;
    const result = {
      created: plan.length - updates, matched: updates,
      preserved_other_records: existing.length - updates,
      entries: plan.map(p => ({ name: p.entry.name, event: p.entry.event, date: p.entry.date,
        category: p.entry.category, existing_id: p.current?.id ?? null }))
    };
    if (dryRun) return result;
    for (const item of plan) {
      const unchanged = item.current?.published && item.current.sort_order === item.sort_order &&
        Object.entries(item.entry).every(([key, value]) => item.current[key] === value);
      if (!unchanged) await saveEntry(db, 'testimonials', {
        entry: item.entry, published: true, sort_order: item.sort_order
      }, item.current);
    }
    const saved = (await db.query('SELECT * FROM public.resume_testimonials ORDER BY sort_order, id')).rows;
    for (const [index, item] of plan.entries()) {
      const matches = matchingRows(saved, item.entry);
      if (matches.length !== 1 || !matches[0].published || matches[0].sort_order !== index ||
          !Object.entries(item.entry).every(([key, value]) => matches[0][key] === value)) {
        throw new Error('Post-import verification failed; rolling back testimonial import');
      }
    }
    if (saved.length !== existing.length + result.created) throw new Error('Unexpected testimonial count; rolling back');
    return result;
  });
}

module.exports = { parseTestimonials, importTestimonials, matchingRows };
