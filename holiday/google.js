'use strict';
const crypto = require('node:crypto');
const { fail, SCOPES, GMAIL_SEND_SCOPE, equal, contactId } = require('./security');
const { mimeMessage } = require('./email');

// Provider URLs are optional, changeable display data, never contact identities.
// Do not fetch, persist or log photos. Ignore placeholders and unsafe image URLs.
function contactPhotoUrl(photos) {
  let fallback = null;
  for (const photo of Array.isArray(photos) ? photos : []) {
    if (!photo || photo.default === true || typeof photo.url !== 'string') continue;
    try {
      const url = new URL(photo.url);
      if (url.protocol !== 'https:' || url.username || url.password) continue;
      if (photo.metadata?.primary === true) return photo.url;
      if (fallback === null) fallback = photo.url;
    } catch { /* Missing/malformed optional photos must not break contact loading. */ }
  }
  return fallback;
}

class HolidayGoogle {
  constructor(config, { fetcher = fetch, now = () => Date.now() } = {}) {
    this.config = config; this.fetcher = fetcher; this.now = now;
    this.keys = null; this.keysExpire = 0;
  }
  async json(url, options = {}) {
    let response, data;
    try {
      response = await this.fetcher(url, { ...options, signal: AbortSignal.timeout(15000) });
      data = await response.json();
    } catch { throw fail('GOOGLE_UNAVAILABLE', 503); }
    if (!response.ok) {
      if ([401].includes(response.status) || data.error === 'invalid_grant') {
        throw fail('GOOGLE_RECONNECT_REQUIRED', 409);
      }
      if (response.status === 403) throw fail('GOOGLE_ACCESS_DENIED', 403);
      if (response.status === 429) throw fail('GOOGLE_QUOTA_EXCEEDED', 429);
      if (response.status === 404) throw fail('CONTACT_NOT_FOUND', 404);
      throw fail('GOOGLE_UNAVAILABLE', 503);
    }
    return data;
  }
  authorizationUrl({ state, nonce, verifier }) {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.config.clientId, redirect_uri: this.config.redirectUri,
      response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline',
      prompt: 'consent', state, nonce,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256'
    }).toString();
    return url.toString();
  }
  async token(params) {
    const result = await this.json('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId,
        client_secret: this.config.clientSecret, ...params }).toString()
    });
    if (!result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0) {
      throw fail('INVALID_GOOGLE_RESPONSE', 503);
    }
    const granted = new Set((result.scope || '').split(' '));
    if (granted.has('https://www.googleapis.com/auth/userinfo.email')) granted.add('email');
    // Legacy Contacts-only connections must keep supporting SMS after upgrade.
    if (result.scope && !SCOPES.filter(s => s !== GMAIL_SEND_SCOPE).every(s => granted.has(s))) {
      throw fail('GOOGLE_SCOPE_REQUIRED', 403);
    }
    return result;
  }
  async exchange(code, verifier) {
    const tokens = await this.token({ code, code_verifier: verifier,
      redirect_uri: this.config.redirectUri, grant_type: 'authorization_code' });
    if (!String(tokens.scope || '').split(' ').includes(GMAIL_SEND_SCOPE)) {
      throw fail('GOOGLE_GMAIL_CONSENT_REQUIRED', 409);
    }
    return tokens;
  }
  refresh(refreshToken) { return this.token({ refresh_token: refreshToken, grant_type: 'refresh_token' }); }
  async verifyIdToken(token, nonce) {
    try {
      if (typeof token !== 'string' || token.length > 20000) throw new Error();
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error();
      const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
      if (header.alg !== 'RS256' || !header.kid) throw new Error();
      if (!this.keys || this.keysExpire <= this.now() || !this.keys.some(k => k.kid === header.kid)) {
        const result = await this.json('https://www.googleapis.com/oauth2/v3/certs');
        if (!Array.isArray(result.keys)) throw new Error();
        this.keys = result.keys; this.keysExpire = this.now() + 3600000;
      }
      const key = this.keys.find(k => k.kid === header.kid && k.kty === 'RSA');
      if (!key || !crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
        crypto.createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error();
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const now = Math.floor(this.now() / 1000);
      if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) ||
        !aud.includes(this.config.clientId) ||
        (aud.length > 1 && claims.azp !== this.config.clientId) ||
        (claims.azp && claims.azp !== this.config.clientId) ||
        !Number.isFinite(claims.exp) || claims.exp <= now ||
        !Number.isFinite(claims.iat) || claims.iat > now + 60 ||
        !equal(claims.nonce, nonce) || typeof claims.sub !== 'string' || !claims.sub ||
        claims.email_verified !== true || typeof claims.email !== 'string' ||
        claims.email.toLowerCase() !== this.config.ownerEmail) throw new Error();
      return { subject: claims.sub, email: claims.email.toLowerCase() };
    } catch (error) {
      if (error.code === 'GOOGLE_UNAVAILABLE') throw error;
      throw fail('OWNER_ACCOUNT_REQUIRED', 403);
    }
  }
  async revoke(token) {
    try {
      const response = await this.fetcher('https://oauth2.googleapis.com/revoke', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(), signal: AbortSignal.timeout(15000)
      });
      return response.ok;
    } catch { return false; }
  }
  normalize(person) {
    const phones = (person.phoneNumbers || []).map(phone => ({
      value: phone.value || '', label: phone.formattedType || phone.type || '',
      canonicalNumber: /^\+[1-9]\d{6,14}$/.test(phone.canonicalForm || '') ? phone.canonicalForm : null
    }));
    const emails = (person.emailAddresses || []).map(address => ({
      value: address.value || '', label: address.formattedType || address.type || ''
    }));
    return {
      resourceName: contactId(person.resourceName),
      displayName: person.names?.[0]?.displayName || '',
      givenName: person.names?.[0]?.givenName || '',
      photoUrl: contactPhotoUrl(person.photos),
      phoneNumbers: phones, hasPhoneNumbers: phones.length > 0,
      emailAddresses: emails, hasEmailAddresses: emails.length > 0
    };
  }
  async list(accessToken, { pageToken, pageSize = 50, search = '' } = {}) {
    const url = new URL('https://people.googleapis.com/v1/people/me/connections');
    url.searchParams.set('personFields', 'names,phoneNumbers,emailAddresses,photos');
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const result = await this.json(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const contacts = (result.connections || []).map(p => this.normalize(p));
    const q = search.toLocaleLowerCase();
    return {
      contacts: contacts.filter(c => !q || `${c.displayName} ${c.phoneNumbers.map(p => p.value).join(' ')} ${c.emailAddresses.map(e => e.value).join(' ')}`.toLocaleLowerCase().includes(q)),
      nextPageToken: result.nextPageToken || null, searchAppliesTo: 'page'
    };
  }
  async get(accessToken, resourceName) {
    const url = `https://people.googleapis.com/v1/${contactId(resourceName)}?personFields=names,phoneNumbers,emailAddresses,photos`;
    return this.normalize(await this.json(url, { headers: { Authorization: `Bearer ${accessToken}` } }));
  }
  async sendEmail(accessToken, { to, subject, message }) {
    const raw = mimeMessage({ from: this.config.ownerEmail, to, subject, message });
    // No retry here. A timeout or unreadable response can mean Gmail accepted it.
    let response;
    try {
      response = await this.fetcher('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }), signal: AbortSignal.timeout(15000)
      });
    } catch { throw fail('EMAIL_OUTCOME_UNKNOWN', 409); }
    if (!response.ok) {
      if (response.status >= 500) throw fail('EMAIL_OUTCOME_UNKNOWN', 409);
      // A definitive Gmail rejection is safe to distinguish from unknown acceptance.
      throw fail('EMAIL_REJECTED', 409);
    }
    try {
      const data = await response.json();
      if (typeof data.id !== 'string' || !data.id) throw new Error();
      return { messageId: data.id };
    } catch { throw fail('EMAIL_OUTCOME_UNKNOWN', 409); }
  }
}
module.exports = { HolidayGoogle };
