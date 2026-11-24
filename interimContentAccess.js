'use strict';

// This switch affects Daily Bread and Prayer Walk only. It never grants Pro,
// changes posting quotas, or controls background audio generation/storage.
function getContentAccessPolicy({
  enabled = process.env.PRAY_OVER_US_CONTENT_PAYWALL_ENABLED
} = {}) {
  if (![undefined, '', 'false', 'true', false, true].includes(enabled)) {
    throw new Error('PRAY_OVER_US_CONTENT_PAYWALL_ENABLED must be true or false');
  }
  const paywallEnabled = enabled === true || enabled === 'true';
  return {
    contentPaywallEnabled: paywallEnabled,
    dailyBread: { requiresPro: paywallEnabled },
    prayerWalk: { requiresPro: paywallEnabled },
    extendedPrayer: { requiresPro: true }
  };
}

function createInterimContentAccess(requirePro, options = {}) {
  const { contentPaywallEnabled: paywallEnabled } = getContentAccessPolicy(options);
  return function requireContentAccess(req, res, next) {
    res.set('Cache-Control', 'private, no-store');
    // Routes must run app authentication and verified-session middleware first.
    if (paywallEnabled) return requirePro(req, res, next);
    return next();
  };
}

module.exports = { createInterimContentAccess, getContentAccessPolicy };
