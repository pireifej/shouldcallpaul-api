'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HolidayGoogle } = require('../holiday/google');
const { chooseEmail, emailContent, mimeMessage } = require('../holiday/email');
const { preference } = require('../holiday/greetings');
const { SCOPES, GMAIL_SEND_SCOPE } = require('../holiday/security');

const config = { ownerEmail: 'owner@example.invalid', clientId: 'synthetic-client',
  clientSecret: 'synthetic-secret', redirectUri: 'https://frontend.example.invalid/api/holiday-greetings/oauth/google/callback' };

test('email selection requires a specific current Contact address and prevents header injection', () => {
  const contact = { emailAddresses: [{ value: 'friend@example.invalid' }, { value: 'other@example.invalid' }] };
  assert.equal(chooseEmail(contact, 'friend@example.invalid'), 'friend@example.invalid');
  assert.throws(() => chooseEmail(contact), e => e.code === 'EMAIL_SELECTION_REQUIRED');
  assert.throws(() => chooseEmail(contact, 'removed@example.invalid'), e => e.code === 'CONTACT_EMAIL_CHANGED');
  assert.throws(() => chooseEmail({}, 'friend@example.invalid'), e => e.code === 'CONTACT_HAS_NO_EMAIL');
  for (const to of ['x@example.invalid\r\nBcc: victim@example.invalid', 'a@example.invalid,b@example.invalid', 'Name <a@example.invalid>']) {
    assert.throws(() => mimeMessage({ from: config.ownerEmail, to, subject: 'Hi', message: 'Hello' }));
  }
  for (const subject of ['', 'Hi\r\nBcc: victim@example.invalid', 'Hi\0']) {
    assert.throws(() => emailContent(subject, 'Hello'));
  }
  assert.throws(() => emailContent('Hi', '   '));
});

test('partial contact setup preserves previous family, notes, occasions and phone choices', () => {
  const previous = { greetingName: 'Friend', familyMode: 'custom', familyCustom: 'the whole family',
    personalNote: 'Synthetic note', occasions: { easter: 'opt_out' }, preferredPhoneNumber: '+12025550101' };
  const result = preference({ selected: true, preferredMethod: 'email', preferredEmailAddress: 'friend@example.invalid' }, previous);
  for (const [key, value] of Object.entries(previous)) assert.deepEqual(result[key], value);
  assert.equal(result.selected, true);
  assert.equal(result.preferredMethod, 'email');
  assert.throws(() => preference({ selected: 'true' }));
  assert.throws(() => preference({ preferredMethod: 'bulk' }));
});

test('People API supports every paginated email choice with stable IDs and no writes', async () => {
  const calls = [];
  const google = new HolidayGoogle(config, { fetcher: async (url, options) => {
    calls.push({ url: String(url), options });
    const second = new URL(url).searchParams.has('pageToken');
    return { ok: true, json: async () => ({ nextPageToken: second ? undefined : 'second-page',
      connections: [{ resourceName: second ? 'people/two' : 'people/one', names: [{ displayName: 'Same Name' }],
        emailAddresses: [{ value: second ? 'two@example.invalid' : 'one@example.invalid', type: 'home' }] }] }) };
  } });
  const first = await google.list('synthetic-access');
  const second = await google.list('synthetic-access', { pageToken: first.nextPageToken, search: 'two@' });
  assert.equal(first.contacts[0].emailAddresses[0].label, 'home');
  assert.equal(second.contacts[0].resourceName, 'people/two');
  assert.equal(second.nextPageToken, null);
  for (const call of calls) {
    assert.match(call.url, /emailAddresses/);
    assert.equal(call.options.method, undefined);
    assert(!call.url.includes('synthetic-access'));
  }
});

test('Gmail uses only send scope, users/me, fixed verified sender and a single recipient', async () => {
  assert(SCOPES.includes(GMAIL_SEND_SCOPE));
  assert(!SCOPES.some(s => /gmail\.(readonly|modify|compose)|mail\.google/.test(s)));
  let calls = 0;
  const google = new HolidayGoogle(config, { fetcher: async (url, options) => {
    calls++;
    assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    assert.equal(options.method, 'POST');
    const raw = Buffer.from(JSON.parse(options.body).raw, 'base64url').toString();
    assert.match(raw, /^From: owner@example.invalid\r\nTo: friend@example.invalid\r\n/);
    assert(!/^Cc:|^Bcc:/im.test(raw));
    const decodedSubject = [...raw.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
      .map(m => Buffer.from(m[1], 'base64').toString()).join('');
    assert.equal(decodedSubject, '🌟'.repeat(30));
    return { ok: true, json: async () => ({ id: 'synthetic-gmail-id' }) };
  } });
  assert.deepEqual(await google.sendEmail('synthetic-access', { to: 'friend@example.invalid',
    from: 'attacker@example.invalid', subject: '🌟'.repeat(30), message: 'Hello\nBcc: not a header' }),
  { messageId: 'synthetic-gmail-id' });
  assert.equal(calls, 1);
});

test('Gmail uncertain acceptance never retries, reflects provider bodies or claims delivery', async () => {
  for (const response of [null, { ok: false, status: 503 },
    { ok: true, json: async () => { throw new Error('private-provider-body'); } },
    { ok: true, json: async () => ({}) }]) {
    let calls = 0;
    const google = new HolidayGoogle(config, { fetcher: async () => {
      calls++; if (!response) throw new Error('private-provider-body'); return response;
    } });
    await assert.rejects(google.sendEmail('synthetic-access', {
      to: 'friend@example.invalid', subject: 'Hello', message: 'Synthetic body'
    }), e => e.code === 'EMAIL_OUTCOME_UNKNOWN' && !e.message.includes('private'));
    assert.equal(calls, 1);
  }
  const rejected = new HolidayGoogle(config, { fetcher: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(rejected.sendEmail('synthetic-access', {
    to: 'friend@example.invalid', subject: 'Hi', message: 'Hello'
  }), e => e.code === 'EMAIL_REJECTED');
});

test('new consent requires Gmail send but legacy Contacts refresh remains usable for SMS', async () => {
  const oldScopes = SCOPES.filter(s => s !== GMAIL_SEND_SCOPE).join(' ');
  const google = new HolidayGoogle(config, { fetcher: async () => ({
    ok: true, json: async () => ({ access_token: 'synthetic-access', expires_in: 3600, scope: oldScopes })
  }) });
  assert.equal((await google.refresh('synthetic-refresh')).scope, oldScopes);
  await assert.rejects(google.exchange('synthetic-code', 'synthetic-verifier'),
    e => e.code === 'GOOGLE_GMAIL_CONSENT_REQUIRED');
});
