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
const API_KEY = process.env.API_KEY || '';

// Security & parsing middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// API Key authentication middleware for write operations
function authMiddleware(req, res, next) {
  // Skip auth for GET, health, and when no API key is configured
  if (req.method === 'GET' || !API_KEY) {
    return next();
  }
  
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey !== API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Invalid or missing API key' });
  }
  next();
}

// Apply auth to all /api routes
app.use('/api', authMiddleware);

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
  if (!deviceId) {
    return res.status(400).json({ status: 'error', message: 'Missing deviceId' });
  }
  
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
    res.status(500).json({ status: 'error', message: 'Internal server error' });
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
    res.status(500).json({ status: 'error', message: 'Internal server error' });
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
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// Initialize database and start server
async function start() {
  try {
    await initDatabase();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[Server] hmdm-data-api running on port ${PORT}`);
      console.log(`[Server] Web UI: http://localhost:${PORT}`);
      console.log(`[Server] Health: http://localhost:${PORT}/health`);
    });
  } catch (err) {
    console.error('[Server] Startup error:', err.message);
    process.exit(1);
  }
}

start();
