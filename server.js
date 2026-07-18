const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { initDatabase, checkMemory, startMemoryMonitor } = require('./db');

// Import routes
const contactsRouter = require('./routes/contacts');
const calllogsRouter = require('./routes/calllogs');
const notificationsRouter = require('./routes/notifications');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || '';

// === SECURITY & PARSING (optimized for 512MB) ===
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());

// Smaller body limit to prevent memory spikes from huge payloads
app.use(express.json({ limit: '2mb' }));       // Was 10mb
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// === REQUEST TIMEOUT MIDDLEWARE ===
// Prevents slow requests from piling up
app.use((req, res, next) => {
  // No timeout for GET (they're fast), only for POST syncs
  if (req.method === 'POST') {
    req.setTimeout(30000, () => {                // 30s timeout for POSTs
      console.warn(`[TIMEOUT] Request timed out: ${req.method} ${req.path}`);
      res.status(408).json({ status: 'error', message: 'Request timed out' });
    });
  }
  next();
});

// === MEMORY CHECK MIDDLEWARE ===
// Reject requests early if memory is too high
app.use((req, res, next) => {
  if (req.method === 'POST' && checkMemory()) {
    return res.status(503).json({ 
      status: 'error', 
      message: 'Server busy, try again shortly' 
    });
  }
  next();
});

// === API KEY AUTH ===
function authMiddleware(req, res, next) {
  if (req.method === 'GET' || !API_KEY) {
    return next();
  }
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey !== API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Invalid API key' });
  }
  next();
}

app.use('/api', authMiddleware);

// === STATIC FILES ===
app.use(express.static(path.join(__dirname, 'public')));

// === HEALTH CHECK ===
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({ 
    status: 'ok', 
    service: 'hmdm-data-api', 
    version: '1.0.0', 
    uptime: process.uptime(),
    memory: `${Math.round(mem.heapUsed/1024/1024)}MB/${Math.round(mem.rss/1024/1024)}MB`
  });
});

// === API ROUTES ===
app.use('/api/contacts', contactsRouter);
app.use('/api/calllogs', calllogsRouter);
app.use('/api/notifications', notificationsRouter);

// === DEVICE INFO ===
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
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (device_id)
       DO UPDATE SET info_data = EXCLUDED.info_data, synced_at = EXCLUDED.synced_at, updated_at = CURRENT_TIMESTAMP`,
      [deviceId, JSON.stringify(info || {}), now]
    );
    res.json({ status: 'success', deviceId });
  } catch (err) {
    console.error('[Device] Info error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

app.get('/api/device/info', async (req, res) => {
  const { deviceId } = req.query;
  try {
    const { getPool } = require('./db');
    const pool = getPool();
    let result;
    if (deviceId) {
      result = await pool.query('SELECT device_id, synced_at, updated_at FROM device_info WHERE device_id = $1', [deviceId]);
    } else {
      result = await pool.query('SELECT device_id, synced_at, updated_at FROM device_info ORDER BY updated_at DESC');
    }
    res.json({ status: 'success', data: result.rows });
  } catch (err) {
    console.error('[Device] Get error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// === SUMMARY (sequential queries to reduce connection usage) ===
app.get('/api/summary', async (req, res) => {
  try {
    const { getPool } = require('./db');
    const pool = getPool();
    
    // Sequential queries = only 1 connection used at a time (was Promise.all = 6 connections)
    const contacts = await pool.query('SELECT COUNT(*) as count FROM device_contacts');
    const calllogs = await pool.query('SELECT COUNT(*) as count FROM device_call_logs');
    const notifications = await pool.query('SELECT COUNT(*) as count FROM device_notifications');
    const devices = await pool.query('SELECT COUNT(*) as count FROM device_info');
    
    const latestCall = await pool.query(
      'SELECT device_id, phone_number, call_type, call_date, contact_name FROM device_call_logs ORDER BY call_date DESC LIMIT 5'
    );
    const latestNotif = await pool.query(
      'SELECT device_id, app_name, title, received_at FROM device_notifications ORDER BY received_at DESC LIMIT 5'
    );

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
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// === START ===
async function start() {
  // Start memory monitor (logs every 60s)
  startMemoryMonitor();
  
  try {
    await initDatabase();
    app.listen(PORT, '0.0.0.0', () => {
      const mem = process.memoryUsage();
      console.log(`[Server] hmdm-data-api running on port ${PORT}`);
      console.log(`[Server] Memory: ${Math.round(mem.rss/1024/1024)}MB RSS | ${Math.round(mem.heapUsed/1024/1024)}MB heap`);
      console.log(`[Server] Health: http://localhost:${PORT}/health`);
    });
  } catch (err) {
    console.error('[Server] Startup error:', err.message);
    process.exit(1);
  }
}

start();
