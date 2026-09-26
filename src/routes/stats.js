'use strict';

// —— 访问统计路由 ——
// POST /api/stats/view  记录一次访问（带 IP 去重 + 5 分钟缓存）
// GET  /api/stats/today  获取今日浏览人数（按 IP 去重）
// by ALyCE_Aoi

const express = require('express');
const db = require('../db');

const router = express.Router();

// 同一 IP 5 分钟内只记录一次（防刷）
const VIEW_DEBOUNCE_MS = 5 * 60 * 1000;
// 内存缓存：{ "ip::path": timestamp }
// 硬上限：超过后强制清掉最旧的 25%，防止攻击者用大量不同 path 把内存撑爆
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
  // 超过硬上限：先清过期项；仍超则按插入顺序淘汰最旧的 25%
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
// 限长 200 字符 + 必须以 / 开头，防止攻击者塞超长字符串进 page_views 把 SQLite 撑爆
router.post('/view', (req, res) => {
  const raw = req.body && req.body.path;
  const path = (typeof raw === 'string' && raw.length <= 200 && raw.startsWith('/'))
    ? raw
    : '/';
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
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