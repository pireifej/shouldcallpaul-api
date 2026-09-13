'use strict';

const crypto = require('node:crypto');

const GOOGLE_CLIENT_IDS = new Set([
  '798628803696-2sodci2f99h4ojbhiqm851im6bgjuiqg.apps.googleusercontent.com',
  '798628803696-b9b82e0mer9c3cm7rpngmpr9eet2hilj.apps.googleusercontent.com'
]);

let appleKeysCache = null;
let appleKeysExpiresAt = 0;

function identityError(message, statusCode = 401) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getGoogleAssertionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw identityError('Google Sign In is not configured', 503);
  return secret;
}

function normalizeGoogleUserInfo(userInfo) {
  if (!userInfo?.id || !userInfo?.email || userInfo.verified_email === false) {
    throw identityError('Google account email is not verified');
  }
  return {
    provider: 'google',
    providerId: String(userInfo.id),
    email: String(userInfo.email).toLowerCase(),
    firstName: userInfo.given_name || '',
    lastName: userInfo.family_name || '',
    picture: userInfo.picture || ''
  };
}

function issueGoogleLoginAssertion(userInfo) {
  const identity = normalizeGoogleUserInfo(userInfo);
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    ...identity,
    exp: now + 300
  })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', getGoogleAssertionSecret())
    .update(payload)
    .digest('base64url');
  return `gsi.${payload}.${signature}`;
}

function verifyGoogleLoginAssertion(assertion) {
  if (typeof assertion !== 'string' || !assertion.startsWith('gsi.')) {
    throw identityError('Google access token is required', 400);
  }
  const parts = assertion.split('.');
  if (parts.length !== 3) throw identityError('Invalid Google login assertion');
  const expected = crypto
    .createHmac('sha256', getGoogleAssertionSecret())
    .update(parts[1])
    .digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw identityError('Invalid Google login assertion');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw identityError('Invalid Google login assertion');
  }
  if (
    payload.provider !== 'google' ||
    !payload.providerId ||
    !payload.email ||
    payload.exp <= Math.floor(Date.now() / 1000)
  ) {
    throw identityError('Google login assertion expired or invalid');
  }
  return payload;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw identityError('Social identity verification failed');
  return data;
}

async function verifyGoogleAccessToken(accessToken) {
  if (!accessToken) throw identityError('Google access token is required', 400);
  const tokenInfo = await fetchJson(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
  );
  if (!GOOGLE_CLIENT_IDS.has(tokenInfo.aud)) {
    throw identityError('Google token was not issued for Pray Over Us');
  }
  const userInfo = await fetchJson('https://www.googleapis.com/userinfo/v2/me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return normalizeGoogleUserInfo(userInfo);
}

async function verifyFacebookAccessToken(accessToken) {
  if (!accessToken) throw identityError('Facebook access token is required', 400);
  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  if (!appId || !appSecret) {
    throw identityError('Facebook Sign In is not configured for secure user sessions', 503);
  }
  const debugResult = await fetchJson(
    `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`
  );
  if (
    !debugResult.data?.is_valid ||
    String(debugResult.data.app_id) !== String(appId) ||
    !debugResult.data.user_id
  ) {
    throw identityError('Facebook token was not issued for Pray Over Us');
  }
  const profile = await fetchJson(
    `https://graph.facebook.com/v20.0/me?fields=id,email,first_name,last_name,picture&access_token=${encodeURIComponent(accessToken)}`
  );
  if (
    !profile.id ||
    String(profile.id) !== String(debugResult.data.user_id) ||
    !profile.email
  ) {
    throw identityError('Facebook account did not provide a verified identity');
  }
  return {
    provider: 'facebook',
    providerId: String(profile.id),
    email: profile.email.toLowerCase(),
    firstName: profile.first_name || '',
    lastName: profile.last_name || '',
    picture: profile.picture?.data?.url || ''
  };
}

async function getApplePublicKeys() {
  if (appleKeysCache && appleKeysExpiresAt > Date.now()) return appleKeysCache;
  const data = await fetchJson('https://appleid.apple.com/auth/keys');
  appleKeysCache = data.keys || [];
  appleKeysExpiresAt = Date.now() + 6 * 60 * 60 * 1000;
  return appleKeysCache;
}

async function verifyAppleIdentityToken(identityToken, expectedUserId) {
  const expectedAudience = process.env.APPLE_CLIENT_ID;
  if (!expectedAudience) {
    throw identityError('Apple Sign In is not configured for secure user sessions', 503);
  }
  if (typeof identityToken !== 'string') {
    throw identityError('Apple identity token is required', 400);
  }

  const parts = identityToken.split('.');
  if (parts.length !== 3) throw identityError('Invalid Apple identity token');
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw identityError('Invalid Apple identity token');
  }
  if (header.alg !== 'RS256' || !header.kid) {
    throw identityError('Invalid Apple identity token');
  }

  const keys = await getApplePublicKeys();
  const jwk = keys.find(key => key.kid === header.kid && key.kty === 'RSA');
  if (!jwk) throw identityError('Apple signing key was not found');
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const validSignature = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKey,
    Buffer.from(parts[2], 'base64url')
  );
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    !validSignature ||
    claims.iss !== 'https://appleid.apple.com' ||
    !audiences.includes(expectedAudience) ||
    !claims.sub ||
    claims.exp <= nowSeconds ||
    (expectedUserId && claims.sub !== expectedUserId)
  ) {
    throw identityError('Apple identity token verification failed');
  }

  return {
    provider: 'apple',
    providerId: String(claims.sub),
    email: claims.email ? claims.email.toLowerCase() : null
  };
}

module.exports = {
  verifyGoogleAccessToken,
  issueGoogleLoginAssertion,
  verifyGoogleLoginAssertion,
  verifyFacebookAccessToken,
  verifyAppleIdentityToken
};
