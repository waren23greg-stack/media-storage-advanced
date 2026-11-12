const Minio = require('minio');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const BUCKET = process.env.MINIO_BUCKET || 'warenvault';
const LOCAL_DIR = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, 'storage'));
const URL_TTL_SECONDS = 7 * 24 * 60 * 60;

// MinIO is used only when fully configured and reachable; otherwise local disk.
const { MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY } = process.env;
const client = (MINIO_ENDPOINT && MINIO_ACCESS_KEY && MINIO_SECRET_KEY)
  ? new Minio.Client({
      endPoint: MINIO_ENDPOINT,
      port: parseInt(process.env.MINIO_PORT) || 9000,
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey: MINIO_ACCESS_KEY,
      secretKey: MINIO_SECRET_KEY
    })
  : null;
let useMinio = false;

async function initialize() {
  if (client) {
    try {
      const exists = await client.bucketExists(BUCKET);
      if (!exists) {
        await client.makeBucket(BUCKET);
        console.log(`WarenVault bucket '${BUCKET}' created.`);
      } else {
        console.log(`WarenVault bucket '${BUCKET}' connected.`);
      }
      useMinio = true;
      return;
    } catch (err) {
      console.warn(`MinIO unavailable (${err.message}), using local disk storage`);
    }
  }
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  console.log(`Storage: local disk at ${LOCAL_DIR}`);
}

const mode = () => (useMinio ? 'minio' : 'local');

function sign(objectName, exp) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required to sign file URLs');
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${objectName}.${exp}`).digest('hex');
}

function verifySignedUrl(objectName, exp, sig) {
  const e = Number(exp);
  if (!objectName || !sig || !Number.isFinite(e) || e < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(objectName, e), 'hex');
  const given = Buffer.from(String(sig), 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function localPath(objectName) {
  const p = path.resolve(LOCAL_DIR, objectName);
  if (!p.startsWith(LOCAL_DIR + path.sep)) throw new Error('Invalid object name');
  return p;
}

async function uploadFile(localFile, objectName, mimetype) {
  if (useMinio) {
    await client.fPutObject(BUCKET, objectName, localFile, { 'Content-Type': mimetype });
  } else {
    const dest = localPath(objectName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(localFile, dest);
  }
  return objectName;
}

async function getFileUrl(objectName) {
  if (useMinio) return client.presignedGetObject(BUCKET, objectName, URL_TTL_SECONDS);
  const exp = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
  return `/media/${objectName}?exp=${exp}&sig=${sign(objectName, exp)}`;
}

async function deleteFile(objectName) {
  if (useMinio) return client.removeObject(BUCKET, objectName);
  fs.rmSync(localPath(objectName), { force: true });
}

async function getFileStream(objectName) {
  if (useMinio) return client.getObject(BUCKET, objectName);
  return fs.createReadStream(localPath(objectName));
}

module.exports = { initialize, mode, uploadFile, getFileUrl, deleteFile, getFileStream, verifySignedUrl, localPath };
