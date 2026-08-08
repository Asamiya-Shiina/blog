'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { z } = require('zod');

const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || './data/uploads');
const MAX_BYTES = parseInt(process.env.UPLOAD_MAX_BYTES || '10485760', 10);

const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf', 'text/plain', 'text/markdown',
]);
const ALLOWED_EXT = new Set(['png','jpg','jpeg','gif','webp','svg','pdf','txt','md','markdown']);

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdir(UPLOAD_DIR, { recursive: true }, err => cb(err, UPLOAD_DIR));
  },
  filename: (_req, file, cb) => {
    const ext = extOf(file.originalname) || 'bin';
    const id = crypto.randomUUID();
    cb(null, `${id}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mime = file.mimetype;
    const ext = extOf(file.originalname);
    if (mime === 'application/octet-stream' && ALLOWED_EXT.has(ext)) {
      return cb(null, true);
    }
    if (ALLOWED_MIME.has(mime) || (mime.startsWith('image/') && ALLOWED_EXT.has(ext))) {
      return cb(null, true);
    }
    return cb(new Error('UNSUPPORTED_TYPE'));
  },
});

function rowToFile(row) {
  return {
    id: row.id,
    filename: row.filename,
    original: row.original,
    mime: row.mime,
    size: row.size,
    uploaded_at: row.uploaded_at,
    url: `/uploads/${row.filename}`,
  };
}

// 列表
router.get('/', requireAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const pageSize = 30;
  const total = db.prepare('SELECT COUNT(*) AS n FROM files').get().n;
  const rows = db.prepare(`
    SELECT id, filename, original, mime, size, uploaded_at
    FROM files
    ORDER BY uploaded_at DESC
    LIMIT ? OFFSET ?
  `).all(pageSize, (page - 1) * pageSize);
  res.json({
    items: rows.map(rowToFile),
    total,
    page,
    page_size: pageSize,
  });
});

// 上传
router.post('/', requireAuth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file too large' });
      if (err.message === 'UNSUPPORTED_TYPE') return res.status(415).json({ error: 'unsupported file type' });
      return res.status(400).json({ error: err.message || 'upload failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'no file' });

    const info = db.prepare(`
      INSERT INTO files (filename, original, mime, size)
      VALUES (?, ?, ?, ?)
    `).run(req.file.filename, req.file.originalname, req.file.mimetype, req.file.size);

    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(rowToFile(row));
  });
});

// 删除
router.delete('/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const row = db.prepare('SELECT filename FROM files WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });

  const info = db.prepare('DELETE FROM files WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });

  const filePath = path.join(UPLOAD_DIR, row.filename);
  try { await fsp.unlink(filePath); } catch (e) {
    if (e.code !== 'ENOENT') console.warn('unlink failed:', e.message);
  }
  res.status(204).end();
});

module.exports = router;
