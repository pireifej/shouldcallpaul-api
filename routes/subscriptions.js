'use strict';

const express = require('express');
const { extractSubscriptionIdentity } = require('../revenueCatProService');

module.exports = function subscriptionRoutes(ctx) {
  const router = express.Router();
  const { authenticate, requireUserSession, proSubscriptionService } = ctx;

  // The mobile SDK must configure/logIn with this account-scoped customer ID.
  // This read does not create a customer, link an account, or grant access.
  router.post('/api/subscriptions/identity', authenticate, requireUserSession, async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const identity = await proSubscriptionService.getAccountIdentity({userId:req.userId});
      res.json({
        revenuecatAppUserId: identity.revenuecatAppUserId,
        entitlement: proSubscriptionService.entitlementKey,
        requiresSdkLogin: true
      });
    } catch (error) {
      res.status(error.statusCode || 503).json({
        error: 'SUBSCRIPTION_IDENTITY_UNAVAILABLE',
        message: error.message
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
