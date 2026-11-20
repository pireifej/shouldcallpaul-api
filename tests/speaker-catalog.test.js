'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const catalog = require('../portfolio/speaker-catalog');
const { categories,quote } = require('../portfolio/catalog');
const { transaction,saveEntry,readSpeakerMenu } = require('../portfolio/store');

test('catalog title matching changes case, spacing and minor punctuation, not topic meaning', () => {
  assert.equal(catalog.normalize('  AI & The Modern Career!  '),catalog.normalize('ai and the modern career'));
  assert.equal(catalog.normalize("The Parent’s Guide"),catalog.normalize("The Parent's Guide"));
  assert.notEqual(catalog.normalize('Find Your Voice - Client A'),catalog.normalize('Find Your Voice'));
  assert.notEqual(catalog.normalize('AI Safety'),catalog.normalize('AI Homework'));
  assert.throws(() => catalog.publicContent({title:'Event',description:'Email me at someone@example.com',
    category_id:'ai',public_copy_confirmed:true}),/reusable text/);
});

test('concurrent real transactions cannot create duplicate inline topics or deliveries on retries', {
  skip: !process.env.DATABASE_URL && 'Development PostgreSQL is required'
}, async () => {
  const raw = new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:4});
  const schema = `catalog_concurrency_${randomUUID().replaceAll('-','')}`;
  const rewrite = sql => sql.replaceAll('public.',`${schema}.`);
  const pool = {
    query:(sql,params) => raw.query(rewrite(sql),params),
    async connect() {
      const client = await raw.connect();
      return {query:(sql,params) => client.query(rewrite(sql),params),release:() => client.release()};
    }
  };
  try {
    await raw.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE public.speaker_menu(id INTEGER PRIMARY KEY,title TEXT,subtitle TEXT);
      INSERT INTO public.speaker_menu VALUES(1,'Offerings','Delivered topics');
      CREATE TABLE public.speaker_categories(id TEXT PRIMARY KEY,sort_order INTEGER DEFAULT 0,
        published BOOLEAN DEFAULT true,content JSONB);
      INSERT INTO public.speaker_categories(id,content) VALUES('skills','{"id":"skills","title":"Skills"}');
      CREATE TABLE public.speaker_topics(id TEXT PRIMARY KEY,category_id TEXT REFERENCES public.speaker_categories(id),
        sort_order INTEGER DEFAULT 0,published BOOLEAN DEFAULT true,content JSONB);
      CREATE TABLE public.resume_workshops(id TEXT PRIMARY KEY,published BOOLEAN DEFAULT false,sort_order INTEGER DEFAULT 0,
        organization_id INTEGER,field_names TEXT[],created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW(),
        ${Object.entries(categories.workshops.fields).map(([k,v]) => `${quote(k)} ${v}`).join(',')});
      CREATE TABLE public.resume_workshop_sessions(id SERIAL PRIMARY KEY,resume_entry_id TEXT,sort_order INTEGER,content JSONB);`);
    await pool.query(fs.readFileSync('migrations/speaker-catalog.sql','utf8'));
    const before = await pool.query("SELECT count(*)::int AS n FROM public.speaker_topics");
    assert.equal(before.rows[0].n,0);
    const save = id => transaction(pool,db => saveEntry(db,'workshops',{
      entry:{id,label:'Different Event '+id},published:true,completion_status:'complete',
      catalog:{new_topics:[{title:'One Shared Subject',description:'A reusable skill-building session.',
        category_id:'skills',public_copy_confirmed:true}]}
    }));
    const [a,b] = await Promise.all([save('delivery-a'),save('delivery-b')]);
    assert.deepEqual(a.catalog.topic_ids,b.catalog.topic_ids);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.speaker_topics')).rows[0].n,1);
    assert.equal((await readSpeakerMenu(pool)).categories[0].items.length,1);
    await assert.rejects(save('delivery-a'),error => error.code === '23505');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.speaker_topics')).rows[0].n,1);
    const row = (await pool.query('SELECT * FROM public.resume_workshops WHERE id=$1',['delivery-a'])).rows[0];
    await transaction(pool,db => saveEntry(db,'workshops',{entry:{label:'Corrected event name'}},row));
    assert.equal((await readSpeakerMenu(pool)).categories[0].items.length,1);
    // Database unique constraints protect duplicate canonical topic keys too.
    await assert.rejects(pool.query(`INSERT INTO public.speaker_topics(id,category_id,content,catalog_title_key)
      VALUES($1,'skills',$2,$3)`,['duplicate',JSON.stringify({title:'One Shared Subject'}),catalog.normalize('One Shared Subject')]),
    error => error.code === '23505');
  } finally {
    await raw.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await raw.end();
  }
});
