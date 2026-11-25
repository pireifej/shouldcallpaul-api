'use strict';

const express = require('express');
const { extractSubscriptionIdentity } = require('../revenueCatProService');
const { getContentAccessPolicy } = require('../interimContentAccess');
const { SubscriptionIdentityReconciliation } = require('../subscriptionIdentityReconciliation');

module.exports = function subscriptionRoutes(ctx) {
  const router = express.Router();
  const { authenticate, requireUserSession, proSubscriptionService } = ctx;
  const reconciliation = () => new SubscriptionIdentityReconciliation(proSubscriptionService);
  const contentAccessPolicy = getContentAccessPolicy({ enabled: ctx.contentPaywallEnabled });

  // Deployment policy only: independent of provider availability and user Pro status.
  router.get('/api/subscriptions/access-policy', authenticate, requireUserSession, (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.json(contentAccessPolicy);
  });

  // The mobile SDK must configure/logIn with this account-scoped customer ID.
  // This read does not create a customer, link an account, or grant access.
  router.post('/api/subscriptions/identity', authenticate, requireUserSession, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const identity = await proSubscriptionService.getAccountIdentity({userId:req.userId});
      const identityReconciliation = await reconciliation().offer(identity);
      res.json({
        revenuecatAppUserId: identity.revenuecatAppUserId,
        entitlement: proSubscriptionService.entitlementKey,
        requiresSdkLogin: true,
        ...(identityReconciliation ? { identityReconciliation } : {})
      });
    } catch (error) {
      res.status(error.statusCode || 503).json({
        error: error.code || 'SUBSCRIPTION_IDENTITY_UNAVAILABLE',
        message: error.message
      });
    }
  });

  router.post('/api/subscriptions/identity-reconciliation/complete', authenticate, requireUserSession, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      // userId is injected/validated by requireUserSession. No client target,
      // source, SDK boolean, entitlement flag, or approval creation is accepted.
      if (!req.body || Array.isArray(req.body) ||
          Object.keys(req.body).some(key => !['authorizationId', 'userId'].includes(key))) {
        return res.status(400).json({ error: 'SUBSCRIPTION_RECONCILIATION_INVALID_INPUT',
          message: 'Only authorizationId is accepted.' });
      }
      res.json(await reconciliation().complete({ userId: req.userId, authorizationId: req.body.authorizationId }));
    } catch (error) {
      res.status(error.statusCode || 503).json({
        error: error.code || 'SUBSCRIPTION_RECONCILIATION_UNAVAILABLE',
        message: error.code ? error.message : 'Subscription identity reconciliation is temporarily unavailable.'
      });
    }
  });

  router.post('/api/subscriptions/pro-status', authenticate, requireUserSession, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const status = await proSubscriptionService.getProStatus({
        ...extractSubscriptionIdentity(req, {includeClientIdentity:true}),
        refresh:req.body?.refresh === true
      });
      res.json({
        isPro: status.isPro,
        entitlement: status.entitlement,
        revenuecatAppUserId: status.revenuecatAppUserId,
        identityVerificationRequired: status.identityVerificationRequired === true
      });
    } catch (error) {
      const statusCode = error.statusCode || 503;
      res.status(statusCode).json({
        error: error.code || (statusCode === 503 ? 'PRO_STATUS_UNAVAILABLE' : 'INVALID_SUBSCRIPTION_IDENTITY'),
        message: error.message
      });
    }
  });

  return router;
};
