'use strict';

function reconciliationError(code, statusCode) {
  return Object.assign(new Error({
    SUBSCRIPTION_RECONCILIATION_REVIEW_REQUIRED: 'Subscription identity evidence changed; operator review is required.',
    SUBSCRIPTION_RECONCILIATION_PROVIDER_UNAVAILABLE: 'Subscription identity evidence could not be verified; retry later.',
    SUBSCRIPTION_RECONCILIATION_TARGET_NOT_READY: 'The approved destination customer is not ready; keep purchases blocked.'
  }[code]), { code, statusCode });
}
const unavailable = () => reconciliationError('SUBSCRIPTION_RECONCILIATION_PROVIDER_UNAVAILABLE', 503);
const review = () => reconciliationError('SUBSCRIPTION_RECONCILIATION_REVIEW_REQUIRED', 409);

// Strictly read-only. Never call SDK login, alias, restore, transfer, or customer creation here.
class ReconciliationProvider {
  constructor(proService) {
    this.pro = proService;
    this.root = `/v2/projects/${encodeURIComponent(proService.projectId)}/customers/`;
    this.connector = proService.connectorsFactory();
  }

  async get(path, { missingAllowed = false } = {}) {
    let response, data;
    try {
      response = await this.connector.proxy('revenuecat', path, { method: 'GET' });
      if (response.status === 404) {
        if (missingAllowed) return null;
        throw review();
      }
      if (!response.ok) throw unavailable();
      data = await response.json();
    } catch (error) {
      if (error.code?.startsWith('SUBSCRIPTION_RECONCILIATION_')) throw error;
      throw unavailable();
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw unavailable();
    return data;
  }

  async list(base, resource) {
    const pathname = `${base}/${resource}`;
    let path = `${pathname}?limit=100`;
    const seen = new Set(), items = [];
    for (let page = 0; page < 10; page++) {
      if (seen.has(path)) throw unavailable();
      seen.add(path);
      const data = await this.get(path);
      if (!Array.isArray(data.items) || !Object.hasOwn(data, 'next_page')) throw unavailable();
      if (data.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw unavailable();
      items.push(...data.items);
      if (items.length > 1000) throw unavailable();
      if (data.next_page === null) return items;
      if (typeof data.next_page !== 'string' || !data.next_page) throw unavailable();
      let next;
      try { next = new URL(data.next_page, 'https://api.revenuecat.com'); }
      catch { throw unavailable(); }
      if (next.origin !== 'https://api.revenuecat.com' || next.username || next.password ||
          next.pathname !== pathname || next.hash ||
          [...next.searchParams.keys()].some(key => !['limit', 'starting_after'].includes(key)) ||
          !next.searchParams.get('starting_after') ||
          next.searchParams.getAll('starting_after').length !== 1 ||
          next.searchParams.getAll('limit').length > 1 ||
          (next.searchParams.has('limit') && !/^(?:[1-9][0-9]?|100)$/.test(next.searchParams.get('limit')))) {
        throw unavailable();
      }
      // Provider pagination cannot change customer, project, environment, or host.
      path = `${next.pathname}${next.search}`;
    }
    throw unavailable();
  }

  async customer(id, missingAllowed = false) {
    const base = `${this.root}${encodeURIComponent(id)}`;
    const customer = await this.get(base, { missingAllowed });
    if (!customer) return null;
    if (customer.id !== id || customer.project_id !== this.pro.projectId) throw review();
    return base;
  }

  async aliases(base, expected) {
    const aliases = await this.list(base, 'aliases');
    const ids = aliases.map(item => item.id);
    if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw unavailable();
    if (ids.length !== expected.length || expected.some(id => !ids.includes(id))) throw review();
  }

  async source(approval) {
    const base = await this.customer(approval.from_customer_id);
    await this.aliases(base, [approval.from_customer_id, approval.original_customer_id]);
    if ((await this.list(base, 'active_entitlements')).length) throw review();
    const subscriptions = await this.list(base, 'subscriptions');
    // This procedure is deliberately narrower than "no active Pro":
    // only expired Google Play sandbox subscriptions and NO one-time purchases.
    if (!subscriptions.length || subscriptions.some(sub =>
      sub.environment !== 'sandbox' || sub.store !== 'play_store' ||
      sub.status !== 'expired' || sub.gives_access !== false ||
      !Number.isFinite(sub.ends_at) || sub.ends_at <= 0 || sub.ends_at > this.pro.now() ||
      !Number.isFinite(sub.current_period_ends_at) ||
      sub.current_period_ends_at <= 0 || sub.current_period_ends_at > this.pro.now()
    )) throw review();
    if ((await this.list(base, 'purchases')).length) throw review();
  }

  async destination(id, missingAllowed = false) {
    const base = await this.customer(id, true);
    if (!base) {
      if (missingAllowed) return;
      throw reconciliationError('SUBSCRIPTION_RECONCILIATION_TARGET_NOT_READY', 409);
    }
    await this.aliases(base, [id]);
    for (const resource of ['active_entitlements', 'subscriptions', 'purchases']) {
      if ((await this.list(base, resource)).length) throw review();
    }
  }
}

module.exports = { ReconciliationProvider, reconciliationError };
