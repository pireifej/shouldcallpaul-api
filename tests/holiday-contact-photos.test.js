'use strict';
// Synthetic contacts and mocked Google only. Never reads application credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const holidayRoutes = require('../routes/holidayGreetings');
const { HolidayGoogle } = require('../holiday/google');
const { COOKIE, SCOPES } = require('../holiday/security');

const config = {
  clientId: 'synthetic-client', clientSecret: 'synthetic-secret',
  origin: 'https://frontend.example.invalid',
  redirectUri: 'https://frontend.example.invalid/api/holiday-greetings/oauth/google/callback',
  ownerEmail: 'owner@example.invalid', sessionSecret: 'synthetic-session-secret-at-least-32-characters',
  encryptionKey: Buffer.alloc(32, 4).toString('base64')
};
const photo = 'https://lh3.googleusercontent.com/synthetic-primary-photo';
const person = {
  resourceName: 'people/synthetic-friend',
  names: [{ displayName: 'Synthetic Friend', givenName: 'Synthetic' }],
  phoneNumbers: [{ value: '(202) 555-0101', canonicalForm: '+12025550101', type: 'mobile' }],
  emailAddresses: [{ value: 'friend@example.invalid', type: 'home' }]
};

test('contact photos prefer the primary real photo without changing existing contact fields', () => {
  const google = new HolidayGoogle(config);
  const original = google.normalize(person);
  const result = google.normalize({ ...person, photos: [
    { url: 'https://lh3.googleusercontent.com/synthetic-secondary-photo', default: false },
    { url: photo, default: false, metadata: { primary: true } }
  ] });
  assert.equal(result.photoUrl, photo);
  assert.deepEqual(result, { ...original, photoUrl: photo });
  assert.equal(result.resourceName, person.resourceName);
});

test('contacts without photos consistently return photoUrl null', () => {
  const google = new HolidayGoogle(config);
  for (const photos of [undefined, null, []]) {
    assert.equal(google.normalize({ ...person, photos }).photoUrl, null);
  }
});

test('Google default placeholders never become contact photos, even when primary', () => {
  const google = new HolidayGoogle(config);
  const placeholder = { url: 'https://lh3.googleusercontent.com/synthetic-default-photo',
    default: true, metadata: { primary: true } };
  assert.equal(google.normalize({ ...person, photos: [placeholder] }).photoUrl, null);
  assert.equal(google.normalize({ ...person, photos: [placeholder, { url: photo }] }).photoUrl, photo);
});

test('missing primary metadata falls back to a real HTTPS photo and malformed photos stay optional', () => {
  const google = new HolidayGoogle(config);
  const invalid = [null, {}, { url: '' }, { url: 'not a URL' },
    { url: 'javascript:alert(1)' }, { url: 'data:image/png;base64,synthetic' },
    { url: 'http://example.invalid/photo' }, { url: 'https://user:password@example.invalid/photo' }];
  assert.equal(google.normalize({ ...person, photos: invalid }).photoUrl, null);
  assert.equal(google.normalize({ ...person, photos: [...invalid, { url: photo }] }).photoUrl, photo);
});

test('photo fields preserve paginated search, stable IDs, phone/email data and existing scopes', async () => {
  const calls = [];
  const google = new HolidayGoogle(config, { fetcher: async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    const item = { ...person, photos: [{ url: photo, metadata: { primary: true } }] };
    return { ok: true, json: async () => parsed.pathname.endsWith('/connections')
      ? { connections: [item], nextPageToken: 'synthetic-next-page' } : item };
  } });
  const page = await google.list('synthetic-access', {
    pageToken: 'synthetic-previous-page', pageSize: 25, search: 'friend@'
  });
  assert.equal(page.nextPageToken, 'synthetic-next-page');
  assert.equal(page.searchAppliesTo, 'page');
  assert.equal(page.contacts.length, 1);
  assert.deepEqual(page.contacts[0], {
    resourceName: person.resourceName, displayName: 'Synthetic Friend', givenName: 'Synthetic',
    photoUrl: photo,
    phoneNumbers: [{ value: '(202) 555-0101', label: 'mobile', canonicalNumber: '+12025550101' }],
    hasPhoneNumbers: true,
    emailAddresses: [{ value: 'friend@example.invalid', label: 'home' }], hasEmailAddresses: true
  });
  assert.equal(calls[0].url.searchParams.get('pageToken'), 'synthetic-previous-page');
  assert.equal(calls[0].url.searchParams.get('pageSize'), '25');
  const filtered = await google.list('synthetic-access', { search: 'no-match' });
  assert.deepEqual(filtered.contacts, []);
  assert.equal(filtered.nextPageToken, 'synthetic-next-page');
  const single = await google.get('synthetic-access', person.resourceName);
  assert.equal(single.photoUrl, photo);
  for (const call of calls) {
    assert.deepEqual(call.url.searchParams.get('personFields').split(','),
      ['names', 'phoneNumbers', 'emailAddresses', 'photos']);
    assert.equal(call.options.method, undefined); // Google reads only.
    assert(!String(call.url).includes('synthetic-access'));
  }
  assert.deepEqual(SCOPES, ['openid', 'email',
    'https://www.googleapis.com/auth/contacts.readonly',
    'https://www.googleapis.com/auth/gmail.send']);
});

test('contact photos stay owner-only, uncached, same-origin and separate from saved preferences', async () => {
  let reads = 0;
  const saved = [{ resourceName: person.resourceName, version: 3, selected: true,
    preferredMethod: 'sms', preferredPhoneNumber: '+12025550101' }];
  const before = structuredClone(saved);
  const google = new HolidayGoogle(config, { fetcher: async () => {
    reads++;
    return { ok: true, json: async () => ({
      connections: [{ ...person, photos: [{ url: photo, default: false }] }]
    }) };
  } });
  const store = {
    async session(token) {
      if (token === 'synthetic-owner-session') return { owner_sub: 'synthetic-owner' };
      if (token === 'synthetic-bootstrap-session') return { owner_sub: null };
      return null;
    },
    async owner(subject) { assert.equal(subject, 'synthetic-owner'); return { connected: true }; },
    async accessToken(subject) { assert.equal(subject, 'synthetic-owner'); return 'synthetic-access'; },
    async preferences(subject) { assert.equal(subject, 'synthetic-owner'); return saved; }
  };
  const app = express();
  app.use(holidayRoutes({ holidayConfig: config, holidayStore: store, holidayGoogle: google }));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/holiday-greetings`;
  try {
    for (const token of [null, 'synthetic-bootstrap-session']) {
      const res = await fetch(`${base}/contacts`, {
        headers: token ? { Cookie: `${COOKIE}=${token}` } : {}
      });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'OWNER_SESSION_REQUIRED' });
      assert.match(res.headers.get('cache-control'), /private, no-store/);
    }
    const ownerHeaders = { Cookie: `${COOKIE}=synthetic-owner-session` };
    const forbidden = await fetch(`${base}/contacts`, {
      headers: { ...ownerHeaders, Origin: 'https://attacker.invalid' }
    });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), { error: 'ORIGIN_FORBIDDEN' });
    assert.equal(reads, 0);
    const res = await fetch(`${base}/contacts`, { headers: ownerHeaders });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).contacts[0].photoUrl, photo);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(reads, 1);
    const preferences = await fetch(`${base}/preferences`, { headers: ownerHeaders });
    assert.deepEqual(await preferences.json(), { preferences: before });
    assert.deepEqual(saved, before);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
