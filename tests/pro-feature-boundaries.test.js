'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const path=require('node:path');
const multer=require('multer');
const prayers=require('../routes/prayers');
const devotional=require('../routes/devotional');
const admin=require('../routes/admin');
const subscriptions=require('../routes/subscriptions');
const {createRequirePro}=require('../revenueCatProService');
const {requireUserSession,issueUserSessionToken}=require('../userSession');
const {createInterimContentAccess}=require('../interimContentAccess');

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
async function withApp(run, contentPaywallEnabled = true) {
  const previous=process.env.SESSION_SECRET;process.env.SESSION_SECRET='pro-gates-test-secret';
  let queries=0,subscriptionChecks=0;
  const pool={async query(sql) {
    queries++;
    if(sql.includes('COUNT(*)'))return {rows:[{count:'1',total:1}]};
    if(sql.includes('last_daily_bread_date'))return {rows:[{last_daily_bread_date:null}]};
    if(sql.includes('extended_prayer'))return {rows:[{extended_prayer:'premium-marker',standard_prayer:'standard-marker'}]};
    if(sql.includes('detailed_prayer'))return {rows:[{detailed_prayer:'premium-marker'}]};
    if(sql.includes('FROM public.request'))return {rows:[{request_id:1,detailed_prayer:'premium-marker',detailed_prayer_es:'premium-es-marker'}]};
    return {rows:[article],rowCount:1};
  }};
  const proSubscriptionService={getProStatus:async identity=>{
    subscriptionChecks++;
    return {isPro:identity.userId===43};
  }};
  const ctx={
    pool,path,multer,contentPaywallEnabled,
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
  app.use(subscriptions(ctx));
  const server=app.listen(0);await new Promise(r=>server.once('listening',r));
  const call=(method,url,body,user=42,appAuth=true)=>fetch(`http://127.0.0.1:${server.address().port}${url}`,{
    method,headers:{'content-type':'application/json',...(appAuth?{authorization:'Basic test'}:{}),
      ...(user?{'x-user-session-token':issueUserSessionToken(user)}:{})},
    ...(method==='POST'?{body:JSON.stringify(body)}:{})
  });
  try {await run(call,()=>queries,()=>subscriptionChecks);} finally {
    await new Promise(r=>server.close(r));
    if(previous===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=previous;
  }
}

for(const enabled of [false,true]) {
  test(`authenticated access policy matches actual content gates, paywall=${enabled}, without provider or database lookup`,async()=>{
    await withApp(async(call,queries,subscriptionChecks)=>{
      const url='/api/subscriptions/access-policy';
      assert.equal((await call('GET',url,{},42,false)).status,401);
      assert.equal((await call('GET',url,{},null)).status,401);
      const beforeQueries=queries(),beforeSubscriptions=subscriptionChecks();
      for(const user of [42,43]) {
        const response=await call('GET',url,{},user);
        assert.equal(response.status,200);
        assert.equal(response.headers.get('cache-control'),'private, no-store');
        assert.deepEqual(await response.json(),{
          contentPaywallEnabled:enabled,
          dailyBread:{requiresPro:enabled},
          prayerWalk:{requiresPro:enabled},
          extendedPrayer:{requiresPro:true}
        });
      }
      assert.equal(queries(),beforeQueries);
      assert.equal(subscriptionChecks(),beforeSubscriptions);
      for(const url of ['/getDailyDevotional','/getPrayerAudio']) {
        const response=await call('POST',url,{requestId:1,text:'Synthetic text'},42);
        assert.equal(response.status,enabled?403:200);
      }
    },enabled);
  });
}

const interimFeatures=features.filter(([,url])=>[
  '/getPrayerAudio','/api/prayer-walk/stream','/getDailyDevotional',
  '/api/daily-bread','/getDailyBreadAudio','/getDailyDevotionalById',
  '/getDailyDevotionalArchive','/readDailyBread'
].includes(url));

for(const [method,url,body] of interimFeatures) {
  test(`${url}${body.date?' '+body.date:''}: interim access permits signed-in free users but still checks identity`,async()=>{
    await withApp(async(call,queries,subscriptionChecks)=>{
      const before=subscriptionChecks();
      assert.equal((await call(method,url,body,42,false)).status,401);
      assert.equal((await call(method,url,body,null)).status,401);
      const response=await call(method,url,body,42);
      assert.equal(response.status,200);
      assert.equal(response.headers.get('cache-control'),'private, no-store');
      const mismatch=await call(method,url,{...body,userId:43},42);
      assert.equal(mismatch.status,403);
      assert.equal((await mismatch.json()).error,'USER_ID_MISMATCH');
      assert.equal(subscriptionChecks(),before,'Interim content must not depend on RevenueCat availability');
    }, false);
  });
}

test('interim unlock does not grant extended-content access or change standard prayer fallback',async()=>{
  await withApp(async call=>{
    for(const [method,url,body] of features.filter(feature=>!interimFeatures.includes(feature))) {
      const response=await call(method,url,body,42);
      assert.equal(response.status,403,url);
      assert.equal((await response.json()).error,'PRO_REQUIRED');
    }
    const response=await call('POST','/getPrayer',{requestId:1},42);
    assert.deepEqual(await response.json(),{error:0,prayerText:'standard-marker',isExtended:false});
  },false);
});

test('request fields cannot disable the server-selected content paywall',async()=>{
  await withApp(async call=>{
    for(const url of ['/getPrayerAudio','/getDailyDevotional']) {
      const response=await call('POST',url,{
        requestId:1,text:'Synthetic text',contentPaywallEnabled:false,
        PRAY_OVER_US_CONTENT_PAYWALL_ENABLED:false,isPro:true
      },42);
      assert.equal(response.status,403);
      assert.equal((await response.json()).error,'PRO_REQUIRED');
    }
  },true);
});

test('interim content switch defaults open, enables only explicitly, and rejects invalid settings',()=>{
  const previous=process.env.PRAY_OVER_US_CONTENT_PAYWALL_ENABLED;
  try {
    delete process.env.PRAY_OVER_US_CONTENT_PAYWALL_ENABLED;
    for(const setting of [undefined,false,'false','',true,'true']) {
      let proChecks=0,nextCalls=0;
      const guard=createInterimContentAccess(()=>proChecks++,{enabled:setting});
      guard({}, {set(){}}, ()=>nextCalls++);
      assert.equal(proChecks,setting===true||setting==='true'?1:0);
      assert.equal(nextCalls,setting===true||setting==='true'?0:1);
    }
    process.env.PRAY_OVER_US_CONTENT_PAYWALL_ENABLED='true';
    let proChecks=0;
    createInterimContentAccess(()=>proChecks++)({}, {set(){}}, ()=>assert.fail('Unexpected bypass'));
    assert.equal(proChecks,1);
    assert.throws(()=>createInterimContentAccess(()=>{}, {enabled:'tru'}),/must be true or false/);
  } finally {
    if(previous===undefined)delete process.env.PRAY_OVER_US_CONTENT_PAYWALL_ENABLED;
    else process.env.PRAY_OVER_US_CONTENT_PAYWALL_ENABLED=previous;
  }
});

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
