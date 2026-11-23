'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { RevenueCatProService } = require('../revenueCatProService');
const subscriptionRoutes = require('../routes/subscriptions');
const { requireUserSession, issueUserSessionToken } = require('../userSession');

function fixture({stored=null, active=true, aliases=[], fail=false, conflict=false}={}) {
  const calls=[],updates=[];
  let mapping=stored;
  const service=new RevenueCatProService({
    projectId:'test-project',entitlementId:'test-pro',identitySecret:'test-account-binding-secret',
    pool:{async query(sql,params) {
      if(sql.includes('SELECT revenuecat_app_user_id')) return {rows:[{revenuecat_app_user_id:mapping}]};
      if(sql.includes('UPDATE')) {
        if(conflict) throw Object.assign(new Error('Synthetic uniqueness conflict'),{code:'23505'});
        updates.push(params); mapping=params[0];return {rowCount:1,rows:[]};
      }
      throw new Error('Unexpected test query');
    }},
    connectorsFactory:()=>({async proxy(name,url,options) {
      assert.equal(name,'revenuecat');assert.equal(options.method,'GET');calls.push(url);
      if(fail) return {ok:false,status:503};
      return {ok:true,status:200,json:async()=>({
        items:url.includes('/aliases?') ? aliases.map(id=>({id})) : active?[{entitlement_id:'test-pro'}]:[]
      })};
    }})
  });
  return {service,calls,updates,mapping:()=>mapping};
}

test('first link requires server-derived account identity and provider entitlement, not a client customer claim',async()=>{
  const f=fixture();
  await assert.rejects(f.service.getProStatus({userId:42,revenuecatAppUserId:'someone-elses-active-customer'}),
    e=>e.statusCode===403 && e.code==='SUBSCRIPTION_IDENTITY_MISMATCH');
  assert.equal(f.calls.length,0);assert.equal(f.updates.length,0);
  const mine=await f.service.getAccountIdentity({userId:42});
  const other=await f.service.getAccountIdentity({userId:43});
  assert.notEqual(mine.revenuecatAppUserId,other.revenuecatAppUserId);
  await assert.rejects(f.service.getProStatus({userId:42,revenuecatAppUserId:other.revenuecatAppUserId}),
    e=>e.statusCode===403);
  const result=await f.service.getProStatus({userId:42,revenuecatAppUserId:mine.revenuecatAppUserId});
  assert.equal(result.isPro,true);
  assert.equal(f.mapping(),mine.revenuecatAppUserId);
  assert(f.calls.every(url=>url.includes(encodeURIComponent(mine.revenuecatAppUserId))));
  assert.equal(f.updates.length,1);
});

test('inactive provider entitlement cannot establish even a correctly bound first link',async()=>{
  const f=fixture({active:false});
  assert.equal((await f.service.getProStatus({userId:42})).isPro,false);
  assert.equal(f.mapping(),null);assert.equal(f.updates.length,0);
});

test('an explicit signed-account refresh observes a purchase or expiration despite cached status',async()=>{
  const f=fixture({active:false});
  assert.equal((await f.service.getProStatus({userId:42})).isPro,false);
  f.service.fetchActiveEntitlement=async()=>true;
  assert.equal((await f.service.getProStatus({userId:42})).isPro,false,'Negative cache should be present');
  assert.equal((await f.service.getProStatus({userId:42,refresh:true})).isPro,true);
  f.service.fetchActiveEntitlement=async()=>false;
  assert.equal((await f.service.getProStatus({userId:42})).isPro,true,'Positive cache should be present');
  assert.equal((await f.service.getProStatus({userId:42,refresh:true})).isPro,false);
});

test('opaque account identities are stable and require a configured signing secret',async()=>{
  const a=fixture(),b=fixture();
  assert.equal((await a.service.getAccountIdentity({userId:42})).revenuecatAppUserId,
    (await b.service.getAccountIdentity({userId:42})).revenuecatAppUserId);
  a.service.identitySecret='';
  await assert.rejects(a.service.getAccountIdentity({userId:42}),e=>e.statusCode===503);
});

test('an existing anonymous mapping alone is not account ownership proof',async()=>{
  const f=fixture({stored:'legacy-anonymous-customer'});
  const result=await f.service.getProStatus({userId:42,revenuecatAppUserId:'legacy-anonymous-customer'});
  assert.equal(result.isPro,false);assert.equal(result.identityVerificationRequired,true);
  assert.equal(f.mapping(),'legacy-anonymous-customer');assert.equal(f.updates.length,0);
  assert(f.calls.every(url=>url.includes('/aliases?')));
});

test('provider-confirmed alias binding supports an existing mapping without replacing it',async()=>{
  const f=fixture({stored:'legacy-anonymous-customer',aliases:['legacy-anonymous-customer']});
  assert.equal((await f.service.getProStatus({userId:42})).isPro,true);
  assert.equal(f.mapping(),'legacy-anonymous-customer');assert.equal(f.updates.length,0);
  const identity=await f.service.getAccountIdentity({userId:42});
  assert(f.calls.every(url=>url.includes(identity.revenuecatAppUserId)));
});

test('a different supplied mapping cannot replace an existing mapping',async()=>{
  const f=fixture({stored:'existing-customer'});
  await assert.rejects(f.service.getProStatus({userId:42,revenuecatAppUserId:'replacement-customer'}),e=>e.statusCode===409);
  assert.equal(f.mapping(),'existing-customer');assert.equal(f.calls.length,0);
});

test('provider account-binding failures fail closed instead of accepting a stored mapping',async()=>{
  const f=fixture({stored:'legacy-customer',fail:true});
  await assert.rejects(f.service.getProStatus({userId:42}),e=>e.statusCode===503);
  assert.equal(f.updates.length,0);
});

test('provider transport failures are a retryable service error, not inactive status or a leaked connector error',async()=>{
  const f=fixture();
  f.service.connectorsFactory=()=>({proxy:async()=>{throw new Error('synthetic-internal-connector-detail');}});
  await assert.rejects(f.service.getProStatus({userId:42}),
    e=>e.statusCode===503 && !e.message.includes('synthetic-internal'));
  assert.equal(f.updates.length,0);
});

test('database ownership conflicts cannot grant Pro after a failed first link',async()=>{
  const f=fixture({conflict:true});
  await assert.rejects(f.service.getProStatus({userId:42}),e=>e.statusCode===409);
  assert.equal(f.mapping(),null);
});

test('mobile identity and pro-status routes derive account solely from the signed session',async()=>{
  const old=process.env.SESSION_SECRET;
  process.env.SESSION_SECRET='synthetic-session-test-secret';
  const f=fixture();
  const app=express();app.use(express.json());app.use(subscriptionRoutes({
    authenticate:(req,res,next)=>req.get('authorization')==='Basic test'?next():res.sendStatus(401),
    requireUserSession,proSubscriptionService:f.service
  }));
  const server=app.listen(0);await new Promise(r=>server.once('listening',r));
  const post=(path,body={},token=issueUserSessionToken(42))=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{
    method:'POST',headers:{authorization:'Basic test','content-type':'application/json',
      ...(token?{'x-user-session-token':token}:{})},body:JSON.stringify(body)
  });
  try {
    assert.equal((await post('/api/subscriptions/identity',{},null)).status,401);
    assert.equal((await post('/api/subscriptions/identity',{userId:43})).status,403);
    const response=await post('/api/subscriptions/identity');
    assert.equal(response.status,200);
    const identity=await response.json();
    assert.equal(identity.revenuecatAppUserId,(await f.service.getAccountIdentity({userId:42})).revenuecatAppUserId);
    assert.equal(f.updates.length,0);assert.equal(f.calls.length,0);
    const forged=await post('/api/subscriptions/pro-status',{revenuecatAppUserId:'unbound-premium-customer'});
    assert.equal(forged.status,403);assert.equal((await forged.json()).error,'SUBSCRIPTION_IDENTITY_MISMATCH');
    const confirmed=await post('/api/subscriptions/pro-status',{revenuecatAppUserId:identity.revenuecatAppUserId});
    assert.equal(confirmed.status,200);assert.equal((await confirmed.json()).isPro,true);
  } finally {
    await new Promise(r=>server.close(r));
    if(old===undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET=old;
  }
});
