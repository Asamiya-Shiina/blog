'use strict';

// 上传孤儿清理
//
// 维护三类资源的「DB 引用集 与 磁盘文件集」一致：
//   1. 头像孤儿：data/uploads/avatars/ 中未被 users.avatar_filename 引用的文件
//   2. 音乐孤儿：data/uploads/music/   中未被 music.filename     引用的文件
//   3. WAL 回收：周期性 PRAGMA wal_checkpoint(TRUNCATE)，将 -wal 内容写回主数据库并截断
//
// 调度（与 src/audit.js:58-62 一致）：
//   - 模块加载时立即执行一次
//   - setInterval(24h) + .unref()
//   - 任一清理失败仅 console.warn，不影响后续 sweep
//
// 由 server.js require() 触发加载，无独立 CLI 入口。

const path = require('node:path');
const fs = require('node:fs');
const db = require('./db');

const AVATAR_DIR = path.join(__dirname, '..', 'data', 'uploads', 'avatars');
const MUSIC_DIR  = path.join(__dirname, '..', 'data', 'uploads', 'music');
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 小时

function readdirSafe(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return [];
  }
  return fs.readdirSync(dir);
}

// 从 dir 中找出未被 referenced 集合引用的文件；跳过 .tmp 与隐藏文件
function diffOrphans(dir, referenced) {
  return readdirSafe(dir).filter(
    name => !name.startsWith('.') && !name.endsWith('.tmp') && !referenced.has(name)
  );
}

function unlinkOrphans(dir, orphans) {
  let removed = 0, failed = 0;
  for (const name of orphans) {
    try {
      fs.unlinkSync(path.join(dir, name));
      removed++;
    } catch (e) {
      console.warn(`[orphan-sweep] 删除失败 ${dir}/${name}: ${e.message}`);
      failed++;
    }
  }
  return { removed, failed };
}

// 头像孤儿清理
function sweepOrphanAvatars() {
  try {
    const rows = db.prepare('SELECT avatar_filename FROM users WHERE avatar_filename IS NOT NULL').all();
    const referenced = new Set(rows.map(r => r.avatar_filename));
    const orphans = diffOrphans(AVATAR_DIR, referenced);
    if (orphans.length === 0) return;
    const { removed, failed } = unlinkOrphans(AVATAR_DIR, orphans);
    console.log(`[orphan-sweep] avatars: 清理 ${removed} 个，失败 ${failed} 个`);
  } catch (e) {
    console.warn('[orphan-sweep] avatars sweep failed:', e.message);
  }
}

// 音乐孤儿清理
function sweepOrphanMusic() {
  try {
    const rows = db.prepare('SELECT filename FROM music').all();
    const referenced = new Set(rows.map(r => r.filename));
    const orphans = diffOrphans(MUSIC_DIR, referenced);
    if (orphans.length === 0) return;
    const { removed, failed } = unlinkOrphans(MUSIC_DIR, orphans);
    console.log(`[orphan-sweep] music: 清理 ${removed} 个，失败 ${failed} 个`);
  } catch (e) {
    console.warn('[orphan-sweep] music sweep failed:', e.message);
  }
}

// WAL checkpoint
// TRUNCATE 模式：将 wal 内容写回主数据库文件后截断 -wal，并把 -shm 标记为可清理
// 常见失败原因：其他进程持锁（本项目为单进程，正常情况下不应出现）/ 磁盘已满
// 失败仅 warn，不影响其他清理任务
function walCheckpoint() {
  try {
    // better-sqlite3 pragma 返回 [busy, log_pages, checkpointed_pages]
    const result = db.pragma('wal_checkpoint(TRUNCATE)');
    // pragma('wal_checkpoint(...)') 在 better-sqlite3 中实际返回 { busy, log_pages, checkpointed_pages }
    const r = Array.isArray(result) ? result[0] : result;
    if (r && (r.checkpointed_pages > 0 || r.busy)) {
      console.log(`[orphan-sweep] wal checkpoint: ${r.checkpointed_pages} 页已合并${r.busy ? '（busy）' : ''}`);
    }
  } catch (e) {
    console.warn('[orphan-sweep] wal checkpoint failed:', e.message);
  }
}

function runAll() {
  sweepOrphanAvatars();
  sweepOrphanMusic();
  walCheckpoint();
}

const timer = setInterval(runAll, SWEEP_INTERVAL_MS);
timer.unref();

// 启动后立即执行一次
runAll();
