const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'warenvault.db');

class WarenVault {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
    console.log('WarenVault database initialized at:', DB_PATH);
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        storage_used INTEGER DEFAULT 0,
        storage_limit INTEGER DEFAULT 5368709120,
        created_at TEXT DEFAULT (datetime('now')),
        last_login TEXT
      );

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL,
        user_id INTEGER NOT NULL,
        original_name TEXT NOT NULL,
        filename TEXT NOT NULL,
        processed_filename TEXT NOT NULL,
        size INTEGER NOT NULL,
        original_size INTEGER NOT NULL,
        compression_ratio REAL NOT NULL,
        mimetype TEXT NOT NULL,
        uploaded_at TEXT DEFAULT (datetime('now')),
        url TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `);
  }

  // User methods
  createUser(uuid, username, email, hashedPassword) {
    const stmt = this.db.prepare(`
      INSERT INTO users (uuid, username, email, password)
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(uuid, username, email, hashedPassword);
  }

  getUserByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }

  getUserByUsername(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }

  getUserById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  getUserByUUID(uuid) {
    return this.db.prepare('SELECT * FROM users WHERE uuid = ?').get(uuid);
  }

  updateLastLogin(userId) {
    this.db.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).run(userId);
  }

  updateStorageUsed(userId, bytes) {
    this.db.prepare('UPDATE users SET storage_used = storage_used + ? WHERE id = ?').run(bytes, userId);
  }

  // File methods
  createFile(data) {
    const stmt = this.db.prepare(`
      INSERT INTO files (uuid, user_id, original_name, filename, processed_filename, size, original_size, compression_ratio, mimetype, url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      data.uuid, data.userId, data.originalName, data.filename,
      data.processedFilename, data.size, data.originalSize,
      data.compressionRatio, data.mimetype, data.url
    );
  }

  getFilesByUser(userId) {
    return this.db.prepare('SELECT * FROM files WHERE user_id = ? ORDER BY uploaded_at DESC').all(userId);
  }

  getFileById(uuid, userId) {
    return this.db.prepare('SELECT * FROM files WHERE uuid = ? AND user_id = ?').get(uuid, userId);
  }

  deleteFile(uuid, userId) {
    return this.db.prepare('DELETE FROM files WHERE uuid = ? AND user_id = ?').run(uuid, userId);
  }

  getUserStats(userId) {
    return this.db.prepare(`
      SELECT
        COUNT(*) as total_files,
        SUM(original_size) as total_original_size,
        SUM(size) as total_final_size,
        AVG(compression_ratio) as avg_compression
      FROM files WHERE user_id = ?
    `).get(userId);
  }

  // Session methods
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

  close() {
    this.db.close();
  }
}

module.exports = new WarenVault();
