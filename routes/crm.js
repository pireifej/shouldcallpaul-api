'use strict';
const express = require('express');

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
      if (!position_id || !user_resume_summary) return err(res, 'position_id and user_resume_summary are required', 400);

      // Fetch position details
      const posResult = await pool.query(`SELECT * FROM crm_positions WHERE id = $1`, [position_id]);
      if (!posResult.rows.length) return err(res, 'Position not found', 404);
      const position = posResult.rows[0];

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are an expert career coach and interview preparation specialist. 
Analyze the candidate's resume against the job requirements and generate a detailed prep guide.
Return valid JSON in exactly this structure:
{
  "skill_gap_analysis": {
    "strong_matches": ["skills the candidate has that match the role"],
    "gaps": ["required skills the candidate lacks or needs to strengthen"],
    "talking_points": ["how to frame existing experience to bridge the gaps"]
  },
  "company_news_talking_points": [
    "Relevant company insight or news angle the candidate should mention in an interview"
  ],
  "recommended_questions": [
    "Thoughtful question the candidate should ask the interviewer"
  ]
}`
          },
          {
            role: 'user',
            content: `POSITION: ${position.title} at ${position.company}
LOCATION: ${position.location || 'Not specified'} | WORK TYPE: ${position.work_type || 'Not specified'}
REQUIRED TECH SKILLS: ${JSON.stringify(position.required_tech_skills || [])}
JOB SUMMARY: ${JSON.stringify(position.parsed_summary || {})}

CANDIDATE RESUME SUMMARY:
${user_resume_summary}`
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
