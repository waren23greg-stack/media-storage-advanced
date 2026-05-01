const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'warenvault.db');

// ─────────────────────────────────────────────────────────────────────────────
// In-memory TTL query cache
// Keys are namespaced strings: "user:email:x", "files:user:1", "stats:user:1"
// Writes always invalidate the affected keys so reads are never stale.
// ─────────────────────────────────────────────────────────────────────────────
class QueryCache {
  constructor() {
    this.store = new Map();
    // Passive eviction sweep every 60 s (unref so it won't keep the process alive)
    setInterval(() => this._sweep(), 60_000).unref();
  }

  set(key, value, ttlMs = 30_000) {
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) { this.store.delete(key); return null; }
    return entry.value;
  }

  /** Remove one or more exact keys */
  invalidate(...keys) {
    for (const k of keys) this.store.delete(k);
  }

  /** Remove every key that starts with a prefix (e.g. 'user:') */
  invalidatePrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  _sweep() {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expires) this.store.delete(key);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WarenVault — SQLite database layer
// ─────────────────────────────────────────────────────────────────────────────
class WarenVault {
  constructor() {
    this.db = new Database(DB_PATH);
    this.cache = new QueryCache();
    this._applyPragmas();
    this._initSchema();
    console.log('WarenVault database initialized at:', DB_PATH);
  }

  // ── Pragmas ────────────────────────────────────────────────────────────────

  _applyPragmas() {
    // WAL: concurrent readers never block the writer
    this.db.pragma('journal_mode = WAL');
    // NORMAL sync is safe under WAL and ~3× faster than FULL
    this.db.pragma('synchronous = NORMAL');
    // Enforce FK constraints
    this.db.pragma('foreign_keys = ON');
    // 32 MB page cache kept in memory (negative value = kibibytes)
    this.db.pragma('cache_size = -32000');
    // Temp tables/indexes in memory instead of disk
    this.db.pragma('temp_store = MEMORY');
    // 64 MB memory-mapped I/O for sequential reads
    this.db.pragma('mmap_size = 67108864');
  }

  // ── Schema + Indexes ───────────────────────────────────────────────────────

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid          TEXT    UNIQUE NOT NULL,
        username      TEXT    UNIQUE NOT NULL,
        email         TEXT    UNIQUE NOT NULL,
        password      TEXT    NOT NULL,
        role          TEXT    DEFAULT 'user',
        storage_used  INTEGER DEFAULT 0,
        storage_limit INTEGER DEFAULT 5368709120,
        created_at    TEXT    DEFAULT (datetime('now')),
        last_login    TEXT
      );

      CREATE TABLE IF NOT EXISTS files (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid               TEXT    UNIQUE NOT NULL,
        user_id            INTEGER NOT NULL,
        original_name      TEXT    NOT NULL,
        filename           TEXT    NOT NULL,
        processed_filename TEXT    NOT NULL,
        size               INTEGER NOT NULL,
        original_size      INTEGER NOT NULL,
        compression_ratio  REAL    NOT NULL,
        mimetype           TEXT    NOT NULL,
        uploaded_at        TEXT    DEFAULT (datetime('now')),
        url                TEXT    NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        token_hash TEXT    NOT NULL,
        created_at TEXT    DEFAULT (datetime('now')),
        expires_at TEXT    NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      -- ── Indexes ──────────────────────────────────────────────────────────

      -- Fast login / registration checks
      CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_uuid     ON users(uuid);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

      -- Composite index: satisfies getFilesByUser ORDER BY uploaded_at DESC
      -- without a separate sort step (index already stores rows in that order)
      CREATE INDEX IF NOT EXISTS idx_files_user_uploaded
        ON files(user_id, uploaded_at DESC);

      -- Covering index for getUserStats: SQLite can answer the entire
      -- COUNT/SUM/AVG query from the index alone, never touching the table heap
      CREATE INDEX IF NOT EXISTS idx_files_stats
        ON files(user_id, original_size, size, compression_ratio);

      -- UUID point-lookup used by getFileById and deleteFile
      CREATE INDEX IF NOT EXISTS idx_files_uuid ON files(uuid);

      -- Session token lookup (used by authenticate middleware)
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
      -- NestFinderCuk Tables
      CREATE TABLE IF NOT EXISTS listings (
        id               TEXT PRIMARY KEY,
        title            TEXT NOT NULL,
        type             TEXT,
        price            REAL,
        location         TEXT,
        description      TEXT,
        water_included   INTEGER DEFAULT 0,
        wifi_available   INTEGER DEFAULT 0,
        available        INTEGER DEFAULT 1,
        photos           TEXT DEFAULT '[]',
        contact_fee      REAL,
        listing_type     TEXT DEFAULT 'rental',
        price_per_night  REAL,
        max_guests       INTEGER,
        amenities        TEXT,
        min_nights       INTEGER,
        latitude         REAL,
        longitude        REAL,
        created_at       TEXT DEFAULT (datetime('now')),
        updated_at       TEXT
      );
      CREATE TABLE IF NOT EXISTS caretaker_contacts (
        id TEXT PRIMARY KEY, listing_id TEXT, caretaker_name TEXT,
        phone TEXT, user_id TEXT,
        FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS favourites (
        id TEXT PRIMARY KEY, user_uid TEXT NOT NULL, listing_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_uid, listing_id)
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, user_uid TEXT NOT NULL,
        rating INTEGER, comment TEXT, created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, user_uid TEXT, listing_id TEXT, amount REAL,
        status TEXT DEFAULT 'pending', method TEXT, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, user_uid TEXT, listing_id TEXT, reason TEXT,
        details TEXT, status TEXT DEFAULT 'open', created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS storage_seekers (
        id TEXT PRIMARY KEY, user_uid TEXT, name TEXT, phone TEXT,
        location TEXT, note TEXT, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS storage_hosts (
        id TEXT PRIMARY KEY, user_uid TEXT, name TEXT, phone TEXT,
        location TEXT, space_size TEXT, price REAL, available INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS storage_bookings (
        id TEXT PRIMARY KEY, seeker_id TEXT, host_id TEXT, status TEXT DEFAULT 'pending',
        start_date TEXT, end_date TEXT, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS host_verifications (
        id TEXT PRIMARY KEY, user_uid TEXT, status TEXT DEFAULT 'pending',
        doc_url TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_listings_location  ON listings(location);
      CREATE INDEX IF NOT EXISTS idx_listings_type      ON listings(type);
      CREATE INDEX IF NOT EXISTS idx_listings_available ON listings(available);
      CREATE INDEX IF NOT EXISTS idx_favourites_user    ON favourites(user_uid);
      CREATE INDEX IF NOT EXISTS idx_reviews_listing    ON reviews(listing_id);
      CREATE INDEX IF NOT EXISTS idx_caretaker_listing  ON caretaker_contacts(listing_id);
    `);
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  createUser(uuid, username, email, hashedPassword) {
    const result = this.db.prepare(`
      INSERT INTO users (uuid, username, email, password) VALUES (?, ?, ?, ?)
    `).run(uuid, username, email, hashedPassword);
    return result;
  }

  getUserByEmail(email) {
    const key = `user:email:${email}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const user = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user) this.cache.set(key, user, 60_000);
    return user || null;
  }

  getUserByUsername(username) {
    // Registration-time check — low frequency, skip cache
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
  }

  getUserById(id) {
    const key = `user:id:${id}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (user) this.cache.set(key, user, 60_000);
    return user || null;
  }

  getUserByUUID(uuid) {
    return this.db.prepare('SELECT * FROM users WHERE uuid = ?').get(uuid) || null;
  }

  updateLastLogin(userId) {
    this.db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(userId);
    // Evict cached user rows so next read reflects the new timestamp
    this.cache.invalidatePrefix('user:');
  }

  updateStorageUsed(userId, bytes) {
    this.db.prepare(`
      UPDATE users SET storage_used = storage_used + ? WHERE id = ?
    `).run(bytes, userId);
    this.cache.invalidatePrefix('user:');
  }

  // ── Files ──────────────────────────────────────────────────────────────────

  createFile(data) {
    const result = this.db.prepare(`
      INSERT INTO files
        (uuid, user_id, original_name, filename, processed_filename,
         size, original_size, compression_ratio, mimetype, url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.uuid, data.userId, data.originalName, data.filename,
      data.processedFilename, data.size, data.originalSize,
      data.compressionRatio, data.mimetype, data.url
    );
    // Invalidate the file list and stats for this user
    this.cache.invalidate(
      `files:user:${data.userId}`,
      `stats:user:${data.userId}`
    );
    return result;
  }

  getFilesByUser(userId) {
    const key = `files:user:${userId}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const files = this.db.prepare(`
      SELECT * FROM files WHERE user_id = ? ORDER BY uploaded_at DESC
    `).all(userId);
    // Short TTL — invalidated immediately on upload/delete anyway
    this.cache.set(key, files, 15_000);
    return files;
  }

  getFileById(uuid, userId) {
    // Point-lookup, not worth caching (single row, rare repeat reads)
    return this.db.prepare(`
      SELECT * FROM files WHERE uuid = ? AND user_id = ?
    `).get(uuid, userId) || null;
  }

  deleteFile(uuid, userId) {
    // Read first so we can reclaim storage_used accurately
    const file = this.getFileById(uuid, userId);
    const result = this.db.prepare(`
      DELETE FROM files WHERE uuid = ? AND user_id = ?
    `).run(uuid, userId);

    if (file) {
      // Reclaim the storage quota
      this.db.prepare(`
        UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE id = ?
      `).run(file.size, userId);
      this.cache.invalidate(
        `files:user:${userId}`,
        `stats:user:${userId}`
      );
      this.cache.invalidatePrefix('user:');
    }
    return result;
  }

  getUserStats(userId) {
    const key = `stats:user:${userId}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    // COALESCE guards against NULL when the user has no files yet
    const stats = this.db.prepare(`
      SELECT
        COUNT(*)                            AS total_files,
        COALESCE(SUM(original_size), 0)    AS total_original_size,
        COALESCE(SUM(size), 0)             AS total_final_size,
        COALESCE(AVG(compression_ratio), 0) AS avg_compression
      FROM files WHERE user_id = ?
    `).get(userId);
    this.cache.set(key, stats, 30_000);
    return stats;
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  createSession(userId, tokenHash, expiresAt) {
    return this.db.prepare(`
      INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)
    `).run(userId, tokenHash, expiresAt);
  }

  deleteSession(tokenHash) {
    return this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteUserSessions(userId) {
    return this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }


  // ── NestFinderCuk helpers ──────────────────────────────────────────────────

  _nestList(table, filters = {}) {
    let sql = `SELECT * FROM ${table} WHERE 1=1`;
    const vals = [];
    for (const [k, v] of Object.entries(filters)) {
      const safe = k.replace(/[^a-zA-Z0-9_]/g, '');
      if (safe) { sql += ` AND ${safe} = ?`; vals.push(v); }
    }
    sql += ` ORDER BY rowid DESC`;
    return this.db.prepare(sql).all(...vals);
  }

  _nestGet(table, id) {
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) || null;
  }

  _nestCreate(table, doc) {
    const keys = Object.keys(doc);
    const sql = `INSERT OR IGNORE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    return this.db.prepare(sql).run(...Object.values(doc));
  }

  _nestPatch(table, id, fields) {
    const safe = Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k.replace(/[^a-zA-Z0-9_]/g, ''), v])
    );
    const sets = Object.keys(safe).map(k => `${k} = ?`).join(', ');
    return this.db.prepare(`UPDATE ${table} SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .run(...Object.values(safe), id);
  }

  _nestDelete(table, id) {
    return this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  }

  close() {
    this.db.close();
  }
}

module.exports = new WarenVault();
