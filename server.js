const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const jwt = require('jsonwebtoken');
const { initDatabase, checkMemory, startMemoryMonitor } = require('./db');

// Import routes
const contactsRouter = require('./routes/contacts');
const calllogsRouter = require('./routes/calllogs');
const notificationsRouter = require('./routes/notifications');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || '';

// JWT config (override via env var for production)
const JWT_SECRET = process.env.JWT_SECRET || 'hmdm-data-api-secret-key-2024';
const JWT_EXPIRES_IN = '24h';

// Local admin credentials (override via env vars)
// Set ADMIN_LOGIN and ADMIN_PASSWORD in Render env for custom credentials
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'Sravan@admin.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Sravan@123';

// === SECURITY & PARSING ===
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// === REQUEST TIMEOUT ===
app.use((req, res, next) => {
  if (req.method === 'POST') {
    req.setTimeout(30000, () => {
      console.warn(`[TIMEOUT] ${req.method} ${req.path}`);
      res.status(408).json({ status: 'error', message: 'Request timed out' });
    });
  }
  next();
});

// === MEMORY CHECK ===
app.use((req, res, next) => {
  if (req.method === 'POST' && checkMemory()) {
    return res.status(503).json({ status: 'error', message: 'Server busy, try again shortly' });
  }
  next();
});

// === JWT AUTH MIDDLEWARE ===
// Only protects /api/* routes (except /api/auth/*).
// HTML pages (/, /dashboard, /login) are served without auth.
// The frontend JS checks localStorage for the JWT and redirects to /login if missing.
// API calls from the frontend include Authorization: Bearer header.
function extractToken(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  if (req.query.token) {
    return req.query.token;
  }
  return null;
}

function authMiddleware(req, res, next) {
  // Public paths
  if (req.path === '/health' || req.path.startsWith('/api/auth')) {
    return next();
  }

  // Only protect /api/* routes (not static HTML)
  if (req.path.startsWith('/api')) {
    // API key takes priority (for device sync apps)
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (apiKey && apiKey === API_KEY) {
      return next();
    }

    // JWT for web dashboard calls
    const token = extractToken(req);
    if (token) {
      try {
        jwt.verify(token, JWT_SECRET);
        return next();
      } catch (err) {
        return res.status(401).json({ status: 'error', message: 'Session expired. Please login again.' });
      }
    }

    return res.status(401).json({ status: 'error', message: 'Authentication required' });
  }

  next();
}

app.use(authMiddleware);

// === AUTH ROUTES ===

// POST /api/auth/login - Local auth, issue JWT on success
// No dependency on hmdmbackend or hmdm-server
app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body;

  if (!login || !password) {
    return res.status(400).json({ status: 'error', message: 'Missing login or password' });
  }

  // Check against env-configured admin credentials
  if (login === ADMIN_LOGIN && password === ADMIN_PASSWORD) {
    const token = jwt.sign(
      { username: login, auth: 'dashboard', iat: Math.floor(Date.now() / 1000) },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    return res.json({ status: 'success', token, message: 'Login successful' });
  }

  return res.status(401).json({ status: 'error', message: 'Invalid username or password' });
});

// GET /api/auth/verify - Check if current token is still valid
app.get('/api/auth/verify', (req, res) => {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ status: 'error', message: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return res.json({ status: 'success', username: decoded.username });
  } catch (err) {
    return res.status(401).json({ status: 'error', message: 'Invalid or expired token' });
  }
});

// === STATIC FILES & PAGES ===

// Root → always serve login page (no server-side auth check)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Dashboard page is served without server-side auth.
// The frontend JS checks localStorage for the JWT and redirects to /login if missing.
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Other static files
app.use(express.static(path.join(__dirname, 'public')));

// === HEALTH ===
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
  if (!deviceId) return res.status(400).json({ status: 'error', message: 'Missing deviceId' });
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

// === SUMMARY ===
app.get('/api/summary', async (req, res) => {
  try {
    const { getPool } = require('./db');
    const pool = getPool();
    const contacts = await pool.query('SELECT COUNT(*) as count FROM device_contacts');
    const calllogs = await pool.query('SELECT COUNT(*) as count FROM device_call_logs');
    const notifications = await pool.query('SELECT COUNT(*) as count FROM device_notifications');
    const devices = await pool.query('SELECT COUNT(*) as count FROM device_info');
    const latestCall = await pool.query('SELECT device_id, phone_number, call_type, call_date, contact_name FROM device_call_logs ORDER BY call_date DESC LIMIT 5');
    const latestNotif = await pool.query('SELECT device_id, app_name, title, received_at FROM device_notifications ORDER BY received_at DESC LIMIT 5');

    res.json({
      status: 'success',
      counts: {
        contacts: parseInt(contacts.rows[0].count),
        callLogs: parseInt(calllogs.rows[0].count),
        notifications: parseInt(notifications.rows[0].count),
        devices: parseInt(devices.rows[0].count),
      },
      recent: { callLogs: latestCall.rows, notifications: latestNotif.rows }
    });
  } catch (err) {
    console.error('[Summary] Error:', err.message);
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// === START ===
async function start() {
  startMemoryMonitor();
  try {
    await initDatabase();
    app.listen(PORT, '0.0.0.0', () => {
      const mem = process.memoryUsage();
      console.log(`[Server] hmdm-data-api running on port ${PORT}`);
      console.log(`[Server] Auth: local credentials (login: ${ADMIN_LOGIN})`);
      console.log(`[Server] Memory: ${Math.round(mem.rss/1024/1024)}MB RSS | ${Math.round(mem.heapUsed/1024/1024)}MB heap`);
      console.log(`[Server] Health: http://localhost:${PORT}/health`);
    });
  } catch (err) {
    console.error('[Server] Startup error:', err.message);
    process.exit(1);
  }
}

start();
