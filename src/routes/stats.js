'use strict';

// 访问统计路由
//
// 接口说明：
//   POST /api/stats/view    记录一次访问（带 IP 去重 + 5 分钟缓存）
//   GET  /api/stats/today   返回今日浏览人数（按 IP 去重）
// 访问统计数据仅用于后台统计与分析，前端不直接使用
// 由 geoip-lite 在服务端解析属地，前端不感知；IP 仅管理员可见
// by ALyCE_Aoi

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');

const router = express.Router();

// 访问记录限流：每 IP 每分钟最多 60 次
// 该端点公开且免登录，旧实现只靠「同一 (ip, path) 5 分钟内只记一次」去重，
// 攻击者轮换 path 即可持续插入 page_views 行（受 db-sweep 的 5 万行上限约束，
// 但仍会拖慢统计查询）。这里加一道按 IP 的闸门。
const viewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// IP 归一化：req.ip 在 trust proxy 下可由客户端伪造且长度不受限，
// 直接当 Map key 会让内存上限失效（1 万个 16KB key ≈ 160MB）
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9A-Fa-f:.]+$/;
function normalizeIp(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > 45) return 'unknown';
  if (IPV4_RE.test(s)) return s;
  if (s.includes(':') && IPV6_RE.test(s)) return s;
  return 'unknown';
}

// 同一 IP 在 5 分钟内只记录一次（防刷）
const VIEW_DEBOUNCE_MS = 5 * 60 * 1000;
// 内存缓存：{ "ip::path": timestamp }
// 硬上限：超过后强制驱逐最旧的 25%，防止攻击者使用大量不同 path 将内存撑爆
const VIEW_CACHE_MAX = 10000;
const recentViews = new Map();

function evictOldest(map, ratio) {
  const drop = Math.max(1, Math.floor(map.size * ratio));
  let i = 0;
  for (const k of map.keys()) {
    if (i >= drop) break;
    map.delete(k);
    i += 1;
  }
}

function shouldRecord(ip, path) {
  const now = Date.now();
  const key = `${ip}::${path}`;
  const last = recentViews.get(key);
  if (last && now - last < VIEW_DEBOUNCE_MS) return false;
  recentViews.set(key, now);
  // 超过硬上限：先清理过期项，仍超限则按插入顺序驱逐最旧的 25%
  if (recentViews.size > VIEW_CACHE_MAX) {
    for (const [k, t] of recentViews) {
      if (now - t > VIEW_DEBOUNCE_MS) recentViews.delete(k);
    }
    if (recentViews.size > VIEW_CACHE_MAX) evictOldest(recentViews, 0.25);
  }
  return true;
}

// POST /api/stats/view
// body: { path }（可选，默认 '/'）
// 限制长度 200 字符且必须以 / 开头，防止攻击者塞入超长字符串把 SQLite 撑爆
router.post('/view', viewLimiter, (req, res) => {
  const raw = req.body && req.body.path;
  const path = (typeof raw === 'string' && raw.length <= 200 && raw.startsWith('/'))
    ? raw
    : '/';
  const ip = normalizeIp(req.ip || req.socket.remoteAddress || '');
  if (shouldRecord(ip, path)) {
    db.prepare('INSERT INTO page_views (path, ip) VALUES (?, ?)').run(path, ip);
  }
  res.json({ ok: true });
});

// GET /api/stats/today
// 返回今日（北京时间 00:00 起）的独立 IP 数（去重）
router.get('/today', (_req, res) => {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT ip) AS n
    FROM page_views
    WHERE viewed_at >= datetime('now', '+8 hours', 'start of day')
  `).get();
  res.json({ count: row.n || 0 });
});

module.exports = router;