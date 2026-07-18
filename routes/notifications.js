const express = require('express');
const { getPool, batchUpsert } = require('../db');

const router = express.Router();

// POST /api/notifications/sync - Sync notifications in bulk (memory-optimized)
router.post('/sync', async (req, res) => {
  const { deviceId, notifications } = req.body;

  if (!deviceId) {
    return res.status(400).json({ status: 'error', message: 'Missing deviceId' });
  }

  if (!notifications || !Array.isArray(notifications) || notifications.length === 0) {
    return res.json({ status: 'success', message: 'No notifications to sync', saved: 0 });
  }

  try {
    const now = Date.now();

    // Single-pass item building
    const items = [];
    for (const notif of notifications) {
      const title = String(notif.title || '');
      const textBody = String(notif.text || notif.textBody || notif.text_body || '');
      if (!title && !textBody) continue; // Skip empty inline

      items.push({
        device_id: deviceId,
        package_name: String(notif.packageName || notif.package_name || '').substring(0, 500),
        app_name: String(notif.appName || notif.app_name || '').substring(0, 500),
        title: title.substring(0, 500),
        text_body: textBody.substring(0, 1000),
        received_at: parseInt(notif.receivedAt || notif.received_at || now),
        synced_at: now
      });
    }

    const result = await batchUpsert(
      'device_notifications',
      ['device_id', 'package_name', 'app_name', 'title', 'text_body', 'received_at', 'synced_at'],
      items,
      ['device_id', 'received_at', 'package_name', 'title'],
      null,
      'NOTHING'
    );

    items.length = 0; // Free memory

    res.json({
      status: 'success',
      saved: result.saved,
      total: notifications.length,
      deviceId
    });
  } catch (err) {
    console.error('[Notifications] Sync error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// GET /api/notifications (sequential queries, smaller defaults)
router.get('/', async (req, res) => {
  const { deviceId, limit = 20, offset = 0, app } = req.query; // Was 50

  try {
    const pool = getPool();

    // 1) Count
    let cq = 'SELECT COUNT(*) FROM device_notifications WHERE 1=1';
    const cp = [];
    let ci = 1;
    if (deviceId) { cq += ` AND device_id = $${ci++}`; cp.push(deviceId); }
    if (app) { cq += ` AND (app_name ILIKE $${ci} OR package_name ILIKE $${ci})`; cp.push(`%${app}%`); }
    const countResult = await pool.query(cq, cp);

    // 2) Data
    let query = 'SELECT * FROM device_notifications WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    if (deviceId) { query += ` AND device_id = $${paramIndex++}`; params.push(deviceId); }
    if (app) {
      query += ` AND (app_name ILIKE $${paramIndex} OR package_name ILIKE $${paramIndex})`;
      params.push(`%${app}%`);
      paramIndex++;
    }
    query += ` ORDER BY received_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const dataResult = await pool.query(query, params);

    res.json({
      status: 'success',
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
      data: dataResult.rows
    });
  } catch (err) {
    console.error('[Notifications] Get error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
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
    console.error('[Notifications] Delete error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

module.exports = router;
