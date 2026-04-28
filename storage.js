const Minio = require('minio');
const path = require('path');
const fs = require('fs');

const client = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || '127.0.0.1',
  port: parseInt(process.env.MINIO_PORT) || 9000,
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'waren',
  secretKey: process.env.MINIO_SECRET_KEY || 'warenvault2024'
});

const BUCKET = process.env.MINIO_BUCKET || 'warenvault';

async function initialize() {
  const exists = await client.bucketExists(BUCKET);
  if (!exists) {
    await client.makeBucket(BUCKET);
    console.log(`WarenVault bucket '${BUCKET}' created.`);
  } else {
    console.log(`WarenVault bucket '${BUCKET}' connected.`);
  }
}

async function uploadFile(localPath, objectName, mimetype) {
  await client.fPutObject(BUCKET, objectName, localPath, { 'Content-Type': mimetype });
  return objectName;
}

async function getFileUrl(objectName) {
  return await client.presignedGetObject(BUCKET, objectName, 7 * 24 * 60 * 60);
}

async function deleteFile(objectName) {
  await client.removeObject(BUCKET, objectName);
}

async function getFileStream(objectName) {
  return await client.getObject(BUCKET, objectName);
}

module.exports = { initialize, uploadFile, getFileUrl, deleteFile, getFileStream };
