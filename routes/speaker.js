'use strict';
const express = require('express');
const { readSpeakerMenu } = require('../portfolio/store');

module.exports = function speakerRoutes(ctx) {
  const router = express.Router();
  const { auditPool } = ctx;

  // Preserve the existing speaker feed URLs, now backed by the database.
  router.get('/speaker/:filename', async (req, res) => {
    try {
      if (req.params.filename.replace(/\.json$/, '') !== 'speaker_menu') {
        return res.status(404).json({ error: 'Speaker data file not found' });
      }
      res.json(await readSpeakerMenu(auditPool));

    } catch (error) {
      console.error('Error serving speaker file:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
