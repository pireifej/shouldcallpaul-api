'use strict';
const express = require('express');
const fsSync = require('fs');
const pathMod = require('path');

// ── Build Paul's resume context once at startup from existing resume_data/ files ──
function stripHtml(str) {
  return (str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildPaulResumeContext() {
  const base = pathMod.join(__dirname, '..', 'resume_data');
  const sections = [];

  // Helper: read a JSON file safely
  function read(filename) {
    try { return JSON.parse(fsSync.readFileSync(pathMod.join(base, filename), 'utf8')); }
    catch { return null; }
  }

  // CERTIFICATIONS
  const certs = read('certificates.json');
  if (certs?.certifications?.length) {
    sections.push('CERTIFICATIONS:\n' + certs.certifications
      .map(c => `- ${c.title} (${c.issuingOrganization}, ${c.completionDate})${c.Description ? ': ' + c.Description.slice(0, 120) : ''}`)
      .join('\n'));
  }

  // AWARDS
  const awards = read('awards.json');
  if (awards?.records?.length) {
    sections.push('AWARDS & RECOGNITION:\n' + awards.records
      .map(a => `- ${a.title} (${a.date}): ${stripHtml(a.desc).slice(0, 120)}`)
      .join('\n'));
  }

  // PATENT
  const patents = read('patent.json');
  if (patents?.records?.length) {
    sections.push('PATENTS:\n' + patents.records
      .map(p => `- ${p.label}: ${stripHtml(p.desc).slice(0, 200)}`)
      .join('\n'));
  }

  // PROJECTS
  const projects = read('projects.json');
  if (projects?.records?.length) {
    sections.push('KEY PROJECTS:\n' + projects.records
      .map(p => `- ${p.label}${p.details?.technology ? ' | Tech: ' + p.details.technology : ''}: ${stripHtml(p.desc).slice(0, 200)}`)
      .join('\n'));
  }

  // CONFERENCE TALKS
  const conf = read('conference.json');
  if (conf?.records?.length) {
    sections.push('CONFERENCE TALKS:\n' + conf.records
      .map(c => `- ${c.label}: ${stripHtml(c.desc).slice(0, 150)}`)
      .join('\n'));
  }

  // HACKATHONS
  const hack = read('hackathon.json');
  if (hack?.records?.length) {
    sections.push('HACKATHONS:\n' + hack.records
      .map(h => `- ${h.label}: ${stripHtml(h.desc).slice(0, 150)}`)
      .join('\n'));
  }

  // WORKSHOPS DELIVERED
  const wkp = read('workshops.json');
  if (wkp?.records?.length) {
    sections.push('WORKSHOPS DELIVERED:\n' + wkp.records
      .map(w => `- ${w.label}${w.details?.date ? ' (' + w.details.date + ')' : ''}: ${stripHtml(w.desc).slice(0, 120)}`)
      .join('\n'));
  }

  // SPEECHES (Toastmasters / public speaking)
  const speech = read('speech.json');
  if (speech?.records?.length) {
    sections.push('PUBLIC SPEAKING / TOASTMASTERS:\n' + speech.records
      .map(s => `- ${s.label}: ${stripHtml(s.desc).slice(0, 100)}`)
      .join('\n'));
  }

  // Speaker topics (from speaker_menu.json)
  try {
    const sm = JSON.parse(fsSync.readFileSync(pathMod.join(__dirname, '..', 'speaker_data', 'speaker_menu.json'), 'utf8'));
    if (sm?.categories?.length) {
      const topics = sm.categories.flatMap(cat => cat.items?.map(i => i.title) || []);
      sections.push('SPEAKING TOPICS OFFERED:\n' + topics.map(t => `- ${t}`).join('\n'));
    }
  } catch {}

  return [
    'CANDIDATE: Paul Ireifej — Principal Data/Platform Engineer & AI Workshop Speaker',
    'BACKGROUND: 15+ years at AT&T as Principal Software Engineer. Surplus as of June 17, 2026 (LDP Sept 15, 2026). Deep expertise in Python, PySpark, Azure (AKS, ADF, Synapse, Fabric), Kubernetes/Helm, Terraform, RAG systems, agentic AI frameworks, ETL pipelines, ML deployment, and enterprise data engineering at scale. Also an active public speaker, Toastmasters member, and workshop facilitator on AI literacy and professional development.',
    ...sections
  ].join('\n\n');
}

// Cache it — built once when the module loads
let PAUL_RESUME_CONTEXT;
try {
  PAUL_RESUME_CONTEXT = buildPaulResumeContext();
  console.log(`📄 Paul resume context built (${PAUL_RESUME_CONTEXT.length} chars)`);
} catch (e) {
  PAUL_RESUME_CONTEXT = 'Paul Ireifej — Principal Software/Data Engineer with 15+ years at AT&T. Python, Azure, AKS, PySpark, ETL, agentic AI, RAG systems.';
  console.warn('⚠️  Resume context build failed, using fallback:', e.message);
}

module.exports = function crmRoutes(ctx) {
  const router = express.Router();
  // CRM data lives in the NEON (production) database
  const { auditPool: pool, authenticate, openai } = ctx;

  const ok  = (res, data)  => res.json({ success: true,  data });
  const err = (res, msg, status = 500) => res.status(status).json({ success: false, error: msg });

  // ─────────────────────────────────────────────────────────────
  // CONTACTS
  // ─────────────────────────────────────────────────────────────

  // GET /api/contacts?category=&search=
  router.get('/api/contacts', authenticate, async (req, res) => {
    try {
      const { category, search } = req.query;
      let query = `SELECT * FROM crm_contacts WHERE 1=1`;
      const params = [];
      if (category) { params.push(category); query += ` AND category = $${params.length}`; }
      if (search)   { params.push(`%${search}%`); query += ` AND (name ILIKE $${params.length} OR organization ILIKE $${params.length})`; }
      query += ` ORDER BY name ASC`;
      const result = await pool.query(query, params);
      ok(res, result.rows);
    } catch (e) { err(res, e.message); }
  });

  // GET /api/contacts/:id
  router.get('/api/contacts/:id', authenticate, async (req, res) => {
    try {
      const result = await pool.query(`SELECT * FROM crm_contacts WHERE id = $1`, [req.params.id]);
      if (!result.rows.length) return err(res, 'Contact not found', 404);
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  // POST /api/contacts
  router.post('/api/contacts', authenticate, async (req, res) => {
    try {
      const { name, title, organization, email, phone, linkedin_url, preferred_channel, category, last_contact_date, needs_followup, followup_date, notes } = req.body;
      if (!name) return err(res, 'name is required', 400);
      const result = await pool.query(
        `INSERT INTO crm_contacts (name, title, organization, email, phone, linkedin_url, preferred_channel, category, last_contact_date, needs_followup, followup_date, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [name, title, organization, email, phone, linkedin_url, preferred_channel, category, last_contact_date || null, needs_followup || false, followup_date || null, notes]
      );
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  // PUT /api/contacts/:id
  router.put('/api/contacts/:id', authenticate, async (req, res) => {
    try {
      const { id } = req.params;
      const fields = ['name','title','organization','email','phone','linkedin_url','preferred_channel','category','last_contact_date','needs_followup','followup_date','notes'];
      const updates = []; const params = [];
      for (const f of fields) {
        if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${params.length}`); }
      }
      if (!updates.length) return err(res, 'No fields to update', 400);
      params.push(id);
      const result = await pool.query(
        `UPDATE crm_contacts SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`, params
      );
      if (!result.rows.length) return err(res, 'Contact not found', 404);
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  router.patch('/api/contacts/:id', authenticate, async (req, res) => {
    try {
      const { id } = req.params;
      const fields = ['name','title','organization','email','phone','linkedin_url','preferred_channel','category','last_contact_date','needs_followup','followup_date','notes'];
      const updates = []; const params = [];
      for (const f of fields) {
        if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${params.length}`); }
      }
      if (!updates.length) return err(res, 'No fields to update', 400);
      params.push(id);
      const result = await pool.query(
        `UPDATE crm_contacts SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`, params
      );
      if (!result.rows.length) return err(res, 'Contact not found', 404);
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  // DELETE /api/contacts/:id
  router.delete('/api/contacts/:id', authenticate, async (req, res) => {
    try {
      const result = await pool.query(`DELETE FROM crm_contacts WHERE id = $1 RETURNING id`, [req.params.id]);
      if (!result.rows.length) return err(res, 'Contact not found', 404);
      ok(res, { deleted_id: result.rows[0].id });
    } catch (e) { err(res, e.message); }
  });

  // ─────────────────────────────────────────────────────────────
  // POSITIONS
  // ─────────────────────────────────────────────────────────────

  // helper — fetch linked contacts array for one or many position ids
  async function fetchPositionContacts(pool, positionIds) {
    if (!positionIds.length) return {};
    const result = await pool.query(
      `SELECT pc.position_id, c.id, c.name, c.title, c.organization, c.email, c.phone, c.linkedin_url
       FROM crm_position_contacts pc
       JOIN crm_contacts c ON c.id = pc.contact_id
       WHERE pc.position_id = ANY($1)
       ORDER BY pc.created_at ASC`,
      [positionIds]
    );
    const map = {};
    for (const row of result.rows) {
      const pid = row.position_id;
      if (!map[pid]) map[pid] = [];
      const { position_id, ...contact } = row;
      map[pid].push(contact);
    }
    return map;
  }

  // GET /api/positions?status=
  router.get('/api/positions', authenticate, async (req, res) => {
    try {
      const { status } = req.query;
      let query = `SELECT p.* FROM crm_positions p WHERE 1=1`;
      const params = [];
      if (status) { params.push(status); query += ` AND p.status = $${params.length}`; }
      query += ` ORDER BY p.updated_at DESC`;
      const result = await pool.query(query, params);
      const ids = result.rows.map(r => r.id);
      const contactsMap = await fetchPositionContacts(pool, ids);
      const rows = result.rows.map(r => ({ ...r, contacts: contactsMap[r.id] || [] }));
      ok(res, rows);
    } catch (e) { err(res, e.message); }
  });

  // GET /api/positions/:id
  router.get('/api/positions/:id', authenticate, async (req, res) => {
    try {
      const result = await pool.query(`SELECT p.* FROM crm_positions p WHERE p.id = $1`, [req.params.id]);
      if (!result.rows.length) return err(res, 'Position not found', 404);
      const pos = result.rows[0];
      const contactsMap = await fetchPositionContacts(pool, [pos.id]);
      ok(res, { ...pos, contacts: contactsMap[pos.id] || [] });
    } catch (e) { err(res, e.message); }
  });

  // GET /api/positions/:id/contacts
  router.get('/api/positions/:id/contacts', authenticate, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT c.id, c.name, c.title, c.organization, c.email, c.phone, c.linkedin_url, pc.created_at AS linked_at
         FROM crm_position_contacts pc
         JOIN crm_contacts c ON c.id = pc.contact_id
         WHERE pc.position_id = $1
         ORDER BY pc.created_at ASC`,
        [req.params.id]
      );
      ok(res, result.rows);
    } catch (e) { err(res, e.message); }
  });

  // POST /api/positions/:id/contacts — link a contact
  router.post('/api/positions/:id/contacts', authenticate, async (req, res) => {
    try {
      const { contact_id } = req.body;
      if (!contact_id) return err(res, 'contact_id is required', 400);
      await pool.query(
        `INSERT INTO crm_position_contacts (position_id, contact_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [req.params.id, contact_id]
      );
      const result = await pool.query(
        `SELECT c.id, c.name, c.title, c.organization, c.email, c.phone, c.linkedin_url
         FROM crm_contacts c WHERE c.id = $1`, [contact_id]
      );
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  // DELETE /api/positions/:id/contacts/:contact_id — unlink a contact
  router.delete('/api/positions/:id/contacts/:contact_id', authenticate, async (req, res) => {
    try {
      await pool.query(
        `DELETE FROM crm_position_contacts WHERE position_id = $1 AND contact_id = $2`,
        [req.params.id, req.params.contact_id]
      );
      ok(res, { unlinked: true });
    } catch (e) { err(res, e.message); }
  });

  // POST /api/positions
  router.post('/api/positions', authenticate, async (req, res) => {
    try {
      const { title, company, url, status, location, work_type, salary_range, hiring_manager_contact_id, recruiter_contact_id, required_tech_skills, parsed_summary, portal_url, portal_login_method } = req.body;
      if (!title || !company) return err(res, 'title and company are required', 400);
      const result = await pool.query(
        `INSERT INTO crm_positions (title, company, url, status, location, work_type, salary_range, hiring_manager_contact_id, recruiter_contact_id, required_tech_skills, parsed_summary, portal_url, portal_login_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [title, company, url, status || 'Targeted', location, work_type, salary_range,
         hiring_manager_contact_id || null, recruiter_contact_id || null,
         JSON.stringify(required_tech_skills || []), JSON.stringify(parsed_summary || {}),
         portal_url || null, portal_login_method || null]
      );
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  // shared handler for PUT + PATCH /api/positions/:id
  const updatePosition = async (req, res) => {
    try {
      const { id } = req.params;
      const body = { ...req.body };
      // Accept camelCase alias from frontend
      if (body.jobDescription !== undefined && body.job_description_text === undefined) {
        body.job_description_text = body.jobDescription;
      }
      const fields = ['title','company','url','status','location','work_type','salary_range','hiring_manager_contact_id','recruiter_contact_id','required_tech_skills','parsed_summary','notes','portal_url','portal_login_method','job_description_text'];
      const updates = []; const params = [];
      for (const f of fields) {
        if (body[f] !== undefined) {
          const val = (f === 'required_tech_skills' || f === 'parsed_summary') ? JSON.stringify(body[f]) : body[f];
          params.push(val); updates.push(`${f} = $${params.length}`);
        }
      }
      if (!updates.length) return err(res, 'No fields to update', 400);
      params.push(id);
      const result = await pool.query(
        `UPDATE crm_positions SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`, params
      );
      if (!result.rows.length) return err(res, 'Position not found', 404);
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  };
  router.put('/api/positions/:id', authenticate, updatePosition);
  router.patch('/api/positions/:id', authenticate, updatePosition);

  // DELETE /api/positions/:id
  router.delete('/api/positions/:id', authenticate, async (req, res) => {
    try {
      const result = await pool.query(`DELETE FROM crm_positions WHERE id = $1 RETURNING id`, [req.params.id]);
      if (!result.rows.length) return err(res, 'Position not found', 404);
      ok(res, { deleted_id: result.rows[0].id });
    } catch (e) { err(res, e.message); }
  });

  // ─────────────────────────────────────────────────────────────
  // WORKSHOPS
  // ─────────────────────────────────────────────────────────────

  // GET /api/workshops?status=
  router.get('/api/workshops', authenticate, async (req, res) => {
    try {
      const { status } = req.query;
      let query = `
        SELECT w.*, c.name AS contact_name, c.email AS contact_email
        FROM crm_workshops w
        LEFT JOIN crm_contacts c ON c.id = w.contact_id
        WHERE 1=1`;
      const params = [];
      if (status) { params.push(status); query += ` AND w.status = $${params.length}`; }
      query += ` ORDER BY w.updated_at DESC`;
      const result = await pool.query(query, params);
      ok(res, result.rows);
    } catch (e) { err(res, e.message); }
  });

  // GET /api/workshops/:id
  router.get('/api/workshops/:id', authenticate, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT w.*, c.name AS contact_name, c.email AS contact_email
        FROM crm_workshops w
        LEFT JOIN crm_contacts c ON c.id = w.contact_id
        WHERE w.id = $1`, [req.params.id]);
      if (!result.rows.length) return err(res, 'Workshop not found', 404);
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  // POST /api/workshops
  router.post('/api/workshops', authenticate, async (req, res) => {
    try {
      const { organization_name, contact_id, status, workshop_title, historical_date, cost_basis, notes } = req.body;
      if (!organization_name) return err(res, 'organization_name is required', 400);
      const result = await pool.query(
        `INSERT INTO crm_workshops (organization_name, contact_id, status, workshop_title, historical_date, cost_basis, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [organization_name, contact_id || null, status || 'Lead', workshop_title, historical_date || null, cost_basis, notes]
      );
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  // PUT /api/workshops/:id
  router.put('/api/workshops/:id', authenticate, async (req, res) => {
    try {
      const { id } = req.params;
      const fields = ['organization_name','contact_id','status','workshop_title','historical_date','cost_basis','notes'];
      const updates = []; const params = [];
      for (const f of fields) {
        if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${params.length}`); }
      }
      if (!updates.length) return err(res, 'No fields to update', 400);
      params.push(id);
      const result = await pool.query(
        `UPDATE crm_workshops SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`, params
      );
      if (!result.rows.length) return err(res, 'Workshop not found', 404);
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  router.patch('/api/workshops/:id', authenticate, async (req, res) => {
    try {
      const { id } = req.params;
      const fields = ['organization_name','contact_id','status','workshop_title','historical_date','cost_basis','notes'];
      const updates = []; const params = [];
      for (const f of fields) {
        if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${params.length}`); }
      }
      if (!updates.length) return err(res, 'No fields to update', 400);
      params.push(id);
      const result = await pool.query(
        `UPDATE crm_workshops SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`, params
      );
      if (!result.rows.length) return err(res, 'Workshop not found', 404);
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  // DELETE /api/workshops/:id
  router.delete('/api/workshops/:id', authenticate, async (req, res) => {
    try {
      const result = await pool.query(`DELETE FROM crm_workshops WHERE id = $1 RETURNING id`, [req.params.id]);
      if (!result.rows.length) return err(res, 'Workshop not found', 404);
      ok(res, { deleted_id: result.rows[0].id });
    } catch (e) { err(res, e.message); }
  });

  // ─────────────────────────────────────────────────────────────
  // ACTIVITY LOGS
  // ─────────────────────────────────────────────────────────────

  // GET /api/activity-logs?entity_type=&entity_id=&contact_id=
  router.get('/api/activity-logs', authenticate, async (req, res) => {
    try {
      const { entity_type, entity_id, contact_id } = req.query;
      let query = `
        SELECT al.*, c.name AS contact_name
        FROM crm_activity_logs al
        LEFT JOIN crm_contacts c ON c.id = al.contact_id
        WHERE 1=1`;
      const params = [];
      if (entity_type) { params.push(entity_type); query += ` AND al.entity_type = $${params.length}`; }
      if (entity_id)   { params.push(entity_id);   query += ` AND al.entity_id = $${params.length}`; }
      if (contact_id)  { params.push(contact_id);  query += ` AND al.contact_id = $${params.length}`; }
      query += ` ORDER BY al.log_date DESC`;
      const result = await pool.query(query, params);
      ok(res, result.rows);
    } catch (e) { err(res, e.message); }
  });

  // GET /api/activity-logs/:id
  router.get('/api/activity-logs/:id', authenticate, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT al.*, c.name AS contact_name
         FROM crm_activity_logs al
         LEFT JOIN crm_contacts c ON c.id = al.contact_id
         WHERE al.id = $1`,
        [req.params.id]
      );
      if (!result.rows.length) return err(res, 'Activity log not found', 404);
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  // PUT + PATCH /api/activity-logs/:id
  const updateActivityLog = async (req, res) => {
    try {
      const { id } = req.params;
      const fields = ['log_text', 'contact_id', 'log_date'];
      const updates = []; const params = [];
      for (const f of fields) {
        if (req.body[f] !== undefined) { params.push(req.body[f]); updates.push(`${f} = $${params.length}`); }
      }
      if (!updates.length) return err(res, 'No fields to update', 400);
      params.push(id);
      const result = await pool.query(
        `UPDATE crm_activity_logs SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`, params
      );
      if (!result.rows.length) return err(res, 'Activity log not found', 404);
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  };
  router.put('/api/activity-logs/:id', authenticate, updateActivityLog);
  router.patch('/api/activity-logs/:id', authenticate, updateActivityLog);

  // DELETE /api/activity-logs/:id
  router.delete('/api/activity-logs/:id', authenticate, async (req, res) => {
    try {
      const result = await pool.query(`DELETE FROM crm_activity_logs WHERE id = $1 RETURNING id`, [req.params.id]);
      if (!result.rows.length) return err(res, 'Activity log not found', 404);
      ok(res, { deleted_id: result.rows[0].id });
    } catch (e) { err(res, e.message); }
  });

  // POST /api/activity-logs
  router.post('/api/activity-logs', authenticate, async (req, res) => {
    try {
      const { entity_type, entity_id, contact_id, log_text } = req.body;
      if (!entity_type || !entity_id || !log_text) return err(res, 'entity_type, entity_id, and log_text are required', 400);
      const validTypes = ['position', 'workshop', 'contact'];
      if (!validTypes.includes(entity_type)) return err(res, `entity_type must be one of: ${validTypes.join(', ')}`, 400);

      // Insert log (log_date defaults to CURRENT_TIMESTAMP in schema)
      const result = await pool.query(
        `INSERT INTO crm_activity_logs (entity_type, entity_id, contact_id, log_text)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [entity_type, entity_id, contact_id || null, log_text]
      );

      // Update the contact's last_contact_date if a contact_id was provided
      if (contact_id) {
        await pool.query(
          `UPDATE crm_contacts SET last_contact_date = NOW() WHERE id = $1`,
          [contact_id]
        );
      }

      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  // ─────────────────────────────────────────────────────────────
  // INTERVIEW PREP
  // ─────────────────────────────────────────────────────────────

  // GET /api/positions/:id/interview-prep
  router.get('/api/positions/:id/interview-prep', authenticate, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT
           ip.id,
           ip.position_id,
           ip.skill_gap_analysis,
           ip.company_news_talking_points,
           ip.prep_notes AS "prepNotes",
           ip.ai_generated_content AS "aiGeneratedContent",
           ip.updated_at,
           p.title AS position_title,
           p.company
         FROM crm_interview_preps ip
         JOIN crm_positions p ON p.id = ip.position_id
         WHERE ip.position_id = $1`,
        [req.params.id]
      );
      // Intentionally exclude legacy freeform_notes and aiContentOverride.
      // Personal notes and AI output are read from their dedicated columns only.
      // Return empty object if no prep exists yet — not a 404
      ok(res, result.rows[0] || null);
    } catch (e) { err(res, e.message); }
  });

  // PUT /api/positions/:id/interview-prep (upsert)
  const saveInterviewPrep = async (req, res) => {
    try {
      const position_id = req.params.id;
      const {
        skill_gap_analysis,
        company_news_talking_points,
        prepNotes,
        aiGeneratedContent
      } = req.body;

      // Presence checks allow partial updates. For example, clearing only
      // aiGeneratedContent must never overwrite prepNotes or legacy freeform_notes.
      const hasSkillGapAnalysis = Object.prototype.hasOwnProperty.call(req.body, 'skill_gap_analysis');
      const hasCompanyNews = Object.prototype.hasOwnProperty.call(req.body, 'company_news_talking_points');
      const hasPrepNotes = Object.prototype.hasOwnProperty.call(req.body, 'prepNotes');
      const hasAiGeneratedContent = Object.prototype.hasOwnProperty.call(req.body, 'aiGeneratedContent');

      const result = await pool.query(
        `INSERT INTO crm_interview_preps (
           position_id,
           skill_gap_analysis,
           company_news_talking_points,
           prep_notes,
           ai_generated_content
         )
          VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (position_id) DO UPDATE SET
            skill_gap_analysis = CASE WHEN $6 THEN EXCLUDED.skill_gap_analysis ELSE crm_interview_preps.skill_gap_analysis END,
            company_news_talking_points = CASE WHEN $7 THEN EXCLUDED.company_news_talking_points ELSE crm_interview_preps.company_news_talking_points END,
            prep_notes = CASE WHEN $8 THEN EXCLUDED.prep_notes ELSE crm_interview_preps.prep_notes END,
            ai_generated_content = CASE WHEN $9 THEN EXCLUDED.ai_generated_content ELSE crm_interview_preps.ai_generated_content END,
           updated_at = NOW()
          RETURNING
            id,
            position_id,
            skill_gap_analysis,
            company_news_talking_points,
            prep_notes AS "prepNotes",
            ai_generated_content AS "aiGeneratedContent",
            updated_at`,
        [position_id,
         hasSkillGapAnalysis ? JSON.stringify(skill_gap_analysis) : null,
         hasCompanyNews ? JSON.stringify(company_news_talking_points) : null,
         hasPrepNotes ? prepNotes : null,
         hasAiGeneratedContent ? JSON.stringify(aiGeneratedContent) : null,
         hasSkillGapAnalysis,
         hasCompanyNews,
         hasPrepNotes,
         hasAiGeneratedContent]
      );
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  };

  router.put('/api/positions/:id/interview-prep', authenticate, saveInterviewPrep);
  router.patch('/api/positions/:id/interview-prep', authenticate, saveInterviewPrep);

  // ─────────────────────────────────────────────────────────────
  // AI ENDPOINTS
  // ─────────────────────────────────────────────────────────────

  // POST /api/ai/parse-jd
  router.post('/api/ai/parse-jd', authenticate, async (req, res) => {
    try {
      const { job_description_text } = req.body;
      if (!job_description_text) return err(res, 'job_description_text is required', 400);

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are a job description parser. Extract structured data from job descriptions and return valid JSON only.
Return exactly this structure (use null for any field not found):
{
  "title": "Job title",
  "company": "Company name",
  "salary": "Salary range as string, e.g. '$120k-$150k'",
  "location": "City, State or Remote",
  "work_type": "Remote | Hybrid | Onsite",
  "hiring_manager_name": "Name if mentioned, else null",
  "tech_skills": ["skill1", "skill2"]
}`
          },
          { role: 'user', content: job_description_text }
        ]
      });

      const parsed = JSON.parse(completion.choices[0].message.content);
      ok(res, parsed);
    } catch (e) {
      console.error('AI parse-jd error:', e.message);
      err(res, e.message);
    }
  });

  // POST /api/ai/generate-prep
  router.post('/api/ai/generate-prep', authenticate, async (req, res) => {
    try {
      const { position_id, user_resume_summary } = req.body;
      if (!position_id) return err(res, 'position_id is required', 400);

      // Fetch position details including notes
      const posResult = await pool.query(`SELECT * FROM crm_positions WHERE id = $1`, [position_id]);
      if (!posResult.rows.length) return err(res, 'Position not found', 404);
      const position = posResult.rows[0];

      // Use caller-supplied summary as override, otherwise use the auto-built context from resume_data/
      const resumeContext = user_resume_summary || PAUL_RESUME_CONTEXT;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are helping Paul Ireifej prepare for a job interview. Your job is to produce a SHORT, SCANNABLE cheat sheet he can glance at during or just before the interview.

RULES — follow every one:
1. WRITE SHORT. Bullet points only. No paragraphs. No essays.
2. MAP TECHNOLOGIES: For every key technology or skill in the job, find the closest real project or experience in Paul's background and write one bullet: "Technology X → Project Y: one sentence on how I used it."
3. SAMPLE ARCHITECTURE: For the 2-3 most important technologies, add one extra bullet showing a brief architecture example in plain English (e.g. "AKS → ran 40-node cluster, Helm charts per service, HPA on CPU/memory, Istio for mTLS between pods").
4. FIRST PERSON, PLAIN ENGLISH. Write as if Paul is saying it out loud. Short sentences. No jargon dumps.
5. GAPS: List only real gaps — technologies clearly required by the job that are not in Paul's background. One bullet each, max 5 words.
6. QUESTIONS: 3 smart questions Paul should ask the interviewer. One sentence each.
7. COMPANY CONTEXT: 2-3 bullets max. Only what Paul should actually say out loud ("They partner with Microsoft on Azure Fabric modernization — I can speak to that directly from my AT&T Fabric work").

Return valid JSON in exactly this structure (all values are strings or arrays of strings — no nested objects):
{
  "elevator_pitch": "One punchy paragraph, 3 sentences max, first person. Who I am, what I bring to THIS role, one concrete proof point.",
  "tech_mappings": [
    "Technology X → Project Y: one sentence on how I used it and what I delivered.",
    "Technology X (architecture): brief architecture example in plain English."
  ],
  "gaps": [
    "Gap skill — brief note on how to address it"
  ],
  "questions_to_ask": [
    "One smart question to ask the interviewer."
  ],
  "company_context": [
    "One thing Paul should mention about the company and why it connects to his experience."
  ]
}`
          },
          {
            role: 'user',
            content: `POSITION: ${position.title} at ${position.company}
LOCATION: ${position.location || 'Not specified'} | WORK TYPE: ${position.work_type || 'Not specified'}
REQUIRED TECH SKILLS: ${JSON.stringify(position.required_tech_skills || [])}
JOB DESCRIPTION SUMMARY: ${JSON.stringify(position.parsed_summary || {})}
JOB DESCRIPTION TEXT: ${(position.job_description_text || '').slice(0, 3000)}
POSITION NOTES: ${position.notes || 'None'}

PAUL'S BACKGROUND:
${resumeContext}`
          }
        ]
      });

      const prepData = JSON.parse(completion.choices[0].message.content);

      // Auto-save the generated prep to the interview_preps table
      await pool.query(
        `INSERT INTO crm_interview_preps (
           position_id,
           skill_gap_analysis,
           company_news_talking_points,
           ai_generated_content
         )
          VALUES ($1,$2,$3,$4)
         ON CONFLICT (position_id) DO UPDATE SET
           skill_gap_analysis = EXCLUDED.skill_gap_analysis,
           company_news_talking_points = EXCLUDED.company_news_talking_points,
            ai_generated_content = EXCLUDED.ai_generated_content,
           updated_at = NOW()`,
        [position_id,
         JSON.stringify(prepData.skill_gap_analysis),
         JSON.stringify(prepData.company_news_talking_points),
         JSON.stringify(prepData)]
      );

      ok(res, prepData);
    } catch (e) {
      console.error('AI generate-prep error:', e.message);
      err(res, e.message);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // JOB DESCRIPTIONS
  // ─────────────────────────────────────────────────────────────

  // POST /api/job-descriptions — save a new JD
  router.post('/api/job-descriptions', authenticate, async (req, res) => {
    try {
      const { raw_text, title, company, position_id, parsed_data } = req.body;
      if (!raw_text) return err(res, 'raw_text is required', 400);
      const result = await pool.query(
        `INSERT INTO crm_job_descriptions (raw_text, title, company, position_id, parsed_data)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [raw_text, title || null, company || null, position_id || null,
         parsed_data ? JSON.stringify(parsed_data) : null]
      );
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  // GET /api/job-descriptions?position_id= — list all, optional filter
  router.get('/api/job-descriptions', authenticate, async (req, res) => {
    try {
      const { position_id } = req.query;
      let query = `
        SELECT jd.*, p.title AS position_title, p.company AS position_company
        FROM crm_job_descriptions jd
        LEFT JOIN crm_positions p ON p.id = jd.position_id
        WHERE 1=1`;
      const params = [];
      if (position_id) { params.push(position_id); query += ` AND jd.position_id = $${params.length}`; }
      query += ` ORDER BY jd.created_at DESC`;
      const result = await pool.query(query, params);
      ok(res, result.rows);
    } catch (e) { err(res, e.message); }
  });

  // GET /api/job-descriptions/:id — get one
  router.get('/api/job-descriptions/:id', authenticate, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT jd.*, p.title AS position_title, p.company AS position_company
         FROM crm_job_descriptions jd
         LEFT JOIN crm_positions p ON p.id = jd.position_id
         WHERE jd.id = $1`,
        [req.params.id]
      );
      if (!result.rows.length) return err(res, 'Job description not found', 404);
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  // PUT + PATCH /api/job-descriptions/:id — update any field
  const updateJobDescription = async (req, res) => {
    try {
      const { id } = req.params;
      const fields = ['raw_text','title','company','position_id','parsed_data'];
      const updates = []; const params = [];
      for (const f of fields) {
        if (req.body[f] !== undefined) {
          const val = f === 'parsed_data' ? JSON.stringify(req.body[f]) : req.body[f];
          params.push(val); updates.push(`${f} = $${params.length}`);
        }
      }
      if (!updates.length) return err(res, 'No fields to update', 400);
      params.push(id);
      const result = await pool.query(
        `UPDATE crm_job_descriptions SET ${updates.join(', ')}, updated_at = NOW()
         WHERE id = $${params.length} RETURNING *`, params
      );
      if (!result.rows.length) return err(res, 'Job description not found', 404);
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  };
  router.put('/api/job-descriptions/:id', authenticate, updateJobDescription);
  router.patch('/api/job-descriptions/:id', authenticate, updateJobDescription);

  // DELETE /api/job-descriptions/:id
  router.delete('/api/job-descriptions/:id', authenticate, async (req, res) => {
    try {
      const result = await pool.query(`DELETE FROM crm_job_descriptions WHERE id = $1 RETURNING id`, [req.params.id]);
      if (!result.rows.length) return err(res, 'Job description not found', 404);
      ok(res, { deleted_id: result.rows[0].id });
    } catch (e) { err(res, e.message); }
  });

  // POST /api/job-descriptions/:id/parse — AI-parse the saved raw_text and store result
  router.post('/api/job-descriptions/:id/parse', authenticate, async (req, res) => {
    try {
      const jdResult = await pool.query(`SELECT * FROM crm_job_descriptions WHERE id = $1`, [req.params.id]);
      if (!jdResult.rows.length) return err(res, 'Job description not found', 404);
      const jd = jdResult.rows[0];

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are a job description parser. Extract structured data and return valid JSON only.
Return exactly this structure (use null for any field not found):
{
  "title": "Job title",
  "company": "Company name",
  "salary": "Salary range as string, e.g. '$120k-$150k'",
  "location": "City, State or Remote",
  "work_type": "Remote | Hybrid | Onsite",
  "hiring_manager_name": "Name if mentioned, else null",
  "tech_skills": ["skill1", "skill2"],
  "summary": "2-3 sentence plain English summary of the role"
}`
          },
          { role: 'user', content: jd.raw_text }
        ]
      });

      const parsed = JSON.parse(completion.choices[0].message.content);

      // Store parsed result + auto-fill title/company if missing
      const updated = await pool.query(
        `UPDATE crm_job_descriptions
         SET parsed_data = $1,
             title = COALESCE(title, $2),
             company = COALESCE(company, $3),
             updated_at = NOW()
         WHERE id = $4 RETURNING *`,
        [JSON.stringify(parsed), parsed.title || null, parsed.company || null, req.params.id]
      );

      ok(res, { job_description: updated.rows[0], parsed });
    } catch (e) {
      console.error('JD parse error:', e.message);
      err(res, e.message);
    }
  });

  return router;
};
