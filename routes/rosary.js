'use strict';
const express = require('express');

module.exports = function rosaryRoutes(ctx) {
  const router = express.Router();
  const { pool, authenticate, rooms, getRoomState } = ctx;

router.post('/rosary/complete', authenticate, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.json({ error: 1, result: "userId is required" });

    const result = await pool.query(
      `UPDATE public."user"
       SET rosary_count = COALESCE(rosary_count, 0) + 1
       WHERE user_id = $1
       RETURNING COALESCE(rosary_count, 0) as rosary_count`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 1, result: "User not found" });
    }

    res.json({ success: true, rosaryCount: result.rows[0].rosary_count });
  } catch (error) {
    console.error('Error completing rosary:', error);
    res.status(500).json({ error: 1, result: error.message });
  }
});

router.get('/rosary-room/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(getRoomState(room));
});

  return router;
};
