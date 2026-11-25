'use strict';
const { randomUUID } = require('node:crypto');
const { fail, hash, random, seal, unseal, GMAIL_SEND_SCOPE } = require('./security');

class HolidayStore {
  constructor(pool, config) { this.pool = pool; this.config = config; }
  async transaction(run) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT'); return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  async createSession(ownerSub = null, client = this.pool) {
    const token = random();
    await client.query(`INSERT INTO hg_sessions(token_hash,owner_sub,expires_at)
      VALUES($1,$2,now()+$3::interval)`, [hash(token), ownerSub, ownerSub ? '14 days' : '15 minutes']);
    return token;
  }
  async session(token, client = this.pool) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const result = await client.query(`SELECT owner_sub,expires_at FROM hg_sessions
      WHERE token_hash=$1 AND expires_at>now()`, [hash(token)]);
    return result.rows[0] || null;
  }
  async logout(token) { await this.pool.query('DELETE FROM hg_sessions WHERE token_hash=$1', [hash(token)]); }
  async start(token) {
    const state = random(), nonce = random(), verifier = random();
    await this.transaction(async client => {
      await client.query('DELETE FROM hg_oauth_states WHERE session_hash=$1 OR expires_at<=now()', [hash(token)]);
      await client.query(`INSERT INTO hg_oauth_states(state_hash,session_hash,proof_ciphertext,expires_at)
        VALUES($1,$2,$3,now()+interval '10 minutes')`,
      [hash(state), hash(token), seal({ nonce, verifier }, this.config, `state:${hash(state)}`)]);
    });
    return { state, nonce, verifier };
  }
  async consumeState(state, token) {
    if (typeof state !== 'string' || state.length > 100 || !token) throw fail('INVALID_OAUTH_STATE', 403);
    const result = await this.pool.query(`DELETE FROM hg_oauth_states
      WHERE state_hash=$1 AND session_hash=$2 AND expires_at>now()
      RETURNING proof_ciphertext`, [hash(state), hash(token)]);
    if (!result.rows.length) throw fail('INVALID_OAUTH_STATE', 403);
    return unseal(result.rows[0].proof_ciphertext, this.config, `state:${hash(state)}`);
  }
  async connectOwner(identity, tokens, oldToken) {
    return this.transaction(async client => {
      // One permitted owner: pin Google's stable subject on first verified consent.
      const existing = await client.query('SELECT subject,token_ciphertext FROM hg_owner WHERE singleton=true FOR UPDATE');
      const row = existing.rows[0];
      if (row && row.subject !== identity.subject) throw fail('OWNER_ACCOUNT_REQUIRED', 403);
      const previous = row?.token_ciphertext ? unseal(row.token_ciphertext, this.config, `google:${identity.subject}`) : {};
      const stored = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || previous.refreshToken,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        scopes: typeof tokens.scope === 'string' ? tokens.scope.split(' ') : []
      };
      if (!stored.refreshToken) throw fail('GOOGLE_OFFLINE_CONSENT_REQUIRED', 409);
      const updated = await client.query(`INSERT INTO hg_owner(singleton,subject,email,token_ciphertext,connected)
        VALUES(true,$1,$2,$3,true)
        ON CONFLICT(singleton) DO UPDATE SET email=excluded.email,
          token_ciphertext=excluded.token_ciphertext, connected=true,updated_at=now()
        WHERE hg_owner.subject=excluded.subject RETURNING subject`,
      [identity.subject, identity.email, seal(stored, this.config, `google:${identity.subject}`)]);
      if (!updated.rows.length) throw fail('OWNER_ACCOUNT_REQUIRED', 403);
      const newToken = await this.createSession(identity.subject, client);
      // Prevent a logged-out/revoked browser session completing an outstanding exchange.
      const revoked = await client.query(`DELETE FROM hg_sessions
        WHERE token_hash=$1 AND expires_at>now() RETURNING token_hash`, [hash(oldToken)]);
      if (!revoked.rowCount) throw fail('OWNER_SESSION_REQUIRED', 401);
      return newToken;
    });
  }
  async owner(subject, client = this.pool) {
    const result = await client.query('SELECT subject,email,connected FROM hg_owner WHERE subject=$1', [subject]);
    if (!result.rows.length) throw fail('OWNER_SESSION_REQUIRED', 401);
    if (result.rows[0].email !== this.config.ownerEmail) throw fail('OWNER_ACCOUNT_REQUIRED', 403);
    return result.rows[0];
  }
  async emailAuthorized(subject) {
    const result = await this.pool.query('SELECT token_ciphertext,connected FROM hg_owner WHERE subject=$1', [subject]);
    const row = result.rows[0];
    return Boolean(row?.connected && row.token_ciphertext &&
      unseal(row.token_ciphertext, this.config, `google:${subject}`).scopes?.includes(GMAIL_SEND_SCOPE));
  }
  async accessToken(subject, google, { requireEmail = false } = {}) {
    const outcome = await this.transaction(async client => {
      const result = await client.query('SELECT token_ciphertext,connected FROM hg_owner WHERE subject=$1 FOR UPDATE', [subject]);
      const row = result.rows[0];
      if (!row?.connected || !row.token_ciphertext) return { reconnect: true };
      const tokens = unseal(row.token_ciphertext, this.config, `google:${subject}`);
      if (requireEmail && !tokens.scopes?.includes(GMAIL_SEND_SCOPE)) return { emailConsent: true };
      if (tokens.expiresAt > Date.now() + 60000) return { accessToken: tokens.accessToken };
      try {
        const refreshed = await google.refresh(tokens.refreshToken);
        const next = { accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token || tokens.refreshToken,
          expiresAt: Date.now() + refreshed.expires_in * 1000,
          scopes: typeof refreshed.scope === 'string' ? refreshed.scope.split(' ') : (tokens.scopes || []) };
        if (requireEmail && !next.scopes.includes(GMAIL_SEND_SCOPE)) return { emailConsent: true };
        await client.query('UPDATE hg_owner SET token_ciphertext=$2,updated_at=now() WHERE subject=$1',
          [subject, seal(next, this.config, `google:${subject}`)]);
        return { accessToken: next.accessToken };
      } catch (error) {
        if (error.code !== 'GOOGLE_RECONNECT_REQUIRED') throw error;
        await client.query('UPDATE hg_owner SET connected=false,token_ciphertext=NULL,updated_at=now() WHERE subject=$1', [subject]);
        return { reconnect: true };
      }
    });
    if (outcome.reconnect) throw fail('GOOGLE_RECONNECT_REQUIRED', 409);
    if (outcome.emailConsent) throw fail('GOOGLE_GMAIL_CONSENT_REQUIRED', 409);
    return outcome.accessToken;
  }
  async disconnect(subject, google) {
    const result = await this.pool.query(`UPDATE hg_owner SET connected=false,updated_at=now()
      WHERE subject=$1 RETURNING token_ciphertext`, [subject]);
    const stored = result.rows[0]?.token_ciphertext;
    if (!stored) return { disconnected: true, providerRevoked: true };
    // The stored token is retained encrypted until confirmed remote revocation;
    // connected=false blocks all API reads even if revocation is temporarily unavailable.
    const tokens = unseal(stored, this.config, `google:${subject}`);
    const providerRevoked = await google.revoke(tokens.refreshToken || tokens.accessToken);
    if (providerRevoked) {
      await this.pool.query(`UPDATE hg_owner SET token_ciphertext=NULL
        WHERE subject=$1 AND connected=false AND token_ciphertext=$2`, [subject, stored]);
    }
    return { disconnected: true, providerRevoked };
  }
  async preferences(subject, client = this.pool) {
    const result = await client.query(`SELECT contact_resource,version,data FROM hg_preferences
      WHERE owner_sub=$1 ORDER BY contact_resource`, [subject]);
    return result.rows.map(row => ({ resourceName: row.contact_resource, version: row.version, ...row.data }));
  }
  async savePreference(subject, resource, expectedVersion, data) {
    return this.transaction(async client => {
      const result = await client.query(`INSERT INTO hg_preferences(owner_sub,contact_resource,version,data)
        VALUES($1,$2,1,$3) ON CONFLICT(owner_sub,contact_resource)
        DO UPDATE SET data=excluded.data,version=hg_preferences.version+1,updated_at=now()
        WHERE hg_preferences.version=$4 RETURNING version,data`,
      [subject, resource, data, expectedVersion]);
      // A create expects version zero; do not let stale updates recreate missing records.
      if (!result.rows.length || (expectedVersion !== 0 && result.rows[0].version === 1) ||
          (expectedVersion === 0 && result.rows[0].version !== 1)) throw fail('VERSION_CONFLICT', 409);
      return { resourceName: resource, version: result.rows[0].version, ...result.rows[0].data };
    });
  }
  async createBatch(subject, data, drafts) {
    const id = randomUUID();
    await this.transaction(async client => {
      await client.query('INSERT INTO hg_batches(id,owner_sub,data) VALUES($1,$2,$3)', [id, subject, data]);
      for (let i = 0; i < drafts.length; i++) {
        await client.query('INSERT INTO hg_drafts(id,batch_id,position,data) VALUES($1,$2,$3,$4)',
          [randomUUID(), id, i, drafts[i]]);
      }
    });
    return this.batch(subject, id);
  }
  async batch(subject, id, client = this.pool, lock = false) {
    const result = await client.query(`SELECT id,version,data,updated_at FROM hg_batches
      WHERE owner_sub=$1 AND id=$2${lock ? ' FOR UPDATE' : ''}`, [subject, id]);
    if (!result.rows.length) throw fail('BATCH_NOT_FOUND', 404);
    const drafts = await client.query('SELECT id,position,data FROM hg_drafts WHERE batch_id=$1 ORDER BY position', [id]);
    const row = result.rows[0];
    return { id: row.id, version: row.version, ...row.data, updatedAt: row.updated_at,
      drafts: drafts.rows.map(d => ({ id: d.id, position: d.position, ...d.data })) };
  }
  async currentBatch(subject) {
    const result = await this.pool.query('SELECT id FROM hg_batches WHERE owner_sub=$1 ORDER BY updated_at DESC,id DESC LIMIT 1', [subject]);
    return result.rows.length ? this.batch(subject, result.rows[0].id) : null;
  }
  async changeBatch(subject, id, version, mutate) {
    return this.transaction(async client => {
      const batch = await this.batch(subject, id, client, true);
      if (batch.version !== version) throw fail('VERSION_CONFLICT', 409);
      const result = await mutate(batch);
      const { drafts, id: ignoredId, version: ignoredVersion, updatedAt, ...data } = batch;
      await client.query('UPDATE hg_batches SET data=$3,version=version+1,updated_at=now() WHERE owner_sub=$1 AND id=$2',
        [subject, id, data]);
      for (const draft of drafts) {
        const { id: draftId, position, ...draftData } = draft;
        await client.query('UPDATE hg_drafts SET data=$3 WHERE batch_id=$1 AND id=$2', [id, draftId, draftData]);
      }
      return { ...(await this.batch(subject, id, client)), ...(result || {}) };
    });
  }
  async deleteBatch(subject, id, version) {
    return this.transaction(async client => {
      const batch = await this.batch(subject, id, client, true);
      if (batch.version !== version) throw fail('VERSION_CONFLICT', 409);
      const attempts = await client.query(
        'SELECT 1 FROM hg_email_attempts WHERE owner_sub=$1 AND batch_id=$2 LIMIT 1', [subject, id]);
      if (attempts.rows.length) throw fail('EMAIL_ATTEMPT_HISTORY_EXISTS', 409);
      await client.query('DELETE FROM hg_batches WHERE owner_sub=$1 AND id=$2 AND version=$3', [subject, id, version]);
    });
  }
  async emailAttempt(subject, id, client = this.pool) {
    const result = await client.query(
      'SELECT id,batch_id,draft_id,state,gmail_message_id FROM hg_email_attempts WHERE owner_sub=$1 AND id=$2',
      [subject, id]);
    return result.rows[0] || null;
  }
  async beginEmailSend(subject, batchId, draftId, expectedVersion, attemptId, validate) {
    return this.transaction(async client => {
      const batch = await this.batch(subject, batchId, client, true);
      const previous = await this.emailAttempt(subject, attemptId, client);
      if (previous) {
        if (previous.batch_id !== batchId || previous.draft_id !== draftId) throw fail('SEND_ATTEMPT_CONFLICT', 409);
        return { replay: true, attempt: previous };
      }
      if (batch.version !== expectedVersion) throw fail('VERSION_CONFLICT', 409);
      const draft = batch.drafts.find(d => d.id === draftId);
      if (!draft) throw fail('DRAFT_NOT_FOUND', 404);
      if (draft.method !== 'email') throw fail('EMAIL_DRAFT_REQUIRED');
      if (draft.state !== 'draft') throw fail('DRAFT_NOT_SENDABLE', 409);
      const blocked = await client.query(
        "SELECT 1 FROM hg_email_attempts WHERE draft_id=$1 AND state <> 'rejected' LIMIT 1", [draftId]);
      if (blocked.rows.length) throw fail('EMAIL_SEND_ALREADY_ATTEMPTED', 409);
      await validate(draft, client);
      try {
        await client.query(
          "INSERT INTO hg_email_attempts(id,owner_sub,batch_id,draft_id,state) VALUES($1,$2,$3,$4,'sending')",
          [attemptId, subject, batchId, draftId]);
      } catch (error) {
        if (error.code === '23505') throw fail('SEND_ATTEMPT_CONFLICT', 409);
        throw error;
      }
      const { id, position, ...data } = draft;
      data.state = 'email_sending'; data.emailAttemptId = attemptId;
      await client.query('UPDATE hg_drafts SET data=$3 WHERE batch_id=$1 AND id=$2', [batchId, draftId, data]);
      await client.query('UPDATE hg_batches SET version=version+1,updated_at=now() WHERE owner_sub=$1 AND id=$2', [subject, batchId]);
      return { replay: false, draft, attempt: { id: attemptId, state: 'sending' } };
    });
  }
  async finishEmailSend(subject, batchId, draftId, attemptId, state, messageId = null) {
    return this.transaction(async client => {
      const batch = await this.batch(subject, batchId, client, true);
      const attempt = await this.emailAttempt(subject, attemptId, client);
      if (!attempt || attempt.batch_id !== batchId || attempt.draft_id !== draftId || attempt.state !== 'sending') {
        throw fail('SEND_ATTEMPT_CONFLICT', 409);
      }
      await client.query(
        "UPDATE hg_email_attempts SET state=$3,gmail_message_id=$4,updated_at=now() WHERE owner_sub=$1 AND id=$2 AND state='sending'",
        [subject, attemptId, state, messageId]);
      const draft = batch.drafts.find(d => d.id === draftId);
      const { id, position, ...data } = draft;
      data.state = { accepted: 'email_accepted', rejected: 'email_rejected', unknown: 'email_outcome_unknown' }[state];
      await client.query('UPDATE hg_drafts SET data=$3 WHERE batch_id=$1 AND id=$2', [batchId, draftId, data]);
      await client.query('UPDATE hg_batches SET version=version+1,updated_at=now() WHERE owner_sub=$1 AND id=$2', [subject, batchId]);
      return this.emailAttempt(subject, attemptId, client);
    });
  }
}
module.exports = { HolidayStore };
