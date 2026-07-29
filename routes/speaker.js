'use strict';
const express = require('express');

module.exports = function speakerRoutes(ctx) {
  const router = express.Router();
  const { fs, path } = ctx;

  // GET /speaker/:filename - Serve speaker menu JSON files
  router.get('/speaker/:filename', async (req, res) => {
    try {
      const filename = req.params.filename;

      // Sanitize filename to prevent directory traversal
      if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
      }

      // Add .json extension if not provided
      const jsonFilename = filename.endsWith('.json') ? filename : filename + '.json';
      const filePath = path.join(__dirname, '..', 'speaker_data', jsonFilename);

      // Check if file exists
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Speaker data file not found' });
      }

      // Read and return JSON file
      const jsonData = fs.readFileSync(filePath, 'utf8');
      const parsedData = JSON.parse(jsonData);

      res.json(parsedData);

    } catch (error) {
      console.error('Error serving speaker file:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
