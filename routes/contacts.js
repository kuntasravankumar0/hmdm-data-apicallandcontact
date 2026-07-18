const express = require('express');
const { getPool, batchUpsert } = require('../db');

const router = express.Router();

// POST /api/contacts/sync - Sync contacts in bulk
router.post('/sync', async (req, res) => {
  const { deviceId, contacts } = req.body;
  
  if (!deviceId) {
    return res.status(400).json({ status: 'error', message: 'Missing deviceId' });
  }
  
  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return res.json({ status: 'success', message: 'No contacts to sync', saved: 0 });
  }

  try {
    const now = Date.now();
    const pool = getPool();
    
    // Prepare items: normalize contact data
    const items = contacts.map(contact => {
      const contactId = String(contact.contactId || contact.rawContactId || '');
      const phone = String(contact.phone || '');
      const email = String(contact.email || '');
      
      // Fallback if contact_id is empty
      const effectiveContactId = contactId || 
        (phone ? `phone:${phone}` : '') || 
        (email ? `email:${email}` : '') || 
        `unknown:${now}_${Math.random().toString(36).substr(2,4)}`;

      return {
        device_id: deviceId,
        contact_id: effectiveContactId,
        name: String(contact.name || ''),
        phone: phone,
        phone_type: String(contact.phoneType || contact.phone_type || ''),
        email: email,
        raw_data: JSON.stringify(contact),
        synced_at: now
      };
    });

    // Batch upsert in chunks (100 per batch)
    const result = await batchUpsert(
      'device_contacts',
      ['device_id', 'contact_id', 'name', 'phone', 'phone_type', 'email', 'raw_data', 'synced_at'],
      items,
      ['device_id', 'contact_id'],
      ['name', 'phone', 'phone_type', 'email', 'raw_data', 'synced_at'],
      'UPDATE'
    );

    res.json({
      status: 'success',
      saved: result.saved,
      updated: result.updated || 0,
      total: contacts.length,
      deviceId
    });
  } catch (err) {
    console.error('[Contacts] Sync error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// GET /api/contacts - Get contacts with pagination + search
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

    const [dataResult, countResult] = await Promise.all([
      pool.query(query, params),
      (() => {
        let cq = 'SELECT COUNT(*) FROM device_contacts WHERE 1=1';
        const cp = [];
        let ci = 1;
        if (deviceId) { cq += ` AND device_id = $${ci++}`; cp.push(deviceId); }
        if (search) { cq += ` AND (name ILIKE $${ci} OR phone ILIKE $${ci} OR email ILIKE $${ci})`; cp.push(`%${search}%`); }
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
    console.error('[Contacts] Get error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// DELETE /api/contacts
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
    console.error('[Contacts] Delete error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

module.exports = router;
