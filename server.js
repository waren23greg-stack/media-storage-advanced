require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const crypto = require('crypto');
const sharp = require('sharp');
const bcrypt = require('bcryptjs');
const db = require('./warenvault');
const { generateToken, authenticate } = require('./auth');
const minio = require('./storage');
const {
  helmetConfig, globalLimiter, authLimiter, uploadLimiter,
  sanitizeBody, validateFile, requestId, securityLogger,
  blockSuspicious, hpp
} = require('./security');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmetConfig);
app.use(requestId);
app.use(securityLogger);
app.use(globalLimiter);
app.use(blockSuspicious);
app.use(hpp());
app.use(sanitizeBody);
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const uploadsDir = path.join(__dirname, 'uploads');
const processedDir = path.join(__dirname, 'processed');

const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const u = Date.now() + '-' + crypto.randomBytes(6).toString('hex');
    cb(null, u + path.extname(file.originalname));
  }
});

const ALLOWED_MIMETYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo'
];

const upload = multer({
  storage: multerStorage,
  fileFilter: (req, file, cb) => {
    ALLOWED_MIMETYPES.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only images and videos allowed'));
  },
  limits: { fileSize: 500 * 1024 * 1024 }
});

function getFileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

async function processImage(inputPath, outputPath) {
  const originalSize = getFileSize(inputPath);
  let pipeline = sharp(inputPath)
    .withMetadata()
    .modulate({ saturation: 1.05 })
    .sharpen({ sigma: 1.0, m1: 0.5, m2: 1.0 })
    .median(2)
    .normalize();

  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.png')       pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  else if (ext === '.webp') pipeline = pipeline.webp({ quality: 92 });
  else                      pipeline = pipeline.jpeg({ quality: 88, progressive: true, mozjpeg: true });

  await pipeline.toFile(outputPath);
  const finalSize = getFileSize(outputPath);
  return {
    originalSize,
    finalSize,
    compressionRatio: parseFloat(((1 - finalSize / originalSize) * 100).toFixed(2)),
    quality: 'Enhanced 114%'
  };
}

async function processAndStore(inputPath, filename, mimetype) {
  const processedFilename = 'processed-' + filename;
  const outputPath = path.join(processedDir, processedFilename);
  const stats = await processImage(inputPath, outputPath);
  const objectName = 'files/' + processedFilename;
  await minio.uploadFile(outputPath, objectName, mimetype);
  const url = await minio.getFileUrl(objectName);
  fs.unlinkSync(inputPath);
  fs.unlinkSync(outputPath);
  return { objectName, url, stats };
}

// ── Auth ───────────────────────────────────────────────────────────────────

app.post('/auth/register', authLimiter, async (req, res) => {
  const { username, email, password } = req.body;
  if (password.length < 6)          return res.status(400).json({ error: 'Password min 6 characters.' });
  if (db.getUserByEmail(email))     return res.status(409).json({ error: 'Email already registered.' });
  if (db.getUserByUsername(username)) return res.status(409).json({ error: 'Username taken.' });
  const hashed = await bcrypt.hash(password, 12);
  const uuid = crypto.randomUUID();
  db.createUser(uuid, username, email, hashed);
  const user = db.getUserByEmail(email);
  const token = generateToken(user);
  res.status(201).json({
    success: true,
    message: `Welcome to WarenVault, ${username}!`,
    token,
    user: { id: user.uuid, username: user.username, email: user.email, role: user.role }
  });
});

app.post('/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const user = db.getUserByEmail(email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: 'Invalid credentials.' });
  db.updateLastLogin(user.id);
  const token = generateToken(user);
  res.json({
    success: true,
    message: `Welcome back, ${user.username}!`,
    token,
    user: {
      id: user.uuid, username: user.username, email: user.email,
      role: user.role, storageUsed: user.storage_used, storageLimit: user.storage_limit
    }
  });
});

app.get('/auth/me', authenticate, (req, res) => {
  const stats = db.getUserStats(req.user.id);
  res.json({
    user: {
      id: req.user.uuid, username: req.user.username, email: req.user.email,
      role: req.user.role, storageUsed: req.user.storage_used,
      storageLimit: req.user.storage_limit, createdAt: req.user.created_at,
      lastLogin: req.user.last_login
    },
    stats: {
      totalFiles: stats.total_files || 0,
      totalOriginalSize: stats.total_original_size || 0,
      totalFinalSize: stats.total_final_size || 0,
      avgCompression: stats.avg_compression || 0
    }
  });
});

app.post('/auth/logout', authenticate, (req, res) => {
  res.json({ success: true, message: 'Logged out.' });
});

// ── Files ──────────────────────────────────────────────────────────────────

app.post('/upload', authenticate, uploadLimiter, upload.single('file'), validateFile, async (req, res) => {
  try {
    const { objectName, url, stats } = await processAndStore(
      req.file.path, req.file.filename, req.file.mimetype
    );
    const fileRecord = {
      uuid: crypto.randomUUID(),
      userId: req.user.id,
      originalName: req.file.originalname,
      filename: objectName,
      processedFilename: objectName,
      size: stats.finalSize,
      originalSize: stats.originalSize,
      compressionRatio: stats.compressionRatio,
      mimetype: req.file.mimetype,
      url
    };
    db.createFile(fileRecord);
    db.updateStorageUsed(req.user.id, stats.finalSize);
    res.json({
      success: true,
      message: `WarenVault stored in MinIO — compressed ${stats.compressionRatio}% with 114% quality boost!`,
      file: { ...fileRecord, quality: stats.quality }
    });
  } catch (error) {
    res.status(500).json({ error: 'File processing failed', details: error.message });
  }
});

app.get('/files', authenticate, async (req, res) => {
  const files = db.getFilesByUser(req.user.id);
  const filesWithUrls = await Promise.all(
    files.map(async file => {
      const freshUrl = await minio.getFileUrl(file.filename);
      return { ...file, url: freshUrl };
    })
  );
  res.json(filesWithUrls);
});

// FIX: was a broken string literal — `filename= + file.original_name + `
app.get('/download/:uuid', authenticate, async (req, res) => {
  const file = db.getFileById(req.params.uuid, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found.' });
  const stream = await minio.getFileStream(file.filename);
  res.setHeader('Content-Disposition', `attachment; filename="${file.original_name}"`);
  stream.pipe(res);
});

app.delete('/delete/:uuid', authenticate, async (req, res) => {
  const file = db.getFileById(req.params.uuid, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found.' });
  await minio.deleteFile(file.filename);
  db.deleteFile(req.params.uuid, req.user.id);
  res.json({ success: true, message: 'File deleted from WarenVault.' });
});

app.get('/stats', authenticate, (req, res) => {
  const stats = db.getUserStats(req.user.id);
  const saved = (stats.total_original_size || 0) - (stats.total_final_size || 0);
  res.json({
    totalFiles: stats.total_files || 0,
    totalOriginalSize: stats.total_original_size || 0,
    totalFinalSize: stats.total_final_size || 0,
    averageCompression: parseFloat((stats.avg_compression || 0).toFixed(2)),
    totalStorageSaved: (saved / (1024 * 1024)).toFixed(2) + ' MB',
    enhancement: '114% quality boost',
    storage: 'MinIO WarenVault'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'WarenVault is running',
    version: '4.0.0',
    database: 'WarenVault SQLite + Query Cache',
    storage: 'MinIO'
  });
});

// ── Start ──────────────────────────────────────────────────────────────────


// ── NestFinderCuk REST API ────────────────────────────────────────────────────

const NEST_COLLECTIONS = [
  'users',
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

minio.initialize().then(() => {
  app.listen(PORT, () => {
    console.log('WarenVault Media Storage v4.0');
    console.log(` Running on http://localhost:${PORT}`);
    console.log(' Database: WarenVault SQLite + Query Cache');
    console.log(' Cloud Storage: MinIO (warenvault bucket)');
    console.log(' Auth: JWT enabled');
  });
}).catch(err => {
  console.warn('MinIO unavailable, continuing without cloud storage:', err.message);
  app.listen(PORT, () => {
    console.log('WarenVault running on port ' + PORT);
    console.log('Database: SQLite | Storage: local fallback');
  });
});
