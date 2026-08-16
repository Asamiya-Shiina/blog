'use strict';

// —— 实时状态路由 ——
// 处理：桌面客户端上报当前活动状态、SSE 推送、管理配置
// 分三层 API：客户端（需登录）、公开（无需登录）、管理（需管理员）

const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { requireAuth, requireAdmin } = require('../auth');
const db = require('../db');
const store = require('../status-store');

const router = express.Router();

// ============ 配置数据库操作 ============

// 读取单个配置项（JSON 反序列化）
function getConfig(key) {
  const row = db.prepare('SELECT value FROM status_config WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

// 写入单个配置项（JSON 序列化，存在则替换）
function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO status_config (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

// 读取所有配置，返回结构化对象（缺失的字段给默认空值）
function getAllConfig() {
  const rows = db.prepare('SELECT key, value FROM status_config').all();
  const config = {};
  for (const row of rows) {
    config[row.key] = JSON.parse(row.value);
  }
  return {
    blacklist: config.blacklist || [],                 // 应用名黑名单
    blacklistPatterns: config.blacklistPatterns || [],  // 黑名单正则
    appNames: config.appNames || {},                    // 进程名 → 显示名映射
    appNamePatterns: config.appNamePatterns || [],      // 正则映射
    titleApps: config.titleApps || [],                  // 显示窗口标题的应用
    titleAppPatterns: config.titleAppPatterns || [],    // 显示标题的正则
  };
}

// ============ 客户端 API（需要登录） ============

// 状态上报限流：15 秒内最多 30 次，防止客户端疯狂刷请求
const statusLimiter = rateLimit({
  windowMs: 15_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// 状态上报 Schema
const statusSchema = z.object({
  active: z.boolean(),                                    // 是否活跃
  app: z.string().max(100).optional().default(''),        // 应用名
  title: z.string().max(300).optional().default(''),      // 窗口标题
  icon: z.string().max(50).optional().default(''),        // 图标标识
  deviceName: z.string().max(50).optional().default('default'),  // 设备名（多设备支持）
});

// POST /api/data：客户端上报当前状态
// deviceId = 用户名_设备名，用于区分同一用户的多台设备
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

// POST /api/data/off：手动关闭状态（主动离线）
const offSchema = z.object({
  deviceName: z.string().max(50).optional().default('default'),
});

router.post('/off', requireAuth, statusLimiter, (req, res) => {
  const parsed = offSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid request' });
  }
  const deviceId = `${req.user.username}_${parsed.data.deviceName}`;
  store.clearStatus(deviceId);
  res.json({ ok: true });
});

// GET /api/data/config：客户端拉取管理配置（黑名单、映射等）
// 客户端根据这些配置决定哪些应用不上报、如何显示应用名
router.get('/config', requireAuth, (req, res) => {
  res.json(getAllConfig());
});

// ============ 公开 API（无需登录） ============

// GET /api/data：获取当前所有活跃设备状态（公开信息）
router.get('/', (_req, res) => {
  res.json(store.getPublicStatus());
});

// GET /api/data/stream：SSE 实时推送
// 客户端建立长连接，服务端在状态变化时主动推送
// 限制最大并发连接数防止资源耗尽
const MAX_SSE_CLIENTS = 50;

router.get('/stream', (req, res) => {
  if (store.clientCount >= MAX_SSE_CLIENTS) {
    return res.status(429).json({ error: 'too many connections' });
  }
  // 设置 SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',   // SSE 格式
    'Cache-Control': 'no-cache',            // 禁止缓存
    'Connection': 'keep-alive',             // 保持长连接
    'X-Accel-Buffering': 'no',              // 禁用 Nginx 缓冲
  });
  // 立即发送当前状态
  res.write(`data: ${JSON.stringify(store.getPublicStatus())}\n\n`);
  // 注册为 SSE 客户端，后续状态变化会自动推送
  store.addClient(res);
  // 每 30 秒发送心跳，防止连接被中间代理断开
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30_000);
  // 客户端断开时清理
  req.on('close', () => clearInterval(heartbeat));
});

// ============ 管理 API（需要登录 + 管理员权限） ============

// GET /api/data/admin/config：获取管理配置
router.get('/admin/config', requireAuth, requireAdmin, (req, res) => {
  res.json(getAllConfig());
});

// POST /api/data/admin/config：保存管理配置
// 部分更新：只修改提交的字段，未提交的保持不变
const configSchema = z.object({
  blacklist: z.array(z.string().max(100)).optional(),
  blacklistPatterns: z.array(z.string().max(200)).optional(),
  appNames: z.record(z.string().max(100), z.string().max(100)).optional(),
  appNamePatterns: z.array(z.object({ pattern: z.string().max(200), name: z.string().max(100) })).optional(),
  titleApps: z.array(z.string().max(100)).optional(),
  titleAppPatterns: z.array(z.object({ pattern: z.string().max(200) })).optional(),
});

router.post('/admin/config', requireAuth, requireAdmin, (req, res) => {
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
