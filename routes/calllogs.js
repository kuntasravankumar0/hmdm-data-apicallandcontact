const express = require('express');
const { getPool, batchUpsert } = require('../db');

const router = express.Router();

// POST /api/calllogs/sync - Sync call logs in bulk
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
    
    // Prepare items for batch insert
    const items = callLogs.map(log => ({
      device_id: deviceId,
      call_id: String(log.callId || log.call_id || ''),
      phone_number: String(log.phoneNumber || log.phone_number || ''),
      call_type: String(log.callType || log.call_type || ''),
      duration_sec: parseInt(log.durationSec || log.duration_sec || 0),
      call_date: parseInt(log.callDate || log.call_date || now),
      contact_name: String(log.contactName || log.contact_name || ''),
      synced_at: now
    })).filter(item => item.phone_number || item.call_date); // Skip empty entries

    // Batch insert with dedup (ON CONFLICT DO NOTHING)
    const result = await batchUpsert(
      'device_call_logs',
      ['device_id', 'call_id', 'phone_number', 'call_type', 'duration_sec', 'call_date', 'contact_name', 'synced_at'],
      items,
      ['device_id', 'call_date', 'phone_number', 'call_type', 'duration_sec'],
      null, // No update - just skip duplicates
      'NOTHING'
    );

    res.json({
      status: 'success',
      saved: result.saved,
      skipped: result.skipped,
      total: callLogs.length,
      deviceId
    });
  } catch (err) {
    console.error('[CallLogs] Sync error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// GET /api/calllogs - Get call logs with pagination + filters
router.get('/', async (req, res) => {
  const { deviceId, limit = 50, offset = 0, phone, type } = req.query;
  
  try {
    const pool = getPool();
    let query = 'SELECT * FROM device_call_logs WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (deviceId) {
      query += ` AND device_id = $${paramIndex++}`;
      params.push(deviceId);
    }
    if (phone) {
      query += ` AND phone_number ILIKE $${paramIndex++}`;
      params.push(`%${phone}%`);
    }
    if (type) {
      query += ` AND call_type = $${paramIndex++}`;
      params.push(type.toUpperCase());
    }

    const paginatedQuery = query + ` ORDER BY call_date DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    // Run data + count queries in parallel
    const [dataResult, countResult] = await Promise.all([
      pool.query(paginatedQuery, params),
      (() => {
        let cq = 'SELECT COUNT(*) FROM device_call_logs WHERE 1=1';
        const cp = [];
        let ci = 1;
        if (deviceId) { cq += ` AND device_id = $${ci++}`; cp.push(deviceId); }
        if (phone) { cq += ` AND phone_number ILIKE $${ci++}`; cp.push(`%${phone}%`); }
        if (type) { cq += ` AND call_type = $${ci++}`; cp.push(type.toUpperCase()); }
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
    console.error('[CallLogs] Get error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
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
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

module.exports = router;
