'use strict';
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false } });
const WORKSHOP_STATUS_ALIASES = {
  Lead: 'Active',
  'Proposal Sent': 'Active',
  Confirmed: 'In Progress',
  Completed: 'Complete'
};

// Known contact IDs from existing DB load
const C = {
  aaron: 1, david_icode: 9, david_kaufman: 10, scott_cascone: 11,
  inning: 17, jen_ma: 19, joe_bedminster: 25, kimberly_paone: 26,
  konstantin_filenko: 27, linda_matawan: 29, ronald_laufer: 37,
  sara_whitwell: 38, seth_heine: 53, teddy_mertyris: 59,
  christopher_carroll: 8, marybeth_bull: 32, melissa_fernandes: 35,
  anne_wallman: 47, casey_pellegrino: 46, james_fahey: 18,
  jennifer_brennan: 20, jennifer_dantuono: 21, jennifer_elliott: 22,
  jodi_simon: 24, krista_horan: 28, matthew_greenberg: 34,
  shannon_orefice: 41, william_salcedo: 44, scott_nurnberger: 39,
  sean_cronin: 40, mike_liebmann: 36, dr_scott_ridley: 12,
  anthony_vona: 5, lisa_auletta: 31, april_magistro: 6, linnette_mercado: 30,
  susan_matson: 42, emily_miller: 14, molly_dillon: 48, erin_mattsson: 49,
  glenn_talavera: 51, jennifer_berry: 52
};

async function createContact(name, email, org, title, category, notes) {
  const r = await pool.query(
    `INSERT INTO crm_contacts (name, email, organization, title, category, notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [name, email || null, org || null, title || null, category || 'Job Search', notes || null]
  );
  console.log(`  ✅ Created contact: ${name} (id ${r.rows[0].id})`);
  return r.rows[0].id;
}

async function insertPosition(d) {
  const r = await pool.query(
    `INSERT INTO crm_positions
       (title, company, url, status, location, work_type, salary_range,
        hiring_manager_contact_id, recruiter_contact_id, required_tech_skills, parsed_summary, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [d.title, d.company, d.url || null, d.status || 'Targeted',
     d.location || null, d.work_type || null, d.salary || null,
     d.hm || null, d.rec || null,
     JSON.stringify(d.skills || []),
     JSON.stringify(d.summary || {}),
     d.notes || null]
  );
  console.log(`  ✅ Position: ${d.title} @ ${d.company} [${d.status}] (id ${r.rows[0].id})`);
  return r.rows[0].id;
}

async function insertWorkshop(d) {
  const status = WORKSHOP_STATUS_ALIASES[d.status] || d.status || 'Active';
  const feeMatch = typeof d.cost === 'string'
    ? d.cost.trim().match(/^\$\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(hour|session))?$/i)
    : null;
  const feeAmount = feeMatch ? Number(feeMatch[1]) : null;
  const feeType = feeMatch ? (feeMatch[2]?.toLowerCase() || 'flat') : null;
  const r = await pool.query(
    `INSERT INTO crm_workshops
       (organization_name, contact_id, status, workshop_title, historical_date,
        fee_amount, fee_type, cost_basis, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [d.org, d.contact_id || null, status,
     d.title || null, d.date || null, feeAmount, feeType, d.cost || null, d.notes || null]
  );
  console.log(`  ✅ Workshop: ${d.org} [${status}] (id ${r.rows[0].id})`);
  return r.rows[0].id;
}

async function insertLog(type, entity_id, contact_id, text, date) {
  await pool.query(
    `INSERT INTO crm_activity_logs (entity_type, entity_id, contact_id, log_text, log_date)
     VALUES ($1,$2,$3,$4,$5)`,
    [type, entity_id, contact_id || null, text, date ? new Date(date) : new Date()]
  );
}

async function main() {
  console.log('\n=== STEP 1: Creating new contacts ===');
  const georgeanne = await createContact('Georgeanne Rainey', 'GRainey@prime-ts.com', 'Prime Technical Staffing', 'Recruiter', 'Job Search', 'Contacted via Natallia. Recruiter for Palantir roles.');
  const emilyHoppe = await createContact('Emily Hoppe', null, 'Palantir', 'Recruiter', 'Job Search', 'Recruiter for DPRE role at Palantir Flatiron NYC.');
  const deepSingh = await createContact('Deep Singh', null, 'Orion Innovation', 'Hiring Contact', 'Job Search', 'Connected via LinkedIn. Senior Cloud Architect role.');
  const willisKwee = await createContact('Willis Kwee', null, 'Crazy Cats AI', 'Principal Platform Engineer', 'Job Search', 'Connected via LinkedIn. Startup – 5 founders, $6M funding, demo in Sept.');
  const natallia = await createContact('Natallia Lysakova', null, 'Capitol AI', 'Recruiter', 'Job Search', 'Recruiter who connected Paul to Capitol AI and Georgeanne Rainey.');
  const endaSweeney = await createContact('Enda Sweeney', null, 'Marcus and Pollack', 'Recruiter', 'Job Search', 'Recruiter via LinkedIn. Asked about status July 28, 2026.');
  const peterLeicht = await createContact('Peter Leicht', null, 'Bloomberg', 'Contact', 'Job Search', 'Will give a recommendation. Connected via Debevoise-Plimpton.');
  const brianLin = await createContact('Brian Lin', null, 'Regeneron', 'Director, AI Engineering (Global Development)', 'Job Search', null);
  const triciaStrong = await createContact('Tricia Strong', 'tricia.strong@morganlewis.com', 'Morgan Lewis', 'Recruiter/Contact', 'Job Search', 'Direct: +1.312.324.1721. Reached out about R4046 Senior Identity and Access Engineer.');
  const emersonPastorelli = await createContact('Emerson Pastorelli', 'emersonp@amdocs.com', 'Amdocs', 'Contact', 'Job Search', 'Connected via Teddy Mertyris. Emailed July 23, 2026.');
  const yanalSaleh = await createContact('Yanal Saleh', 'ysaleh@epps.org', 'Elmwood Park Public Schools', 'Director of Technology', 'Job Search', 'Emailed July 19, 2026 about workshop: "Introducing Your New Data Analyst: Notebook LM"');
  const tamerMamkej = await createContact('Tamer Mamkej', 'tmamkej@hawthorneschools.org', 'Hawthorne Public Schools', 'Director of Technology', 'Job Search', 'Emailed July 19, 2026.');
  const michaelDeCarlo = await createContact('Michael De Carlo', 'mhdecarlo@live.com', 'CFCA', 'Contact', 'Workshop', 'Met July 14, 2026 at Brookdale - Road to National AI Day workshop. Emailed July 15.');

  console.log('\n=== STEP 2: Inserting positions ===');

  // — PALANTIR —
  const palantirId = await insertPosition({
    title: 'Data Pipeline Reliability Engineer (DPRE)',
    company: 'Palantir',
    status: 'Interviewing',
    location: 'Manhattan, NY (Flatiron)',
    work_type: 'Hybrid',
    salary: '$110k-$147k',
    rec: georgeanne,
    hm: emilyHoppe,
    skills: ['Python', 'PySpark', 'Foundry', 'Data Pipelines'],
    notes: `Recruiter Georgeanne Rainey (Prime Technical Staffing) via Natallia. Also a Support Engineer / Data Pipeline Engineer role (24 spots for both). No clearance needed but federal projects – double-check. Highlight Python and manual debugging. PySpark relevant. Large enterprise-scale data via Foundry (runs on PySpark + Python). Interview process: 4–6 weeks. HackerRank exercises → walk them through how you'd do it → 2–3 virtual tech rounds. Show Python and PySpark work through Foundry. First couple weeks: 4–5 days in office, then 2–3 days. Full-time employee of Palantir's customer (benefits, insurance, PTO, weekly Friday paycheck). Target $160–165k. Send updated resume and vetting questions.`
  });

  // — ORION INNOVATION —
  const orionId = await insertPosition({
    title: 'Senior Cloud Architect',
    company: 'Orion Innovation',
    status: 'Interviewing',
    hm: deepSingh,
    skills: ['Microsoft Fabric', 'Azure', 'AKS', 'Terraform', 'Databricks', 'Python', 'RAG', 'Istio', 'Red Hat Linux'],
    notes: `Connected via Deep Singh on LinkedIn. Interview notes on Thangarajan Santhanam (Principal Platform Engineer role context): Designed data pipelines in Microsoft Fabric for real-time fraud analytics. Implemented Microsoft Foundry for data governance/compliance. Engineered agentic testing frameworks. Built RAG troubleshooting helper on wikis. Managed Istio in AKS for traffic/security. Azure Synapse for historical log queries. Azure Data Factory for legacy migration. Terraform for AKS + VNets. Key prep: Best Buy example – reviewed pair engineer design and pushed back. Rating: design/azure cloud/reporting/AI. MongoDB optimization quote: "In a real-time fraud mitigation app, SLA budget was strictly under 30ms to avoid timing out upstream API calls. By eliminating unindexed queries and optimizing document projection, we brought p99 latency from 1.2s to under 15ms." 10 max / 1 least scoring format.`
  });

  // — CRAZY CATS AI —
  const crazyCatsId = await insertPosition({
    title: 'Principal Platform Engineer',
    company: 'Crazy Cats AI',
    status: 'Interviewing',
    salary: 'Up to $300k (base + 25% bonus + 50% equity)',
    hm: willisKwee,
    skills: ['Platform Engineering', 'AI', 'System Architecture'],
    notes: `Willis Kwee via LinkedIn. 5 founders – two sessions completed. No live coding, no LeetCode. $6M funding. First Principal Engineer hire. Customer demos scheduled for September. Leading workflow/process and developing best practices. High technical proficiency required – solve problems themselves. WilmerHale legal (also Lianne?). Phil? Eric Myer? 20 years exp, Dell bought their companies. Research "Crazy Cats AI" before next interview.`
  });

  // — JACK AND JILL AI —
  await insertPosition({
    title: 'Project Manager',
    company: 'Jack and Jill AI',
    url: 'https://app.jackandjill.ai/jack/dashboard/inbox',
    status: 'Applied',
    skills: ['Project Management', 'AI'],
    notes: 'Online résumé/CV submission for Project Manager 2395-437. Portal: Jack and Jill AI job portal.'
  });

  // — 3CLOUD —
  await insertPosition({
    title: 'Principal Architect - Security',
    company: '3Cloud',
    url: 'https://job-boards.greenhouse.io/3cloud/jobs/8582239002',
    status: 'Applied',
    skills: ['Azure', 'Security', 'Cloud Architecture'],
    notes: 'Greenhouse portal: https://my.greenhouse.io/dashboard'
  });

  // — MARCUS AND POLLACK —
  await insertPosition({
    title: 'TBD',
    company: 'Marcus and Pollack',
    status: 'Applied',
    rec: endaSweeney,
    notes: 'Working with recruiter Enda Sweeney via LinkedIn. Asked about status July 28, 2026.'
  });

  // — AMD —
  await insertPosition({
    title: 'TBD',
    company: 'AMD',
    status: 'Targeted',
    location: 'Secaucus',
    notes: 'Need to search for open positions.'
  });

  // — AT&T GFMO —
  await insertPosition({
    title: 'GFMO Opportunity',
    company: 'AT&T / GFMO',
    status: 'Targeted',
    hm: C.jen_ma,
    notes: 'Internal networking for Global Finance Management Office. Jen Ma has nothing currently.'
  });

  // — AT&T INTERNAL —
  await insertPosition({
    title: 'Internal Role (Surplus)',
    company: 'AT&T Internal',
    status: 'Inactive',
    hm: C.david_kaufman,
    notes: 'Surplus status effective June 17, 2026. Last Day on Payroll (LDP): September 15, 2026. David Kaufman has nothing. Need to ask Inning.'
  });

  // — AT&T EXTERNAL —
  await insertPosition({
    title: 'Principal System Engineering / Sr Specialist Member of Technical Staff',
    company: 'AT&T External',
    url: 'https://att.wd1.myworkdayjobs.com/en-US/ATTGeneral/job/Principal-System-Engineering_R-114239',
    status: 'Applied',
    skills: ['Software Automation', 'Systems Engineering'],
    notes: 'Portal: https://att.wd1.myworkdayjobs.com/en-US/ATTGeneral/userHome. Role IDs: R-114239 (Principal System Engineering) + Sr Specialist Member of Technical Staff (Software Automation).'
  });

  // — BLOOMBERG —
  await insertPosition({
    title: 'TBD',
    company: 'Bloomberg',
    status: 'Targeted',
    hm: peterLeicht,
    notes: 'Peter Leicht will give a recommendation. Need to search Bloomberg openings. Also connected via Debevoise-Plimpton employer portal.'
  });

  // — BLUE SIGNAL SEARCH —
  await insertPosition({
    title: 'TBD',
    company: 'Blue Signal Search',
    status: 'Targeted',
    notes: 'Monitoring external opportunities via Loxo platform. Dashboard: https://blue-signal-search.app.loxo.co'
  });

  // — BROOKDALE CC (CPS Instructor) —
  await insertPosition({
    title: 'CPS Instructor, Business & Career Training',
    company: 'Brookdale Community College',
    status: 'Applied',
    hm: C.melissa_fernandes,
    notes: 'CPS = Continuing and Professional Studies. Start date April 7, 2026. Career Dashboard login: pireifej@gmail.com (Google). Direct follow-up June 30, 2026. Met Casey Pellegrino and Anne Wallman on campus July 20, 2026. Emailed Molly (HR) July 2, follow-up July 21. Emailed Casey follow-up July 28, 2026.'
  });

  // — CHARTER COMMUNICATIONS —
  await insertPosition({
    title: 'TBD',
    company: 'Charter Communications',
    status: 'Targeted',
    location: 'Stamford, CT',
    notes: 'Targeted external lead.'
  });

  // — GARTNER —
  await insertPosition({
    title: 'TBD',
    company: 'Gartner',
    status: 'Rejected',
    location: 'Stamford, CT',
    notes: 'Application submitted via Workday. Rejected.'
  });

  // — ICIMS —
  await insertPosition({
    title: 'TBD',
    company: 'iCIMS',
    status: 'Targeted',
    location: 'Holmdel, NJ',
    notes: 'Targeted external lead.'
  });

  // — ICODE —
  await insertPosition({
    title: 'AI Instructor / Supervisor / Director',
    company: 'iCode',
    status: 'Applied',
    hm: C.david_icode,
    notes: 'Pitching for Old Bridge or Freehold locations. Follow-up June 30, 2026. Send follow-up email July 23, 2026. Contact: David (shrewsbury@icodeschool.com).'
  });

  // — DATAANNOTATION x2 —
  await insertPosition({ title: 'Android Developer - AI Trainer', company: 'DataAnnotation', status: 'Applied', notes: 'Applied via Indeed.' });
  await insertPosition({ title: 'Frontend Developer - AI Trainer', company: 'DataAnnotation', status: 'Applied', notes: 'Applied via Indeed.' });

  // — THERAPYNOTES —
  await insertPosition({ title: 'Senior Software Developer', company: 'TherapyNotes', status: 'Applied', notes: 'Applied via Indeed.' });

  // — DIGIBLE —
  await insertPosition({ title: 'Senior Software Engineer', company: 'Digible', status: 'Applied', notes: 'Applied via Indeed.' });

  // — KEYSIGHT —
  await insertPosition({
    title: 'Multiple Engineering Roles',
    company: 'Keysight',
    url: 'https://jobs.keysight.com/external',
    status: 'Applied',
    hm: C.ronald_laufer,
    skills: ['AKS', 'Helm', 'Azure', 'Kubernetes'],
    notes: 'Applied June 25, 2026. Job IDs: 53269, 52986, 52947, 53113, 52969. Strategy: leverage AKS and Helm expertise from AT&T Principal role. Internal referral link via Ronald Laufer (ron.laufer@keysight.com).'
  });

  // — LEIDOS x2 —
  await insertPosition({
    title: 'Software Engineer',
    company: 'Leidos',
    url: 'https://careers.leidos.com/jobs/17806688-software-engineer',
    status: 'Rejected',
    notes: 'Job ID 17806688. Login: pireifej@gmail.com. Strategy: Agentic AI and Windsurf troubleshooting experience.'
  });
  await insertPosition({
    title: 'Senior ServiceNow Developer',
    company: 'Leidos',
    url: 'https://careers.leidos.com/jobs/17844438-senior-servicenow-developer',
    status: 'Rejected',
    notes: 'Job ID 17844438. Login: pireifej@gmail.com.'
  });

  // — NBC SPORTS —
  await insertPosition({ title: 'TBD', company: 'NBC Sports Group', status: 'Targeted', location: 'Stamford, CT' });

  // — PITNEY BOWES —
  await insertPosition({ title: 'TBD', company: 'Pitney Bowes', status: 'Targeted', location: 'Stamford, CT' });

  // — PURE INSURANCE —
  await insertPosition({
    title: 'Senior AI Engineer',
    company: 'PURE Insurance',
    url: 'https://pureinsurance.wd5.myworkdayjobs.com/en-US/PURE/job/White-Plains/Senior-AI-Engineer_R2715',
    status: 'Applied',
    location: 'White Plains, NY',
    hm: C.konstantin_filenko,
    skills: ['AI Engineering'],
    notes: 'Application submitted via internal referral link August 7, 2026. Role ID: R2715. Portal: https://pureinsurance.wd5.myworkdayjobs.com/en-US/PURE/userHome. Contact: Konstantin Filenko.'
  });

  // — VONAGE —
  await insertPosition({
    title: 'Multiple Roles',
    company: 'Vonage',
    status: 'Applied',
    notes: 'Applied for Job IDs 8591899002, 8405725002, 8583597002, 8599475002. URLs: https://www.vonage.com/careers/job-details/8591899002/ | https://job-boards.greenhouse.io/vonage/jobs/8405725002 | https://job-boards.greenhouse.io/vonage/jobs/8583597002 | https://job-boards.greenhouse.io/vonage/jobs/8599475002'
  });

  // — WWE / TKO —
  await insertPosition({ title: 'TBD', company: 'WWE (TKO Group Holdings)', status: 'Targeted', location: 'Stamford, CT' });

  // — KAYAK —
  await insertPosition({ title: 'TBD', company: 'Kayak', status: 'Targeted', location: 'Stamford, CT' });

  // — ROBERT HALF —
  await insertPosition({ title: 'Software Engineer II', company: 'Robert Half', status: 'Rejected', notes: 'Applied via Robert Half dashboard. Rejected.' });

  // — MORGAN LEWIS —
  const mlBiAnalyst = await insertPosition({ title: 'BI Analytics Analyst', company: 'Morgan Lewis', status: 'Applied', hm: triciaStrong, notes: 'Applied via Morgan Lewis portal. Cultural fit notes: community service (Mobilizing for Equity), smart AI use encouraged, new Chair starts Sept officially, former Chair Jami 30+ years.' });
  await insertPosition({ title: 'IT Business Relationship Manager', company: 'Morgan Lewis', status: 'Applied', hm: triciaStrong });
  await insertPosition({ title: 'Senior Identity and Access Engineer', company: 'Morgan Lewis', status: 'Applied', hm: triciaStrong, notes: 'Role R4046. Tricia Strong (tricia.strong@morganlewis.com, +1.312.324.1721) reached out directly. Via Lianne connection.' });
  await insertPosition({ title: 'BI Analytics Developer', company: 'Morgan Lewis', status: 'Rejected', notes: 'Applied via portal. Rejected.' });
  await insertPosition({ title: 'Data Specialist, Data Management & Analytics', company: 'Morgan Lewis', status: 'Inactive', notes: 'Will not apply for now.' });

  // — REGENERON —
  await insertPosition({
    title: 'Director, AI Engineering (Global Development)',
    company: 'Regeneron',
    url: 'https://regeneron.wd1.myworkdayjobs.com/Careers/job/TARRYTOWN/Director--AI-Engineering--Global-Development-_R44760',
    status: 'Rejected',
    location: 'Tarrytown, NY',
    hm: brianLin,
    skills: ['AI Engineering', 'ML'],
    notes: 'Login: paul.ireifej@gmail.com. Rejected. Via Brian Lin referral.'
  });

  // — CAPITOL AI —
  await insertPosition({
    title: 'TBD',
    company: 'Capitol AI',
    status: 'Targeted',
    rec: natallia,
    notes: 'Via Natallia Lysakova. Decision makers away, she will follow up. Pinged Natallia July 23, 2026.'
  });

  // — PROLMOBILE —
  await insertPosition({
    title: 'TBD',
    company: 'PrologMobile',
    status: 'Targeted',
    hm: C.seth_heine,
    notes: 'Working with Seth Heine. He recommended looking at GSMA. Also: Zach Vorwaller (https://www.linkedin.com/in/zacharyvorwaller/) – messaged about "We are hiring a coder to run AI stacks/agents."'
  });

  // — GSMA —
  await insertPosition({
    title: 'TBD',
    company: 'GSMA',
    status: 'Targeted',
    notes: 'Referred by Seth Heine at PrologMobile. Need to check job portal.'
  });

  // — HOLMDEL SCHOOL DISTRICT —
  await insertPosition({
    title: 'TBD – Full-Time Employment',
    company: 'Holmdel School District',
    status: 'Targeted',
    hm: C.scott_cascone,
    notes: 'Coffee meeting Monday July 20, 2026 with Dr. Scott Cascone. Goal: give resume, ask for job or connection. Look for open Holmdel positions. NJ DOE certification path: https://nj.gov/education/certification/'
  });

  // — ELMWOOD PARK PUBLIC SCHOOLS —
  await insertPosition({
    title: 'Director of Technology',
    company: 'Elmwood Park Public Schools',
    status: 'Applied',
    hm: yanalSaleh,
    notes: 'Emailed Yanal Saleh on July 19, 2026. Workshop angle: "Introducing Your New Data Analyst: Notebook LM".'
  });

  // — HAWTHORNE PUBLIC SCHOOLS —
  await insertPosition({
    title: 'Director of Technology',
    company: 'Hawthorne Public Schools',
    status: 'Applied',
    hm: tamerMamkej,
    notes: 'Emailed Tamer Mamkej on July 19, 2026.'
  });

  // — AMDOCS —
  await insertPosition({
    title: 'TBD',
    company: 'Amdocs',
    status: 'Targeted',
    hm: emersonPastorelli,
    notes: 'Connected via Teddy Mertyris (mertyris@gmail.com). Emailed Emerson Pastorelli July 23, 2026 to connect.'
  });

  // — JOE BEDMINSTER (direct referral) —
  await insertPosition({
    title: 'Software Developer (Referral)',
    company: 'Bedminster Contact (Joe)',
    status: 'Targeted',
    hm: C.joe_bedminster,
    notes: 'Direct referral from Joe at Bedminster Toastmasters. Specific software developer role he is looking to fill. Lead active.'
  });

  console.log('\n=== STEP 3: Inserting workshops ===');

  const wBBBS = await insertWorkshop({
    org: 'Big Brother Big Sister (BBBS)',
    contact_id: C.marybeth_bull,
    status: 'Confirmed',
    title: 'Public Speaking & Communication Staff Workshop',
    notes: 'Contacts: MaryBeth Bull, Matthew Greenberg, William Salcedo, Shannon Orefice, Jessica Raczyk. Historical: Jan 16, 2026 (Asbury Park) + Oct 10, 2025 (Morristown) – staff development for one-on-one and community partner messaging. Toastmasters Accredited Speaker rec form requested June 4, 2026; MaryBeth confirmed submitted June 24. Follow-up July 13 – she confirmed she submitted. Need to contact Toastmasters International to confirm receipt.'
  });

  const wBrookdale = await insertWorkshop({
    org: 'Brookdale Community College',
    contact_id: C.melissa_fernandes,
    status: 'Confirmed',
    title: 'AI & Professional Development Workshops',
    notes: 'Contacts: Melissa De Sousa-Fernandes, Casey Pellegrino, Anne M Wallman, Erin Mattsson, Molly Dillon (HR). Christopher Carroll confirmed Toastmasters rec form submitted June 4, 2026. Met Casey and Anne on campus July 20, 2026. Sent follow-up email July 21. Emailed Molly (HR) July 2 + follow-up July 21. Emailed Casey follow-up July 28. Road to National AI Day event held at Brookdale July 14, 2026 (met Michael De Carlo there).'
  });

  const wCFCA = await insertWorkshop({
    org: 'CFCA',
    contact_id: C.sara_whitwell,
    status: 'Lead',
    title: 'Accredited Speaker / Workshop',
    notes: 'Contact: Sara Whitwell (fraud@cfca.org). Toastmasters rec form requested June 20, 2026. Confirmed received by Toastmasters International Accredited Speaker Program. Fall event: https://cfca.org/event/fall-educational-2026-saint-paul-minneapolis-minnesota/ – apply as Independent Professional. Also met Michael De Carlo (mhdecarlo@live.com) at Brookdale AI Day July 14. Emailed him July 15.'
  });

  const wCheeseQuake = await insertWorkshop({
    org: 'CheeseQuake School (Sayreville)',
    contact_id: C.april_magistro,
    status: 'Lead',
    notes: 'Contacts: April Magistro (Principal), Linnette Mercado (Secretary). Follow-up email sent to both June 12, 2026.'
  });

  const wEdisonRotary = await insertWorkshop({
    org: 'Edison Rotary',
    contact_id: C.aaron,
    status: 'Lead',
    notes: 'Contact: Aaron (edisonrotary@gmail.com). Formal follow-up email sent June 6, 2026, following verified text outreach.'
  });

  const wFranklinSchool = await insertWorkshop({
    org: 'Franklin School (North Bergen)',
    status: 'Completed',
    title: 'Week of Respect Sessions',
    date: '2024-10-09',
    notes: 'October 9, 2024. 100+ students (grades 4–8), two 30-minute sessions focused on kindness and responsibility. Volunteer engagement.'
  });

  const wHazletLib = await insertWorkshop({
    org: 'Hazlet Library',
    contact_id: C.jennifer_brennan,
    status: 'Proposal Sent',
    title: 'AI for Beginners',
    notes: 'Contact: Jennifer Brennan. Proposal submitted June 12, 2026. Under review by Monmouth County Library Programming Staff (node: Jodi Simon). Monitor Zoho portal for approval. Historical: "Think on Your Feet" improv (Nov 3, 2025), "Teen Talk: Mastering Public Speaking" (July 24, 2025).'
  });

  const wHazletSD = await insertWorkshop({
    org: 'Hazlet School District',
    contact_id: C.dr_scott_ridley,
    status: 'Inactive',
    notes: 'Contact: Dr. Scott Ridley. Refused for 2026 cycle due to budget constraints. Firm invitation to pitch for 2027 Professional Development cycle. Reconnect late 2026.'
  });

  const wHolmdelPS = await insertWorkshop({
    org: 'Holmdel Public Schools',
    contact_id: C.scott_cascone,
    status: 'Lead',
    title: 'Young Speakers Academy / AI Leadership',
    notes: 'Contact: Dr. Scott Cascone (scascone@holmdelschools.org). Accredited Speaker Program lead. Historical: "The Future of School Leadership with AI" – Aug 25, 2025. Email sent June 23, 2026 to discuss Young Speakers Academy expansion. Coffee meeting pending scheduling.'
  });

  const wIndianHill = await insertWorkshop({
    org: 'Indian Hill School (Holmdel)',
    status: 'Completed',
    title: 'Career Day Series (Software Engineering and AI)',
    date: '2026-05-29',
    notes: 'Recurring high-value partner. Most recent: May 29, 2026 – 8 sessions of 50 min each, grades 4–6, hands-on AI music and story generation. Previous: May 30, 2025 (7 sessions, 20 min), March 31, 2024 (7 sessions, 20 min). 20+ students per session.'
  });

  const wMatawanChamber = await insertWorkshop({
    org: 'Matawan-Aberdeen Chamber of Commerce',
    contact_id: C.linda_matawan,
    status: 'Completed',
    title: 'AI for Local Business Owners',
    date: '2026-03-03',
    notes: 'Contact: Linda (linda@macocnj.com). March 3, 2026 AI session at Ginkaku Japanese Bistro, 24 attendees. Active referral node and guest speaker. Resume posted to MC Job Board June 20, 2026.'
  });

  const wMAPL = await insertWorkshop({
    org: 'Matawan-Aberdeen Public Library',
    contact_id: C.kimberly_paone,
    status: 'Confirmed',
    title: 'AI Decoded Series (Sessions 1–5)',
    notes: 'Contacts: Kimberly Paone, Jennifer Elliott, Krista Horan. High-priority node. Kimberly Paone confirmed Toastmasters rec form submission (June 2026). AI Decoded: Building Blocks, Daily Life, Under the Hood, Securing the Future, The Future of Thinking. Historical: AI Program (Feb 10, 2025), Find Your Voice (Jan 15, 2025), Master the Art of Public Speaking (March 14, 2024).'
  });

  const wPlainsboro = await insertWorkshop({
    org: 'Plainsboro Public Library',
    contact_id: C.james_fahey,
    status: 'Inactive',
    title: 'AI Program',
    notes: 'Contact: James Fahey (referred by Krista Horan from MAPL). Submitted form and follow-up June 30, 2026. James declined – budget constraints and too many existing AI programs. Emailed follow-up with new ideas July 17, 2026.'
  });

  const wMARSD = await insertWorkshop({
    org: 'Matawan-Aberdeen Regional School District',
    contact_id: C.sean_cronin,
    status: 'Lead',
    title: 'AI Professional Development Session',
    cost: '$50/session',
    notes: 'Contacts: Sean Cronin, Mike Liebmann. Original Oct 13 PD day cancelled. $150 rate rejected. Counter-offer: $50 for summer AI session submitted June 12, 2026. Sent email July 22 to schedule for fall at $50 rate.'
  });

  const wFireAcademy = await insertWorkshop({
    org: 'Monmouth County Fire Academy',
    contact_id: C.glenn_talavera,
    status: 'Completed',
    title: 'Effective Public Speaking & Active Listening',
    date: '2026-05-13',
    cost: '$75/hour',
    notes: 'Contact: Glenn Talavera (Director, Monmouth County Dept of Human Resources). May 13, 2026: 4 total sessions, 11AM session 45+ attendees. Submitted AI workshop info, he will follow up. Last direct communication May 21, 2026. Sent follow-up July 2, 2026. Trying to schedule 1–2 sessions for October 7, 2026.'
  });

  const wMonmouthCountyLib = await insertWorkshop({
    org: 'Monmouth County Library',
    contact_id: C.jodi_simon,
    status: 'Confirmed',
    title: 'Next-Level AI: Exploring Google Gemini and NotebookLM / AI & Family Safety',
    notes: 'Contacts: Jodi Simon (MLIS), Jennifer Berry (jberry@monmouthcountylib.org). Level 1 approval confirmed June 15, 2026. Accepted program for 2027 – they will reach out September 2026 for scheduling. NEW: "AI & Family Safety" proposal submitted July 17, 2026 – approved July 18, passed Level 1. Program submission portal available. Two active programs.'
  });

  const wOldBridge = await insertWorkshop({
    org: 'Old Bridge Township Public Schools',
    contact_id: C.jennifer_dantuono,
    status: 'Lead',
    notes: 'Contact: Jennifer D\'Antuono (jdantuono@obps.org). Active workshop pitch. Follow-up email sent June 12, 2026.'
  });

  const wPrinceton = await insertWorkshop({
    org: 'Princeton Fitness & Wellness',
    status: 'Completed',
    title: 'Speak So Others Will Listen',
    date: '2025-11-14',
    notes: 'November 14, 2025. 20+ attendees. Community workshop.'
  });

  const wRaritanValley = await insertWorkshop({
    org: 'Raritan Valley Elementary',
    contact_id: C.anthony_vona,
    status: 'Lead',
    notes: 'Contacts: Anthony Vona, Lisa Auletta. Second follow-up email sent June 12, 2026.'
  });

  const wRedBank = await insertWorkshop({
    org: 'Red Bank Public Library',
    contact_id: C.emily_miller,
    status: 'Confirmed',
    title: 'Multiple Workshop Programs',
    notes: 'Contact: Emily Miller (emily@redbanklibrary.org). Active partner. Programs: Telling Tales: The Art of Storytelling (Oct 2, 2025), AI for Beginners (March 6, 2025), Find Your Voice (Feb 6, 2025), Youth Leadership Program (July–Aug 2024). Multiple repeat engagements.'
  });

  const wRPI = await insertWorkshop({
    org: 'RPI Alumni Event',
    status: 'Completed',
    title: "Find Your Voice with Paul Ireifej '07",
    date: '2025-03-26',
    notes: "March 26, 2025. 1-hour interactive session for alumni and friends. Institutional networking engagement."
  });

  const wSayreville = await insertWorkshop({
    org: 'Sayreville Middle School',
    contact_id: C.scott_nurnberger,
    status: 'Lead',
    notes: 'Contact: Scott Nurnberger (Scott.Nurnberger@sayrevillek12.net). Follow-up email sent June 12, 2026.'
  });

  const wSomerville = await insertWorkshop({
    org: "SCLSNJ's Somerville Library",
    status: 'Completed',
    title: 'Youth Leadership Program – Impromptu Speaking',
    date: '2024-03-09',
    notes: 'March 9, 2024. Guest session, 15 attendees.'
  });

  const wToastmasters = await insertWorkshop({
    org: 'Toastmasters',
    contact_id: C.susan_matson,
    status: 'Lead',
    title: 'Speak So Others Will Listen',
    notes: 'Contact: Susan Matson (smatson123@icloud.com). Strategic tracking for speaking opportunities. Last follow-up June 6, 2026. Accredited Speaker program contact: accreditedspeaker@toastmasters.org.'
  });

  // Archive / Low Priority
  await insertWorkshop({ org: 'Bernards Township Library', status: 'Inactive', notes: 'Follow-up campaign sent June 6, 2026 (mnorton@bernardslibrary.org). Low priority.' });
  await insertWorkshop({ org: 'Clarence Dillon Public Library', contact_id: C.arthur || null, status: 'Inactive', notes: 'Lead moved to inactive following Director Arthur\'s "interest-based only" instruction.' });
  await insertWorkshop({ org: 'Holmdel Library', status: 'Inactive', notes: 'Lead terminated. Program cancelled as of May 21, 2025.' });
  await insertWorkshop({ org: 'Morris County Library', contact_id: C.anne_mizera || null, status: 'Lead', notes: 'Contact: Anne Mizera (amizera@co.morris.nj.us). Follow-up sent June 6, 2026. Lower priority.' });
  await insertWorkshop({ org: 'Morristown Library', contact_id: C.mary_lynn_becza || null, status: 'Lead', notes: 'Contact: Mary Lynn Becza (marylynn.becza@mmt.mainlib.org). Follow-up sent June 6, 2026. Lower priority.' });
  await insertWorkshop({ org: 'EMACC (Eastern Monmouth Chamber)', status: 'Inactive', notes: 'Director Jennifer Eckhoff retired April 30, 2026. Inactive.' });
  await insertWorkshop({ org: 'Greater New Brunswick Rotary', status: 'Inactive', notes: 'Closed.' });

  console.log('\n=== STEP 4: Inserting activity logs ===');

  // Toastmasters Accredited Speaker rec form tracking (logged against each workshop/contact)
  await insertLog('workshop', wBBBS, C.marybeth_bull, 'Toastmasters Accredited Speaker rec form requested June 4, 2026. MaryBeth Bull confirmed submitted June 24. Follow-up email July 13, 2026 – she confirmed she submitted. Next step: contact Toastmasters International (accreditedspeaker@toastmasters.org) to confirm receipt.', '2026-07-13');
  await insertLog('workshop', wMAPL, C.kimberly_paone, 'Toastmasters Accredited Speaker rec form confirmed submitted by Kimberly Paone (June 2026).', '2026-06-30');
  await insertLog('workshop', wCFCA, C.sara_whitwell, 'Toastmasters Accredited Speaker rec form requested June 20, 2026. Confirmed received by Toastmasters International Accredited Speaker Program.', '2026-06-20');
  await insertLog('workshop', wBrookdale, C.christopher_carroll, 'Christopher Carroll confirmed Toastmasters Accredited Speaker rec form submitted to World Headquarters on June 4, 2026.', '2026-06-04');
  await insertLog('contact', C.linda_matawan, C.linda_matawan, 'Linda Martin (Matawan Chamber): emailed July 15, 2026 requesting Toastmasters Accredited Speaker recommendation form based on 30-second elevator speech presentation.', '2026-07-15');

  // Key position activity logs
  await insertLog('workshop', wMonmouthCountyLib, C.jennifer_berry, 'Jennifer Berry reached out. New proposal "AI & Family Safety" submitted July 17, 2026. Approved July 18, passed Level 1.', '2026-07-18');
  await insertLog('workshop', wHazletLib, C.jennifer_brennan, 'AI for Beginners proposal submitted June 12, 2026. Notification received: under review by Monmouth County Library Programming Staff (Jodi Simon).', '2026-06-12');
  await insertLog('workshop', wFireAcademy, C.glenn_talavera, 'Sent AI workshop information. Glenn said he will follow up. Trying to schedule October 7 sessions. Follow-up email sent July 2, 2026.', '2026-07-02');
  await insertLog('workshop', wMARSD, C.sean_cronin, 'Counter-offer of $50 for summer AI session submitted after original Oct 13 PD day cancelled and $150 rate rejected. Sent follow-up email July 22 to schedule for fall.', '2026-07-22');

  console.log('\n✅ All data loaded successfully!\n');

  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM crm_positions) AS positions,
      (SELECT COUNT(*) FROM crm_workshops) AS workshops,
      (SELECT COUNT(*) FROM crm_activity_logs) AS logs,
      (SELECT COUNT(*) FROM crm_contacts) AS contacts
  `);
  console.log('Final counts:', counts.rows[0]);
}

main().then(() => pool.end()).catch(e => { console.error('FATAL:', e.message); pool.end(); process.exit(1); });
