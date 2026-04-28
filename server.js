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

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const uploadsDir = path.join(__dirname, 'uploads');
const processedDir = path.join(__dirname, 'processed');
[uploadsDir, processedDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + crypto.randomBytes(6).toString('hex');
    cb(null, unique + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/gif','image/webp','video/mp4','video/webm','video/quicktime','video/x-msvideo'];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only images and videos allowed'));
  },
  limits: { fileSize: 500 * 1024 * 1024 }
});

function getFileSize(filePath) {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

async function processImage(inputPath, outputPath) {
  const originalSize = getFileSize(inputPath);
  const metadata = await sharp(inputPath).metadata();
  let pipeline = sharp(inputPath).withMetadata().modulate({ saturation: 1.05 }).sharpen({ sigma: 1.0, m1: 0.5, m2: 1.0 }).median(2).normalize();
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.png') pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
  else if (ext === '.webp') pipeline = pipeline.webp({ quality: 92 });
  else pipeline = pipeline.jpeg({ quality: 88, progressive: true, mozjpeg: true });
  await pipeline.toFile(outputPath);
  const finalSize = getFileSize(outputPath);
  return { originalSize, finalSize, compressionRatio: parseFloat(((1 - finalSize / originalSize) * 100).toFixed(2)), quality: 'Enhanced 114%', format: metadata.format };
}

async function processMedia(inputPath, filename) {
  const ext = path.extname(filename).toLowerCase();
  const outputPath = path.join(processedDir, 'processed-' + filename);
  const isImage = ['.jpg','.jpeg','.png','.gif','.webp'].includes(ext);
  if (!isImage) throw new Error('Unsupported media type');
  const stats = await processImage(inputPath, outputPath);
  return { outputPath, stats };
}

// ── AUTH ROUTES ──────────────────────────────────────────

app.post('/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Username, email and password are required.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.getUserByEmail(email))
    return res.status(409).json({ error: 'Email already registered.' });
  if (db.getUserByUsername(username))
    return res.status(409).json({ error: 'Username already taken.' });
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

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });
  const user = db.getUserByEmail(email);
  if (!user)
    return res.status(401).json({ error: 'Invalid credentials.' });
  const match = await bcrypt.compare(password, user.password);
  if (!match)
    return res.status(401).json({ error: 'Invalid credentials.' });
  db.updateLastLogin(user.id);
  const token = generateToken(user);
  res.json({
    success: true,
    message: `Welcome back, ${user.username}!`,
    token,
    user: { id: user.uuid, username: user.username, email: user.email, role: user.role }
  });
});

app.get('/auth/me', authenticate, (req, res) => {
  const stats = db.getUserStats(req.user.id);
  res.json({
    user: {
      id: req.user.uuid,
      username: req.user.username,
      email: req.user.email,
      role: req.user.role,
      storageUsed: req.user.storage_used,
      storageLimit: req.user.storage_limit,
      createdAt: req.user.created_at,
      lastLogin: req.user.last_login
    },
    stats: {
      totalFiles: stats.total_files || 0,
      totalOriginalSize: stats.total_original_size || 0,
      totalFinalSize: stats.total_final_size || 0,
      avgCompression: stats.avg_compression || 0,
      storageSaved: ((stats.total_original_size || 0) - (stats.total_final_size || 0))
    }
  });
});

app.post('/auth/logout', authenticate, (req, res) => {
  res.json({ success: true, message: 'Logged out successfully.' });
});

// ── FILE ROUTES (protected) ──────────────────────────────

app.post('/upload', authenticate, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided.' });
  try {
    const { outputPath, stats } = await processMedia(req.file.path, req.file.filename);
    const fileRecord = {
      uuid: crypto.randomUUID(),
      userId: req.user.id,
      originalName: req.file.originalname,
      filename: path.basename(outputPath),
      processedFilename: path.basename(outputPath),
      size: stats.finalSize,
      originalSize: stats.originalSize,
      compressionRatio: stats.compressionRatio,
      mimetype: req.file.mimetype,
      url: `${req.protocol}://${req.get('host')}/download/${path.basename(outputPath)}`
    };
    db.createFile(fileRecord);
    db.updateStorageUsed(req.user.id, stats.finalSize);
    res.json({
      success: true,
      message: `WarenVault compressed by ${stats.compressionRatio}% with 114% quality boost!`,
      file: { ...fileRecord, quality: stats.quality, enhancement: '114%' }
    });
  } catch (error) {
    res.status(500).json({ error: 'File processing failed', details: error.message });
  }
});

app.get('/files', authenticate, (req, res) => {
  const files = db.getFilesByUser(req.user.id);
  res.json(files);
});

app.get('/download/:filename', (req, res) => {
  const filePath = path.join(processedDir, req.params.filename);
  if (!path.resolve(filePath).startsWith(path.resolve(processedDir)))
    return res.status(403).json({ error: 'Access denied.' });
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: 'File not found.' });
  res.download(filePath);
});

app.delete('/delete/:uuid', authenticate, (req, res) => {
  const file = db.getFileById(req.params.uuid, req.user.id);
  if (!file) return res.status(404).json({ error: 'File not found.' });
  const filePath = path.join(processedDir, file.processed_filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  db.deleteFile(req.params.uuid, req.user.id);
  res.json({ success: true, message: 'File deleted.' });
});

app.get('/stats', authenticate, (req, res) => {
  const stats = db.getUserStats(req.user.id);
  const saved = (stats.total_original_size || 0) - (stats.total_final_size || 0);
  res.json({
    totalFiles: stats.total_files || 0,
    totalOriginalSize: stats.total_original_size || 0,
    totalFinalSize: stats.total_final_size || 0,
    averageCompression: parseFloat((stats.avg_compression || 0).toFixed(2)),
    totalStorageSaved: `${(saved / (1024 * 1024)).toFixed(2)} MB`,
    enhancement: '114% quality boost'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'WarenVault is running', version: '3.0.0', database: 'WarenVault SQLite' });
});

app.listen(PORT, () => {
  console.log(`\n WarenVault Media Storage v3.0`);
  console.log(` Running on http://localhost:${PORT}`);
  console.log(` Database: WarenVault SQLite`);
  console.log(` Auth: JWT enabled\n`);
});
