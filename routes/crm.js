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

  // GET /api/positions?status=
  router.get('/api/positions', authenticate, async (req, res) => {
    try {
      const { status } = req.query;
      let query = `
        SELECT p.*,
          hm.name AS hiring_manager_name,
          rc.name AS recruiter_name
        FROM crm_positions p
        LEFT JOIN crm_contacts hm ON hm.id = p.hiring_manager_contact_id
        LEFT JOIN crm_contacts rc ON rc.id = p.recruiter_contact_id
        WHERE 1=1`;
      const params = [];
      if (status) { params.push(status); query += ` AND p.status = $${params.length}`; }
      query += ` ORDER BY p.updated_at DESC`;
      const result = await pool.query(query, params);
      ok(res, result.rows);
    } catch (e) { err(res, e.message); }
  });

  // GET /api/positions/:id
  router.get('/api/positions/:id', authenticate, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT p.*,
          hm.name AS hiring_manager_name,
          rc.name AS recruiter_name
        FROM crm_positions p
        LEFT JOIN crm_contacts hm ON hm.id = p.hiring_manager_contact_id
        LEFT JOIN crm_contacts rc ON rc.id = p.recruiter_contact_id
        WHERE p.id = $1`, [req.params.id]);
      if (!result.rows.length) return err(res, 'Position not found', 404);
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  // POST /api/positions
  router.post('/api/positions', authenticate, async (req, res) => {
    try {
      const { title, company, url, status, location, work_type, salary_range, hiring_manager_contact_id, recruiter_contact_id, required_tech_skills, parsed_summary } = req.body;
      if (!title || !company) return err(res, 'title and company are required', 400);
      const result = await pool.query(
        `INSERT INTO crm_positions (title, company, url, status, location, work_type, salary_range, hiring_manager_contact_id, recruiter_contact_id, required_tech_skills, parsed_summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [title, company, url, status || 'Targeted', location, work_type, salary_range,
         hiring_manager_contact_id || null, recruiter_contact_id || null,
         JSON.stringify(required_tech_skills || []), JSON.stringify(parsed_summary || {})]
      );
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

  // PUT /api/positions/:id
  router.put('/api/positions/:id', authenticate, async (req, res) => {
    try {
      const { id } = req.params;
      const fields = ['title','company','url','status','location','work_type','salary_range','hiring_manager_contact_id','recruiter_contact_id','required_tech_skills','parsed_summary','notes'];
      const updates = []; const params = [];
      for (const f of fields) {
        if (req.body[f] !== undefined) {
          const val = (f === 'required_tech_skills' || f === 'parsed_summary') ? JSON.stringify(req.body[f]) : req.body[f];
          params.push(val); updates.push(`${f} = $${params.length}`);
        }
      }
      if (!updates.length) return err(res, 'No fields to update', 400);
      params.push(Date.now()); // updated_at placeholder — use NOW() in query
      updates.push(`updated_at = NOW()`);
      params.pop(); // remove the placeholder, updated_at uses NOW() inline
      params.push(id);
      const result = await pool.query(
        `UPDATE crm_positions SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`, params
      );
      if (!result.rows.length) return err(res, 'Position not found', 404);
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

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
        `SELECT ip.*, p.title AS position_title, p.company
         FROM crm_interview_preps ip
         JOIN crm_positions p ON p.id = ip.position_id
         WHERE ip.position_id = $1`,
        [req.params.id]
      );
      // Return empty object if no prep exists yet — not a 404
      ok(res, result.rows[0] || null);
    } catch (e) { err(res, e.message); }
  });

  // PUT /api/positions/:id/interview-prep (upsert)
  router.put('/api/positions/:id/interview-prep', authenticate, async (req, res) => {
    try {
      const position_id = req.params.id;
      const { skill_gap_analysis, company_news_talking_points, freeform_notes } = req.body;
      const result = await pool.query(
        `INSERT INTO crm_interview_preps (position_id, skill_gap_analysis, company_news_talking_points, freeform_notes)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (position_id) DO UPDATE SET
           skill_gap_analysis = EXCLUDED.skill_gap_analysis,
           company_news_talking_points = EXCLUDED.company_news_talking_points,
           freeform_notes = EXCLUDED.freeform_notes,
           updated_at = NOW()
         RETURNING *`,
        [position_id,
         JSON.stringify(skill_gap_analysis || null),
         JSON.stringify(company_news_talking_points || null),
         freeform_notes || null]
      );
      ok(res, result.rows[0]);
    } catch (e) { err(res, e.message); }
  });

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
            content: `You are an expert career coach and interview preparation specialist.
Analyze the candidate's full background against the job requirements and generate a detailed, specific prep guide.
Use the candidate's actual projects, certifications, awards, and experience — do not be generic.
Return valid JSON in exactly this structure:
{
  "skill_gap_analysis": {
    "strong_matches": ["specific skills/experiences the candidate has that directly match this role"],
    "gaps": ["required skills the candidate lacks or needs to strengthen for this role"],
    "talking_points": ["concrete ways to frame the candidate's existing experience to bridge each gap"]
  },
  "company_news_talking_points": [
    "Specific insight, news angle, or company context the candidate should mention in the interview"
  ],
  "recommended_questions": [
    "Thoughtful, role-specific question the candidate should ask the interviewer"
  ]
}`
          },
          {
            role: 'user',
            content: `POSITION: ${position.title} at ${position.company}
LOCATION: ${position.location || 'Not specified'} | WORK TYPE: ${position.work_type || 'Not specified'}
SALARY: ${position.salary_range || 'Not specified'}
REQUIRED TECH SKILLS: ${JSON.stringify(position.required_tech_skills || [])}
JOB SUMMARY: ${JSON.stringify(position.parsed_summary || {})}
POSITION NOTES: ${position.notes || 'None'}

CANDIDATE BACKGROUND:
${resumeContext}`
          }
        ]
      });

      const prepData = JSON.parse(completion.choices[0].message.content);

      // Auto-save the generated prep to the interview_preps table
      await pool.query(
        `INSERT INTO crm_interview_preps (position_id, skill_gap_analysis, company_news_talking_points, freeform_notes)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (position_id) DO UPDATE SET
           skill_gap_analysis = EXCLUDED.skill_gap_analysis,
           company_news_talking_points = EXCLUDED.company_news_talking_points,
           updated_at = NOW()`,
        [position_id,
         JSON.stringify(prepData.skill_gap_analysis),
         JSON.stringify(prepData.company_news_talking_points),
         null]
      );

      ok(res, prepData);
    } catch (e) {
      console.error('AI generate-prep error:', e.message);
      err(res, e.message);
    }
  });

  return router;
};
