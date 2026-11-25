'use strict';
const { createHmac } = require('node:crypto');
const { RevenueCatProService } = require('../../revenueCatProService');
const { SubscriptionIdentityReconciliation } = require('../../subscriptionIdentityReconciliation');

const userId = 42, projectId = 'synthetic-project';
const secret = 'synthetic-reconciliation-signing-secret';
const fromId = 'synthetic-legacy-customer';
const originalId = '$RCAnonymousID:synthetic-original';
const targetId = 'pou_v1_' + createHmac('sha256', secret)
  .update(`pray-over-us:revenuecat:account:${userId}`).digest('base64url');
const authorizationId = '12345678-1234-4234-8234-123456789abc';
const list = items => ({ items, next_page: null });
function fixture({ pool, approved = true } = {}) {
  const f = { reads: [], writes: [], mapping: fromId, otherOwner: false,
    clock: { value: Date.now() }, status: 200, intercept: null };
  f.approval = approved ? {
    id: authorizationId, user_id: userId, project_id: projectId,
    from_customer_id: fromId, to_customer_id: targetId, original_customer_id: originalId,
    approved_at: new Date(f.clock.value - 3600000), approved_by: 'synthetic-operator',
    expires_at: new Date(f.clock.value + 3600000), completed_at: null,
    evidence_reference: 'synthetic-review-reference'
  } : null;
  f.source = {
    exists: true, customer: { id: fromId, project_id: projectId },
    aliases: list([{ id: fromId }, { id: originalId }]), active_entitlements: list([]),
    subscriptions: list([{ id: 'synthetic-subscription', environment: 'sandbox', store: 'play_store',
      status: 'expired', gives_access: false, ends_at: f.clock.value - 60000,
      current_period_ends_at: f.clock.value - 60000 }]), purchases: list([])
  };
  f.target = {
    exists: false, customer: { id: targetId, project_id: projectId },
    aliases: list([{ id: targetId }]), active_entitlements: list([]),
    subscriptions: list([]), purchases: list([])
  };
  const memoryPool = {
    async query(sql, args = []) {
      if (/SELECT revenuecat_app_user_id/.test(sql)) {
        return { rows: [{ revenuecat_app_user_id: args[0] === userId ? f.mapping : null }] };
      }
      if (/SELECT user_id FROM/.test(sql)) return { rows: f.otherOwner ? [{ user_id: 99 }] : [] };
      if (/SELECT \* FROM public.subscription_identity_reconciliations/.test(sql)) {
        const a = f.approval;
        const matches = sql.includes('WHERE id =')
          ? a?.id === args[0] && a?.user_id === args[1] && a?.project_id === args[2]
          : a?.user_id === args[0] && a?.project_id === args[1] && !a?.completed_at;
        return { rows: matches ? [structuredClone(a)] : [] };
      }
      f.writes.push({ sql, args });
      if (/UPDATE public."user"/.test(sql)) {
        if (f.mapping !== args[2]) return { rows: [], rowCount: 0 };
        f.mapping = args[0]; return { rows: [{ user_id: userId }], rowCount: 1 };
      }
      if (/UPDATE public.subscription_identity/.test(sql)) {
        f.approval.completed_at = new Date(f.clock.value);
        return { rows: [{ id: authorizationId }], rowCount: 1 };
      }
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      throw new Error('Unexpected synthetic database query');
    },
    async connect() { return { query: this.query.bind(this), release() {} }; }
  };
  f.pool = pool || memoryPool;
  f.pro = new RevenueCatProService({
    pool: f.pool, projectId, entitlementId: 'synthetic-pro', identitySecret: secret,
    now: () => f.clock.value,
    connectorsFactory: () => ({
      async proxy(name, path, options) {
        if (name !== 'revenuecat' || options.method !== 'GET') throw new Error('Provider writes forbidden');
        f.reads.push({ path, method: options.method });
        const url = new URL(path, 'https://api.revenuecat.com');
        const segments = url.pathname.split('/');
        const index = segments.indexOf('customers'), id = decodeURIComponent(segments[index + 1]);
        const resource = segments[index + 2] || 'customer';
        const customer = id === fromId ? f.source : id === targetId ? f.target : null;
        let response = !customer?.exists ? { status: 404 } : { status: f.status, body: customer[resource] };
        if (f.intercept) response = await f.intercept({ url, id, resource, response }) || response;
        return { status: response.status, ok: response.status === 200,
          json: async () => structuredClone(response.body) };
      }
    })
  });
  f.service = new SubscriptionIdentityReconciliation(f.pro);
  f.identity = () => f.pro.getAccountIdentity({ userId });
  f.offer = async () => f.service.offer(await f.identity());
  f.complete = () => f.service.complete({ userId, authorizationId });
  return f;
}
module.exports = { fixture, userId, projectId, fromId, originalId, targetId, authorizationId, list };
