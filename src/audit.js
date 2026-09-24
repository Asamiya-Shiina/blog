'use strict';

// 审计日志：关键操作（角色变更、密码修改、用户增删、SMTP 配置等）留痕
// 用于事后追溯「谁在什么时候动了什么」

const db = require('./db');

const insertStmt = db.prepare(
  'INSERT INTO audit_log (actor_id, target_id, action, detail) VALUES (?, ?, ?, ?)'
);

/**
 * 写一条审计日志
 * @param {object} entry
 * @param {number|null} entry.actorId  操作人 user.id（系统/匿名时传 null）
 * @param {number|null} [entry.targetId] 作用对象 user.id（可选）
 * @param {string}      entry.action  动作名，如 'user.create' / 'role.change' / 'password.change'
 * @param {object}      [entry.detail] 额外上下文（任意可 JSON 化对象）
 */
function log({ actorId = null, targetId = null, action, detail = null }) {
  try {
    const json = detail == null ? null : JSON.stringify(detail);
    insertStmt.run(actorId, targetId, action, json);
  } catch (e) {
    // 审计日志写入失败不应阻塞业务路径
    console.warn('audit log failed:', e.message);
  }
}

module.exports = { log };

// —— 保留策略 ——
// 审计日志不能无界增长：站主活跃一年就能堆几万行，磁盘满 SQLite 直接罢工
// 每 6 小时跑一次：
//   1) 删 90 天以前的记录
//   2) 总行数超过硬上限（10 万）时按时间删到只剩 8 万，留缓冲
const RETAIN_DAYS = 90;
const HARD_CAP = 100_000;
const SOFT_CAP = 80_000;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const deleteByAgeStmt = db.prepare(
  "DELETE FROM audit_log WHERE at < datetime('now', '+8 hours', ?)"
);
const countStmt = db.prepare('SELECT COUNT(*) AS n FROM audit_log');
const deleteOldestStmt = db.prepare('DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log ORDER BY at ASC LIMIT ?)');

function sweep() {
  try {
    deleteByAgeStmt.run(`-${RETAIN_DAYS} days`);
    const n = countStmt.get().n;
    if (n > HARD_CAP) deleteOldestStmt.run(n - SOFT_CAP);
  } catch (e) {
    console.warn('audit sweep failed:', e.message);
  }
}

const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
sweepTimer.unref();   // 不阻塞进程退出

// 模块加载时立即跑一次（适用于刚启动就有积压数据的情况）
sweep();
