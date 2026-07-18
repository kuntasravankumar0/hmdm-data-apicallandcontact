const express = require('express');
const { getPool, batchUpsert } = require('../db');

const router = express.Router();

// POST /api/notifications/sync - Sync notifications in bulk
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
    
    // Prepare items for batch insert
    const items = notifications.map(notif => ({
      device_id: deviceId,
      package_name: String(notif.packageName || notif.package_name || ''),
      app_name: String(notif.appName || notif.app_name || ''),
      title: String(notif.title || ''),
      text_body: String(notif.text || notif.textBody || notif.text_body || ''),
      received_at: parseInt(notif.receivedAt || notif.received_at || now),
      synced_at: now
    })).filter(item => item.title || item.text_body); // Skip empty entries

    // Batch insert with dedup (ON CONFLICT DO NOTHING)
    const result = await batchUpsert(
      'device_notifications',
      ['device_id', 'package_name', 'app_name', 'title', 'text_body', 'received_at', 'synced_at'],
      items,
      ['device_id', 'received_at', 'package_name', 'title'],
      null,
      'NOTHING'
    );

    res.json({
      status: 'success',
      saved: result.saved,
      skipped: result.skipped,
      total: notifications.length,
      deviceId
    });
  } catch (err) {
    console.error('[Notifications] Sync error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// GET /api/notifications - Get notifications with pagination
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

    const paginatedQuery = query + ` ORDER BY received_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const [dataResult, countResult] = await Promise.all([
      pool.query(paginatedQuery, params),
      (() => {
        let cq = 'SELECT COUNT(*) FROM device_notifications WHERE 1=1';
        const cp = [];
        let ci = 1;
        if (deviceId) { cq += ` AND device_id = $${ci++}`; cp.push(deviceId); }
        if (app) { cq += ` AND (app_name ILIKE $${ci} OR package_name ILIKE $${ci})`; cp.push(`%${app}%`); }
        return pool.query(cq, cp);
      })()
    ]);

    res.json({
      status: 'success',
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
      data: dataResult.rows
    });
  } catch (err) {
    console.error('[Notifications] Get error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
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
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

module.exports = router;
