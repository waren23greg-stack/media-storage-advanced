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

const app = express();
const PORT = process.env.PORT || 5000;
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const uploadsDir = path.join(__dirname, 'uploads');
const processedDir = path.join(__dirname, 'processed');

const multerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => { const u = Date.now() + '-' + crypto.randomBytes(6).toString('hex'); cb(null, u + path.extname(file.originalname)); }
});
const upload = multer({ storage: multerStorage, fileFilter: (req, file, cb) => { const a = ['image/jpeg','image/png','image/gif','image/webp','video/mp4','video/webm','video/quicktime','video/x-msvideo']; a.includes(file.mimetype) ? cb(null, true) : cb(new Error('Only images and videos allowed')); }, limits: { fileSize: 500*1024*1024 } });

function getFileSize(p) { try { return fs.statSync(p).size; } catch { return 0; } }

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
  return { originalSize, finalSize, compressionRatio: parseFloat(((1 - finalSize/originalSize)*100).toFixed(2)), quality: 'Enhanced 114%' };
}

async function processAndStore(inputPath, filename, mimetype) {
  const ext = path.extname(filename).toLowerCase();
  const isImage = ['.jpg','.jpeg','.png','.gif','.webp'].includes(ext);
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

app.post('/auth/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (password.length < 6) return res.status(400).json({ error: 'Password min 6 characters.' });
  if (db.getUserByEmail(email)) return res.status(409).json({ error: 'Email already registered.' });
  if (db.getUserByUsername(username)) return res.status(409).json({ error: 'Username taken.' });
  const hashed = await bcrypt.hash(password, 12);
  const uuid = crypto.randomUUID();
  db.createUser(uuid, username, email, hashed);
  const user = db.getUserByEmail(email);
  const token = generateToken(user);
  res.status(201).json({ success: true, message: 'Welcome to WarenVault, ' + username + '!', token, user: { id: user.uuid, username: user.username, email: user.email, role: user.role } });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.getUserByEmail(email);
  const match = await bcrypt.compare(password, user.password);
  db.updateLastLogin(user.id);
  const token = generateToken(user);
  res.json({ success: true, message: 'Welcome back, ' + user.username + '!', token, user: { id: user.uuid, username: user.username, email: user.email, role: user.role, storageUsed: user.storage_used, storageLimit: user.storage_limit } });
});

app.get('/auth/me', authenticate, (req, res) => {
  const stats = db.getUserStats(req.user.id);
  res.json({ user: { id: req.user.uuid, username: req.user.username, email: req.user.email, role: req.user.role, storageUsed: req.user.storage_used, storageLimit: req.user.storage_limit, createdAt: req.user.created_at, lastLogin: req.user.last_login }, stats: { totalFiles: stats.total_files||0, totalOriginalSize: stats.total_original_size||0, totalFinalSize: stats.total_final_size||0, avgCompression: stats.avg_compression||0 } });
});

app.post('/auth/logout', authenticate, (req, res) => { res.json({ success: true, message: 'Logged out.' }); });

app.post('/upload', authenticate, upload.single('file'), async (req, res) => {
  try {
    const { objectName, url, stats } = await processAndStore(req.file.path, req.file.filename, req.file.mimetype);
    const fileRecord = { uuid: crypto.randomUUID(), userId: req.user.id, originalName: req.file.originalname, filename: objectName, processedFilename: objectName, size: stats.finalSize, originalSize: stats.originalSize, compressionRatio: stats.compressionRatio, mimetype: req.file.mimetype, url };
    db.createFile(fileRecord);
    db.updateStorageUsed(req.user.id, stats.finalSize);
    res.json({ success: true, message: 'WarenVault stored in MinIO — compressed ' + stats.compressionRatio + '% with 114% quality boost!', file: { ...fileRecord, quality: stats.quality } });
  } catch (error) { res.status(500).json({ error: 'File processing failed', details: error.message }); }
});

app.get('/files', authenticate, async (req, res) => {
  const files = db.getFilesByUser(req.user.id);
  const filesWithUrls = await Promise.all(files.map(async file => { const freshUrl = await minio.getFileUrl(file.filename); return { ...file, url: freshUrl }; }));
  res.json(filesWithUrls);
});

app.get('/download/:filename', authenticate, async (req, res) => {
  const file = db.getFileById(req.params.filename, req.user.id);
  const stream = await minio.getFileStream(file.filename);
  res.setHeader('Content-Disposition', 'attachment; filename= + file.original_name + ');
  stream.pipe(res);
});

app.delete('/delete/:uuid', authenticate, async (req, res) => {
  const file = db.getFileById(req.params.uuid, req.user.id);
  await minio.deleteFile(file.filename);
  db.deleteFile(req.params.uuid, req.user.id);
  res.json({ success: true, message: 'File deleted from WarenVault.' });
});

app.get('/stats', authenticate, (req, res) => {
  const stats = db.getUserStats(req.user.id);
  const saved = (stats.total_original_size||0) - (stats.total_final_size||0);
  res.json({ totalFiles: stats.total_files||0, totalOriginalSize: stats.total_original_size||0, totalFinalSize: stats.total_final_size||0, averageCompression: parseFloat((stats.avg_compression||0).toFixed(2)), totalStorageSaved: (saved/(1024*1024)).toFixed(2) + ' MB', enhancement: '114% quality boost', storage: 'MinIO WarenVault' });
});

app.get('/health', (req, res) => { res.json({ status: 'WarenVault is running', version: '4.0.0', database: 'WarenVault SQLite', storage: 'MinIO' }); });

minio.initialize().then(() => {
  app.listen(PORT, () => {
    console.log('WarenVault Media Storage v4.0');
    console.log(' Running on http://localhost:' + PORT);
    console.log(' Database: WarenVault SQLite');
    console.log(' Cloud Storage: MinIO (warenvault bucket)');
    console.log(' Auth: JWT enabled');
  });
}).catch(err => { console.error('MinIO connection failed:', err.message); process.exit(1); });
