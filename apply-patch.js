// apply-patch.js — Run from inside media-storage-advanced folder
// node apply-patch.js
const fs = require('fs');
const crypto = require('crypto');

// ── 1. Patch warenvault.js ─────────────────────────────────────────────────
let wv = fs.readFileSync('warenvault.js', 'utf8');

const SCHEMA_PATCH = `
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
      CREATE INDEX IF NOT EXISTS idx_caretaker_listing  ON caretaker_contacts(listing_id);`;

const METHODS_PATCH = `
  // ── NestFinderCuk helpers ──────────────────────────────────────────────────

  _nestList(table, filters = {}) {
    let sql = \`SELECT * FROM \${table} WHERE 1=1\`;
    const vals = [];
    for (const [k, v] of Object.entries(filters)) {
      const safe = k.replace(/[^a-zA-Z0-9_]/g, '');
      if (safe) { sql += \` AND \${safe} = ?\`; vals.push(v); }
    }
    sql += \` ORDER BY rowid DESC\`;
    return this.db.prepare(sql).all(...vals);
  }

  _nestGet(table, id) {
    return this.db.prepare(\`SELECT * FROM \${table} WHERE id = ?\`).get(id) || null;
  }

  _nestCreate(table, doc) {
    const keys = Object.keys(doc);
    const sql = \`INSERT OR IGNORE INTO \${table} (\${keys.join(',')}) VALUES (\${keys.map(() => '?').join(',')})\`;
    return this.db.prepare(sql).run(...Object.values(doc));
  }

  _nestPatch(table, id, fields) {
    const safe = Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k.replace(/[^a-zA-Z0-9_]/g, ''), v])
    );
    const sets = Object.keys(safe).map(k => \`\${k} = ?\`).join(', ');
    return this.db.prepare(\`UPDATE \${table} SET \${sets}, updated_at = datetime('now') WHERE id = ?\`)
      .run(...Object.values(safe), id);
  }

  _nestDelete(table, id) {
    return this.db.prepare(\`DELETE FROM \${table} WHERE id = ?\`).run(id);
  }

`;

// Insert schema patch just before the closing backtick of db.exec
if (!wv.includes('NestFinderCuk Tables')) {
  wv = wv.replace(
    `CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);\n    \`);`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);${SCHEMA_PATCH}\n    \`);`
  );
  console.log('✓ Schema tables added to warenvault.js');
} else {
  console.log('⚠ Schema already patched, skipping.');
}

// Insert methods before close()
if (!wv.includes('_nestList')) {
  wv = wv.replace('  close() {', METHODS_PATCH + '  close() {');
  console.log('✓ Methods added to warenvault.js');
} else {
  console.log('⚠ Methods already patched, skipping.');
}

fs.writeFileSync('warenvault.js', wv);

// ── 2. Patch server.js ─────────────────────────────────────────────────────
let sv = fs.readFileSync('server.js', 'utf8');

const ROUTES_PATCH = `
// ── NestFinderCuk REST API ────────────────────────────────────────────────────

const NEST_COLLECTIONS = [
  'listings','caretaker_contacts','favourites','reviews',
  'payments','reports','storage_seekers','storage_hosts',
  'storage_bookings','host_verifications'
];

app.get('/nest/:collection', (req, res) => {
  const { collection } = req.params;
  if (!NEST_COLLECTIONS.includes(collection))
    return res.status(404).json({ error: 'Unknown collection' });
  const filters = {};
  for (const [k, v] of Object.entries(req.query)) {
    const safe = k.replace(/[^a-zA-Z0-9_]/g, '');
    if (safe) filters[safe] = v;
  }
  try { res.json(db._nestList(collection, filters)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/nest/:collection/:id', (req, res) => {
  const { collection, id } = req.params;
  if (!NEST_COLLECTIONS.includes(collection))
    return res.status(404).json({ error: 'Unknown collection' });
  const doc = db._nestGet(collection, id);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(doc);
});

app.post('/nest/:collection', authenticate, (req, res) => {
  const { collection } = req.params;
  if (!NEST_COLLECTIONS.includes(collection))
    return res.status(404).json({ error: 'Unknown collection' });
  const doc = { id: crypto.randomUUID(), ...req.body, created_at: new Date().toISOString() };
  try { db._nestCreate(collection, doc); res.status(201).json(doc); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/nest/:collection/:id', authenticate, (req, res) => {
  const { collection, id } = req.params;
  if (!NEST_COLLECTIONS.includes(collection))
    return res.status(404).json({ error: 'Unknown collection' });
  if (!db._nestGet(collection, id)) return res.status(404).json({ error: 'Not found' });
  try { db._nestPatch(collection, id, req.body); res.json(db._nestGet(collection, id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/nest/:collection/:id', authenticate, (req, res) => {
  const { collection, id } = req.params;
  if (!NEST_COLLECTIONS.includes(collection))
    return res.status(404).json({ error: 'Unknown collection' });
  db._nestDelete(collection, id);
  res.json({ success: true });
});

// Bulk import listings (no auth needed for initial seed)
app.post('/nest/listings/import', (req, res) => {
  const listings = req.body;
  if (!Array.isArray(listings)) return res.status(400).json({ error: 'Send an array' });
  let count = 0;
  for (const r of listings) {
    try { db._nestCreate('listings', { id: r.id || crypto.randomUUID(), ...r }); count++; } catch {}
  }
  res.json({ imported: count });
});

`;

if (!sv.includes('NestFinderCuk REST API')) {
  sv = sv.replace('minio.initialize().then', ROUTES_PATCH + 'minio.initialize().then');
  fs.writeFileSync('server.js', sv);
  console.log('✓ Routes added to server.js');
} else {
  console.log('⚠ Routes already patched, skipping.');
}

console.log('\nDone. Now run: npm start');
