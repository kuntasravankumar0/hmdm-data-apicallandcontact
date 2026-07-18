const express = require('express');
const { getPool, batchUpsert } = require('../db');

const router = express.Router();

// POST /api/calllogs/sync - Sync call logs in bulk (memory-optimized)
router.post('/sync', async (req, res) => {
  const { deviceId, callLogs } = req.body;

  if (!deviceId) {
    return res.status(400).json({ status: 'error', message: 'Missing deviceId' });
  }

  if (!callLogs || !Array.isArray(callLogs) || callLogs.length === 0) {
    return res.json({ status: 'success', message: 'No call logs to sync', saved: 0 });
  }

  try {
    const now = Date.now();

    // Build items with single pass (no map+filter chain)
    const items = [];
    for (const log of callLogs) {
      const phone = String(log.phoneNumber || log.phone_number || '');
      const callDate = parseInt(log.callDate || log.call_date || now);
      if (!phone && !callDate) continue; // Skip empty entries inline

      items.push({
        device_id: deviceId,
        call_id: String(log.callId || log.call_id || '').substring(0, 255),
        phone_number: phone.substring(0, 255),
        call_type: String(log.callType || log.call_type || '').substring(0, 50),
        duration_sec: parseInt(log.durationSec || log.duration_sec || 0) || 0,
        call_date: callDate,
        contact_name: String(log.contactName || log.contact_name || '').substring(0, 500),
        synced_at: now
      });
    }

    const result = await batchUpsert(
      'device_call_logs',
      ['device_id', 'call_id', 'phone_number', 'call_type', 'duration_sec', 'call_date', 'contact_name', 'synced_at'],
      items,
      ['device_id', 'call_date', 'phone_number', 'call_type', 'duration_sec'],
      null,
      'NOTHING'
    );

    items.length = 0; // Free memory

    res.json({
      status: 'success',
      saved: result.saved,
      total: callLogs.length,
      deviceId
    });
  } catch (err) {
    console.error('[CallLogs] Sync error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// GET /api/calllogs (sequential queries, smaller defaults)
router.get('/', async (req, res) => {
  const { deviceId, limit = 20, offset = 0, phone, type } = req.query; // Was 50

  try {
    const pool = getPool();

    // 1) Count query
    let cq = 'SELECT COUNT(*) FROM device_call_logs WHERE 1=1';
    const cp = [];
    let ci = 1;
    if (deviceId) { cq += ` AND device_id = $${ci++}`; cp.push(deviceId); }
    if (phone) { cq += ` AND phone_number ILIKE $${ci++}`; cp.push(`%${phone}%`); }
    if (type) { cq += ` AND call_type = $${ci++}`; cp.push(type.toUpperCase()); }
    const countResult = await pool.query(cq, cp);

    // 2) Data query
    let query = 'SELECT * FROM device_call_logs WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    if (deviceId) { query += ` AND device_id = $${paramIndex++}`; params.push(deviceId); }
    if (phone) { query += ` AND phone_number ILIKE $${paramIndex++}`; params.push(`%${phone}%`); }
    if (type) { query += ` AND call_type = $${paramIndex++}`; params.push(type.toUpperCase()); }
    query += ` ORDER BY call_date DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
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
    console.error('[CallLogs] Get error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// DELETE /api/calllogs
router.delete('/', async (req, res) => {
  const { deviceId } = req.query;
  try {
    const pool = getPool();
    if (deviceId) {
      await pool.query('DELETE FROM device_call_logs WHERE device_id = $1', [deviceId]);
    } else {
      await pool.query('DELETE FROM device_call_logs');
    }
    res.json({ status: 'success', message: 'Call logs cleared' });
  } catch (err) {
    console.error('[CallLogs] Delete error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

module.exports = router;
