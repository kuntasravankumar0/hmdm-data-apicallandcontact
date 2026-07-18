// Database connection and table initialization
const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || 
        `postgresql://${process.env.DB_USERNAME || 'avnadmin'}:${process.env.DB_PASSWORD || ''}@${process.env.DB_HOST || 'pg-7cd95c5-elenah-4365.l.aivencloud.com'}:${process.env.DB_PORT || '20827'}/${process.env.DB_NAME || 'defaultdb'}?sslmode=require`,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

async function initDatabase() {
  const client = await getPool().connect();
  try {
    // Create contacts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_contacts (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255) NOT NULL,
        contact_id VARCHAR(255) NOT NULL DEFAULT '',
        name VARCHAR(500) DEFAULT '',
        phone VARCHAR(255) DEFAULT '',
        phone_type VARCHAR(100) DEFAULT '',
        email VARCHAR(500) DEFAULT '',
        raw_data JSONB DEFAULT '{}',
        synced_at BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(device_id, contact_id)
      );
    `);

    // Create call logs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_call_logs (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255) NOT NULL,
        call_id VARCHAR(255) DEFAULT '',
        phone_number VARCHAR(255) DEFAULT '',
        call_type VARCHAR(50) DEFAULT '',
        duration_sec INTEGER DEFAULT 0,
        call_date BIGINT NOT NULL,
        contact_name VARCHAR(500) DEFAULT '',
        synced_at BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(device_id, call_date, phone_number, call_type, duration_sec)
      );
    `);

    // Create notifications table
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_notifications (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255) NOT NULL,
        package_name VARCHAR(500) DEFAULT '',
        app_name VARCHAR(500) DEFAULT '',
        title TEXT DEFAULT '',
        text_body TEXT DEFAULT '',
        received_at BIGINT NOT NULL,
        synced_at BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(device_id, received_at, package_name, title)
      );
    `);

    // Create device info table
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_info (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE NOT NULL,
        info_data JSONB DEFAULT '{}',
        synced_at BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create indexes for faster queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_contacts_device ON device_contacts(device_id);
      CREATE INDEX IF NOT EXISTS idx_contacts_name ON device_contacts(name);
      CREATE INDEX IF NOT EXISTS idx_calllogs_device ON device_call_logs(device_id);
      CREATE INDEX IF NOT EXISTS idx_calllogs_date ON device_call_logs(call_date DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_device ON device_notifications(device_id);
      CREATE INDEX IF NOT EXISTS idx_notifications_time ON device_notifications(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_deviceinfo_device ON device_info(device_id);
    `);

    console.log('[DB] All tables initialized successfully');
  } catch (err) {
    console.error('[DB] Table initialization error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getPool, initDatabase };
