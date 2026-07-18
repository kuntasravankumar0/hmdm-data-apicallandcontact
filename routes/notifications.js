const express = require('express');
const { getPool } = require('../db');

const router = express.Router();

// POST /api/notifications/sync - Sync notifications from device
router.post('/sync', async (req, res) => {
  const { deviceId, notifications } = req.body;
  
  if (!deviceId) {
    return res.status(400).json({ status: 'error', message: 'Missing deviceId' });
  }
  
  if (!notifications || !Array.isArray(notifications) || notifications.length === 0) {
    return res.json({ status: 'success', message: 'No notifications to sync', saved: 0 });
  }

  const pool = getPool();
  const client = await pool.connect();
  let saved = 0;
  let skipped = 0;

  try {
    await client.query('BEGIN');
    const now = Date.now();

    for (const notif of notifications) {
      const packageName = String(notif.packageName || notif.package_name || '');
      const appName = String(notif.appName || notif.app_name || '');
      const title = String(notif.title || '');
      const textBody = String(notif.text || notif.textBody || notif.text_body || '');
      const receivedAt = parseInt(notif.receivedAt || notif.received_at || now);

      if (!title && !textBody) continue;

      // Dedup by device_id + received_at + package_name + title
      const result = await client.query(
        `INSERT INTO device_notifications (device_id, package_name, app_name, title, text_body, received_at, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (device_id, received_at, package_name, title)
         DO NOTHING
         RETURNING id`,
        [deviceId, packageName, appName, title, textBody, receivedAt, now]
      );

      if (result.rows.length > 0) {
        saved++;
      } else {
        skipped++;
      }
    }

    await client.query('COMMIT');
    res.json({
      status: 'success',
      saved,
      skipped,
      total: notifications.length,
      deviceId
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Notifications] Sync error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  } finally {
    client.release();
  }
});

// GET /api/notifications - Get notifications
router.get('/', async (req, res) => {
  const { deviceId, limit = 50, offset = 0, app } = req.query;
  
  try {
    const pool = getPool();
    let query = 'SELECT * FROM device_notifications WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (deviceId) {
      query += ` AND device_id = $${paramIndex++}`;
      params.push(deviceId);
    }
    if (app) {
      query += ` AND (app_name ILIKE $${paramIndex} OR package_name ILIKE $${paramIndex})`;
      params.push(`%${app}%`);
      paramIndex++;
    }

    query += ` ORDER BY received_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    let countQuery = 'SELECT COUNT(*) FROM device_notifications WHERE 1=1';
    const countParams = [];
    let ci = 1;
    if (deviceId) { countQuery += ` AND device_id = $${ci++}`; countParams.push(deviceId); }
    if (app) { countQuery += ` AND (app_name ILIKE $${ci} OR package_name ILIKE $${ci})`; countParams.push(`%${app}%`); }
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      status: 'success',
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
      data: result.rows
    });
  } catch (err) {
    console.error('[Notifications] Get error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// DELETE /api/notifications
router.delete('/', async (req, res) => {
  const { deviceId } = req.query;
  try {
    const pool = getPool();
    if (deviceId) {
      await pool.query('DELETE FROM device_notifications WHERE device_id = $1', [deviceId]);
    } else {
      await pool.query('DELETE FROM device_notifications');
    }
    res.json({ status: 'success', message: 'Notifications cleared' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
