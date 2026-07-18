const express = require('express');
const { getPool } = require('../db');

const router = express.Router();

// POST /api/contacts/sync - Sync contacts from device
router.post('/sync', async (req, res) => {
  const { deviceId, contacts } = req.body;
  
  if (!deviceId) {
    return res.status(400).json({ status: 'error', message: 'Missing deviceId' });
  }
  
  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return res.json({ status: 'success', message: 'No contacts to sync', saved: 0 });
  }

  const pool = getPool();
  const client = await pool.connect();
  let saved = 0;
  let updated = 0;

  try {
    await client.query('BEGIN');
    const now = Date.now();

    for (const contact of contacts) {
      const contactId = String(contact.contactId || contact.rawContactId || '');
      const name = String(contact.name || '');
      const phone = String(contact.phone || '');
      const phoneType = String(contact.phoneType || '');
      const email = String(contact.email || '');

      if (!contactId && !phone) continue; // Skip if no identifier

      // Try to update existing contact first
      const result = await client.query(
        `INSERT INTO device_contacts (device_id, contact_id, name, phone, phone_type, email, raw_data, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (device_id, contact_id)
         DO UPDATE SET 
           name = EXCLUDED.name,
           phone = EXCLUDED.phone,
           phone_type = EXCLUDED.phone_type,
           email = EXCLUDED.email,
           raw_data = EXCLUDED.raw_data,
           synced_at = EXCLUDED.synced_at,
           updated_at = CURRENT_TIMESTAMP
         RETURNING (xmax = 0) AS inserted`,
        [deviceId, contactId, name, phone, phoneType, email, JSON.stringify(contact), now]
      );
      
      if (result.rows[0]?.inserted) {
        saved++;
      } else {
        updated++;
      }
    }

    await client.query('COMMIT');
    res.json({
      status: 'success',
      saved,
      updated,
      total: contacts.length,
      deviceId
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Contacts] Sync error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  } finally {
    client.release();
  }
});

// GET /api/contacts - Get all contacts
router.get('/', async (req, res) => {
  const { deviceId, limit = 100, offset = 0, search } = req.query;
  
  try {
    const pool = getPool();
    let query = 'SELECT * FROM device_contacts WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (deviceId) {
      query += ` AND device_id = $${paramIndex++}`;
      params.push(deviceId);
    }

    if (search) {
      query += ` AND (name ILIKE $${paramIndex} OR phone ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY name ASC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);
    
    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM device_contacts WHERE 1=1';
    const countParams = [];
    let countIdx = 1;
    if (deviceId) {
      countQuery += ` AND device_id = $${countIdx++}`;
      countParams.push(deviceId);
    }
    if (search) {
      countQuery += ` AND (name ILIKE $${countIdx} OR phone ILIKE $${countIdx} OR email ILIKE $${countIdx})`;
      countParams.push(`%${search}%`);
    }
    const countResult = await pool.query(countQuery, countParams);

    res.json({
      status: 'success',
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
      data: result.rows
    });
  } catch (err) {
    console.error('[Contacts] Get error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// DELETE /api/contacts - Clear contacts
router.delete('/', async (req, res) => {
  const { deviceId } = req.query;
  try {
    const pool = getPool();
    if (deviceId) {
      await pool.query('DELETE FROM device_contacts WHERE device_id = $1', [deviceId]);
    } else {
      await pool.query('DELETE FROM device_contacts');
    }
    res.json({ status: 'success', message: 'Contacts cleared' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
