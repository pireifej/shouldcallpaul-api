'use strict';

const { ReplitConnectors } = require('@replit/connectors-sdk');
const { createHmac } = require('node:crypto');

const PRO_REQUIRED_RESPONSE = Object.freeze({
  error: 'PRO_REQUIRED',
  message: 'An active Pray Over Us Pro subscription is required.'
});

function extractSubscriptionIdentity(req, { includeClientIdentity = false } = {}) {
  // Content/posting authorization never depends on a client-selected ID.
  // Only the explicit status handshake accepts one as a consistency check.
  if (!includeClientIdentity) return { userId: req.userId };
  const input = req.body || req.query || {};
  return {
    userId: req.userId,
    revenuecatAppUserId:
      input.revenuecatAppUserId ??
      input.revenuecat_app_user_id ??
      req.get?.('x-revenuecat-app-user-id')
  };
}

class RevenueCatProService {
  constructor({
    pool,
    connectorsFactory = () => new ReplitConnectors(),
    projectId = process.env.REVENUECAT_PROJECT_ID,
    entitlementId = process.env.REVENUECAT_PRO_ENTITLEMENT_ID,
    entitlementKey = process.env.REVENUECAT_PRO_ENTITLEMENT_KEY || 'Pray Over Us Pro',
    identitySecret = () => process.env.SESSION_SECRET,
    activeTtlMs = 5 * 60 * 1000,
    inactiveTtlMs = 60 * 1000,
    maxCacheEntries = 1000,
    maxConcurrentLookups = 20,
    maxQueuedLookups = 100,
    now = () => Date.now()
  }) {
    this.pool = pool;
    this.connectorsFactory = connectorsFactory;
    this.projectId = projectId;
    this.entitlementId = entitlementId;
    this.entitlementKey = entitlementKey;
    this.identitySecret = identitySecret;
    this.activeTtlMs = activeTtlMs;
    this.inactiveTtlMs = inactiveTtlMs;
    this.maxCacheEntries = maxCacheEntries;
    this.maxConcurrentLookups = maxConcurrentLookups;
    this.maxQueuedLookups = maxQueuedLookups;
    this.now = now;
    this.cache = new Map();
    this.inFlight = new Map();
    this.activeLookups = 0;
    this.lookupWaiters = [];
  }

  async getAccountIdentity({ userId }) {
    const numericUserId = Number(userId);
    if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) {
      const error = new Error('userId must be a positive integer');
      error.statusCode = 400;
      throw error;
    }

    const userResult = await this.pool.query(
      `SELECT revenuecat_app_user_id
       FROM public."user"
       WHERE user_id = $1`,
      [numericUserId]
    );
    if (!userResult.rows.length) {
      const error = new Error('User not found');
      error.statusCode = 404;
      throw error;
    }

    const secret = typeof this.identitySecret === 'function' ? this.identitySecret() : this.identitySecret;
    if (!secret) {
      const error = new Error('Account subscription identity is not configured');
      error.statusCode = 503;
      throw error;
    }
    // Domain-separated, opaque identity derived only from the verified account.
    // Never derive this from an email, a client identifier, or editable attributes.
    const appUserId = 'pou_v1_' + createHmac('sha256', secret)
      .update(`pray-over-us:revenuecat:account:${numericUserId}`).digest('base64url');
    return {
      userId: numericUserId,
      revenuecatAppUserId: appUserId,
      storedAppUserId: this.normalizeAppUserId(userResult.rows[0].revenuecat_app_user_id)
    };
  }

  async getProStatus({ userId, revenuecatAppUserId, refresh = false }) {
    const suppliedAppUserId = this.normalizeAppUserId(revenuecatAppUserId);
    const identity = await this.getAccountIdentity({ userId });
    const { userId: numericUserId, revenuecatAppUserId: appUserId, storedAppUserId } = identity;
    if (suppliedAppUserId && suppliedAppUserId !== appUserId && suppliedAppUserId !== storedAppUserId) {
      const error = new Error('RevenueCat identity does not belong to the signed-in account');
      error.statusCode = storedAppUserId ? 409 : 403;
      error.code = 'SUBSCRIPTION_IDENTITY_MISMATCH';
      throw error;
    }

    // An old anonymous mapping is not ownership proof. Require RevenueCat's
    // authenticated alias response to bind it to this server-derived account.
    // Keep the old mapping intact, even on failure; never silently replace it.
    if (storedAppUserId && storedAppUserId !== appUserId &&
        !await this.hasLegacyAccountBinding(appUserId, storedAppUserId)) {
      return {
        isPro: false, entitlement: this.entitlementKey,
        revenuecatAppUserId: appUserId, identityVerificationRequired: true,
        source: 'account_binding_required'
      };
    }

    const cached = this.cache.get(appUserId);
    if (!refresh && cached && cached.expiresAt > this.now()) {
      if (cached.isPro && !storedAppUserId) {
        await this.linkConfirmedIdentity(numericUserId, appUserId);
      }
      return {
        isPro: cached.isPro,
        entitlement: this.entitlementKey,
        revenuecatAppUserId: appUserId,
        source: 'cache'
      };
    }

    const isPro = await this.getFreshEntitlementStatus(appUserId);

    // First links require BOTH the session-derived account binding and an
    // authenticated RevenueCat entitlement for that exact account customer.
    if (isPro && !storedAppUserId) {
      await this.linkConfirmedIdentity(numericUserId, appUserId);
    }

    return {
      isPro,
      entitlement: this.entitlementKey,
      revenuecatAppUserId: appUserId,
      source: 'revenuecat'
    };
  }

  async hasLegacyAccountBinding(appUserId, storedAppUserId) {
    if (!this.projectId) throw Object.assign(new Error('RevenueCat project configuration is missing'), {statusCode:503});
    return this.withLookupSlot(async () => {
      const connectors = this.connectorsFactory();
      let cursor = '';
      for (let page = 0; page < 5; page++) {
        const suffix = cursor ? `&starting_after=${encodeURIComponent(cursor)}` : '';
        const response = await connectors.proxy('revenuecat',
          `/v2/projects/${encodeURIComponent(this.projectId)}/customers/${encodeURIComponent(appUserId)}/aliases?limit=100${suffix}`,
          {method:'GET'});
        if (response.status === 404) return false;
        if (!response.ok) throw Object.assign(new Error('RevenueCat account binding verification is unavailable'), {statusCode:503});
        const data = await response.json();
        if (!Array.isArray(data.items)) throw Object.assign(new Error('Invalid RevenueCat account binding response'), {statusCode:503});
        if (data.items.some(alias => alias.id === storedAppUserId)) return true;
        if (!data.next_page) return false;
        cursor = data.items.at(-1)?.id;
        if (!cursor) break;
      }
      throw Object.assign(new Error('RevenueCat account binding could not be fully verified'), {statusCode:503});
    });
  }

  async getFreshEntitlementStatus(appUserId) {
    if (this.inFlight.has(appUserId)) return this.inFlight.get(appUserId);

    const lookup = this.withLookupSlot(() => this.fetchActiveEntitlement(appUserId))
      .then((isPro) => {
        this.setCacheEntry(appUserId, isPro);
        return isPro;
      })
      .finally(() => this.inFlight.delete(appUserId));
    this.inFlight.set(appUserId, lookup);
    return lookup;
  }

  async withLookupSlot(callback) {
    await this.acquireLookupSlot();
    try {
      return await callback();
    } catch (error) {
      if (error.statusCode) throw error;
      // Do not return connector internals or mistake transport/schema errors
      // for an inactive subscriber (or for a daily quota rejection).
      throw Object.assign(new Error('RevenueCat verification is temporarily unavailable'), {statusCode:503});
    } finally {
      this.releaseLookupSlot();
    }
  }

  async acquireLookupSlot() {
    if (this.activeLookups < this.maxConcurrentLookups) {
      this.activeLookups++;
      return;
    }
    if (this.lookupWaiters.length >= this.maxQueuedLookups) {
      const error = new Error('RevenueCat entitlement verification is busy; please retry');
      error.statusCode = 503;
      throw error;
    }
    await new Promise(resolve => this.lookupWaiters.push(resolve));
  }

  releaseLookupSlot() {
    const next = this.lookupWaiters.shift();
    if (next) {
      next();
    } else {
      this.activeLookups--;
    }
  }

  setCacheEntry(appUserId, isPro) {
    const currentTime = this.now();
    for (const [key, value] of this.cache) {
      if (value.expiresAt <= currentTime) this.cache.delete(key);
    }
    if (!this.cache.has(appUserId) && this.cache.size >= this.maxCacheEntries) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(appUserId, {
      isPro,
      expiresAt: currentTime + (isPro ? this.activeTtlMs : this.inactiveTtlMs)
    });
  }

  async linkConfirmedIdentity(userId, appUserId) {
    try {
      const result = await this.pool.query(
        `UPDATE public."user"
         SET revenuecat_app_user_id = $1
         WHERE user_id = $2
           AND revenuecat_app_user_id IS NULL`,
        [appUserId, userId]
      );
      if (result.rowCount === 0) {
        const current = await this.pool.query(
          `SELECT revenuecat_app_user_id
           FROM public."user"
           WHERE user_id = $1`,
          [userId]
        );
        if (current.rows[0]?.revenuecat_app_user_id !== appUserId) {
          const conflict = new Error('This user is already linked to a different RevenueCat identity');
          conflict.statusCode = 409;
          throw conflict;
        }
      }
    } catch (error) {
      if (error.code === '23505') {
        const conflict = new Error('This RevenueCat identity is already linked to another user');
        conflict.statusCode = 409;
        throw conflict;
      }
      throw error;
    }
  }

  normalizeAppUserId(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 255) {
      const error = new Error('revenuecatAppUserId must be a string of 255 characters or fewer');
      error.statusCode = 400;
      throw error;
    }
    return value.trim() || null;
  }

  async fetchActiveEntitlement(appUserId) {
    if (!this.projectId || !this.entitlementId) {
      throw new Error('RevenueCat Pro entitlement configuration is missing');
    }

    const connectors = this.connectorsFactory();
    const response = await connectors.proxy(
      'revenuecat',
      `/v2/projects/${encodeURIComponent(this.projectId)}/customers/${encodeURIComponent(appUserId)}/active_entitlements`,
      { method: 'GET' }
    );

    if (response.status === 404) return false;
    if (!response.ok) {
      const error = new Error(`RevenueCat entitlement lookup failed with HTTP ${response.status}`);
      error.statusCode = 503;
      throw error;
    }

    const data = await response.json();
    if (!Array.isArray(data.items)) {
      throw Object.assign(new Error('Invalid RevenueCat entitlement response'), {statusCode:503});
    }
    return data.items.some((item) =>
      item.entitlement_id === this.entitlementId ||
      item.id === this.entitlementId ||
      item.lookup_key === this.entitlementKey
    );
  }
}

function createRequirePro(proService) {
  return async function requirePro(req, res, next) {
    res.set('Cache-Control', 'private, no-store');
    try {
      const status = await proService.getProStatus(extractSubscriptionIdentity(req));
      if (!status.isPro) return res.status(403).json(PRO_REQUIRED_RESPONSE);
      req.proStatus = status;
      next();
    } catch (error) {
      const statusCode = error.statusCode || 503;
      res.status(statusCode).json({
        error: statusCode === 503 ? 'PRO_STATUS_UNAVAILABLE' : 'INVALID_SUBSCRIPTION_IDENTITY',
        message: error.message
      });
    }
  };
}

module.exports = {
  PRO_REQUIRED_RESPONSE,
  extractSubscriptionIdentity,
  RevenueCatProService,
  createRequirePro
};
