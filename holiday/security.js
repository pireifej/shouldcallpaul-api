'use strict';
const crypto = require('node:crypto');

const PREFIX = '/api/holiday-greetings';
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/contacts.readonly', GMAIL_SEND_SCOPE];
const COOKIE = '__Host-hg-session';

function fail(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function random() { return crypto.randomBytes(32).toString('base64url'); }
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function configFromEnv() {
  if (process.env.HOLIDAY_GREETINGS_ENABLED !== 'true') return null;
  return validateConfig({
    clientId: process.env.HOLIDAY_GOOGLE_CLIENT_ID,
    clientSecret: process.env.HOLIDAY_GOOGLE_CLIENT_SECRET,
    encryptionKey: process.env.HOLIDAY_TOKEN_ENCRYPTION_KEY,
    sessionSecret: process.env.HOLIDAY_SESSION_SECRET,
    ownerEmail: process.env.HOLIDAY_OWNER_EMAIL,
    origin: process.env.HOLIDAY_FRONTEND_ORIGIN,
    redirectUri: process.env.HOLIDAY_GOOGLE_REDIRECT_URI
  });
}
function validateConfig(config) {
  if (!config || !['clientId', 'clientSecret', 'encryptionKey', 'sessionSecret', 'ownerEmail',
    'origin', 'redirectUri'].every(key => typeof config[key] === 'string' && config[key])) {
    throw fail('HOLIDAY_SETUP_REQUIRED', 503);
  }
  let origin, redirect;
  try { origin = new URL(config.origin); redirect = new URL(config.redirectUri); }
  catch { throw fail('HOLIDAY_SETUP_REQUIRED', 503); }
  if (origin.protocol !== 'https:' || origin.origin !== config.origin ||
      redirect.origin !== origin.origin || redirect.pathname !== `${PREFIX}/oauth/google/callback` ||
      redirect.search || redirect.hash || redirect.username || redirect.password ||
      Buffer.from(config.encryptionKey, 'base64').length !== 32 ||
      config.sessionSecret.length < 32 || !/^[^@\s]+@[^@\s]+$/.test(config.ownerEmail)) {
    throw fail('HOLIDAY_SETUP_REQUIRED', 503);
  }
  return { ...config, ownerEmail: config.ownerEmail.toLowerCase() };
}
function seal(value, config, context) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(config.encryptionKey, 'base64'), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.');
}
function unseal(value, config, context) {
  try {
    const [iv, tag, data] = value.split('.').map(s => Buffer.from(s, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(config.encryptionKey, 'base64'), iv);
    decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
  } catch { throw fail('AUTHORIZATION_STORAGE_UNAVAILABLE', 503); }
}
function csrf(token, config) {
  return crypto.createHmac('sha256', config.sessionSecret).update(`holiday-csrf:${token}`).digest('base64url');
}
function cookieToken(req) {
  return String(req.headers.cookie || '').split(';').map(p => p.trim())
    .find(p => p.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}
function contactId(value) {
  if (typeof value !== 'string' || !/^people\/[A-Za-z0-9_-]{1,180}$/.test(value)) {
    throw fail('INVALID_CONTACT_RESOURCE');
  }
  return value;
}
function text(value, max = 2000) {
  if (typeof value !== 'string' || value.length > max) throw fail('INVALID_TEXT');
  return value;
}
function template(value, fields) {
  text(value, 10000);
  const allowed = new Set(['name', 'family', 'occasion', 'note']);
  const withoutFields = value.replace(/\{([^{}]*)\}/g, (_, field) => {
    if (!allowed.has(field)) throw fail('UNKNOWN_TEMPLATE_FIELD');
    return '';
  });
  if (/[{}]/.test(withoutFields)) throw fail('INVALID_TEMPLATE');
  return value.replace(/\{([^{}]*)\}/g, (_, field) => fields[field] || '');
}
module.exports = { PREFIX, COOKIE, SCOPES, GMAIL_SEND_SCOPE, fail, hash, random, equal, configFromEnv,
  validateConfig, seal, unseal, csrf, cookieToken, contactId, text, template };
