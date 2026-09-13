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
const {
  issueUserSessionToken,
  verifyUserSessionToken,
  requireUserSession
} = require('../userSession');
const {
  verifyGoogleAccessToken,
  verifyFacebookAccessToken,
  verifyAppleIdentityToken
} = require('../providerIdentity');

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

test('Google, Facebook, and Apple identity data comes from verified provider tokens', async () => {
  const originalFetch = global.fetch;
  const originalAppleClientId = process.env.APPLE_CLIENT_ID;
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
    if (value.includes('graph.facebook.com')) {
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
    });
  } finally {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
});