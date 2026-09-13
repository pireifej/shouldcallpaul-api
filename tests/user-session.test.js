'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const authRoutes = require('../routes/auth');
const prayersRoutes = require('../routes/prayers');
const usersRoutes = require('../routes/users');
const {
  issueUserSessionToken,
  verifyUserSessionToken,
  requireUserSession
} = require('../userSession');
const {
  verifyGoogleAccessToken,
  issueGoogleLoginAssertion,
  verifyFacebookAccessToken,
  verifyAppleIdentityToken
} = require('../providerIdentity');
const { sanitizeParams } = require('../requestSanitizer');

async function withServer(router, callback) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('email login returns a session token signed for the authenticated user', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'email-login-test-secret';
  const user = {
    user_id: 42,
    password: 'stored-hash',
    active: 1,
    has_password: true,
    faith_points: 0
  };
  const router = authRoutes({
    authenticate: (req, res, next) => next(),
    pool: {
      query: async () => ({ rows: [{ ...user }] })
    },
    bcrypt: {
      compare(password, hash, callback) {
        callback(null, password === 'correct-password' && hash === 'stored-hash');
      }
    },
    loadFaithRanks: async () => [],
    computeRank: () => ({ level: 1 }),
    issueUserSessionToken
  });

  try {
    await withServer(router, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'person@example.com',
          password: 'correct-password'
        })
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.user_session_token, body.result[0].user_session_token);
      assert.equal(verifyUserSessionToken(body.user_session_token).sub, 42);
    });
  } finally {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
});

test('request logging redacts provider and app session credentials', () => {
  const sanitized = sanitizeParams({
    accessToken: 'google-secret',
    access_token: 'facebook-secret',
    identity_token: 'apple-secret',
    userSessionToken: 'session-secret',
    user_session_token: 'session-secret-2',
    code: 'oauth-code',
    codeVerifier: 'oauth-verifier',
    email: 'safe@example.com'
  });
  for (const [key, value] of Object.entries(sanitized)) {
    if (key === 'email') assert.equal(value, 'safe@example.com');
    else assert.equal(value, '***');
  }
});

test('Google, Facebook, and Apple identity data comes from verified provider tokens', async () => {
  const originalFetch = global.fetch;
  const originalAppleClientId = process.env.APPLE_CLIENT_ID;
  const originalFacebookAppId = process.env.FACEBOOK_APP_ID;
  const originalFacebookAppSecret = process.env.FACEBOOK_APP_SECRET;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048
  });
  const appleHeader = Buffer.from(JSON.stringify({
    alg: 'RS256',
    kid: 'test-apple-key'
  })).toString('base64url');
  const appleClaims = Buffer.from(JSON.stringify({
    iss: 'https://appleid.apple.com',
    aud: 'com.prayoverus.test',
    sub: 'apple-user-123',
    exp: Math.floor(Date.now() / 1000) + 300,
    email: 'apple@example.com'
  })).toString('base64url');
  const appleSignature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(`${appleHeader}.${appleClaims}`),
    privateKey
  ).toString('base64url');

  process.env.APPLE_CLIENT_ID = 'com.prayoverus.test';
  process.env.FACEBOOK_APP_ID = 'facebook-app-123';
  process.env.FACEBOOK_APP_SECRET = 'facebook-test-secret';
  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes('oauth2.googleapis.com/tokeninfo')) {
      return {
        ok: true,
        json: async () => ({
          aud: '798628803696-b9b82e0mer9c3cm7rpngmpr9eet2hilj.apps.googleusercontent.com'
        })
      };
    }
    if (value.includes('googleapis.com/userinfo')) {
      return {
        ok: true,
        json: async () => ({
          id: 'google-123',
          email: 'Google@Example.com',
          verified_email: true,
          given_name: 'Google',
          family_name: 'User'
        })
      };
    }
    if (value.includes('graph.facebook.com/debug_token')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            is_valid: true,
            app_id: 'facebook-app-123',
            user_id: 'facebook-123'
          }
        })
      };
    }
    if (value.includes('graph.facebook.com/v20.0/me')) {
      return {
        ok: true,
        json: async () => ({
          id: 'facebook-123',
          email: 'Facebook@Example.com',
          first_name: 'Facebook',
          last_name: 'User'
        })
      };
    }
    if (value === 'https://appleid.apple.com/auth/keys') {
      const jwk = publicKey.export({ format: 'jwk' });
      return {
        ok: true,
        json: async () => ({
          keys: [{ ...jwk, kid: 'test-apple-key', alg: 'RS256', use: 'sig' }]
        })
      };
    }
    throw new Error(`Unexpected URL: ${value}`);
  };

  try {
    const google = await verifyGoogleAccessToken('google-token');
    const facebook = await verifyFacebookAccessToken('facebook-token');
    const apple = await verifyAppleIdentityToken(
      `${appleHeader}.${appleClaims}.${appleSignature}`,
      'apple-user-123'
    );
    assert.deepEqual(
      [google.providerId, google.email],
      ['google-123', 'google@example.com']
    );
    assert.deepEqual(
      [facebook.providerId, facebook.email],
      ['facebook-123', 'facebook@example.com']
    );
    assert.deepEqual(
      [apple.providerId, apple.email],
      ['apple-user-123', 'apple@example.com']
    );
  } finally {
    global.fetch = originalFetch;
    if (originalAppleClientId === undefined) delete process.env.APPLE_CLIENT_ID;
    else process.env.APPLE_CLIENT_ID = originalAppleClientId;
    if (originalFacebookAppId === undefined) delete process.env.FACEBOOK_APP_ID;
    else process.env.FACEBOOK_APP_ID = originalFacebookAppId;
    if (originalFacebookAppSecret === undefined) delete process.env.FACEBOOK_APP_SECRET;
    else process.env.FACEBOOK_APP_SECRET = originalFacebookAppSecret;
  }
});

test('Google login accepts the signed identity returned to the Android OAuth flow', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'raw-google-login-test-secret';
  const assertion = issueGoogleLoginAssertion({
    id: 'google-raw-1',
    email: 'raw-google@example.com',
    given_name: 'Raw',
    family_name: 'Google'
  });
  const pool = {
    query: async () => ({
      rows: [{
        user_id: 42,
        email: 'raw-google@example.com',
        active: 1,
        google_id: 'google-raw-1',
        faith_points: 0
      }]
    })
  };
  const router = authRoutes({
    pool,
    bcrypt: { hash: async () => 'unused' },
    authenticate: (req, res, next) => next(),
    computeRank: () => 'Seed',
    awardBadge: async () => null,
    loadFaithRanks: async () => [],
    sendGmailSingle: async () => ({ error: 0 }),
    issueUserSessionToken,
    log: () => {}
  });

  try {
    await withServer(router, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/googleLogin`, {
        method: 'POST',
        body: JSON.stringify({
          google_id: 'google-raw-1',
          provider_login_proof: assertion,
          email: 'untrusted-attacker@example.com',
          first_name: 'Untrusted'
        })
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.error, 0);
      assert.equal(body.result[0].user_id, 42);
      assert.ok(body.user_session_token);
    });
  } finally {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
});

test('Google assertions cannot be issued for missing or unverified identities', () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'google-assertion-validation-secret';
  try {
    assert.throws(
      () => issueGoogleLoginAssertion({ id: 'google-1', email: '' }),
      /email is not verified/
    );
    assert.throws(
      () => issueGoogleLoginAssertion({
        id: 'google-1',
        email: 'unverified@example.com',
        verified_email: false
      }),
      /email is not verified/
    );
  } finally {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
});

test('Facebook identity rejects a token issued for another app', async () => {
  const originalFetch = global.fetch;
  const originalAppId = process.env.FACEBOOK_APP_ID;
  const originalAppSecret = process.env.FACEBOOK_APP_SECRET;
  process.env.FACEBOOK_APP_ID = 'pray-over-us-app';
  process.env.FACEBOOK_APP_SECRET = 'facebook-test-secret';
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: {
        is_valid: true,
        app_id: 'another-app',
        user_id: 'facebook-123'
      }
    })
  });
  try {
    await assert.rejects(
      () => verifyFacebookAccessToken('wrong-app-token'),
      /not issued for Pray Over Us/
    );
  } finally {
    global.fetch = originalFetch;
    if (originalAppId === undefined) delete process.env.FACEBOOK_APP_ID;
    else process.env.FACEBOOK_APP_ID = originalAppId;
    if (originalAppSecret === undefined) delete process.env.FACEBOOK_APP_SECRET;
    else process.env.FACEBOOK_APP_SECRET = originalAppSecret;
  }
});

test('multipart prayer posting cannot replace the session user ID', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'multipart-session-test-secret';
  const token = issueUserSessionToken(42);
  const router = prayersRoutes({
    pool: { query: async () => ({ rows: [] }) },
    authenticate: (req, res, next) => next(),
    requireUserSession,
    requirePro: (req, res, next) => next(),
    proSubscriptionService: {
      getProStatus: async () => ({ isPro: false })
    },
    prayerAudioCache: new Map(),
    MAX_PRAYER_AUDIO_CACHE: 10,
    PRAYER_AUDIO_DIR: '/tmp',
    multer,
    path,
    fs
  });

  try {
    await withServer(router, async (baseUrl) => {
      const form = new FormData();
      form.set('userId', '99');
      form.set('requestText', 'Please pray for my family.');
      form.set('requestTitle', 'Family');
      form.set('sendEmail', 'true');
      form.set('idempotencyKey', `multipart-user-session-${process.pid}`);

      const response = await fetch(`${baseUrl}/api/prayers/post`, {
        method: 'POST',
        headers: { 'x-user-session-token': token },
        body: form
      });
      const body = await response.json();
      assert.equal(response.status, 403);
      assert.equal(body.error, 'USER_ID_MISMATCH');

      const editForm = new FormData();
      editForm.set('userId', '99');
      editForm.set('requestId', '123');
      editForm.set('requestText', 'Changed text');
      const editResponse = await fetch(`${baseUrl}/editRequest`, {
        method: 'POST',
        headers: { 'x-user-session-token': token },
        body: editForm
      });
      const editBody = await editResponse.json();
      assert.equal(editResponse.status, 403);
      assert.equal(editBody.error, 'USER_ID_MISMATCH');
    });
  } finally {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
});

test('account profile routes require a matching session, including multipart uploads', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'account-route-session-test-secret';
  const token = issueUserSessionToken(42);
  const router = usersRoutes({
    pool: {
      query: async () => {
        throw new Error('Database should not be reached for rejected identities');
      }
    },
    auditPool: { query: async () => ({ rows: [] }) },
    authenticate: (req, res, next) => next(),
    requireUserSession,
    multer,
    path,
    uploadImage: async () => {
      throw new Error('Upload should not be reached for rejected identities');
    }
  });

  try {
    await withServer(router, async (baseUrl) => {
      const missing = await fetch(`${baseUrl}/getUser`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 42 })
      });
      assert.equal(missing.status, 401);
      assert.deepEqual(await missing.json(), {
        error: 'USER_SESSION_REQUIRED',
        message: 'A valid user session is required.'
      });

      const mismatch = await fetch(`${baseUrl}/updateUser`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-session-token': token
        },
        body: JSON.stringify({ userId: 99, real_name: 'Wrong account' })
      });
      assert.equal(mismatch.status, 403);
      assert.deepEqual(await mismatch.json(), {
        error: 'USER_ID_MISMATCH',
        message: 'The session does not match the requested user.'
      });

      const emailMismatch = await fetch(`${baseUrl}/updateEmail`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-session-token': token
        },
        body: JSON.stringify({ userId: 99, newEmail: 'attacker@example.com' })
      });
      assert.equal(emailMismatch.status, 403);
      assert.equal((await emailMismatch.json()).error, 'USER_ID_MISMATCH');

      const uploadForm = new FormData();
      uploadForm.set('userId', '99');
      uploadForm.set(
        'image',
        new Blob([Buffer.from('not-a-real-png')], { type: 'image/png' }),
        'profile.png'
      );
      const upload = await fetch(`${baseUrl}/uploadProfilePicture`, {
        method: 'POST',
        headers: { 'x-user-session-token': token },
        body: uploadForm
      });
      assert.equal(upload.status, 403);
      assert.equal((await upload.json()).error, 'USER_ID_MISMATCH');
    });
  } finally {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
});

test('marking a prayer answered uses the signed user throughout the complete flow', async () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'answered-prayer-session-test-secret';
  const token = issueUserSessionToken(42);
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('requester_name')) {
        return {
          rows: [{
            request_id: 77,
            user_id: 42,
            request_title: 'Healing',
            request_text: 'Please pray',
            requester_name: 'Pat'
          }]
        };
      }
      if (sql.includes('SELECT DISTINCT ON')) return { rows: [] };
      if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: '1' }] };
      if (sql.includes('SELECT timestamp')) return { rows: [] };
      return { rows: [] };
    }
  };
  const router = prayersRoutes({
    pool,
    authenticate: (req, res, next) => next(),
    requireUserSession,
    requirePro: (req, res, next) => next(),
    proSubscriptionService: { getProStatus: async () => ({ isPro: false }) },
    prayerAudioCache: new Map(),
    MAX_PRAYER_AUDIO_CACHE: 10,
    PRAYER_AUDIO_DIR: '/tmp',
    multer,
    path,
    fs,
    awardBadge: async () => null,
    sendPushNotification: async () => ({ shouldRemoveToken: false }),
    sendGmailSingle: async () => ({ error: 0 }),
    log: () => {}
  });

  try {
    await withServer(router, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/markPrayerAnswered`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-session-token': token
        },
        body: JSON.stringify({
          request_id: 77,
          user_id: 42,
          answered_message: 'Thank you for praying.'
        })
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.error, 0);
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(calls.some(call =>
        call.sql.includes('SET active = 2') &&
        call.params[2] === 42
      ));
      assert.ok(calls.some(call =>
        call.sql.includes('SELECT DISTINCT ON') &&
        call.params[1] === 42
      ));
    });
  } finally {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
});