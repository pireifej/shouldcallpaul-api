'use strict';

function validateResumeWorkshopEntries(records) {
  if (!Array.isArray(records)) throw new Error('Resume workshop catalog must contain records');
  const ids = new Set();
  for (const record of records) {
    if (typeof record.id !== 'string' || !record.id.trim() || ids.has(record.id)) {
      throw new Error('Resume workshop entries must have unique, non-empty permanent string IDs');
    }
    ids.add(record.id);
  }
  return ids;
}

async function validateResumeEntryReference(value, pool) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    return 'resume_entry_id must be a non-empty string or null';
  }
  const result = await pool.query('SELECT id FROM public.resume_workshops WHERE id = $1', [value]);
  return result.rows.length
    ? null
    : 'resume_entry_id does not match an existing resume workshop entry';
}

module.exports = {
  validateResumeWorkshopEntries,
  validateResumeEntryReference
};
