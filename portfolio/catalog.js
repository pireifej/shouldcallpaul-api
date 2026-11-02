'use strict';

// Explicit allowlist: API category names never become arbitrary SQL identifiers.
const common = {
  image: 'text', label: 'text', type: 'text', desc: 'text', link: 'text',
  gallery: 'jsonb', details: 'jsonb'
};
const categories = Object.freeze({
  workshops: { table: 'resume_workshops', root: 'records', fields: {
    ...common, category: 'text', totalAttendance: 'integer'
  } },
  speech: { table: 'resume_speeches', root: 'records', fields: common },
  conference: { table: 'resume_conferences', root: 'records', fields: {
    ...common, agendaLink: 'text', powerpointLink: 'text', certificate: 'text'
  } },
  hackathon: { table: 'resume_hackathons', root: 'records', fields: {
    ...common, demoLink: 'text', powerpointLink: 'text', tech_stack: 'jsonb'
  } },
  patent: { table: 'resume_patents', root: 'records', fields: { ...common, disclosure: 'text' } },
  projects: { table: 'resume_projects', root: 'records', fields: common },
  races: { table: 'resume_races', root: 'records', fields: common },
  awards: { table: 'resume_awards', root: 'records', fields: {
    title: 'text', date: 'text', desc: 'text'
  } },
  certificates: { table: 'resume_certificates', root: 'certifications', fields: {
    designation: 'text', title: 'text', issuingOrganization: 'text',
    completionDate: 'text', expirationDate: 'text', Identifier: 'text',
    formattedEntry: 'text', Description: 'text'
  } },
  testimonials: { table: 'resume_testimonials', root: 'records', fields: {
    name: 'text', title: 'text', organization: 'text', quote: 'text',
    event: 'text', date: 'text', category: 'text'
  } }
});
const quote = key => `"${key}"`;
const categoryName = value => value.replace(/\.json$/, '');

function validateEntry(category, entry) {
  const config = categories[category];
  if (!config || !entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return 'entry must be an object in a supported category';
  }
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'id') {
      if (typeof value !== 'string' || !value.trim() || value !== value.trim()) return 'id must be a non-empty string';
      continue;
    }
    if (key === 'sessions' && category === 'workshops') {
      if (!Array.isArray(value)) return 'sessions must be an array';
      for (const s of value) {
        if (!s || typeof s !== 'object' || Array.isArray(s)) return 'sessions must contain objects';
        if (s.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) return 'session time must be HH:MM';
        if (s.timeZone !== undefined) {
          try { new Intl.DateTimeFormat('en', { timeZone: s.timeZone }); }
          catch { return 'Invalid session timeZone'; }
        }
        for (const field of ['attendees', 'durationMinutes']) {
          if (s[field] !== undefined && s[field] !== null &&
              (!Number.isInteger(s[field]) || s[field] < 0)) return `session ${field} must be a non-negative integer or null`;
        }
      }
      continue;
    }
    const type = Object.hasOwn(config.fields, key) ? config.fields[key] : null;
    if (!type) return `Unknown entry field: ${key}`;
    if (value === null) continue;
    if (type === 'text' && typeof value !== 'string') return `${key} must be text or null`;
    if (type === 'integer' && (!Number.isInteger(value) || value < 0)) return `${key} must be a non-negative integer or null`;
    if (type === 'jsonb') {
      if (['gallery', 'tech_stack'].includes(key)) {
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) return `${key} must be an array of strings`;
      } else if (typeof value !== 'object' || Array.isArray(value)) return `${key} must be an object`;
    }
  }
  return null;
}

module.exports = { categories, quote, categoryName, validateEntry };
