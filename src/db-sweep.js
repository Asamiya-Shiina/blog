'use strict';

// 数据库清理模块
//
// 处理两类会持续增长的 DB 表：
//   1. page_views：每次访问 /api/stats/view 写入一行，仅查询「今日」数据，历史数据无访问需求
//      → 保留 30 天 + 5 万行硬上限（双保险，与 src/audit.js:42-46 模式一致）
//   2. pending users：注册时未完成邮箱验证的临时用户
//      → 委托 db.sweepExpiredPendingUsers() 清理 verify_expires 已过期的行
//
// 调度（与 src/audit.js:58-62 模式一致）：
//   - 模块加载时立即执行一次
//   - setInterval(6h) + .unref()
//   - 任一清理失败仅 console.warn，不影响后续 sweep
//
// 由 server.js require() 触发加载，无独立 CLI 入口。

const db = require('./db');

const RETAIN_DAYS = 30;
const HARD_CAP = 50_000;
const SOFT_CAP = 40_000;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时

// page_views 清理
const deleteByAgeStmt = db.prepare(
  "DELETE FROM page_views WHERE viewed_at < datetime('now', '+8 hours', ?)"
);
const countPageViewsStmt = db.prepare('SELECT COUNT(*) AS n FROM page_views');
const deleteOldestPageViewsStmt = db.prepare(
  'DELETE FROM page_views WHERE id IN (SELECT id FROM page_views ORDER BY viewed_at ASC LIMIT ?)'
);

// 分批删除上限：单批 5000 行，足以让单次 sweep 把事件循环压在 5-15ms 以内。
// 即使 10 万行要分 20 批消化，批次间通过 setImmediate 让出事件循环，
// HTTP / SSE 推送可以插入，避免 sweep 期间整站停顿。
const DELETE_BATCH_SIZE = 5000;

async function sweepPageViews() {
  try {
    deleteByAgeStmt.run(`-${RETAIN_DAYS} days`);
    let n = countPageViewsStmt.get().n;
    if (n <= HARD_CAP) return;
    let remaining = n - SOFT_CAP;
    let deleted = 0;
    while (remaining > 0) {
      const batch = Math.min(DELETE_BATCH_SIZE, remaining);
      const info = deleteOldestPageViewsStmt.run(batch);
      deleted += info.changes;
      remaining -= batch;
      // 让出事件循环：单批 5-15ms 后插入一次 microtask，让其它 HTTP/SSE 处理
      await new Promise(resolve => setImmediate(resolve));
    }
    if (deleted > 0) {
      console.log(`[db-sweep] page_views: 分批删除 ${deleted} 行（${DELETE_BATCH_SIZE}/批）`);
    }
  } catch (e) {
    console.warn('[db-sweep] page_views sweep failed:', e.message);
  }
}

// pending users 清理
async function sweepPendingUsers() {
  try {
    const removed = db.sweepExpiredPendingUsers();
    if (removed.length > 0) {
      console.log(`[db-sweep] pending users: 清理 ${removed.length} 个`);
    }
  } catch (e) {
    console.warn('[db-sweep] pending users sweep failed:', e.message);
  }
}

async function runAll() {
  await sweepPageViews();
  await sweepPendingUsers();
}

// 调度：setInterval 对 async 函数的返回值（Promise）会忽略，
// 改用 setTimeout 链式调度，并在每次完成后 unref 不阻塞进程退出。
function schedule() {
  runAll()
    .catch(e => console.warn('[db-sweep] runAll failed:', e.message))
    .finally(() => {
      const t = setTimeout(schedule, SWEEP_INTERVAL_MS);
      t.unref();
    });
}

// 启动后立即执行一次
schedule();
