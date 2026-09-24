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
// 内存缓存：{ ip: { path: timestamp } }
const recentViews = new Map();

function shouldRecord(ip, path) {
  const now = Date.now();
  const key = `${ip}::${path}`;
  const last = recentViews.get(key);
  if (last && now - last < VIEW_DEBOUNCE_MS) return false;
  recentViews.set(key, now);
  // 定期清理过期条目（避免内存泄漏）
  if (recentViews.size > 10000) {
    for (const [k, t] of recentViews) {
      if (now - t > VIEW_DEBOUNCE_MS) recentViews.delete(k);
    }
  }
  return true;
}

// POST /api/stats/view
// body: { path }（可选，默认 '/'）
router.post('/view', (req, res) => {
  const path = (req.body && req.body.path) || '/';
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