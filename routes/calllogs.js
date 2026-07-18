const express = require('express');
const { getPool } = require('../db');

const router = express.Router();

// POST /api/calllogs/sync - Sync call logs from device
router.post('/sync', async (req, res) => {
  const { deviceId, callLogs } = req.body;
  
  if (!deviceId) {
    return res.status(400).json({ status: 'error', message: 'Missing deviceId' });
  }
  
  if (!callLogs || !Array.isArray(callLogs) || callLogs.length === 0) {
    return res.json({ status: 'success', message: 'No call logs to sync', saved: 0 });
  }

  const pool = getPool();
  const client = await pool.connect();
  let saved = 0;
  let skipped = 0;

  try {
    await client.query('BEGIN');
    const now = Date.now();

    for (const log of callLogs) {
      const phoneNumber = String(log.phoneNumber || '');
      const callType = String(log.callType || '');
      const durationSec = parseInt(log.durationSec || log.duration_sec || 0);
      const callDate = parseInt(log.callDate || log.call_date || now);
      const contactName = String(log.contactName || log.contact_name || '');

      if (!phoneNumber && !callDate) continue;

      // Dedup by device_id + call_date + phone + type + duration
      const result = await client.query(
        `INSERT INTO device_call_logs (device_id, call_id, phone_number, call_type, duration_sec, call_date, contact_name, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (device_id, call_date, phone_number, call_type, duration_sec)
         DO NOTHING
         RETURNING id`,
        [deviceId, String(log.callId || ''), phoneNumber, callType, durationSec, callDate, contactName, now]
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
      total: callLogs.length,
      deviceId
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[CallLogs] Sync error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  } finally {
    client.release();
  }
});

// GET /api/calllogs - Get call logs
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

    query += ` ORDER BY call_date DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Total count
    let countQuery = 'SELECT COUNT(*) FROM device_call_logs WHERE 1=1';
    const countParams = [];
    let ci = 1;
    if (deviceId) { countQuery += ` AND device_id = $${ci++}`; countParams.push(deviceId); }
    if (phone) { countQuery += ` AND phone_number ILIKE $${ci++}`; countParams.push(`%${phone}%`); }
    if (type) { countQuery += ` AND call_type = $${ci++}`; countParams.push(type.toUpperCase()); }
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      status: 'success',
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
      data: result.rows
    });
  } catch (err) {
    console.error('[CallLogs] Get error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// DELETE /api/calllogs - Clear call logs
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
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
