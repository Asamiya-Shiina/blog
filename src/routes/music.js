'use strict';

// —— 音乐路由 ——
// 处理：列表、上传、删除、设置当前播放歌曲
// 公开接口：GET /api/music/active  （前台播放器调用）
// 管理接口：其余全部需要登录

const path = require('path');
const fs = require('fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireAdmin } = require('../auth');

const db = require('../db');

const router = express.Router();

// 音乐文件存放目录（与 server.js 中的静态挂载保持一致）
const MUSIC_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'music');
fs.mkdirSync(MUSIC_DIR, { recursive: true });

// 允许的 MIME 类型与对应扩展名
// 仅放行主流浏览器原生支持的格式，避免上传奇怪容器
const ALLOWED_MIME = {
  'audio/mpeg':    '.mp3',
  'audio/mp3':     '.mp3',
  'audio/wav':     '.wav',
  'audio/x-wav':   '.wav',
  'audio/wave':    '.wav',
  'audio/ogg':     '.ogg',
  'audio/flac':    '.flac',
  'audio/x-flac':  '.flac',
  'audio/mp4':     '.m4a',
  'audio/x-m4a':   '.m4a',
  'audio/aac':     '.aac',
  'audio/x-aac':   '.aac',
};

// 单文件大小上限：15MB，对一首完整歌曲绰绰有余
const MAX_SIZE = 15 * 1024 * 1024;

// 写操作限流：15 分钟最多 30 次
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many requests, try again later' },
});

// 数据库行 → 歌曲对象
function rowToSong(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    original_name: row.original_name,
    mime: row.mime,
    size_bytes: row.size_bytes,
    src: `/audio/${encodeURIComponent(row.filename)}`,
    created_at: row.created_at,
  };
}

// 取当前激活的歌曲（公开）
router.get('/active', (_req, res) => {
  const setting = db.prepare('SELECT active_id FROM music_settings WHERE id = 1').get();
  if (!setting || !setting.active_id) return res.json({ song: null });
  const row = db.prepare('SELECT * FROM music WHERE id = ?').get(setting.active_id);
  if (!row) return res.json({ song: null });
  res.json({ song: rowToSong(row) });
});

// 列出所有歌曲（需登录）
router.get('/', requireAuth, requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT * FROM music ORDER BY created_at DESC').all();
  const setting = db.prepare('SELECT active_id FROM music_settings WHERE id = 1').get();
  const activeId = setting ? setting.active_id : null;
  res.json({
    items: rows.map(r => ({ ...rowToSong(r), is_active: r.id === activeId })),
  });
});

// 上传歌曲（管理员）
// Express req.body 是 Node Readable，与 Web Request.formData() 不直接兼容
// 这里把 Node 流转成 Web ReadableStream 再构造一个 Request 调用原生 formData()
router.post('/', requireAuth, requireAdmin, writeLimiter, async (req, res) => {
  let form;
  try {
    // 用 Node→Web 流转换 + Request 包装，让 undici 来解析 multipart
    const webBody = Readable.toWeb(req);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    const webReq = new Request('http://internal/upload', {
      method: 'POST',
      headers,
      body: webBody,
      duplex: 'half',
    });
    form = await webReq.formData();
  } catch (e) {
    console.warn('multipart parse failed:', e.message);
    return res.status(400).json({ error: 'invalid multipart payload' });
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return res.status(400).json({ error: 'file is required' });
  }
  const fileName = file.name || 'song';
  const mime = (file.type || '').toLowerCase();
  const ext = ALLOWED_MIME[mime];
  if (!ext) {
    return res.status(400).json({ error: `unsupported mime type: ${mime || '(unknown)'}` });
  }

  // 读取字节并做最终大小校验
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0)           return res.status(400).json({ error: 'empty file' });
  if (buf.length > MAX_SIZE)      return res.status(413).json({ error: `file too large (max ${MAX_SIZE / 1024 / 1024}MB)` });

  // 磁盘文件名：随机 UUID + 扩展名，避免用户控制路径
  const storedName = crypto.randomUUID() + ext;
  const fullPath = path.join(MUSIC_DIR, storedName);

  try {
    await fs.promises.writeFile(fullPath, buf);
  } catch (e) {
    console.error('music write failed:', e);
    return res.status(500).json({ error: 'failed to write file' });
  }

  // 标题：用户可显式指定，否则用 original_name 去扩展名
  let title = String(form.get('title') || '').trim().slice(0, 200);
  if (!title) {
    title = String(fileName).replace(/\.[^.]+$/, '').slice(0, 200) || '未命名';
  }

  let row;
  try {
    const info = db.prepare(`
      INSERT INTO music (filename, original_name, title, mime, size_bytes)
      VALUES (?, ?, ?, ?, ?)
    `).run(storedName, String(fileName).slice(0, 255), title, mime, buf.length);
    row = db.prepare('SELECT * FROM music WHERE id = ?').get(info.lastInsertRowid);
  } catch (e) {
    // DB 写入失败，回滚磁盘文件
    fs.promises.unlink(fullPath).catch(() => {});
    console.error('music insert failed:', e);
    return res.status(500).json({ error: 'failed to save record' });
  }

  res.status(201).json({ song: rowToSong(row) });
});

// 设置当前播放歌曲（管理员）
// body: { id: number } 设为激活；{ id: null } 清除激活
router.patch('/active', requireAuth, requireAdmin, writeLimiter, (req, res) => {
  const id = req.body && req.body.id;
  if (id !== null && !Number.isInteger(id)) {
    return res.status(400).json({ error: 'id must be integer or null' });
  }
  if (id !== null) {
    const exists = db.prepare('SELECT 1 FROM music WHERE id = ?').get(id);
    if (!exists) return res.status(404).json({ error: 'song not found' });
  }
  db.prepare('UPDATE music_settings SET active_id = ? WHERE id = 1').run(id);
  const setting = db.prepare('SELECT active_id FROM music_settings WHERE id = 1').get();
  const row = setting && setting.active_id
    ? db.prepare('SELECT * FROM music WHERE id = ?').get(setting.active_id)
    : null;
  res.json({ song: rowToSong(row) });
});

// 删除歌曲（管理员）
router.delete('/:id', requireAuth, requireAdmin, writeLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

  const row = db.prepare('SELECT * FROM music WHERE id = ?').get(id);
  if (!row) return res.status(204).end();

  // 如果删除的是当前激活的，先清空设置（外键也会自动 SET NULL，但显式处理更清晰）
  db.prepare('UPDATE music_settings SET active_id = NULL WHERE id = 1 AND active_id = ?').run(id);
  db.prepare('DELETE FROM music WHERE id = ?').run(id);

  // 异步删文件，失败也不影响 API 响应
  fs.promises.unlink(path.join(MUSIC_DIR, row.filename)).catch((e) => {
    console.warn('music file unlink failed:', row.filename, e.message);
  });

  res.status(204).end();
});

module.exports = router;
