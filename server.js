const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { initDatabase } = require('./db');

// Import routes
const contactsRouter = require('./routes/contacts');
const calllogsRouter = require('./routes/calllogs');
const notificationsRouter = require('./routes/notifications');

const app = express();
const PORT = process.env.PORT || 3001;

// Security & parsing middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files (web UI)
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint (for Render)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'hmdm-data-api', version: '1.0.0', uptime: process.uptime() });
});

// API routes
app.use('/api/contacts', contactsRouter);
app.use('/api/calllogs', calllogsRouter);
app.use('/api/notifications', notificationsRouter);

// Device info endpoints
app.post('/api/device/info', async (req, res) => {
  const { deviceId, info } = req.body;
  if (!deviceId) return res.status(400).json({ status: 'error', message: 'Missing deviceId' });
  
  try {
    const { getPool } = require('./db');
    const pool = getPool();
    const now = Date.now();
    
    await pool.query(
      `INSERT INTO device_info (device_id, info_data, synced_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (device_id)
       DO UPDATE SET info_data = EXCLUDED.info_data, synced_at = EXCLUDED.synced_at, updated_at = CURRENT_TIMESTAMP`,
      [deviceId, JSON.stringify(info || {}), now]
    );
    
    res.json({ status: 'success', deviceId });
  } catch (err) {
    console.error('[Device] Info error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/device/info', async (req, res) => {
  const { deviceId } = req.query;
  try {
    const { getPool } = require('./db');
    const pool = getPool();
    let result;
    if (deviceId) {
      result = await pool.query('SELECT * FROM device_info WHERE device_id = $1', [deviceId]);
    } else {
      result = await pool.query('SELECT * FROM device_info ORDER BY updated_at DESC');
    }
    res.json({ status: 'success', data: result.rows });
  } catch (err) {
    console.error('[Device] Get error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Summary endpoint - get counts for dashboard
app.get('/api/summary', async (req, res) => {
  try {
    const { getPool } = require('./db');
    const pool = getPool();
    const [contacts, calllogs, notifications, devices] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM device_contacts'),
      pool.query('SELECT COUNT(*) as count FROM device_call_logs'),
      pool.query('SELECT COUNT(*) as count FROM device_notifications'),
      pool.query('SELECT COUNT(*) as count FROM device_info'),
    ]);

    // Latest data per type
    const [latestCall, latestNotif] = await Promise.all([
      pool.query('SELECT device_id, phone_number, call_type, call_date, contact_name FROM device_call_logs ORDER BY call_date DESC LIMIT 5'),
      pool.query('SELECT device_id, app_name, title, received_at FROM device_notifications ORDER BY received_at DESC LIMIT 5'),
    ]);

    res.json({
      status: 'success',
      counts: {
        contacts: parseInt(contacts.rows[0].count),
        callLogs: parseInt(calllogs.rows[0].count),
        notifications: parseInt(notifications.rows[0].count),
        devices: parseInt(devices.rows[0].count),
      },
      recent: {
        callLogs: latestCall.rows,
        notifications: latestNotif.rows,
      }
    });
  } catch (err) {
    console.error('[Summary] Error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Initialize database and start server
async function start() {
  try {
    await initDatabase();
    
    // Also create device_info table
    const { getPool } = require('./db');
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS device_info (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE NOT NULL,
        info_data JSONB DEFAULT '{}',
        synced_at BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('[DB] Device info table ready');
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Server] hmdm-data-api running on port ${PORT}`);
      console.log(`[Server] Web UI: http://localhost:${PORT}`);
      console.log(`[Server] API: http://localhost:${PORT}/api`);
      console.log(`[Server] Health: http://localhost:${PORT}/health`);
    });
  } catch (err) {
    console.error('[Server] Startup error:', err.message);
    process.exit(1);
  }
}

start();
