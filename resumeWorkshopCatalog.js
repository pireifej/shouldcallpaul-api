'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RESUME_WORKSHOPS_PATH = path.join(__dirname, 'resume_data', 'workshops.json');

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

function readResumeWorkshopIds() {
  // Read on each reference write so manually maintained changes take effect
  // without a cache or a second catalog in the database.
  const catalog = JSON.parse(fs.readFileSync(RESUME_WORKSHOPS_PATH, 'utf8'));
  return validateResumeWorkshopEntries(catalog.records);
}

function validateResumeEntryReference(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim()) {
    return 'resume_entry_id must be a non-empty string or null';
  }
  return readResumeWorkshopIds().has(value)
    ? null
    : 'resume_entry_id does not match an existing resume workshop entry';
}

module.exports = {
  RESUME_WORKSHOPS_PATH,
  validateResumeWorkshopEntries,
  readResumeWorkshopIds,
  validateResumeEntryReference
};
