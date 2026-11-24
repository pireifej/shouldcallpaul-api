'use strict';
const crypto = require('node:crypto');
const { fail, SCOPES, equal, contactId } = require('./security');

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
    if (result.scope && !SCOPES.every(s => granted.has(s))) {
      throw fail('GOOGLE_SCOPE_REQUIRED', 403);
    }
    return result;
  }
  exchange(code, verifier) {
    return this.token({ code, code_verifier: verifier,
      redirect_uri: this.config.redirectUri, grant_type: 'authorization_code' });
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
    return {
      resourceName: contactId(person.resourceName),
      displayName: person.names?.[0]?.displayName || '',
      givenName: person.names?.[0]?.givenName || '',
      phoneNumbers: phones, hasPhoneNumbers: phones.length > 0
    };
  }
  async list(accessToken, { pageToken, pageSize = 50, search = '' } = {}) {
    const url = new URL('https://people.googleapis.com/v1/people/me/connections');
    url.searchParams.set('personFields', 'names,phoneNumbers');
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const result = await this.json(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const contacts = (result.connections || []).map(p => this.normalize(p));
    const q = search.toLocaleLowerCase();
    return {
      contacts: contacts.filter(c => !q || `${c.displayName} ${c.phoneNumbers.map(p => p.value).join(' ')}`.toLocaleLowerCase().includes(q)),
      nextPageToken: result.nextPageToken || null, searchAppliesTo: 'page'
    };
  }
  async get(accessToken, resourceName) {
    const url = `https://people.googleapis.com/v1/${contactId(resourceName)}?personFields=names,phoneNumbers`;
    return this.normalize(await this.json(url, { headers: { Authorization: `Bearer ${accessToken}` } }));
  }
}
module.exports = { HolidayGoogle };
