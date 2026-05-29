/**
 * Collector Plugin Backend Server
 * ================================
 * Stores player collection registrations and serves them to other plugin users.
 *
 * Endpoints:
 *   GET  /api/profile/:rsn          — fetch a player's collection profile
 *   PUT  /api/profile               — register / update your collection
 *   POST /api/profile/:rsn/sync     — push bank quantity updates
 *   DELETE /api/profile/:rsn        — unregister (optional)
 *
 * Storage: SQLite (single file, zero-config, easy to migrate later)
 *
 * Deploy on any VPS (Railway, Render, Fly.io, DigitalOcean, etc.)
 * Then update API_BASE in CollectorApiClient.java with your URL.
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const path = require('path');

// ============================================================================
// Setup
// ============================================================================

const app = express();
const PORT = process.env.PORT || 8080;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../collector.db');

// ============================================================================
// Database
// ============================================================================

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    rsn             TEXT PRIMARY KEY COLLATE NOCASE,
    collection_label TEXT NOT NULL DEFAULT 'My Collection',
    last_sync       INTEGER NOT NULL DEFAULT 0,
    registered_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS collection_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    rsn             TEXT NOT NULL COLLATE NOCASE,
    item_id         INTEGER NOT NULL DEFAULT 0,
    item_name       TEXT NOT NULL,
    current_quantity INTEGER NOT NULL DEFAULT 0,
    goal_quantity   INTEGER NOT NULL DEFAULT 1,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (rsn) REFERENCES profiles(rsn) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_items_rsn ON collection_items(rsn);
`);

// Prepared statements
const stmts = {
  getProfile: db.prepare('SELECT * FROM profiles WHERE rsn = ?'),
  getItems: db.prepare('SELECT * FROM collection_items WHERE rsn = ? ORDER BY sort_order ASC'),
  upsertProfile: db.prepare(`
    INSERT INTO profiles (rsn, collection_label, last_sync, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(rsn) DO UPDATE SET
      collection_label = excluded.collection_label,
      last_sync = excluded.last_sync,
      updated_at = excluded.updated_at
  `),
  deleteItems: db.prepare('DELETE FROM collection_items WHERE rsn = ?'),
  insertItem: db.prepare(`
    INSERT INTO collection_items (rsn, item_id, item_name, current_quantity, goal_quantity, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  updateItemQty: db.prepare(`
    UPDATE collection_items SET current_quantity = ? WHERE rsn = ? AND item_name = ?
  `),
  updateLastSync: db.prepare('UPDATE profiles SET last_sync = ?, updated_at = ? WHERE rsn = ?'),
  deleteProfile: db.prepare('DELETE FROM profiles WHERE rsn = ?'),
};

// Transaction helpers
const saveProfileTx = db.transaction((rsn, label, items) => {
  const now = Date.now();
  stmts.upsertProfile.run(rsn, label, now, now);
  stmts.deleteItems.run(rsn);
  items.forEach((item, i) => {
    stmts.insertItem.run(rsn, item.itemId || 0, item.itemName, item.currentQuantity || 0, item.goalQuantity || 1, i);
  });
  return now;
});

const syncQuantitiesTx = db.transaction((rsn, items) => {
  const now = Date.now();
  items.forEach(item => {
    stmts.updateItemQty.run(item.currentQuantity || 0, rsn, item.itemName);
  });
  stmts.updateLastSync.run(now, now, rsn);
  return now;
});

// ============================================================================
// Middleware
// ============================================================================

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50kb' }));

// Rate limiting — generous for a small plugin user base
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // 60 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});
app.use('/api', limiter);

// ============================================================================
// Helpers
// ============================================================================

function profileFromRow(profileRow, itemRows) {
  return {
    rsn: profileRow.rsn,
    registered: true,
    collectionLabel: profileRow.collection_label,
    lastSyncTimestamp: profileRow.last_sync,
    collectionList: itemRows.map(row => ({
      itemId: row.item_id,
      itemName: row.item_name,
      currentQuantity: row.current_quantity,
      goalQuantity: row.goal_quantity,
    }))
  };
}

function validateRsn(rsn) {
  return typeof rsn === 'string' && rsn.length >= 1 && rsn.length <= 12;
}

function validateItems(items) {
  if (!Array.isArray(items)) return false;
  if (items.length > 20) return false;
  return items.every(item =>
    typeof item.itemName === 'string' &&
    item.itemName.length > 0 &&
    item.itemName.length <= 100 &&
    Number.isInteger(item.goalQuantity || 1) &&
    (item.goalQuantity || 1) >= 1
  );
}

// ============================================================================
// Routes
// ============================================================================

/**
 * GET /api/profile/:rsn
 * Returns a player's collection profile, or 404 if not registered.
 */
app.get('/api/profile/:rsn', (req, res) => {
  const rsn = req.params.rsn.trim();
  if (!validateRsn(rsn)) {
    return res.status(400).json({ error: 'Invalid RSN' });
  }

  const profile = stmts.getProfile.get(rsn);
  if (!profile) {
    return res.status(404).json({ error: 'Player not registered' });
  }

  const items = stmts.getItems.all(rsn);
  res.json(profileFromRow(profile, items));
});

/**
 * PUT /api/profile
 * Register or update a player's collection.
 * Body: { rsn, collectionLabel, collectionList: [...] }
 */
app.put('/api/profile', (req, res) => {
  const { rsn, collectionLabel, collectionList } = req.body;

  if (!validateRsn(rsn)) {
    return res.status(400).json({ error: 'Invalid RSN' });
  }
  if (!validateItems(collectionList || [])) {
    return res.status(400).json({ error: 'Invalid collection items (max 20, names required)' });
  }

  const label = (collectionLabel || 'My Collection').slice(0, 50);
  const items = (collectionList || []).slice(0, 20);

  try {
    const now = saveProfileTx(rsn, label, items);
    const profile = stmts.getProfile.get(rsn);
    const savedItems = stmts.getItems.all(rsn);
    res.json(profileFromRow(profile, savedItems));
  } catch (err) {
    console.error('Save profile error:', err);
    res.status(500).json({ error: 'Failed to save profile' });
  }
});

/**
 * POST /api/profile/:rsn/sync
 * Update bank quantities for existing collection items.
 * Body: [{ itemName, currentQuantity }, ...]
 */
app.post('/api/profile/:rsn/sync', (req, res) => {
  const rsn = req.params.rsn.trim();
  if (!validateRsn(rsn)) {
    return res.status(400).json({ error: 'Invalid RSN' });
  }

  const profile = stmts.getProfile.get(rsn);
  if (!profile) {
    return res.status(404).json({ error: 'Player not registered' });
  }

  const items = req.body;
  if (!Array.isArray(items) || items.length > 20) {
    return res.status(400).json({ error: 'Invalid items array' });
  }

  try {
    syncQuantitiesTx(rsn, items);
    res.json({ success: true, syncedAt: Date.now() });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Failed to sync quantities' });
  }
});

/**
 * DELETE /api/profile/:rsn
 * Unregister a player. In production you'd want auth here.
 */
app.delete('/api/profile/:rsn', (req, res) => {
  const rsn = req.params.rsn.trim();
  if (!validateRsn(rsn)) {
    return res.status(400).json({ error: 'Invalid RSN' });
  }

  stmts.deleteProfile.run(rsn);
  res.json({ success: true });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ============================================================================
// Start
// ============================================================================

app.listen(PORT, () => {
  console.log(`✅ Collector Plugin Server running on port ${PORT}`);
  console.log(`   DB: ${DB_PATH}`);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
