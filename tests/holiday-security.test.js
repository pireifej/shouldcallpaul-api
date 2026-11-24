'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const holidayRoutes = require('../routes/holidayGreetings');
const { privateHolidayTransport } = require('../holiday/privateTransport');
const { HolidayGoogle } = require('../holiday/google');
const { choosePhone, preference } = require('../holiday/greetings');
const { validateConfig, seal, unseal, template, SCOPES } = require('../holiday/security');

const config = { clientId: 'synthetic-client', clientSecret: 'synthetic-client-secret',
  origin: 'https://frontend.example.invalid',
  redirectUri: 'https://frontend.example.invalid/api/holiday-greetings/oauth/google/callback',
  ownerEmail: 'owner@example.invalid', sessionSecret: 'synthetic-session-secret-at-least-32-characters',
  encryptionKey: Buffer.alloc(32, 7).toString('base64') };

test('holiday config fails closed for missing keys or unapproved redirect/origin values', () => {
  assert.deepEqual(validateConfig(config), config);
  for (const changes of [{ ownerEmail: '' }, { sessionSecret: 'short' },
    { encryptionKey: 'short' }, { origin: 'http://frontend.example.invalid' },
    { redirectUri: 'https://attacker.invalid/api/holiday-greetings/oauth/google/callback' },
    { redirectUri: `${config.redirectUri}?next=https://attacker.invalid` }]) {
    assert.throws(() => validateConfig({ ...config, ...changes }));
  }
});

test('AES-GCM authenticates encrypted tokens and binds them to subject/context', () => {
  const cipher = seal({ accessToken: 'synthetic-private-token' }, config, 'google:owner-sub');
  assert(!cipher.includes('synthetic-private-token'));
  assert.deepEqual(unseal(cipher, config, 'google:owner-sub'), { accessToken: 'synthetic-private-token' });
  assert.throws(() => unseal(cipher, config, 'google:another-sub'));
  assert.throws(() => unseal(`${cipher.slice(0, -8)}AAAAAAAA`, config, 'google:owner-sub'));
});

test('template substitution is literal, single pass, and rejects unknown fields', () => {
  assert.equal(template('Hi {name}, {family} {occasion} {note}', {
    name: '{occasion}', family: '$&', occasion: 'Holiday', note: '$1'
  }), 'Hi {occasion}, $& Holiday $1');
  for (const value of ['Hi {religion}', 'Hi {name', 'Hi {{name}}']) assert.throws(() => template(value, {}));
});

test('phone selection never guesses country codes or silently substitutes a missing saved number', () => {
  const contact = { phoneNumbers: [
    { value: '(202) 555-0101', canonicalNumber: '+12025550101' },
    { value: '020 1234 5678', canonicalNumber: null }
  ] };
  assert.throws(() => choosePhone(contact), e => e.code === 'PHONE_SELECTION_REQUIRED');
  assert.equal(choosePhone(contact, '020 1234 5678'), '020 1234 5678');
  assert.throws(() => choosePhone(contact, '+12025559999'), e => e.code === 'CONTACT_PHONE_CHANGED');
  assert.throws(() => choosePhone({ phoneNumbers: [] }), e => e.code === 'CONTACT_HAS_NO_PHONE');
  assert.equal(preference({}).familyMode, 'off');
  assert.deepEqual(preference({}).occasions, {});
});

test('OIDC verification checks signatures, permitted owner, audience, issuer, expiry, nonce and verified email', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-key', alg: 'RS256' };
  const now = Math.floor(Date.now() / 1000);
  const valid = { iss: 'https://accounts.google.com', aud: config.clientId, sub: 'owner-sub',
    exp: now + 3600, iat: now, nonce: 'synthetic-nonce', email: config.ownerEmail, email_verified: true };
  const sign = (changes = {}, signingKey = privateKey, alg = 'RS256') => {
    const parts = [Buffer.from(JSON.stringify({ alg, kid: jwk.kid })).toString('base64url'),
      Buffer.from(JSON.stringify({ ...valid, ...changes })).toString('base64url')];
    return `${parts.join('.')}.${crypto.sign('RSA-SHA256', Buffer.from(parts.join('.')), signingKey).toString('base64url')}`;
  };
  let jwksCalls = 0;
  const google = new HolidayGoogle(config, { fetcher: async () => {
    jwksCalls++; return { ok: true, json: async () => ({ keys: [jwk] }) };
  } });
  assert.deepEqual(await google.verifyIdToken(sign(), 'synthetic-nonce'), { subject: 'owner-sub', email: config.ownerEmail });
  for (const changes of [{ email: 'another@example.invalid' }, { email_verified: false },
    { aud: 'another-client' }, { iss: 'https://attacker.invalid' }, { exp: now - 1 },
    { nonce: 'wrong-nonce' }, { sub: '' }, { iat: now + 500 }, { azp: 'another-client' }]) {
    await assert.rejects(google.verifyIdToken(sign(changes), 'synthetic-nonce'), e => e.code === 'OWNER_ACCOUNT_REQUIRED');
  }
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(google.verifyIdToken(sign({}, other.privateKey), 'synthetic-nonce'));
  await assert.rejects(google.verifyIdToken(sign({}, privateKey, 'none'), 'synthetic-nonce'));
  assert.equal(jwksCalls, 1);
  const auth = new URL(google.authorizationUrl({ state: 'state', nonce: 'nonce', verifier: 'verifier' }));
  assert.deepEqual(auth.searchParams.get('scope').split(' '), SCOPES);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), config.redirectUri);
  assert(!auth.toString().includes(config.clientSecret));
});

test('People API pagination and search retain stable resources and all labeled phone choices', async () => {
  const urls = [];
  const google = new HolidayGoogle(config, { fetcher: async url => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ nextPageToken: 'next-synthetic-page',
      connections: [{ resourceName: 'people/synthetic-contact', names: [{ displayName: 'Synthetic Contact' }],
        phoneNumbers: [{ value: '202-555-0101', canonicalForm: '+12025550101', type: 'mobile' },
          { value: '020 1234 5678', type: 'home' }] },
      { resourceName: 'people/no-phone', names: [{ displayName: 'Other Contact' }] }] }) };
  } });
  const result = await google.list('synthetic-access', { pageToken: 'previous-page', pageSize: 25, search: 'synthetic' });
  assert.equal(result.nextPageToken, 'next-synthetic-page');
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].resourceName, 'people/synthetic-contact');
  assert.equal(result.contacts[0].phoneNumbers.length, 2);
  assert.equal(result.contacts[0].phoneNumbers[1].canonicalNumber, null);
  assert.match(urls[0], /pageToken=previous-page/);
  assert(!urls[0].includes('synthetic-access'));
  const all = await google.list('synthetic-access');
  assert.equal(all.contacts[1].hasPhoneNumbers, false);
});

test('provider failures are explicit and never expose response bodies', async () => {
  for (const [status, error, code] of [[401, {}, 'GOOGLE_RECONNECT_REQUIRED'],
    [403, {}, 'GOOGLE_ACCESS_DENIED'], [429, {}, 'GOOGLE_QUOTA_EXCEEDED'],
    [400, { error: 'invalid_grant' }, 'GOOGLE_RECONNECT_REQUIRED']]) {
    const google = new HolidayGoogle(config, { fetcher: async () => ({
      ok: false, status, json: async () => ({ private: 'must-not-escape', ...error })
    }) });
    await assert.rejects(google.list('synthetic-access'), e => e.code === code && !e.message.includes('must-not-escape'));
  }
});

test('unconfigured feature fails explicitly without database access and private routes bypass legacy logging', async () => {
  const app = express(); app.use(express.json());
  app.use(holidayRoutes({ holidayConfig: null,
    auditPool: new Proxy({}, { get() { assert.fail('Disabled feature accessed database'); } }) }));
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/holiday-greetings/session`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'HOLIDAY_SETUP_REQUIRED' });
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  } finally { await new Promise(r => server.close(r)); }
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const bypass = source.indexOf('if (/^\\/api\\/holiday-greetings(?:\\/|$)/i.test(req.path)) return next();');
  assert(bypass >= 0);
  assert(bypass < source.indexOf('const safeBody = sanitizeParams'));
});

test('malformed or oversized private JSON is rejected without reflecting private content', async () => {
  const app = express();
  app.use('/api/holiday-greetings', privateHolidayTransport());
  app.use((req, res) => res.sendStatus(204));
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  try {
    for (const [body, status, error] of [['{"private":"synthetic-secret",', 400, 'INVALID_JSON'],
      [JSON.stringify({ message: 'x'.repeat(270000) }), 413, 'PAYLOAD_TOO_LARGE']]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/API/HOLIDAY-GREETINGS/batches`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body
      });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error });
    }
  } finally { await new Promise(r => server.close(r)); }
});
