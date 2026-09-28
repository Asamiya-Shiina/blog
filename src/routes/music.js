'use strict';

// 音乐路由
// 提供列表、上传、删除与设置当前播放歌曲等接口
// 公开接口：GET /api/music/active（前台播放器调用）
// 管理接口：其余全部需要登录
// ALyCE_Aoi

const path = require('path');
const fs = require('fs');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireManager } = require('../auth');

const db = require('../db');

const router = express.Router();

// 音乐文件存放目录（与 server.js 中的静态挂载保持一致）
const MUSIC_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'music');
fs.mkdirSync(MUSIC_DIR, { recursive: true });

// 允许的 MIME 类型与对应扩展名
// 仅放行主流浏览器原生支持的格式，避免未知容器带来的兼容问题
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

// 单文件大小上限：15MB，对一首完整歌曲已足够
const MAX_SIZE = 15 * 1024 * 1024;

// 写操作限流：15 分钟最多 30 次
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many requests, try again later' },
});

// 将数据库行映射为歌曲对象
// 仅在 withOriginal=true 时携带 original_name（原始上传文件名，仅管理员可见）
// 公开接口不暴露该字段，避免向匿名访客泄漏站主本地的原始文件名
function rowToSong(row, withOriginal = false) {
  if (!row) return null;
  const song = {
    id: row.id,
    title: row.title,
    mime: row.mime,
    size_bytes: row.size_bytes,
    src: `/audio/${encodeURIComponent(row.filename)}`,
    created_at: row.created_at,
  };
  if (withOriginal) song.original_name = row.original_name;
  return song;
}

// 取当前激活的歌曲（公开）
router.get('/active', (_req, res) => {
  const setting = db.prepare('SELECT active_id FROM music_settings WHERE id = 1').get();
  if (!setting || !setting.active_id) return res.json({ song: null });
  const row = db.prepare('SELECT * FROM music WHERE id = ?').get(setting.active_id);
  if (!row) return res.json({ song: null });
  // 公开播放器不给 original_name（原始文件名属站主隐私）
  res.json({ song: rowToSong(row, false) });
});

// 列出所有歌曲（需登录）
router.get('/', requireManager, (_req, res) => {
  const rows = db.prepare('SELECT * FROM music ORDER BY created_at DESC').all();
  const setting = db.prepare('SELECT active_id FROM music_settings WHERE id = 1').get();
  const activeId = setting ? setting.active_id : null;
  res.json({
    items: rows.map(r => ({ ...rowToSong(r, true), is_active: r.id === activeId })),
  });
});

// 上传歌曲（管理员）
// Express req 是 Node.js Readable 流，与 Web Request.formData() 不直接兼容
// 此处将 Node 流转换为 Web ReadableStream 并包装为 Request，使用 undici 解析 multipart
router.post('/', requireManager, writeLimiter, async (req, res) => {
  let form;
  try {
    // Node → Web 流转换后通过 Request 包装，由 undici 负责 multipart 解析
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

  // 读取字节并执行最终大小校验
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0)           return res.status(400).json({ error: 'empty file' });
  if (buf.length > MAX_SIZE)      return res.status(413).json({ error: `file too large (max ${MAX_SIZE / 1024 / 1024}MB)` });

  // 磁盘文件名采用 UUID + 扩展名的形式，防止用户控制路径
  const storedName = crypto.randomUUID() + ext;
  const fullPath = path.join(MUSIC_DIR, storedName);

  try {
    await fs.promises.writeFile(fullPath, buf);
  } catch (e) {
    console.error('music write failed:', e);
    return res.status(500).json({ error: 'failed to write file' });
  }

  // 标题：用户可显式指定；缺省时使用原始文件名去除扩展名
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
    // DB 写入失败时回滚磁盘文件
    fs.promises.unlink(fullPath).catch(() => {});
    console.error('music insert failed:', e);
    return res.status(500).json({ error: 'failed to save record' });
  }

  res.status(201).json({ song: rowToSong(row, true) });
});

// 设置当前播放歌曲（管理员）
// body: { id: number } 设为激活；{ id: null } 清除激活
router.patch('/active', requireManager, writeLimiter, (req, res) => {
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
router.delete('/:id', requireManager, writeLimiter, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });

  const row = db.prepare('SELECT * FROM music WHERE id = ?').get(id);
  if (!row) return res.status(204).end();

  // 若删除的是当前激活的歌曲，先清空设置
  // 外键 ON DELETE SET NULL 也会自动处理，这里显式执行以保持语义清晰
  db.prepare('UPDATE music_settings SET active_id = NULL WHERE id = 1 AND active_id = ?').run(id);
  db.prepare('DELETE FROM music WHERE id = ?').run(id);

  // 异步删除文件，失败不影响 API 响应
  fs.promises.unlink(path.join(MUSIC_DIR, row.filename)).catch((e) => {
    console.warn('music file unlink failed:', row.filename, e.message);
  });

  res.status(204).end();
});

module.exports = router;
