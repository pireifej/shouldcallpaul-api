'use strict';

// The legacy nullable slot remains writable by older clients. Never backfill it
// into the junction: doing so would make an old client's unlink ineffective.
function resumeIdsSql(alias) {
  if (!['w', 'crm_workshops'].includes(alias)) throw new Error('Invalid workshop alias');
  return `ARRAY(
    SELECT l.resume_entry_id FROM public.crm_workshop_resume_links l WHERE l.workshop_id = ${alias}.id
    UNION SELECT ${alias}.resume_entry_id WHERE ${alias}.resume_entry_id IS NOT NULL
    ORDER BY 1
  ) AS resume_entry_ids`;
}

function linkSchema(pool) {
  let ready;
  return () => ready ||= pool.query("SELECT to_regclass('public.crm_workshop_resume_links') AS relation")
    .then(result => {
      const exists = Boolean(result.rows[0]?.relation);
      if (!exists) console.warn('Many-to-many workshop links await the additive Publish migration; legacy links remain available.');
      return exists;
    }).catch(error => { ready = undefined; throw error; });
}

module.exports = { resumeIdsSql, linkSchema };
