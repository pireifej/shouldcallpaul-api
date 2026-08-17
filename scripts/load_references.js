'use strict';
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const refs = [
    {
      name: 'Antoine Diffloth',
      title: 'Director, Data Science',
      organization: 'AT&T',
      linkedin_url: 'https://www.linkedin.com/in/antoine-diffloth-b112841/',
      category: 'Reference',
    },
    {
      name: 'Vibin Baby',
      title: 'Technical Project Manager',
      organization: 'Tech Mahindra',
      linkedin_url: 'https://www.linkedin.com/in/vibin-baby-27282422/',
      phone: '(469) 592-1733',
      category: 'Reference',
    },
    {
      name: 'Stephen Grandinetti',
      title: 'Principal Technical Project Manager',
      organization: 'AT&T',
      email: 'stevegrando@gmail.com',
      phone: '(732) 425-1941',
      linkedin_url: 'https://www.linkedin.com/in/sgrandinetti/',
      category: 'Reference',
    },
    {
      name: 'Raju Puli',
      title: 'Principal Data & AI Engineer',
      organization: 'AT&T',
      phone: '(469) 478-9445',
      linkedin_url: 'https://www.linkedin.com/in/raju-p-1736a571/',
      category: 'Reference',
      notes: 'ML inferencing infrastructure',
    },
    {
      name: 'Heather Wighton',
      title: 'Director',
      organization: 'AT&T',
      email: 'hsmilack@hotmail.com',
      phone: '(610) 216-4768',
      linkedin_url: 'https://www.linkedin.com/in/heatherwighton/',
      category: 'Reference',
    },
    {
      name: 'Prem Kumar Neerukonda',
      organization: 'AT&T',
      email: 'prembudda@gmail.com',
      phone: '(510) 556-9851',
      category: 'Reference',
    },
    {
      name: 'Jim Hohman',
      title: 'Lead Member of Technical Staff',
      email: 'jmhohnj@gmail.com',
      phone: '(973) 534-3701',
      linkedin_url: 'https://www.linkedin.com/in/james-hohman-3707451',
      category: 'Reference',
    },
    {
      name: 'Bishwas',
      phone: '+1 (641) 819-8209',
      category: 'Reference',
    },
  ];

  for (const r of refs) {
    const result = await pool.query(
      `INSERT INTO crm_contacts (name, title, organization, email, phone, linkedin_url, category, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [r.name, r.title || null, r.organization || null, r.email || null,
       r.phone || null, r.linkedin_url || null, r.category, r.notes || null]
    );
    if (result.rows.length) {
      console.log(`✅ Inserted: ${r.name} (id ${result.rows[0].id})`);
    } else {
      console.log(`⚠️  Skipped (already exists?): ${r.name}`);
    }
  }

  const count = await pool.query(`SELECT COUNT(*) FROM crm_contacts WHERE category = 'Reference'`);
  console.log(`\nTotal Reference contacts in DB: ${count.rows[0].count}`);
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
