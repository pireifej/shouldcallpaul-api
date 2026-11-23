'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const path=require('node:path');
const multer=require('multer');
const prayers=require('../routes/prayers');
const devotional=require('../routes/devotional');
const admin=require('../routes/admin');
const {createRequirePro}=require('../revenueCatProService');
const {requireUserSession,issueUserSessionToken}=require('../userSession');

const article={id:1,date:'2026-11-20',lang:'en',title:'Synthetic article',bible_verse:'Verse',
  verse_reference:'Reference',theme:'Theme',image_url:null,article_body:'premium-body-marker',prayer:'premium-prayer-marker'};
const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'});
const features=[
  ['GET','/api/requests',{}],
  ['POST','/getAllRequests',{}],
  ['POST','/getDetailedPrayerByRequestId',{requestId:1}],
  ['POST','/api/prayers/generate',{requestText:'Synthetic text',extended:true}],
  ['POST','/testGeneratePrayer',{requestText:'Synthetic text',extended:'true'}],
  ['POST','/getPrayerAudio',{requestId:1,text:'Synthetic text'}],
  ['POST','/api/prayer-walk/stream',{requestId:1,text:'Synthetic text'}],
  ['POST','/getDailyDevotional',{}],
  ['POST','/api/daily-bread',{}],
  ['POST','/getDailyBreadAudio',{date:today,checkOnly:true}],
  ['POST','/getDailyBreadAudio',{date:today}],
  ['POST','/getDailyBreadAudio',{date:'2020-01-01'}],
  ['POST','/getDailyDevotionalById',{articleId:1}],
  ['POST','/getDailyDevotionalArchive',{}],
  ['POST','/readDailyBread',{}]
];
async function withApp(run) {
  const previous=process.env.SESSION_SECRET;process.env.SESSION_SECRET='pro-gates-test-secret';
  let queries=0;
  const pool={async query(sql) {
    queries++;
    if(sql.includes('COUNT(*)'))return {rows:[{count:'1',total:1}]};
    if(sql.includes('last_daily_bread_date'))return {rows:[{last_daily_bread_date:null}]};
    if(sql.includes('extended_prayer'))return {rows:[{extended_prayer:'premium-marker',standard_prayer:'standard-marker'}]};
    if(sql.includes('detailed_prayer'))return {rows:[{detailed_prayer:'premium-marker'}]};
    if(sql.includes('FROM public.request'))return {rows:[{request_id:1,detailed_prayer:'premium-marker',detailed_prayer_es:'premium-es-marker'}]};
    return {rows:[article],rowCount:1};
  }};
  const proSubscriptionService={getProStatus:async identity=>({isPro:identity.userId===43})};
  const ctx={
    pool,path,multer,
    authenticate:(req,res,next)=>req.get('authorization')==='Basic test'?next():res.sendStatus(401),
    requireUserSession,proSubscriptionService,requirePro:createRequirePro(proSubscriptionService),
    log:()=>{},dailyBreadAudioCache:new Map([
      [today,Buffer.from('synthetic-today-audio')],['2020-01-01',Buffer.from('synthetic-archive-audio')]
    ]),
    prayerAudioCache:new Map([['1',Buffer.from('synthetic-audio')]]),
    serveAudioBuffer:(req,res,b)=>res.type('audio/mpeg').send(b),
    generatePrayer:async()=>({processedPrayer:'premium-marker',rawPrayer:'premium-marker'}),
    awardBadge:async()=>null
  };
  const app=express();app.use(express.json());app.use(prayers(ctx));app.use(devotional(ctx));app.use(admin(ctx));
  const server=app.listen(0);await new Promise(r=>server.once('listening',r));
  const call=(method,url,body,user=42,appAuth=true)=>fetch(`http://127.0.0.1:${server.address().port}${url}`,{
    method,headers:{'content-type':'application/json',...(appAuth?{authorization:'Basic test'}:{}),
      ...(user?{'x-user-session-token':issueUserSessionToken(user)}:{})},
    ...(method==='POST'?{body:JSON.stringify(body)}:{})
  });
  try {await run(call,()=>queries);} finally {
    await new Promise(r=>server.close(r));
    if(previous===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=previous;
  }
}

for(const [method,url,body] of features) {
  test(`${method} ${url}${body.date?' '+body.date:''}: app + session + Pro are checked before premium reads`,async()=>{
    await withApp(async(call,queries)=>{
      assert.equal((await call(method,url,body,42,false)).status,401);
      assert.equal((await call(method,url,body,null)).status,401);
      const before=queries();
      const denied=await call(method,url,body,42);
      assert.equal(denied.status,403);
      assert.deepEqual(await denied.json(),{
        error:'PRO_REQUIRED',message:'An active Pray Over Us Pro subscription is required.'
      });
      assert.equal(queries(),before,'Free user reached a premium data query');
      const allowed=await call(method,url,body,43);
      assert.equal(allowed.status,200);
    });
  });
}

test('free Daily Bread preview excludes full reading, prayer, and audio URLs',async()=>{
  await withApp(async call=>{
    const response=await call('GET','/getDailyDevotional',{},42);
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.result.locked,true);
    for(const field of ['article_body','prayer','audio_url'])assert(!Object.hasOwn(body.result,field));
  });
});

test('standard generation and standard cached reading remain free; extended cached reading requires Pro',async()=>{
  await withApp(async call=>{
    assert.equal((await call('POST','/api/prayers/generate',{requestText:'Synthetic text'},42)).status,200);
    const free=await call('POST','/getPrayer',{requestId:1},42);
    assert.deepEqual(await free.json(),{error:0,prayerText:'standard-marker',isExtended:false});
    const pro=await call('POST','/getPrayer',{requestId:1},43);
    assert.deepEqual(await pro.json(),{error:0,prayerText:'premium-marker',isExtended:true});
  });
});
