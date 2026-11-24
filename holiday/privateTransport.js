'use strict';
const express = require('express');

// Run before the legacy body parsers/logger, including for malformed private JSON.
function privateHolidayTransport() {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));
  router.use((error, req, res, next) => {
    res.removeHeader('Access-Control-Allow-Origin');
    res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
    res.status(error.type === 'entity.too.large' ? 413 : 400).json({
      error: error.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON'
    });
  });
  return router;
}
module.exports = { privateHolidayTransport };
