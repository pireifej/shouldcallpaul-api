'use strict';

const crypto = require('node:crypto');

const USER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is required for user sessions');
  return secret;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signPayload(encodedPayload, secret = getSessionSecret()) {
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function issueUserSessionToken(userId, options = {}) {
  const numericUserId = Number(userId);
  if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) {
    throw new Error('Cannot issue a user session without a valid user ID');
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload = {
    sub: numericUserId,
    iat: nowSeconds,
    exp: nowSeconds + (options.ttlSeconds ?? USER_SESSION_TTL_SECONDS),
    v: 1
  };
  const encodedPayload = encodeJson(payload);
  return `${encodedPayload}.${signPayload(encodedPayload, options.secret)}`;
}

function verifyUserSessionToken(token, options = {}) {
  if (typeof token !== 'string' || token.length > 2048) {
    throw new Error('Invalid user session token');
  }

  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Invalid user session token');
  const [encodedPayload, suppliedSignature] = parts;
  const expectedSignature = signPayload(encodedPayload, options.secret);
  const suppliedBuffer = Buffer.from(suppliedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    throw new Error('Invalid user session token');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid user session token');
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    payload.v !== 1 ||
    !Number.isSafeInteger(payload.sub) ||
    payload.sub <= 0 ||
    !Number.isSafeInteger(payload.exp) ||
    payload.exp <= nowSeconds
  ) {
    throw new Error('Expired or invalid user session token');
  }
  return payload;
}

function requireUserSession(req, res, next) {
  try {
    const cookieToken = String(req.headers.cookie || '')
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith('user_session_token='))
      ?.slice('user_session_token='.length);
    const token =
      req.get('x-user-session-token') ||
      (cookieToken ? decodeURIComponent(cookieToken) : undefined);
    const payload = verifyUserSessionToken(token);
    const bodyUserId = req.body?.userId ?? req.body?.user_id;
    if (bodyUserId !== undefined && Number(bodyUserId) !== payload.sub) {
      return res.status(403).json({
        error: 'USER_ID_MISMATCH',
        message: 'The session does not match the requested user.'
      });
    }

    req.userId = payload.sub;
    if (req.body && typeof req.body === 'object') req.body.userId = payload.sub;
    next();
  } catch (error) {
    res.status(401).json({
      error: 'USER_SESSION_REQUIRED',
      message: 'A valid user session is required.'
    });
  }
}

module.exports = {
  USER_SESSION_TTL_SECONDS,
  issueUserSessionToken,
  verifyUserSessionToken,
  requireUserSession
};
