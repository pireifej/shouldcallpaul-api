'use strict';

const express = require('express');
const { extractSubscriptionIdentity } = require('../revenueCatProService');

module.exports = function subscriptionRoutes(ctx) {
  const router = express.Router();
  const { authenticate, proSubscriptionService } = ctx;

  router.post('/api/subscriptions/pro-status', authenticate, async (req, res) => {
    try {
      const status = await proSubscriptionService.getProStatus(extractSubscriptionIdentity(req));
      res.json({
        isPro: status.isPro,
        entitlement: status.entitlement,
        revenuecatAppUserId: status.revenuecatAppUserId
      });
    } catch (error) {
      const statusCode = error.statusCode || 503;
      res.status(statusCode).json({
        error: statusCode === 503 ? 'PRO_STATUS_UNAVAILABLE' : 'INVALID_SUBSCRIPTION_IDENTITY',
        message: error.message
      });
    }
  });

  return router;
};
