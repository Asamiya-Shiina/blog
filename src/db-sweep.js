'use strict';

// —— 数据库相关清理 ——
//
// 处理两类会持续增长的 DB 表：
//   1. page_views：每次访问 /api/stats/view 写一行，只查「今日」，历史数据无人看
//      → 保留 30 天 + 5 万行硬上限（双保险，与 src/audit.js:42-46 同模式）
//   2. pending users：注册未验证邮箱的临时用户
//      → 委托 db.sweepExpiredPendingUsers() 清掉 verify_expires 已过期的行
//
// 调度（与 src/audit.js:58-62 同模式）：
//   - 模块加载即跑一次
//   - setInterval(6h) + .unref()
//   - 失败 console.warn，不阻塞后续
//
// server.js require() 即生效。

const db = require('./db');

const RETAIN_DAYS = 30;
const HARD_CAP = 50_000;
const SOFT_CAP = 40_000;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时

// —— page_views ——
const deleteByAgeStmt = db.prepare(
  "DELETE FROM page_views WHERE viewed_at < datetime('now', '+8 hours', ?)"
);
const countPageViewsStmt = db.prepare('SELECT COUNT(*) AS n FROM page_views');
const deleteOldestPageViewsStmt = db.prepare(
  'DELETE FROM page_views WHERE id IN (SELECT id FROM page_views ORDER BY viewed_at ASC LIMIT ?)'
);

function sweepPageViews() {
  try {
    deleteByAgeStmt.run(`-${RETAIN_DAYS} days`);
    const n = countPageViewsStmt.get().n;
    if (n > HARD_CAP) deleteOldestPageViewsStmt.run(n - SOFT_CAP);
  } catch (e) {
    console.warn('[db-sweep] page_views sweep failed:', e.message);
  }
}

// —— pending users ——
function sweepPendingUsers() {
  try {
    const removed = db.sweepExpiredPendingUsers();
    if (removed.length > 0) {
      console.log(`[db-sweep] pending users: 清理 ${removed.length} 个`);
    }
  } catch (e) {
    console.warn('[db-sweep] pending users sweep failed:', e.message);
  }
}

function runAll() {
  sweepPageViews();
  sweepPendingUsers();
}

const timer = setInterval(runAll, SWEEP_INTERVAL_MS);
timer.unref();

// 启动后立即跑一次
runAll();
