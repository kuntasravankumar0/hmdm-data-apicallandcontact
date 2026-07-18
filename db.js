// Database connection and table initialization
// OPTIMIZED for 512MB RAM instances
const { Pool } = require('pg');

let pool;

// Conservative defaults for 512MB RAM
const POOL_MAX = parseInt(process.env.POOL_MAX || '3');     // Max 3 connections
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '20'); // Smaller chunks
const DB_TIMEOUT = parseInt(process.env.DB_TIMEOUT || '15000'); // 15s query timeout

function getPool() {
  if (!pool) {
    // IMPORTANT: Node 24.x + newer pg (v9+) treats sslmode=require as
    // an alias for verify-full, causing "self-signed certificate in
    // certificate chain" errors on Aiven PostgreSQL.
    //
    // Solution: Strip ALL sslmode parameters from the connection string
    // and rely exclusively on the Pool's ssl config object below.
    let rawUrl = process.env.DATABASE_URL || 
      `postgresql://${process.env.DB_USERNAME || 'avnadmin'}:${encodeURIComponent(process.env.DB_PASSWORD || '')}@${process.env.DB_HOST || 'pg-7cd95c5-elenah-4365.l.aivencloud.com'}:${process.env.DB_PORT || '20827'}/${process.env.DB_NAME || 'defaultdb'}?connectTimeout=10`;
    
    // Strip any sslmode parameter from the query string.
    // Preserve the ? or & delimiter so multi-param URLs stay valid.
    // e.g. "?sslmode=require&connectTimeout=10" → "?&connectTimeout=10"
    const connectionString = rawUrl.replace(/([?&])sslmode=[^&#]+/gi, '$1');
    
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
      max: POOL_MAX,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
      query_timeout: DB_TIMEOUT,
      statement_timeout: DB_TIMEOUT,
      maxUses: 50,
    });
    
    pool.on('error', (err) => {
      console.error('[DB] Pool error:', err.message);
    });

    console.log(`[DB] Pool created (max: ${POOL_MAX}, chunk: ${CHUNK_SIZE})`);
  }
  return pool;
}

// Memory check helper - warns if memory usage is too high
function checkMemory() {
  const usage = process.memoryUsage();
  const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
  const rssMB = Math.round(usage.rss / 1024 / 1024);
  
  if (heapMB > 300 || rssMB > 400) {
    console.warn(`[MEMORY] High usage - heap: ${heapMB}MB, RSS: ${rssMB}MB`);
    if (global.gc) {
      global.gc();
      const afterGC = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      console.log(`[MEMORY] GC freed ${heapMB - afterGC}MB (heap: ${afterGC}MB)`);
    }
    return true;
  }
  return false;
}

// Log memory periodically
function startMemoryMonitor() {
  setInterval(() => {
    const usage = process.memoryUsage();
    console.log(`[MEM] RSS:${Math.round(usage.rss/1024/1024)}M Heap:${Math.round(usage.heapUsed/1024/1024)}M/${Math.round(usage.heapTotal/1024/1024)}M Ext:${Math.round(usage.external/1024/1024)}M`);
  }, 60000);
}

// Batch upsert - memory-optimized with smaller chunks
async function batchUpsert(table, columns, items, conflictColumns, updateColumns, onConflictAction = 'UPDATE') {
  if (!items || items.length === 0) return { saved: 0, updated: 0, skipped: 0 };

  const pool = getPool();
  const client = await pool.connect();
  let saved = 0;

  try {
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      
      const placeholders = [];
      const values = [];
      let paramIndex = 1;

      for (const item of chunk) {
        const rowPlaceholders = columns.map(() => `$${paramIndex++}`);
        placeholders.push(`(${rowPlaceholders.join(', ')})`);
        for (const col of columns) {
          values.push(item[col] !== undefined ? item[col] : null);
        }
      }

      const conflictTarget = conflictColumns.map(c => `"${c}"`).join(', ');
      
      let updateClause;
      if (onConflictAction === 'UPDATE' && updateColumns && updateColumns.length > 0) {
        const setClauses = updateColumns
          .filter(col => conflictColumns.indexOf(col) === -1)
          .map(col => `"${col}" = EXCLUDED."${col}"`);
        updateClause = `DO UPDATE SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP`;
      } else {
        updateClause = 'DO NOTHING';
      }

      const query = `
        INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')})
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (${conflictTarget})
        ${updateClause}
      `;

      const result = await client.query(query, values);
      saved += result.rowCount;
      chunk.length = 0;
    }

    return { saved, updated: 0, skipped: 0 };
  } catch (err) {
    throw err;
  } finally {
    client.release();
  }
}

// Initialize all database tables
async function initDatabase() {
  const client = await getPool().connect();
  try {
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

    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_contacts_device ON device_contacts(device_id)',
      'CREATE INDEX IF NOT EXISTS idx_contacts_name ON device_contacts(name)',
      'CREATE INDEX IF NOT EXISTS idx_contacts_phone ON device_contacts(phone)',
      'CREATE INDEX IF NOT EXISTS idx_contacts_email ON device_contacts(email)',
      'CREATE INDEX IF NOT EXISTS idx_calllogs_device ON device_call_logs(device_id)',
      'CREATE INDEX IF NOT EXISTS idx_calllogs_date ON device_call_logs(call_date DESC)',
      'CREATE INDEX IF NOT EXISTS idx_calllogs_phone ON device_call_logs(phone_number)',
      'CREATE INDEX IF NOT EXISTS idx_notifications_device ON device_notifications(device_id)',
      'CREATE INDEX IF NOT EXISTS idx_notifications_time ON device_notifications(received_at DESC)',
      'CREATE INDEX IF NOT EXISTS idx_deviceinfo_device ON device_info(device_id)',
    ];

    for (const idx of indexes) { await client.query(idx); }

    console.log('[DB] All tables and indexes ready');
  } catch (err) {
    console.error('[DB] Init error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getPool, initDatabase, batchUpsert, checkMemory, startMemoryMonitor, CHUNK_SIZE };
