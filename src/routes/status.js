'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { requireAuth } = require('../auth');
const db = require('../db');
const store = require('../status-store');

const router = express.Router();

// ============ 配置数据库操作 ============

function getConfig(key) {
  const row = db.prepare('SELECT value FROM status_config WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO status_config (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

function getAllConfig() {
  const rows = db.prepare('SELECT key, value FROM status_config').all();
  const config = {};
  for (const row of rows) {
    config[row.key] = JSON.parse(row.value);
  }
  return {
    blacklist: config.blacklist || [],
    blacklistPatterns: config.blacklistPatterns || [],
    appNames: config.appNames || {},
    appNamePatterns: config.appNamePatterns || [],
    titleApps: config.titleApps || [],
    titleAppPatterns: config.titleAppPatterns || [],
  };
}

// ============ 客户端 API（需要登录） ============

const statusLimiter = rateLimit({
  windowMs: 15_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const statusSchema = z.object({
  active: z.boolean(),
  app: z.string().max(100).optional().default(''),
  title: z.string().max(300).optional().default(''),
  icon: z.string().max(50).optional().default(''),
  deviceName: z.string().max(50).optional().default('default'),
});

// POST /api/status - 客户端上报状态
router.post('/', requireAuth, statusLimiter, (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request' });
  }
  const deviceId = `${req.user.username}_${parsed.data.deviceName}`;
  if (parsed.data.active) {
    store.updateStatus(deviceId, parsed.data);
  } else {
    store.clearStatus(deviceId);
  }
  res.json({ ok: true });
});

// POST /api/status/off - 手动关闭
router.post('/off', requireAuth, (req, res) => {
  const deviceName = req.body.deviceName || 'default';
  const deviceId = `${req.user.username}_${deviceName}`;
  store.clearStatus(deviceId);
  res.json({ ok: true });
});

// GET /api/status/config - 客户端拉取配置
router.get('/config', requireAuth, (req, res) => {
  res.json(getAllConfig());
});

// ============ 公开 API（无需登录） ============

// GET /api/status - 获取当前状态
router.get('/', (_req, res) => {
  res.json(store.getPublicStatus());
});

// GET /api/status/stream - SSE 推送
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify(store.getPublicStatus())}\n\n`);
  store.addClient(res);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30_000);
  req.on('close', () => clearInterval(heartbeat));
});

// ============ 管理 API（需要登录） ============

// GET /api/status/admin/config - 获取配置
router.get('/admin/config', requireAuth, (req, res) => {
  res.json(getAllConfig());
});

// POST /api/status/admin/config - 保存配置
const configSchema = z.object({
  blacklist: z.array(z.string().max(100)).optional(),
  blacklistPatterns: z.array(z.string().max(200)).optional(),
  appNames: z.record(z.string().max(100), z.string().max(100)).optional(),
  appNamePatterns: z.array(z.object({ pattern: z.string().max(200), name: z.string().max(100) })).optional(),
  titleApps: z.array(z.string().max(100)).optional(),
  titleAppPatterns: z.array(z.object({ pattern: z.string().max(200) })).optional(),
});

router.post('/admin/config', requireAuth, (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid config' });
  }
  for (const [key, value] of Object.entries(parsed.data)) {
    setConfig(key, value);
  }
  res.json({ ok: true });
});

module.exports = router;
