'use strict';
// Disposable PostgreSQL + mocked Google only. Never uses application database credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Pool } = require('pg');
const { HolidayStore } = require('../holiday/store');
const routes = require('../routes/holidayGreetings');
const { COOKIE, csrf, seal, SCOPES, fail } = require('../holiday/security');

const config = { ownerEmail: 'owner@example.invalid', origin: 'https://frontend.example.invalid',
  sessionSecret: 'synthetic-session-secret-at-least-thirty-two-characters',
  encryptionKey: Buffer.alloc(32, 5).toString('base64') };
const available = spawnSync('initdb', ['--version'], { stdio: 'ignore' }).status === 0;

test('Holiday email real database: selection, secure sends, idempotency and uncertain outcomes',
  { skip: !available, timeout: 120000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holiday-email-test-'));
    const data = path.join(dir, 'data');
    let pool, server, started = false;
    try {
      execFileSync('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale'], { stdio: 'pipe' });
      execFileSync('pg_ctl', ['-D', data, '-l', path.join(dir, 'postgres.log'), '-w', '-t', '20',
        '-o', `-h '' -k ${dir} -p 15434`, 'start'], { stdio: 'pipe' });
      started = true;
      pool = new Pool({ host: dir, port: 15434, user: 'postgres', database: 'postgres', max: 5 });
      const migrate = async () => {
        for (const file of ['holiday-greetings.sql', 'holiday-greetings-email.sql']) {
          await pool.query(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
        }
      };
      await migrate();
      const store = new HolidayStore(pool, config);
      const subject = 'synthetic-owner';
      const credentials = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
        scopes: SCOPES, expiresAt: Date.now() + 3600000 };
      await pool.query('INSERT INTO hg_owner(subject,email,connected,token_ciphertext) VALUES($1,$2,true,$3)',
        [subject, config.ownerEmail, seal(credentials, config, `google:${subject}`)]);
      const sessionToken = await store.createSession(subject);
      const contact = { resourceName: 'people/friend', displayName: 'Synthetic Friend', givenName: 'Friend',
        emailAddresses: [{ value: 'friend@example.invalid', label: 'home' }],
        phoneNumbers: [{ value: '+12025550101', canonicalNumber: '+12025550101' }] };
      let sends = 0, outcome = 'accepted', releaseSend = null, enteredSend = null, missingContact = false;
      const google = {
        async get() { if (missingContact) throw fail('CONTACT_NOT_FOUND', 404); return structuredClone(contact); },
        async sendEmail(token, message) {
          sends++; assert.equal(token, 'synthetic-access');
          assert.equal(message.to, 'friend@example.invalid');
          assert.deepEqual(Object.keys(message).sort(), ['message', 'subject', 'to']);
          if (enteredSend) enteredSend();
          if (releaseSend) await releaseSend;
          if (outcome !== 'accepted') throw fail(outcome === 'rejected' ? 'EMAIL_REJECTED' : 'EMAIL_OUTCOME_UNKNOWN', 409);
          return { messageId: 'synthetic-message-id' };
        }
      };
      const app = express(); app.use(express.json());
      app.use(routes({ holidayConfig: config, holidayGoogle: google, auditPool: pool }));
      server = app.listen(0); await new Promise(r => server.once('listening', r));
      const prefix = '/api/holiday-greetings';
      async function api(method, endpoint, body, headers = {}) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${prefix}${endpoint}`, {
          method, headers: { 'Content-Type': 'application/json', Origin: config.origin,
            Cookie: `${COOKIE}=${sessionToken}`, 'X-CSRF-Token': csrf(sessionToken, config), ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        return { status: response.status, body: await response.json() };
      }
      let prefVersion = 0;
      async function preference(changes) {
        const result = await api('PUT', '/preferences', { resourceName: contact.resourceName, version: prefVersion, ...changes });
        if (result.status === 200) prefVersion = result.body.version;
        return result;
      }
      async function batch() {
        const result = await api('POST', '/batches', { occasion: 'christmas', baseTemplate: 'Hello {name}',
          recipients: [{ resourceName: contact.resourceName, subject: 'Synthetic greeting' }] });
        assert.equal(result.status, 201, JSON.stringify(result.body));
        return result.body;
      }
      const url = b => `/batches/${b.id}/drafts/${b.drafts[0].id}`;
      const send = (b, attemptId = randomUUID(), headers = {}) =>
        api('POST', `${url(b)}/send-email`, { version: b.version, attemptId, confirmed: true }, headers);

      await t.test('sparse preference changes preserve existing wording and explicit selection', async () => {
        assert.equal((await preference({ greetingName: 'Old Friend', familyMode: 'family',
          personalNote: 'Synthetic note', occasions: { christmas: 'opt_in' },
          preferredPhoneNumber: '+12025550101' })).status, 200);
        const saved = await preference({ selected: true, preferredMethod: 'email',
          preferredEmailAddress: 'friend@example.invalid' });
        assert.equal(saved.status, 200);
        assert.equal(saved.body.greetingName, 'Old Friend');
        assert.equal(saved.body.personalNote, 'Synthetic note');
        assert.equal(saved.body.familyMode, 'family');
        await migrate();
        assert.equal((await store.preferences(subject))[0].selected, true);
      });

      await t.test('missing consent, unselected contacts, occasion exclusions and changed destinations fail safely', async () => {
        const b = await batch();
        await pool.query('UPDATE hg_owner SET token_ciphertext=$1', [seal({ ...credentials, scopes: [] }, config, `google:${subject}`)]);
        const noConsent = await send(b);
        assert.equal(noConsent.status, 409);
        assert.equal(noConsent.body.error, 'GOOGLE_GMAIL_CONSENT_REQUIRED');
        assert.equal((await api('GET', '/session')).body.gmailSendAuthorized, false);
        await pool.query('UPDATE hg_owner SET token_ciphertext=$1', [seal(credentials, config, `google:${subject}`)]);
        contact.emailAddresses[0].value = 'changed@example.invalid';
        assert.equal((await send(b)).body.error, 'CONTACT_EMAIL_CHANGED');
        contact.emailAddresses[0].value = 'friend@example.invalid';
        missingContact = true;
        assert.equal((await send(b)).body.error, 'CONTACT_NOT_FOUND');
        missingContact = false;
        await preference({ selected: false });
        assert.equal((await send(b)).body.error, 'CONTACT_NOT_SELECTED');
        const unselected = await api('POST', '/batches', { occasion: 'christmas', baseTemplate: 'Hello',
          recipients: [{ resourceName: contact.resourceName, subject: 'Hi' }] });
        assert.equal(unselected.body.error, 'CONTACT_NOT_SELECTED');
        await preference({ selected: true, occasions: { christmas: 'opt_out' } });
        assert.equal((await send(b)).body.error, 'CONTACT_OCCASION_OPTED_OUT');
        await preference({ occasions: { christmas: 'opt_in' } });
        assert.equal(sends, 0);
      });

      await t.test('send requires real owner session, CSRF, Origin, confirmation and latest version', async () => {
        const b = await batch();
        for (const headers of [{ Cookie: '' }, { 'X-CSRF-Token': '' }, { Origin: 'https://attacker.invalid' }]) {
          assert([401, 403].includes((await send(b, randomUUID(), headers)).status));
        }
        assert.equal((await api('POST', `${url(b)}/send-email`, { version: b.version, attemptId: randomUUID() })).status, 400);
        assert.equal((await api('POST', `${url(b)}/send-email`, { version: b.version, attemptId: randomUUID(), confirmed: true,
          from: 'attacker@example.invalid' })).status, 400);
        assert.equal((await send({ ...b, version: 99 })).body.error, 'VERSION_CONFLICT');
        assert.equal(sends, 0);
      });

      await t.test('double taps and concurrent different attempt IDs send once, with durable replay', async () => {
        const b = await batch(), attemptId = randomUUID();
        let release;
        releaseSend = new Promise(r => { release = r; });
        const entered = new Promise(r => { enteredSend = r; });
        const first = send(b, attemptId);
        await entered;
        const replay = await send(b, attemptId);
        assert.equal(replay.status, 202);
        assert.equal(replay.body.attempt.requiresReview, true);
        assert.equal((await send(b)).status, 409);
        assert.equal((await api('PATCH', url(b), { version: b.version + 1, state: 'draft' })).status, 409);
        release(); releaseSend = null; enteredSend = null;
        const accepted = await first;
        assert.equal(accepted.status, 200);
        assert.equal(accepted.body.attempt.acceptedByGmail, true);
        assert.equal(accepted.body.attempt.deliveryConfirmed, false);
        const count = sends;
        const restartedStore = new HolidayStore(pool, config);
        assert.equal((await restartedStore.emailAttempt(subject, attemptId)).state, 'accepted');
        assert.equal((await send(b, attemptId)).status, 200);
        assert.equal(sends, count);
        assert.equal((await api('GET', `${url(b)}/email-attempts/${attemptId}`)).body.attempt.state, 'accepted');
        assert.equal((await api('DELETE', `/batches/${b.id}`, { version: b.version + 2 })).body.error, 'EMAIL_ATTEMPT_HISTORY_EXISTS');
        assert.equal(await store.emailAttempt('other-owner', attemptId), null);
      });

      await t.test('ambiguous Gmail outcomes stay blocked after replay, new attempts and editing', async () => {
        outcome = 'unknown';
        const b = await batch(), attemptId = randomUUID(), count = sends;
        const result = await send(b, attemptId);
        assert.equal(result.status, 409);
        assert.equal(result.body.attempt.state, 'unknown');
        assert.equal((await send(b, attemptId)).body.replay, true);
        assert.equal((await send({ ...b, version: b.version + 2 })).status, 409);
        assert.equal((await api('PATCH', url(b), { version: b.version + 2, state: 'draft' })).status, 409);
        assert.equal(sends, count + 1);
        outcome = 'accepted';
      });

      await t.test('definite rejection permits only a reviewed edit and explicit new attempt', async () => {
        outcome = 'rejected';
        const b = await batch(), attemptId = randomUUID();
        assert.equal((await send(b, attemptId)).body.attempt.state, 'rejected');
        const edited = await api('PATCH', url(b), { version: b.version + 2, subject: 'Revised subject', state: 'draft' });
        assert.equal(edited.status, 200);
        outcome = 'accepted';
        assert.equal((await send(edited.body, attemptId)).body.attempt.state, 'rejected');
        assert.equal((await send(edited.body)).status, 200);
      });

      await t.test('crash after committed claim cannot resend and keeps history durable', async () => {
        const b = await batch(), attemptId = randomUUID(), count = sends;
        await store.beginEmailSend(subject, b.id, b.drafts[0].id, b.version, attemptId, async () => {});
        assert.equal((await send(b, attemptId)).status, 202);
        assert.equal((await send({ ...b, version: b.version + 1 })).status, 409);
        assert.equal(sends, count);
        const foreign = await batch();
        assert.equal((await send(foreign, attemptId)).body.error, 'SEND_ATTEMPT_CONFLICT');
        const spoofed = await api('GET', `${url(foreign)}/email-attempts/${attemptId}`);
        assert.equal(spoofed.status, 404);
      });
      await t.test('losing the final database acknowledgement cannot trigger another Gmail send', async () => {
        const b = await batch(), attemptId = randomUUID(), count = sends;
        const finish = HolidayStore.prototype.finishEmailSend;
        HolidayStore.prototype.finishEmailSend = async () => { throw new Error('Synthetic database interruption'); };
        try {
          const result = await send(b, attemptId);
          assert.equal(result.status, 409);
          assert.equal(result.body.error, 'EMAIL_OUTCOME_UNKNOWN');
        } finally { HolidayStore.prototype.finishEmailSend = finish; }
        assert.equal((await send(b, attemptId)).status, 202);
        assert.equal((await send({ ...b, version: b.version + 1 })).status, 409);
        assert.equal(sends, count + 1);
      });
    } finally {
      if (server) await new Promise(r => server.close(r));
      if (pool) await pool.end();
      if (started) execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe' });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
