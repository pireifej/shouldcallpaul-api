'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const routes = require('../routes/subscriptions');
const { requireUserSession, issueUserSessionToken } = require('../userSession');
const { createRequirePro } = require('../revenueCatProService');
const { checkFreeTierDailyLimit } = require('../freeTierRequestLimit');
const { fixture, userId, projectId, fromId, originalId, targetId, authorizationId, list } =
  require('./helpers/subscription-reconciliation');
const rejects = (p, status) => assert.rejects(p, e => e.statusCode === status);

test('unapproved legacy identity keeps its verification requirement and no authorization is created', async () => {
  const f = fixture({ approved: false });
  assert.equal(await f.offer(), undefined);
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
  const status = await f.pro.getProStatus({ userId });
  assert.equal(status.isPro, false);
  assert.equal(status.identityVerificationRequired, true);
  assert.equal(f.mapping, fromId);
});

test('approved offer is exact, fresh, read-only, and does not expose operator evidence', async () => {
  const f = fixture();
  assert.deepEqual(await f.offer(), {
    authorizationId, action: 'switch_without_restore', fromAppUserId: fromId,
    toAppUserId: targetId, expectedOriginalAppUserId: originalId,
    expiresAt: f.approval.expires_at.toISOString()
  });
  assert.equal(f.mapping, fromId); assert.equal(f.writes.length, 0);
  assert(f.reads.length >= 6); assert(f.reads.every(read => read.method === 'GET'));
  assert.equal((await f.pro.getProStatus({ userId })).identityVerificationRequired, true,
    'Offering a transition must not bypass existing ownership protection');
});

test('no approval can be borrowed from another account/project or authorize a different target', async t => {
  for (const [field, value, status] of [
    ['user_id', 99, null], ['project_id', 'other-project', null],
    ['to_customer_id', 'pou_v1_another-account', 409], ['from_customer_id', 'different-legacy', 409],
    ['original_customer_id', '$RCAnonymousID:another-original', 409]
  ]) await t.test(field, async () => {
    const f = fixture(); f.approval[field] = value;
    if (status) await rejects(f.offer(), status);
    else assert.equal(await f.offer(), undefined);
    assert.equal(f.writes.length, 0);
  });
});

test('expiry, future approval, changed mappings, and another owner block the transition', async () => {
  let f = fixture(); f.approval.expires_at = new Date(f.clock.value - 1); await rejects(f.offer(), 410);
  f = fixture(); f.approval.approved_at = new Date(f.clock.value + 1); await rejects(f.offer(), 409);
  f = fixture(); f.mapping = 'changed-mapping'; await rejects(f.offer(), 409);
  f = fixture(); f.otherOwner = true; await rejects(f.offer(), 409); assert.equal(f.reads.length, 0);
});

test('active, production, malformed, non-Play, and non-expired subscription evidence is rejected', async t => {
  for (const patch of [
    { environment: 'production' }, { status: 'active' }, { gives_access: true },
    { store: 'app_store' }, { ends_at: null }, { current_period_ends_at: null },
    { ends_at: Date.now() + 86400000 }
  ]) await t.test(JSON.stringify(patch), async () => {
    const f = fixture(); Object.assign(f.source.subscriptions.items[0], patch);
    await rejects(f.offer(), 409); assert.equal(f.writes.length, 0);
  });
  let f = fixture(); f.source.active_entitlements = list([{ id: 'synthetic-active' }]); await rejects(f.offer(), 409);
  f = fixture(); f.source.subscriptions = list([]); await rejects(f.offer(), 409);
  f = fixture(); f.source.purchases = list([{ environment: 'sandbox' }]); await rejects(f.offer(), 409);
});

test('missing/extra aliases and unavailable or malformed provider responses fail closed', async () => {
  let f = fixture(); f.source.aliases.items.pop(); await rejects(f.offer(), 409);
  f = fixture(); f.source.aliases.items.push({ id: 'another-customer' }); await rejects(f.offer(), 409);
  f = fixture(); f.source.aliases.items.push({ id: originalId }); await rejects(f.offer(), 503);
  f = fixture(); f.source.customer.project_id = 'different-project'; await rejects(f.offer(), 409);
  f = fixture(); f.source.exists = false; await rejects(f.offer(), 409);
  f = fixture(); f.status = 503; await rejects(f.offer(), 503);
  f = fixture(); f.source.subscriptions = { items: [] }; await rejects(f.offer(), 503);
  f = fixture(); f.intercept = () => { throw new Error('private connector detail'); };
  await assert.rejects(f.offer(), e => e.statusCode === 503 && !e.message.includes('private'));
});

test('all subscription pages are checked, including production history on the last page', async () => {
  const f = fixture();
  f.source.subscriptions.next_page =
    `/v2/projects/${projectId}/customers/${fromId}/subscriptions?starting_after=next`;
  f.intercept = ({ url, resource }) => resource === 'subscriptions' && url.searchParams.has('starting_after')
    ? { status: 200, body: list([{ ...f.source.subscriptions.items[0], environment: 'production' }]) } : null;
  await rejects(f.offer(), 409);
  assert(f.reads.some(read => read.path.includes('starting_after=next')));
  assert.equal(f.writes.length, 0);
});

test('valid alias and subscription pagination is followed to completion without environment filtering', async () => {
  const f = fixture();
  const base = `/v2/projects/${projectId}/customers/${fromId}`;
  f.source.aliases = { items: [{ id: fromId }], next_page: `${base}/aliases?starting_after=alias-cursor` };
  const sub = f.source.subscriptions.items[0];
  f.source.subscriptions = { items: [], next_page: `${base}/subscriptions?starting_after=sub-cursor` };
  f.intercept = ({ url, resource }) => {
    if (!url.searchParams.has('starting_after')) return null;
    return { status: 200, body: list(resource === 'aliases' ? [{ id: originalId }] : [sub]) };
  };
  assert(await f.offer());
  assert.equal(f.reads.filter(read => read.path.includes('starting_after=')).length, 2);
  assert(f.reads.every(read => !read.path.includes('environment=')));
  assert.equal(f.writes.length, 0);
});

test('provider pagination cannot change account, host, project, filter, or loop forever', async t => {
  for (const next of [
    'https://evil.invalid/steal', '/v2/projects/other/customers/foreign/subscriptions?starting_after=x',
    `/v2/projects/${projectId}/customers/${fromId}/subscriptions?starting_after=x&environment=sandbox`,
    `/v2/projects/${projectId}/customers/${fromId}/subscriptions?limit=100`,
    `/v2/projects/${projectId}/customers/${fromId}/subscriptions?starting_after=x&starting_after=y`
  ]) await t.test(next, async () => {
    const f = fixture(); f.source.subscriptions.next_page = next; await rejects(f.offer(), 503);
    assert(!f.reads.some(read => read.path.includes('evil.invalid') || read.path.includes('/foreign/')));
  });
  const f = fixture();
  f.source.subscriptions.next_page = `/v2/projects/${projectId}/customers/${fromId}/subscriptions?starting_after=x`;
  await rejects(f.offer(), 503); assert(f.reads.length < 10);
});

test('completion needs an approved, existing, empty destination in the correct project', async t => {
  let f = fixture(); await rejects(f.complete(), 409); assert.equal(f.mapping, fromId);
  for (const change of [
    f => { f.target.customer.id = 'foreign-id'; },
    f => { f.target.customer.project_id = 'foreign-project'; },
    f => { f.target.aliases.items.push({ id: 'foreign-alias' }); },
    f => { f.target.active_entitlements.items.push({ id: 'pro' }); },
    f => { f.target.subscriptions.items.push({ environment: 'production' }); },
    f => { f.target.purchases.items.push({ environment: 'sandbox' }); }
  ]) await t.test('conflicting destination', async () => {
    const f = fixture(); f.target.exists = true; change(f);
    await rejects(f.complete(), 409); assert.equal(f.mapping, fromId); assert.equal(f.writes.length, 0);
  });
});

test('completion rechecks source evidence even after an offer was returned', async () => {
  const f = fixture(); await f.offer(); f.target.exists = true;
  f.source.subscriptions.items[0].environment = 'production';
  await rejects(f.complete(), 409); assert.equal(f.mapping, fromId); assert.equal(f.writes.length, 0);
});

test('successful completion preserves history, gives no Pro, preserves quota, and replays safely', async () => {
  const f = fixture(); f.target.exists = true;
  const history = structuredClone(f.source);
  assert.deepEqual(await f.complete(), { completed: true, revenuecatAppUserId: targetId });
  assert.equal(f.mapping, targetId); assert.deepEqual(f.source, history);
  const status = await f.pro.getProStatus({ userId, refresh: true });
  assert.equal(status.isPro, false); assert.notEqual(status.identityVerificationRequired, true);
  assert.deepEqual(await checkFreeTierDailyLimit({ query: async () => ({ rows: [{ request_id: 1 }] }) },
    userId, status.isPro, new Date('2026-01-05T15:00:00Z')), { limited: true, requestDate: '2026-01-05' });
});

test('completed authorizations replay without provider calls, even after expiry, but not after reassignment', async () => {
  const f = fixture(); f.target.exists = true; await f.complete();
  const updates = f.writes.filter(write => write.sql.includes('UPDATE')).length;
  f.clock.value += 86400000; f.status = 503; f.reads.length = 0;
  await f.complete(); assert.equal(f.reads.length, 0);
  assert.equal(f.writes.filter(write => write.sql.includes('UPDATE')).length, updates);
  f.mapping = 'changed-after-completion'; await rejects(f.complete(), 409);
});

test('approval expiration during fresh provider checks cannot yield an offer', async () => {
  const f = fixture();
  f.intercept = ({ id }) => {
    if (id === targetId) f.clock.value += 86400000;
    return null;
  };
  await rejects(f.offer(), 410); assert.equal(f.writes.length, 0);
});

test('operator approval edits or revocation during verification cannot yield a stale offer', async () => {
  for (const mutate of [
    f => { f.approval = null; },
    f => { f.approval.evidence_reference = 'changed-review'; },
    f => { f.approval.completed_at = new Date(f.clock.value); }
  ]) {
    const f = fixture();
    f.intercept = ({ id }) => { if (id === targetId) mutate(f); return null; };
    await assert.rejects(f.offer(), e => [403, 409].includes(e.statusCode));
    assert.equal(f.writes.length, 0);
  }
});

test('HTTP contract requires app auth and session, rejects forged fields, and protects Pro gates', async () => {
  const old = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'synthetic-reconciliation-session-secret';
  const f = fixture(), app = express(); app.use(express.json());
  app.use(routes({ authenticate: (req, res, next) => req.get('authorization') === 'Basic test'
    ? next() : res.status(401).json({ error: 'APP_AUTH_REQUIRED' }),
  requireUserSession, proSubscriptionService: f.pro, contentPaywallEnabled: false }));
  app.post('/synthetic-pro-gate', (req, res, next) => { req.userId = userId; next(); },
    createRequirePro(f.pro), (req, res) => res.json({ ok: true }));
  const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
  const send = (path, body = {}, account = userId, appAuth = true) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        ...(appAuth ? { authorization: 'Basic test' } : {}),
        ...(account ? { 'x-user-session-token': issueUserSessionToken(account) } : {}) },
      body: JSON.stringify(body)
    });
  const complete = '/api/subscriptions/identity-reconciliation/complete';
  try {
    assert.equal((await send(complete, { authorizationId }, null)).status, 401);
    assert.equal((await send(complete, { authorizationId }, userId, false)).status, 401);
    assert.equal((await send(complete, { authorizationId }, 99)).status, 403);
    assert.equal((await send(complete, { authorizationId, userId: 99 })).status, 403);
    for (const extra of [{ toAppUserId: 'foreign' }, { isPro: true }, { sdkMatches: true }]) {
      assert.equal((await send(complete, { authorizationId, ...extra })).status, 400);
    }
    assert.equal((await send(complete, { authorizationId: 'invalid' })).status, 400);
    const offered = await send('/api/subscriptions/identity');
    assert.equal(offered.status, 200); assert.equal(offered.headers.get('cache-control'), 'private, no-store');
    assert.equal((await offered.json()).identityReconciliation.fromAppUserId, fromId);
    assert.equal(f.writes.length, 0);
    f.target.exists = true;
    assert.equal((await send(complete, { authorizationId })).status, 200);
    const status = await (await send('/api/subscriptions/pro-status', {
      revenuecatAppUserId: targetId, refresh: true
    })).json();
    assert.equal(status.isPro, false); assert.equal(status.identityVerificationRequired, false);
    assert.equal((await send('/synthetic-pro-gate')).status, 403);
    const identity = await (await send('/api/subscriptions/identity')).json();
    assert(!Object.hasOwn(identity, 'identityReconciliation'));
    assert.equal(identity.revenuecatAppUserId, targetId);
    assert(f.reads.every(read => read.method === 'GET'));
    f.mapping = fromId; f.approval = null;
    const unapproved = await (await send('/api/subscriptions/identity', {
      identityReconciliation: { fromAppUserId: fromId, toAppUserId: targetId },
      approved: true, isPro: true
    })).json();
    assert.deepEqual(Object.keys(unapproved).sort(), ['entitlement', 'requiresSdkLogin', 'revenuecatAppUserId']);
    assert.equal((await send(complete, { authorizationId })).status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (old === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = old;
  }
});
