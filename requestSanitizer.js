'use strict';

const SENSITIVE_FIELDS = new Set([
  'password',
  'newpassword',
  'confirmpassword',
  'token',
  'fcm_token',
  'authorization',
  'api_key',
  'secret',
  'accesstoken',
  'access_token',
  'identity_token',
  'usersessiontoken',
  'user_session_token',
  'provider_login_proof',
  'code',
  'codeverifier'
]);

function sanitizeParams(body, replacement = '***') {
  if (!body || typeof body !== 'object') return body;
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    const normalizedKey = key.toLowerCase();
    const isSignedGoogleAssertion =
      (normalizedKey === 'google_id' || normalizedKey === 'googleid') &&
      typeof value === 'string' &&
      value.startsWith('gsi.');
    out[key] = SENSITIVE_FIELDS.has(normalizedKey) || isSignedGoogleAssertion
      ? replacement
      : value;
  }
  return out;
}

module.exports = { sanitizeParams };
