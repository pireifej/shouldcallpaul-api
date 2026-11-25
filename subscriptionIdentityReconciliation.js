'use strict';

const { ReconciliationProvider } = require('./subscriptionReconciliationProvider');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function failure(code, statusCode, message) {
  return Object.assign(new Error(message), { code, statusCode });
}
const conflict = () => failure('SUBSCRIPTION_RECONCILIATION_CONFLICT', 409,
  'The approved identity no longer matches this account; operator review is required.');
const expired = () => failure('SUBSCRIPTION_RECONCILIATION_EXPIRED', 410,
  'The subscription identity authorization has expired; operator review is required.');
const unauthorized = () => failure('SUBSCRIPTION_RECONCILIATION_NOT_AUTHORIZED', 403,
  'No subscription identity reconciliation is authorized for this account.');

class SubscriptionIdentityReconciliation {
  constructor(proService) { this.pro = proService; this.pool = proService.pool; }

  async safe(callback) {
    try { return await callback(); }
    catch (error) {
      if (error.code?.startsWith('SUBSCRIPTION_RECONCILIATION_')) throw error;
      if (error.code === '23505') throw conflict();
      throw failure('SUBSCRIPTION_RECONCILIATION_UNAVAILABLE', 503,
        'Subscription identity reconciliation is temporarily unavailable.');
    }
  }

  validate(approval, identity, { completed = false } = {}) {
    if (Number(approval.user_id) !== identity.userId || approval.project_id !== this.pro.projectId ||
        approval.to_customer_id !== identity.revenuecatAppUserId ||
        !approval.from_customer_id || approval.from_customer_id.startsWith('$RCAnonymousID:') ||
        approval.from_customer_id.startsWith('pou_v1_') ||
        !approval.original_customer_id?.startsWith('$RCAnonymousID:')) throw conflict();
    const approved = new Date(approval.approved_at).getTime();
    const end = new Date(approval.expires_at).getTime();
    if (!Number.isFinite(approved) || !Number.isFinite(end) || approved > this.pro.now() || end <= approved) throw conflict();
    if (!completed && end <= this.pro.now()) throw expired();
  }

  async noOtherOwner(db, identity, approval) {
    const result = await db.query(
      `SELECT user_id FROM public."user"
       WHERE user_id <> $1 AND revenuecat_app_user_id = ANY($2::text[]) LIMIT 1`,
      [identity.userId, [approval.from_customer_id, approval.to_customer_id, approval.original_customer_id]]);
    if (result.rows.length) throw conflict();
  }

  sameApproval(row, snapshot) {
    if (!row) throw unauthorized();
    for (const field of ['user_id', 'project_id', 'from_customer_id', 'to_customer_id',
      'original_customer_id', 'approved_by', 'evidence_reference', 'approved_at', 'expires_at']) {
      if (String(row[field]) !== String(snapshot[field])) throw conflict();
    }
  }

  async verify(approval, missingDestinationAllowed) {
    if (!this.pro.projectId) throw conflict();
    return this.pro.withLookupSlot(async () => {
      const provider = new ReconciliationProvider(this.pro);
      await provider.source(approval);
      await provider.destination(approval.to_customer_id, missingDestinationAllowed);
    });
  }

  async offer(identity) {
    // Normal new/linked accounts do not incur a new query or provider request.
    if (!identity.storedAppUserId || identity.storedAppUserId === identity.revenuecatAppUserId) return undefined;
    return this.safe(async () => {
      const result = await this.pool.query(
        `SELECT * FROM public.subscription_identity_reconciliations
         WHERE user_id = $1 AND project_id = $2 AND completed_at IS NULL`,
        [identity.userId, this.pro.projectId]);
      if (!result.rows.length) return undefined;
      const approval = result.rows[0];
      this.validate(approval, identity);
      if (approval.from_customer_id !== identity.storedAppUserId) throw conflict();
      await this.noOtherOwner(this.pool, identity, approval);
      await this.verify(approval, true);
      // Verification may take time: never offer an authorization that expired meanwhile.
      this.validate(approval, identity);
      const reviewed = await this.pool.query(
        `SELECT * FROM public.subscription_identity_reconciliations
         WHERE id = $1 AND user_id = $2 AND project_id = $3`,
        [approval.id, identity.userId, this.pro.projectId]);
      this.sameApproval(reviewed.rows[0], approval);
      if (reviewed.rows[0].completed_at) throw conflict();
      const current = await this.pro.getAccountIdentity({ userId: identity.userId });
      if (current.storedAppUserId !== approval.from_customer_id ||
          current.revenuecatAppUserId !== approval.to_customer_id) throw conflict();
      return {
        authorizationId: approval.id, action: 'switch_without_restore',
        fromAppUserId: approval.from_customer_id, toAppUserId: approval.to_customer_id,
        expectedOriginalAppUserId: approval.original_customer_id,
        expiresAt: new Date(approval.expires_at).toISOString()
      };
    });
  }

  async complete({ userId, authorizationId }) {
    if (typeof authorizationId !== 'string' || !UUID.test(authorizationId)) {
      throw failure('SUBSCRIPTION_RECONCILIATION_INVALID_INPUT', 400, 'A valid authorizationId is required.');
    }
    return this.safe(async () => {
      const identity = await this.pro.getAccountIdentity({ userId });
      // Reject missing/wrong-account authorizations without touching RevenueCat.
      const result = await this.pool.query(
        `SELECT * FROM public.subscription_identity_reconciliations
         WHERE id = $1 AND user_id = $2 AND project_id = $3`,
        [authorizationId, identity.userId, this.pro.projectId]);
      if (!result.rows.length) throw unauthorized();
      const approval = result.rows[0];
      this.validate(approval, identity, { completed: Boolean(approval.completed_at) });
      if (!approval.completed_at) {
        if (identity.storedAppUserId !== approval.from_customer_id) throw conflict();
        await this.noOtherOwner(this.pool, identity, approval);
        await this.verify(approval, false);
      }
      // Network calls finish BEFORE acquiring any database lock. Revalidate the
      // approval and account under locks; provider state is not transactional.
      const db = await this.pool.connect();
      try {
        await db.query('BEGIN');
        const locked = await db.query(
          `SELECT * FROM public.subscription_identity_reconciliations
           WHERE id = $1 AND user_id = $2 AND project_id = $3 FOR UPDATE`,
          [authorizationId, identity.userId, this.pro.projectId]);
        if (!locked.rows.length) throw unauthorized();
        const row = locked.rows[0];
        // An operator edit during provider verification invalidates that snapshot.
        this.sameApproval(row, approval);
        this.validate(row, identity, { completed: Boolean(row.completed_at) });
        const account = await db.query(
          `SELECT revenuecat_app_user_id FROM public."user" WHERE user_id = $1 FOR UPDATE`, [identity.userId]);
        const mapping = account.rows[0]?.revenuecat_app_user_id;
        if (row.completed_at) {
          if (mapping !== row.to_customer_id) throw conflict();
        } else {
          if (mapping !== row.from_customer_id) throw conflict();
          await this.noOtherOwner(db, identity, row);
          const updated = await db.query(
            `UPDATE public."user" SET revenuecat_app_user_id = $1
             WHERE user_id = $2 AND revenuecat_app_user_id = $3 RETURNING user_id`,
            [row.to_customer_id, identity.userId, row.from_customer_id]);
          if (updated.rowCount !== 1) throw conflict();
          const finished = await db.query(
            `UPDATE public.subscription_identity_reconciliations SET completed_at = clock_timestamp()
             WHERE id = $1 AND user_id = $2 AND completed_at IS NULL
               AND approved_at <= clock_timestamp() AND expires_at > clock_timestamp() RETURNING id`,
            [authorizationId, identity.userId]);
          if (finished.rowCount !== 1) throw expired();
        }
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { db.release(); }
      this.pro.cache.delete(approval.from_customer_id);
      this.pro.cache.delete(approval.to_customer_id);
      return { completed: true, revenuecatAppUserId: identity.revenuecatAppUserId };
    });
  }
}

module.exports = { SubscriptionIdentityReconciliation };
