'use strict';
// Fully isolated PostgreSQL process: no DATABASE_URL, production connection,
// application schema, customers, or external credentials are used.
const test=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync,spawnSync}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Pool}=require('pg');
const {persistCompletedPost}=require('../postingPersistence');
const available=spawnSync('initdb',['--version'],{stdio:'ignore'}).status===0;

test('real PostgreSQL: free posting is atomic across connections and rolls back failed prayer persistence',
  {skip:!available,timeout:45000},async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pou-quota-test-'));
    const data=path.join(dir,'data');
    let pool,started=false;
    try {
      execFileSync('initdb',['-D',data,'-A','trust','-U','postgres','--no-locale'],{stdio:'pipe',timeout:15000});
      execFileSync('pg_ctl',['-D',data,'-l',path.join(dir,'postgres.log'),'-w','-t','15',
        '-o',`-h '' -k ${dir} -p 15432`,'start'],{stdio:'pipe',timeout:20000});
      started=true;
      pool=new Pool({host:dir,port:15432,user:'postgres',database:'postgres',max:4});
      await pool.query(`
        CREATE TABLE public.prayers (
          prayer_id SERIAL PRIMARY KEY, prayer_title TEXT,
          prayer_text TEXT NOT NULL CHECK(prayer_text <> 'synthetic-write-failure'),
          prayer_text_me TEXT, tags TEXT, active SMALLINT, prayer_file_name TEXT, prayer_en TEXT, prayer_es TEXT
        );
        CREATE TABLE public.request (
          request_id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL,
          request_text TEXT, request_title TEXT, picture TEXT,
          fk_prayer_id INTEGER REFERENCES public.prayers(prayer_id), active SMALLINT,
          my_church_only BOOLEAN, timestamp TIMESTAMP NOT NULL, updated_timestamp TIMESTAMP,
          content_en TEXT, content_es TEXT, request_source TEXT, website_request_date DATE
        )`);
      const insertQuery=`INSERT INTO public.request (
        user_id,request_text,request_title,picture,fk_prayer_id,active,my_church_only,
        content_en,content_es,request_source,website_request_date,timestamp,updated_timestamp
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamp,$12::timestamp) RETURNING request_id`;
      const post=(isPro=false,prayerText='synthetic-generated-prayer')=>persistCompletedPost({
        pool,userId:42,isPro,requestSource:'mobile',postingNow:()=>new Date('2026-11-23T15:00:00Z'),
        insertQuery,queryParams:[42,'synthetic request','synthetic title',null,null,1,false,null,null,'mobile',null,null],
        prayerText,lang:'en'
      });
      await assert.rejects(post(false,'synthetic-write-failure'),e=>e.code==='23514');
      assert.equal((await pool.query('SELECT COUNT(*) FROM public.request')).rows[0].count,'0');
      assert.equal((await pool.query('SELECT COUNT(*) FROM public.prayers')).rows[0].count,'0');
      const concurrent=await Promise.all([post(),post()]);
      assert.deepEqual(concurrent.map(r=>r.limited).sort(),[false,true]);
      assert.equal((await pool.query('SELECT COUNT(*) FROM public.request WHERE fk_prayer_id IS NOT NULL')).rows[0].count,'1');
      assert.equal((await pool.query('SELECT COUNT(*) FROM public.prayers')).rows[0].count,'1');
      assert.equal((await post()).limited,true);
      const proPosts=await Promise.all([post(true),post(true)]);
      assert(proPosts.every(r=>r.limited===false));
      assert.equal((await pool.query('SELECT COUNT(*) FROM public.request')).rows[0].count,'3');
      assert.equal((await pool.query('SELECT COUNT(*) FROM public.prayers')).rows[0].count,'3');
    } finally {
      if(pool)await pool.end();
      if(started)execFileSync('pg_ctl',['-D',data,'-m','immediate','-w','stop'],{stdio:'pipe',timeout:10000});
      fs.rmSync(dir,{recursive:true,force:true});
    }
  });
