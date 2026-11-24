'use strict';
// Real, disposable PostgreSQL only. Never uses application connection strings.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Pool } = require('pg');
const holidayRoutes = require('../routes/holidayGreetings');
const { HolidayStore } = require('../holiday/store');
const { csrf, hash, unseal, fail, COOKIE } = require('../holiday/security');

const available = spawnSync('initdb', ['--version'], { stdio: 'ignore' }).status === 0;
const config = {
  clientId: 'synthetic-client', clientSecret: 'synthetic-secret',
  origin: 'https://frontend.example.invalid',
  redirectUri: 'https://frontend.example.invalid/api/holiday-greetings/oauth/google/callback',
  ownerEmail: 'owner@example.invalid', sessionSecret: 'synthetic-session-secret-at-least-32-characters',
  encryptionKey: Buffer.alloc(32, 9).toString('base64')
};
const prefix = '/api/holiday-greetings';

test('Holiday Greetings real database and API security, persistence, concurrency and lifecycle',
  { skip: !available, timeout: 120000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holiday-api-test-'));
    const data = path.join(dir, 'data');
    let pool, server, started = false;
    try {
      execFileSync('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale'],
        { stdio: 'pipe', timeout: 30000 });
      execFileSync('pg_ctl', ['-D', data, '-l', path.join(dir, 'postgres.log'), '-w', '-t', '20',
        '-o', `-h '' -k ${dir} -p 15433`, 'start'], { stdio: 'pipe', timeout: 25000 });
      started = true;
      pool = new Pool({ host: dir, port: 15433, user: 'postgres', database: 'postgres', max: 5 });
      await pool.query(fs.readFileSync(path.join(__dirname, '../migrations/holiday-greetings.sql'), 'utf8'));
      // Schema is re-runnable and never drops existing records.
      await pool.query(fs.readFileSync(path.join(__dirname, '../migrations/holiday-greetings.sql'), 'utf8'));
      const store = new HolidayStore(pool, config);
      let refreshCalls = 0, denyIdentity = false, returnedRefresh = 'synthetic-refresh';
      let identitySubject = 'synthetic-owner-sub', lastProof;
      const contacts = new Map([
        ['people/contact-one', { resourceName: 'people/contact-one', displayName: 'Synthetic One',
          givenName: 'One', phoneNumbers: [{ value: '202-555-0101', canonicalNumber: '+12025550101', label: 'mobile' }] }],
        ['people/contact-two', { resourceName: 'people/contact-two', displayName: 'Synthetic Two',
          givenName: 'Two', phoneNumbers: [
            { value: '202-555-0102', canonicalNumber: '+12025550102', label: 'mobile' },
            { value: '202-555-0103', canonicalNumber: '+12025550103', label: 'home' }] }],
        ['people/no-phone', { resourceName: 'people/no-phone', displayName: 'No Phone', phoneNumbers: [] }]
      ]);
      const google = {
        authorizationUrl(proof) { lastProof = proof; return `https://accounts.google.com/synthetic?state=${proof.state}`; },
        async exchange(code, verifier) {
          assert.equal(verifier, lastProof.verifier);
          return { id_token: 'synthetic-id-token', access_token: 'synthetic-access',
            refresh_token: returnedRefresh, expires_in: 3600 };
        },
        async verifyIdToken(token, nonce) {
          assert.equal(nonce, lastProof.nonce);
          if (denyIdentity) throw fail('OWNER_ACCOUNT_REQUIRED', 403);
          return { subject: identitySubject, email: config.ownerEmail };
        },
        async refresh(token) {
          assert.equal(token, 'synthetic-refresh'); refreshCalls++;
          return { access_token: 'synthetic-refreshed-access', expires_in: 3600 };
        },
        async revoke() { return true; },
        async get(token, resource) {
          if (!contacts.has(resource)) throw fail('CONTACT_NOT_FOUND', 404);
          return contacts.get(resource);
        },
        async list() { return { contacts: [...contacts.values()], nextPageToken: null }; }
      };
      function mount() {
        const app = express(); app.use(express.json());
        app.use(holidayRoutes({ auditPool: pool, holidayConfig: config, holidayGoogle: google }));
        return app.listen(0);
      }
      server = mount(); await new Promise(r => server.once('listening', r));
      async function request(method, endpoint, body, { cookie, csrfToken, origin = config.origin, extra = {} } = {}) {
        return fetch(`http://127.0.0.1:${server.address().port}${prefix}${endpoint}`, {
          method, redirect: 'manual', headers: { 'Content-Type': 'application/json',
            ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}),
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...extra },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
      }
      async function bootstrap() {
        const response = await request('GET', '/session');
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.authenticated, false);
        const setCookie = response.headers.get('set-cookie');
        assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /Secure/i);
        assert.match(setCookie, /SameSite=Lax/i); assert(!/Domain=/i.test(setCookie));
        return { cookie: setCookie.split(';')[0], csrfToken: body.csrfToken };
      }
      async function begin(auth) {
        const response = await request('GET', '/oauth/google/start', undefined, auth);
        assert.equal(response.status, 200);
        return new URL((await response.json()).authorizationUrl).searchParams.get('state');
      }
      async function login() {
        const before = await bootstrap(), state = await begin(before);
        const response = await request('GET', `/oauth/google/callback?state=${state}&code=synthetic-code`, undefined,
          { ...before, origin: null });
        assert.equal(response.status, 303);
        assert.equal(response.headers.get('location'), `${config.origin}/?holidayGreetings=connected`);
        const cookie = response.headers.get('set-cookie').split(';')[0];
        assert.notEqual(cookie, before.cookie);
        const session = await request('GET', '/session', undefined, { cookie });
        return { cookie, csrfToken: (await session.json()).csrfToken };
      }

      await t.test('shared credentials, fake owner headers and anonymous bootstrap cannot access private data', async () => {
        const anonymous = await bootstrap();
        for (const endpoint of ['/contacts', '/preferences', '/batches/current']) {
          const response = await request('GET', endpoint, undefined, {
            extra: { Authorization: 'Basic shared-service', 'X-Owner-Email': config.ownerEmail,
              'X-Owner-Subject': 'synthetic-owner-sub' }
          });
          assert.equal(response.status, 401);
          assert.equal((await request('GET', endpoint, undefined, anonymous)).status, 401);
        }
        assert.equal((await request('GET', '/oauth/google/start', undefined, anonymous)).status, 200);
        assert.equal((await request('GET', '/oauth/google/start', undefined, { cookie: anonymous.cookie })).status, 403);
      });

      await t.test('OAuth state is browser-bound, expiring and single-use; another owner is rejected', async () => {
        const a = await bootstrap(), b = await bootstrap();
        const state = await begin(a);
        const callback = `/oauth/google/callback?state=${state}&code=synthetic-code`;
        assert.equal((await request('GET', callback, undefined, b)).status, 403);
        denyIdentity = true;
        assert.equal((await request('GET', callback, undefined, a)).status, 403);
        denyIdentity = false;
        assert.equal((await request('GET', callback, undefined, a)).status, 403);
        assert.equal((await pool.query('SELECT count(*) FROM hg_owner')).rows[0].count, '0');
        const expired = await begin(a);
        await pool.query('UPDATE hg_oauth_states SET expires_at=now()-interval \'1 second\' WHERE state_hash=$1', [hash(expired)]);
        assert.equal((await request('GET', `/oauth/google/callback?state=${expired}&code=x`, undefined, a)).status, 403);
      });

      let auth = await login();
      await t.test('tokens are encrypted and all mutation routes require owner CSRF and allowed origin', async () => {
        const row = (await pool.query('SELECT * FROM hg_owner')).rows[0];
        assert(!row.token_ciphertext.includes('synthetic-refresh'));
        assert.equal(unseal(row.token_ciphertext, config, `google:${row.subject}`).refreshToken, 'synthetic-refresh');
        for (const [method, endpoint, body] of [
          ['PUT', '/preferences', {}], ['POST', '/batches', {}], ['POST', '/logout', {}],
          ['POST', '/google/disconnect', {}],
          ['PATCH', '/batches/11111111-1111-1111-1111-111111111111', {}],
          ['DELETE', '/batches/11111111-1111-1111-1111-111111111111', {}],
          ['PATCH', '/batches/11111111-1111-1111-1111-111111111111/drafts/22222222-2222-2222-2222-222222222222', {}],
          ['POST', '/batches/11111111-1111-1111-1111-111111111111/drafts/22222222-2222-2222-2222-222222222222/opened', {}],
          ['POST', '/batches/11111111-1111-1111-1111-111111111111/drafts/22222222-2222-2222-2222-222222222222/mark-sent', {}]
        ]) {
          assert.equal((await request(method, endpoint, body, { cookie: auth.cookie })).status, 403);
        }
        assert.equal((await request('GET', '/contacts', undefined, { ...auth, origin: 'https://attacker.invalid' })).status, 403);
        const response = await request('GET', '/session', undefined, auth);
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        assert.equal(response.headers.get('access-control-allow-origin'), null);
      });

      await t.test('stable Google subject cannot be replaced by a different subject and reconnect retains refresh token', async () => {
        identitySubject = 'different-subject-same-email';
        const attempt = await bootstrap(), state = await begin(attempt);
        assert.equal((await request('GET', `/oauth/google/callback?state=${state}&code=x`, undefined, attempt)).status, 403);
        identitySubject = 'synthetic-owner-sub'; returnedRefresh = undefined;
        auth = await login();
        const row = (await pool.query('SELECT * FROM hg_owner')).rows[0];
        assert.equal(unseal(row.token_ciphertext, config, `google:${row.subject}`).refreshToken, 'synthetic-refresh');
      });

      await t.test('preferences use stable resource IDs, explicit occasion choices and optimistic versions', async () => {
        const pref = { resourceName: 'people/contact-one', version: 0,
          greetingName: 'Friend {occasion}', familyMode: 'family',
          personalNote: 'A literal $& note', occasions: { christmas: 'opt_in' } };
        let response = await request('PUT', '/preferences', pref, auth);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).version, 1);
        assert.equal((await request('PUT', '/preferences', pref, auth)).status, 409);
        const stored = (await (await request('GET', '/preferences', undefined, auth)).json()).preferences;
        assert.equal(stored[0].resourceName, 'people/contact-one');
        assert.equal((await request('PUT', '/preferences', { ...pref, version: 1, greetingName: 'Renamed' }, auth)).status, 200);
        assert.equal((await request('PUT', '/preferences', { ...pref, version: 99 }, auth)).status, 409);
      });

      const createInput = { occasion: 'christmas', baseTemplate: 'Hello {name}, {family}. {note}',
        recipients: [{ resourceName: 'people/contact-one' }] };
      let batch;
      await t.test('batches require explicit recipients, phone selection, occasion confirmation and valid templates', async () => {
        assert.equal((await request('POST', '/batches', { ...createInput, recipients: [] }, auth)).status, 400);
        assert.equal((await request('POST', '/batches', { ...createInput, baseTemplate: '{religion}' }, auth)).status, 400);
        for (const [resourceName, status] of [['people/no-phone', 409], ['people/contact-two', 400]]) {
          const response = await request('POST', '/batches', {
            ...createInput, recipients: [{ resourceName, confirmedForOccasion: true }]
          }, auth);
          assert.equal(response.status, status);
        }
        const ask = await request('POST', '/batches', {
          ...createInput, recipients: [{ resourceName: 'people/contact-two', phoneNumber: '+12025550102' }]
        }, auth);
        assert.equal((await ask.json()).error, 'OCCASION_CONFIRMATION_REQUIRED');
        const response = await request('POST', '/batches', createInput, auth);
        assert.equal(response.status, 201);
        batch = await response.json();
        assert.equal(batch.drafts[0].state, 'draft');
        assert.equal(batch.drafts[0].phoneNumber, '+12025550101');
        assert.equal(batch.drafts[0].message, 'Hello Renamed, you and your family. A literal $& note');
      });

      await t.test('concurrent edits cannot overwrite newer drafts or queue progress', async () => {
        const responses = await Promise.all(['Draft A', 'Draft B'].map(message =>
          request('PATCH', `/batches/${batch.id}/drafts/${batch.drafts[0].id}`,
            { version: batch.version, message }, auth)));
        assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
        batch = await (await request('GET', `/batches/${batch.id}`, undefined, auth)).json();
        assert.equal(batch.version, 2);
        const forbidden = await request('PATCH', `/batches/${batch.id}/drafts/${batch.drafts[0].id}`,
          { version: batch.version, state: 'manually_marked_sent' }, auth);
        assert.equal(forbidden.status, 400);
      });

      await t.test('opening Messages atomically persists edits/number/queue but cannot claim sending', async () => {
        let response = await request('POST', `/batches/${batch.id}/drafts/${batch.drafts[0].id}/opened`,
          { version: batch.version, message: 'Final synthetic greeting', phoneNumber: '+12025550101', queuePosition: 1 }, auth);
        assert.equal(response.status, 200);
        batch = await response.json();
        assert.equal(batch.drafts[0].state, 'opened_in_messages');
        assert.equal(batch.queuePosition, 1);
        assert.deepEqual(batch.handoff, { phoneNumber: '+12025550101', message: 'Final synthetic greeting' });
        response = await request('POST', `/batches/${batch.id}/drafts/${batch.drafts[0].id}/mark-sent`,
          { version: batch.version }, auth);
        assert.equal(response.status, 400);
        response = await request('POST', `/batches/${batch.id}/drafts/${batch.drafts[0].id}/mark-sent`,
          { version: batch.version, confirmed: true }, auth);
        assert.equal(response.status, 200);
        batch = await response.json();
        assert.equal(batch.drafts[0].state, 'manually_marked_sent');
      });

      await t.test('saved phone disappearing is a conflict, not silent fallback', async () => {
        const contact = contacts.get('people/contact-one');
        contact.phoneNumbers[0].canonicalNumber = '+12025559999';
        const response = await request('POST', `/batches/${batch.id}/drafts/${batch.drafts[0].id}/opened`,
          { version: batch.version }, auth);
        assert.equal(response.status, 409);
        assert.equal((await response.json()).error, 'CONTACT_PHONE_CHANGED');
        contact.phoneNumbers[0].canonicalNumber = '+12025550101';
      });

      await t.test('occasion opt-out is respected, custom occasions and skipped state persist, delete requires matching version', async () => {
        const pref = { resourceName: 'people/contact-two', version: 0,
          occasions: { christmas: 'opt_out' } };
        assert.equal((await request('PUT', '/preferences', pref, auth)).status, 200);
        const rejected = await request('POST', '/batches', { ...createInput,
          recipients: [{ resourceName: pref.resourceName, phoneNumber: '+12025550102',
            confirmedForOccasion: true }] }, auth);
        assert.equal(rejected.status, 409);
        assert.equal((await rejected.json()).error, 'CONTACT_OCCASION_OPTED_OUT');
        let response = await request('POST', '/batches', { occasion: 'custom',
          customOccasionLabel: 'A personal celebration', baseTemplate: '{occasion}: {name}',
          recipients: [{ resourceName: pref.resourceName, phoneNumber: '+12025550102', confirmedForOccasion: true }]
        }, auth);
        assert.equal(response.status, 201);
        let custom = await response.json();
        response = await request('PATCH', `/batches/${custom.id}/drafts/${custom.drafts[0].id}`,
          { version: custom.version, state: 'skipped' }, auth);
        custom = await response.json();
        assert.equal(custom.drafts[0].state, 'skipped');
        assert.equal((await request('DELETE', `/batches/${custom.id}`, { version: 1 }, auth)).status, 409);
        assert.equal((await request('DELETE', `/batches/${custom.id}`, { version: custom.version }, auth)).status, 200);
        assert.equal((await request('GET', `/batches/${custom.id}`, undefined, auth)).status, 404);
      });

      await t.test('cross-owner batch, draft and preference access cannot bypass owner scoping', async () => {
        const foreign = await store.createBatch('synthetic-owner-sub', { occasion: 'easter' }, []);
        await assert.rejects(store.batch('different-subject', foreign.id), e => e.code === 'BATCH_NOT_FOUND');
        await assert.rejects(store.changeBatch('different-subject', foreign.id, 1, () => {}), e => e.code === 'BATCH_NOT_FOUND');
        await assert.rejects(store.deleteBatch('different-subject', foreign.id, 1), e => e.code === 'BATCH_NOT_FOUND');
        assert.deepEqual(await store.preferences('different-subject'), []);
        const response = await request('PATCH', `/batches/${batch.id}/drafts/33333333-3333-3333-3333-333333333333`,
          { version: batch.version, message: 'no overwrite' }, auth);
        assert.equal(response.status, 404);
        await store.deleteBatch('synthetic-owner-sub', foreign.id, 1);
      });

      await t.test('drafts, queue, preferences and owner session survive API and PostgreSQL restart', async () => {
        await new Promise(r => server.close(r)); server = null;
        await pool.end(); pool = null;
        execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe', timeout: 15000 });
        started = false;
        execFileSync('pg_ctl', ['-D', data, '-l', path.join(dir, 'postgres.log'), '-w',
          '-o', `-h '' -k ${dir} -p 15433`, 'start'],
          { stdio: 'pipe', timeout: 20000 });
        started = true;
        pool = new Pool({ host: dir, port: 15433, user: 'postgres', database: 'postgres', max: 5 });
        server = mount(); await new Promise(r => server.once('listening', r));
        const response = await request('GET', '/batches/current', undefined, auth);
        const current = (await response.json()).batch;
        assert.equal(current.id, batch.id);
        assert.equal(current.queuePosition, 1);
        assert.equal(current.drafts[0].message, 'Final synthetic greeting');
        assert.equal(current.drafts[0].state, 'manually_marked_sent');
        assert.equal((await (await request('GET', '/preferences', undefined, auth)).json()).preferences.length, 2);
      });

      await t.test('refresh is serialized, missing refresh tokens are preserved, revoked consent requires reconnect', async () => {
        const currentStore = new HolidayStore(pool, config);
        const row = (await pool.query('SELECT * FROM hg_owner')).rows[0];
        const tokens = unseal(row.token_ciphertext, config, `google:${row.subject}`);
        tokens.expiresAt = 0;
        const { seal } = require('../holiday/security');
        await pool.query('UPDATE hg_owner SET token_ciphertext=$1', [seal(tokens, config, `google:${row.subject}`)]);
        await Promise.all([currentStore.accessToken(row.subject, google), currentStore.accessToken(row.subject, google)]);
        assert.equal(refreshCalls, 1);
        const renewed = (await pool.query('SELECT token_ciphertext FROM hg_owner')).rows[0];
        assert.equal(unseal(renewed.token_ciphertext, config, `google:${row.subject}`).refreshToken, 'synthetic-refresh');
        await pool.query('UPDATE hg_owner SET token_ciphertext=$1', [seal(tokens, config, `google:${row.subject}`)]);
        await assert.rejects(currentStore.accessToken(row.subject, { refresh: async () => { throw fail('GOOGLE_RECONNECT_REQUIRED', 409); } }),
          e => e.code === 'GOOGLE_RECONNECT_REQUIRED');
        assert.equal((await pool.query('SELECT connected FROM hg_owner')).rows[0].connected, false);
      });

      await t.test('disconnect revokes Google, logout revokes owner session, and expired sessions fail', async () => {
        const currentStore = new HolidayStore(pool, config);
        const bootstrapToken = await currentStore.createSession();
        const reconnectToken = await currentStore.connectOwner(
          { subject: 'synthetic-owner-sub', email: config.ownerEmail },
          { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 },
          bootstrapToken);
        const reconnect = { cookie: `${COOKIE}=${reconnectToken}`, csrfToken: csrf(reconnectToken, config) };
        google.revoke = async () => false;
        let disconnected = await request('POST', '/google/disconnect', {}, reconnect);
        assert.deepEqual(await disconnected.json(), { disconnected: true, providerRevoked: false });
        assert.equal((await request('GET', '/contacts', undefined, reconnect)).status, 409);
        google.revoke = async () => true;
        disconnected = await request('POST', '/google/disconnect', {}, reconnect);
        assert.deepEqual(await disconnected.json(), { disconnected: true, providerRevoked: true });
        assert.equal((await request('GET', '/contacts', undefined, reconnect)).status, 409);
        // Draft editing is intentionally independent of Google connectivity.
        assert.equal((await request('GET', `/batches/${batch.id}`, undefined, reconnect)).status, 200);
        assert.equal((await request('POST', '/logout', {}, reconnect)).status, 200);
        assert.equal((await request('GET', '/preferences', undefined, reconnect)).status, 401);
        await pool.query('UPDATE hg_sessions SET expires_at=now()-interval \'1 second\'');
        assert.equal((await request('GET', '/contacts', undefined, auth)).status, 401);
        await assert.rejects(currentStore.connectOwner(
          { subject: 'synthetic-owner-sub', email: config.ownerEmail },
          { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 },
          reconnectToken), e => e.code === 'OWNER_SESSION_REQUIRED');
      });
    } finally {
      if (server) await new Promise(r => server.close(r));
      if (pool) await pool.end();
      if (started) execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe', timeout: 15000 });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
